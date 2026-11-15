//! 端侧 TTS 模型分发：清单解析、按源下载、安装事务（校验+安全解包+原子提交）、
//! 已装注册表与使用引用计数。
//!
//! 分层约定（codex 设计）：Rust 只管模型文件的分发与落盘；合成与播放在原生壳
//! （sherpa-onnx），壳经 podic-mobile FFI 取模型版本目录并在使用期间持引用——
//! 引用未释放时删除模型返回 MODEL_IN_USE。

use crate::error::Error;
use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 默认 TTS 清单（独立于词典发布仓库：发布周期/许可/运行时要求都不同）
pub const DEFAULT_TTS_MANIFEST_URL: &str =
    "https://github.com/podic-dictionary/tts/releases/latest/download/tts-metainfo.json";
/// gh-proxy 预设的前缀（与词典源一致）
pub const GHPROXY_PREFIX: &str = "https://gh-proxy.com/";

// ---------------- 清单协议 ----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsManifest {
    pub schema_version: i64,
    #[serde(default)]
    pub catalog_revision: i64,
    #[serde(default)]
    pub defaults: HashMap<String, String>,
    pub models: Vec<TtsModelEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsModelEntry {
    /// 稳定主键（如 supertonic-3-int8），不是展示名
    pub model_id: String,
    pub family: String, // supertonic | vits-piper（壳按 family 构造引擎配置）
    pub languages: Vec<String>,
    pub name: String,
    pub version: String,
    /// 同 model_id 下严格递增，更新判断依据
    pub revision: i64,
    #[serde(default)]
    pub notes: String,
    pub package: TtsPackage,
    #[serde(default)]
    pub files: Vec<TtsFileSpec>,
    /// 壳构造引擎所需的文件映射（相对版本目录），按 family 结构不同
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub voices: Vec<Value>,
    #[serde(default)]
    pub default_voice_id: i64,
    #[serde(default)]
    pub licenses: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsPackage {
    pub url: String,
    pub format: String, // tar.bz2
    /// 压缩包 sha256（必填，安装前强制校验）
    pub sha256: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub archive_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsFileSpec {
    pub path: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub sha256: String,
}

// ---------------- 源解析 ----------------

/// 源模式：github（直连）/ ghproxy（对 github URL 加代理前缀）/ custom（清单直链）
/// 与词典更新源同语义，但独立保存（见 Settings.tts）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TtsSource {
    pub mode: String,
    #[serde(default)]
    pub custom_manifest_url: String,
}

/// 解析清单地址：custom 给直链用直链；github/ghproxy 用默认清单（ghproxy 加前缀）
pub fn manifest_url_for(source: &TtsSource) -> String {
    match source.mode.as_str() {
        "custom" if !source.custom_manifest_url.trim().is_empty() => {
            source.custom_manifest_url.trim().to_string()
        }
        "ghproxy" => format!("{GHPROXY_PREFIX}{DEFAULT_TTS_MANIFEST_URL}"),
        _ => DEFAULT_TTS_MANIFEST_URL.to_string(),
    }
}

/// 模型包 URL 解析：ghproxy 模式对 github.com 地址统一加前缀
/// （否则清单加速了、123MB 模型仍直连）；其余模式原样。
/// 清单内的相对 URL 以清单地址为基准解析
pub fn resolve_model_url(source: &TtsSource, manifest_url: &str, url: &str) -> String {
    let absolute = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        // 相对清单目录
        let base = manifest_url.trim_end_matches('/');
        let base_dir = base.rsplit_once('/').map(|(d, _)| d).unwrap_or(base);
        format!("{base_dir}/{url}")
    };
    if source.mode == "ghproxy"
        && !absolute.starts_with(GHPROXY_PREFIX)
        && absolute.contains("://github.com/")
    {
        return format!("{GHPROXY_PREFIX}{absolute}");
    }
    absolute
}

// ---------------- 安装注册表 ----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsInstalled {
    pub model_id: String,
    pub revision: i64,
    pub version: String,
    pub languages: Vec<String>,
    pub family: String,
    /// 版本目录（壳加载引擎用）
    pub path: String,
    pub installed_at: u64,
    /// 清单里的引擎构造配置（文件名映射等，按 family 结构不同；壳解析用）
    #[serde(default)]
    pub config: Value,
}

fn tts_root(data_dir: &Path) -> PathBuf {
    data_dir.join("tts")
}

/// 已装模型列表（读 models/*/current.json；损坏记录跳过）
pub fn installed_models(data_dir: &Path) -> Vec<TtsInstalled> {
    let models_dir = tts_root(data_dir).join("models");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&models_dir) else {
        return out;
    };
    for e in entries.flatten() {
        let cur = e.path().join("current.json");
        let Ok(raw) = std::fs::read_to_string(&cur) else { continue };
        let Ok(mut v) = serde_json::from_str::<TtsInstalled>(&raw) else { continue };
        v.path = e.path().join("versions").join(v.revision.to_string()).to_string_lossy().into_owned();
        if !Path::new(&v.path).is_dir() {
            continue; // current 指向的版本目录不存在：视为未装
        }
        out.push(v);
    }
    out
}

/// 全局使用引用计数（进程级）：壳加载引擎前 acquire、卸载后 release，
/// 删除模型时计数 > 0 返回 MODEL_IN_USE。放全局静态是因为 server AppState
/// 与 podic-mobile FFI 都要访问，而 FFI 拿不到 AppState
static IN_USE: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn in_use_map() -> &'static Mutex<HashMap<String, u32>> {
    IN_USE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn acquire(model_id: &str) -> u32 {
    let mut m = in_use_map().lock().unwrap();
    let c = m.entry(model_id.to_string()).or_insert(0);
    *c += 1;
    *c
}

pub fn release(model_id: &str) -> u32 {
    let mut m = in_use_map().lock().unwrap();
    let next = m.get(model_id).copied().unwrap_or(0).saturating_sub(1);
    if next == 0 {
        m.remove(model_id);
    } else {
        m.insert(model_id.to_string(), next);
    }
    next
}

pub fn in_use_count(model_id: &str) -> u32 {
    in_use_map().lock().unwrap().get(model_id).copied().unwrap_or(0)
}

// ---------------- 安装事务 ----------------

#[derive(Debug, Clone, Serialize)]
pub struct TtsInstallProgress {
    pub phase: String, // download | verify_archive | extract | verify_files | commit
    pub downloaded: u64,
    pub total: u64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// 下载并安装指定清单条目。事务步骤：
/// staging 下载 → 压缩包 sha256 → 安全解包（tar.bz2，拒绝绝对路径/.. /链接）→
/// 逐文件校验 → 原子移动到 versions/<revision> → 更新 current.json。
/// 中断/崩溃只留下 staging 临时目录，已装版本不受影响（下次启动由清场逻辑回收）
pub async fn install_model(
    data_dir: &Path,
    entry: &TtsModelEntry,
    url: &str,
    stop: Arc<AtomicBool>,
    mut on_progress: impl FnMut(TtsInstallProgress) + Send + 'static,
) -> Result<TtsInstalled> {
    let root = tts_root(data_dir);
    let models_dir = root.join("models").join(&entry.model_id);
    let versions_dir = models_dir.join("versions");
    std::fs::create_dir_all(&versions_dir)?;

    let staging = root.join("staging").join(format!("{}-{}", entry.model_id, now_secs()));
    std::fs::create_dir_all(&staging)?;
    let _cleanup = StagingGuard(&staging);

    // ---- 1. 下载 ----
    let http = reqwest::Client::new();
    let resp = http.get(url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(entry.package.size_bytes);
    let archive_path = staging.join("package.tar.bz2");
    let mut file = std::fs::File::create(&archive_path)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await? {
        if stop.load(Ordering::Relaxed) {
            return Err(Error::Other("已取消".into()));
        }
        std::io::Write::write_all(&mut file, &chunk)?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        on_progress(TtsInstallProgress { phase: "download".into(), downloaded, total });
    }
    drop(file);

    // ---- 2. 压缩包校验 ----
    on_progress(TtsInstallProgress { phase: "verify_archive".into(), downloaded, total });
    let got = format!("{:x}", hasher.finalize());
    if !got.eq_ignore_ascii_case(&entry.package.sha256) {
        return Err(Error::Other(format!("模型包校验失败（清单记录与下载内容不一致）")));
    }

    // ---- 3+4. 安全解包 + 逐文件校验（阻塞任务里跑，不占 tokio worker）----
    let extract_dir = staging.join("extracted");
    let entry2 = entry.clone();
    let extract_dir2 = extract_dir.clone();
    let archive2 = archive_path.clone();
    let stop2 = stop.clone();
    let files_checked = std::sync::mpsc::channel::<Result<usize>>();
    let (tx_check, rx_check) = files_checked;
    let handle = std::thread::spawn(move || {
        let r = (|| -> Result<usize> {
            std::fs::create_dir_all(&extract_dir2)?;
            let f = std::fs::File::open(&archive2)?;
            let bz = bzip2::read::BzDecoder::new(f);
            let mut archive = tar::Archive::new(bz);
            archive.set_overwrite(false);
            for entry in archive.entries()? {
                if stop2.load(Ordering::Relaxed) {
                    return Err(Error::Other("已取消".into()));
                }
                let mut entry = entry?;
                let path = entry.path()?.to_path_buf();
                let kind = entry.header().entry_type();
                // 只接受普通文件与目录；软链接/硬链接/设备文件一律拒绝
                if !kind.is_file() && !kind.is_dir() {
                    return Err(Error::Other(format!("压缩包含不允许的条目类型: {}", path.display())));
                }
                // 拒绝绝对路径与 ..
                let mut safe = PathBuf::new();
                let mut ok = true;
                for comp in path.components() {
                    match comp {
                        std::path::Component::Normal(c) => safe.push(c),
                        std::path::Component::CurDir => {}
                        _ => { ok = false; break; }
                    }
                }
                if !ok || safe.as_os_str().is_empty() {
                    return Err(Error::Other(format!("压缩包含不安全的路径: {}", path.display())));
                }
                // 剥掉 archive_root（如 sherpa-onnx-supertonic-3-tts-int8-2026-05-11/）
                let rel = if !entry2.package.archive_root.is_empty() {
                    let root_p = Path::new(&entry2.package.archive_root);
                    match safe.strip_prefix(root_p) {
                        Ok(r) => r.to_path_buf(),
                        Err(_) => safe.clone(), // 不带 root 的包按原样（root 校验放到必须文件检查）
                    }
                } else {
                    safe
                };
                let dest = extract_dir2.join(&rel);
                if kind.is_dir() {
                    std::fs::create_dir_all(&dest)?;
                    continue;
                }
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                // 单文件大小限制（512MB）防解压炸弹
                if entry.size() > 512 * 1024 * 1024 {
                    return Err(Error::Other("压缩包内单文件过大".into()));
                }
                entry.unpack(&dest)?;
            }
            // 逐文件校验（清单 files 非空时）
            if !entry2.files.is_empty() {
                for spec in &entry2.files {
                    if stop2.load(Ordering::Relaxed) {
                        return Err(Error::Other("已取消".into()));
                    }
                    let p = extract_dir2.join(&spec.path);
                    let meta = std::fs::metadata(&p).map_err(|_| {
                        Error::Other(format!("解包缺文件: {}", spec.path))
                    })?;
                    if !meta.is_file() || meta.len() != spec.size_bytes {
                        return Err(Error::Other(format!("文件大小不符: {}", spec.path)));
                    }
                    if !spec.sha256.is_empty() {
                        let mut f = std::fs::File::open(&p)?;
                        let mut h = Sha256::new();
                        let mut buf = vec![0u8; 1 << 20];
                        loop {
                            let n = f.read(&mut buf)?;
                            if n == 0 { break; }
                            h.update(&buf[..n]);
                        }
                        let got = format!("{:x}", h.finalize());
                        if !got.eq_ignore_ascii_case(&spec.sha256) {
                            return Err(Error::Other(format!("文件校验失败: {}", spec.path)));
                        }
                    }
                }
                Ok(entry2.files.len())
            } else {
                Ok(0)
            }
        })();
        let _ = tx_check.send(r);
    });
    // 解包期间发 extract 心跳进度
    let mut n = 0;
    loop {
        if let Ok(r) = rx_check.try_recv() {
            let n_files = r?;
            on_progress(TtsInstallProgress { phase: "verify_files".into(), downloaded: n_files as u64, total: n_files as u64 });
            break;
        }
        if handle.is_finished() && rx_check.try_recv().is_err() {
            return Err(Error::Other("解包线程异常退出".into()));
        }
        on_progress(TtsInstallProgress { phase: "extract".into(), downloaded: n, total: entry.files.len() as u64 });
        n = n.wrapping_add(1);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    // ---- 5. 原子提交 ----
    on_progress(TtsInstallProgress { phase: "commit".into(), downloaded, total });
    let target = versions_dir.join(entry.revision.to_string());
    if target.exists() {
        // 同 revision 重复安装：先删旧（内容按清单不可变）
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&extract_dir, &target)?;
    let installed = TtsInstalled {
        model_id: entry.model_id.clone(),
        revision: entry.revision,
        version: entry.version.clone(),
        languages: entry.languages.clone(),
        family: entry.family.clone(),
        path: target.to_string_lossy().into_owned(),
        installed_at: now_secs(),
        config: entry.config.clone(),
    };
    let cur = models_dir.join("current.json");
    let tmp_cur = models_dir.join("current.json.part");
    std::fs::write(&tmp_cur, serde_json::to_string_pretty(&installed)?)?;
    std::fs::rename(&tmp_cur, &cur)?;
    Ok(installed)
}

/// 清理历史残留（staging 超过一天的目录、versions 里未被 current 指向且超过一天的版本）
pub fn cleanup(data_dir: &Path) {
    let root = tts_root(data_dir);
    let cutoff = now_secs().saturating_sub(24 * 3600);
    if let Ok(entries) = std::fs::read_dir(root.join("staging")) {
        for e in entries.flatten() {
            let age = e.metadata().and_then(|m| m.modified())
                .ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs()).unwrap_or(0);
            if age < cutoff { continue; }
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    if let Ok(entries) = std::fs::read_dir(root.join("models")) {
        for e in entries.flatten() {
            let cur_rev = std::fs::read_to_string(e.path().join("current.json")).ok()
                .and_then(|s| serde_json::from_str::<TtsInstalled>(&s).ok())
                .map(|v| v.revision);
            if let Ok(vers) = std::fs::read_dir(e.path().join("versions")) {
                for v in vers.flatten() {
                    let rev = v.file_name().to_string_lossy().parse::<i64>().unwrap_or(-1);
                    if Some(rev) == cur_rev { continue; }
                    let age = v.metadata().and_then(|m| m.modified())
                        .ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs()).unwrap_or(0);
                    if age < cutoff { continue; }
                    let _ = std::fs::remove_dir_all(v.path());
                }
            }
        }
    }
}

/// 删除模型（整目录）。使用引用 > 0 时返回错误
pub fn remove_model(data_dir: &Path, model_id: &str) -> Result<()> {
    if in_use_count(model_id) > 0 {
        return Err(Error::Other("MODEL_IN_USE".into()));
    }
    // model_id 是路径段：拒绝越权
    if model_id.is_empty() || model_id.contains('/') || model_id.contains("..") {
        return Err(Error::Other("非法的 model_id".into()));
    }
    let dir = tts_root(data_dir).join("models").join(model_id);
    if !dir.is_dir() {
        return Err(Error::Other("模型不存在".into()));
    }
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

struct StagingGuard<'a>(&'a Path);
impl Drop for StagingGuard<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0);
    }
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_resolution() {
        let gh = TtsSource { mode: "github".into(), custom_manifest_url: String::new() };
        assert_eq!(manifest_url_for(&gh), DEFAULT_TTS_MANIFEST_URL);
        let gp = TtsSource { mode: "ghproxy".into(), custom_manifest_url: String::new() };
        assert_eq!(manifest_url_for(&gp), format!("{GHPROXY_PREFIX}{DEFAULT_TTS_MANIFEST_URL}"));
        let resolved = resolve_model_url(&gp, DEFAULT_TTS_MANIFEST_URL, "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/x.tar.bz2");
        assert!(resolved.starts_with(GHPROXY_PREFIX));
        // 非 github 地址不加前缀
        let other = resolve_model_url(&gp, DEFAULT_TTS_MANIFEST_URL, "https://example.com/x.tar.bz2");
        assert_eq!(other, "https://example.com/x.tar.bz2");
        // 直连模式不动 URL
        let direct = resolve_model_url(&gh, DEFAULT_TTS_MANIFEST_URL, "https://github.com/a/b");
        assert_eq!(direct, "https://github.com/a/b");
    }

    #[test]
    fn in_use_lifecycle() {
        assert_eq!(acquire("test-model"), 1);
        assert_eq!(acquire("test-model"), 2);
        assert_eq!(in_use_count("test-model"), 2);
        assert_eq!(release("test-model"), 1);
        assert_eq!(release("test-model"), 0);
        assert_eq!(in_use_count("test-model"), 0);
    }
}

#[cfg(test)]
mod send_checks {
    #[test]
    fn types_are_send() {
        fn assert_send<T: Send>() {}
        assert_send::<crate::settings::TtsSettings>();
        assert_send::<super::TtsManifest>();
        assert_send::<super::TtsModelEntry>();
    }
}
