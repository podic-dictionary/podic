//! 词典包在线更新：manifest 直链检查 + 下载 + sha256 校验 + 原子替换。
//! manifest 格式见 scripts/pipeline/build_all.sh 产出的 manifest.json。

use crate::error::Error;
use crate::packs::PackInfo;
use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackUpdate {
    pub lang: String,
    pub pack_id: String,
    pub current_version: String,
    pub latest_version: String,
    /// .db.gz 下载地址
    pub url: String,
    /// 解压后 .db 的 sha256
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    pub file: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default = "default_schema_version")]
    _schema_version: i64,
    #[serde(default)]
    packs: Vec<ManifestPack>,
}

fn default_schema_version() -> i64 {
    1
}

#[derive(Debug, Deserialize)]
struct ManifestPack {
    lang: String,
    pack_id: String,
    version: String,
    file: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    size: u64,
}

/// 简单版本比较：按数字段比较，"0.2.0" > "0.1.9"
fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| p.split('-').next().unwrap_or("0").parse().unwrap_or(0))
            .collect()
    };
    let (va, vb) = (parse(a), parse(b));
    for i in 0..va.len().max(vb.len()) {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

pub async fn check_updates(manifest_url: &str, installed: &[PackInfo]) -> Result<Vec<PackUpdate>> {
    if manifest_url.is_empty() {
        return Ok(vec![]);
    }
    let http = reqwest::Client::new();
    let resp = http.get(manifest_url).send().await?;
    if !resp.status().is_success() {
        return Err(Error::Other(format!("获取 manifest 失败: {}", resp.status())));
    }
    let manifest: Manifest = serde_json::from_str(&resp.text().await?)?;

    let mut out = vec![];
    for p in &manifest.packs {
        let current = installed
            .iter()
            .find(|i| i.lang == p.lang)
            .map(|i| i.version.clone());
        let Some(current_version) = current else {
            continue; // 未安装的包不提示（避免误导新用户全量下载）
        };
        if !version_gt(&p.version, &current_version) {
            continue;
        }
        let url = match &p.url {
            Some(u) => u.clone(),
            None => {
                // manifest 放在 releases/latest/download/ 下时，构造同目录直链
                match manifest_url.rsplit_once('/') {
                    Some((base, _)) if base.ends_with("releases/latest/download") => {
                        format!("{base}/{}", p.file)
                    }
                    _ => {
                        // 同目录相对链接
                        match manifest_url.rsplit_once('/') {
                            Some((base, _)) => format!("{base}/{}", p.file),
                            None => continue,
                        }
                    }
                }
            }
        };
        out.push(PackUpdate {
            lang: p.lang.clone(),
            pack_id: p.pack_id.clone(),
            current_version,
            latest_version: p.version.clone(),
            url,
            sha256: p.sha256.clone().unwrap_or_default(),
            size: p.size,
            file: p.file.clone(),
        });
    }
    Ok(out)
}

/// 下载进度事件
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub phase: String, // download | extract | verify
    pub downloaded: u64,
    pub total: u64,
}

/// 下载 .db.gz -> 解压 -> sha256 校验 -> 原子落盘到 dest。
/// 返回 (dest, 解压后字节数)。
pub async fn download_and_verify(
    url: &str,
    sha256_expected: &str,
    dest: &Path,
    stop: Arc<AtomicBool>,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<u64> {
    let http = reqwest::Client::new();
    let resp = http.get(url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);

    // 下载到临时 .gz
    let tmp_gz = dest.with_extension("db.gz.part");
    let mut file = std::fs::File::create(&tmp_gz)?;
    let mut hasher = Sha256::new(); // 对 .gz 内容（仅作下载完整性参考）
    let mut downloaded: u64 = 0;
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await? {
        if stop.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&tmp_gz);
            return Err(Error::Other("已取消".into()));
        }
        std::io::copy(&mut &chunk[..], &mut file)?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        on_progress(DownloadProgress {
            phase: "download".into(),
            downloaded,
            total,
        });
    }
    drop(file);

    // 解压
    on_progress(DownloadProgress { phase: "extract".into(), downloaded, total });
    let tmp_db = dest.with_extension("db.part");
    let gz = std::fs::File::open(&tmp_gz)?;
    let mut decoder = flate2::read::GzDecoder::new(gz);
    let mut out = std::fs::File::create(&tmp_db)?;
    std::io::copy(&mut decoder, &mut out)?;
    drop(out);
    let _ = std::fs::remove_file(&tmp_gz);

    // 校验解压后 db 的 sha256
    on_progress(DownloadProgress { phase: "verify".into(), downloaded, total });
    if !sha256_expected.is_empty() {
        let mut file = std::fs::File::open(&tmp_db)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        let got = format!("{:x}", h.finalize());
        if got != sha256_expected {
            let _ = std::fs::remove_file(&tmp_db);
            return Err(Error::Other(format!(
                "sha256 校验失败：期望 {sha256_expected}，实际 {got}"
            )));
        }
    }

    // 原子替换
    std::fs::rename(&tmp_db, dest)?;
    Ok(dest.metadata()?.len())
}

#[cfg(test)]
mod tests {
    use super::version_gt;

    #[test]
    fn version_compare() {
        assert!(version_gt("0.2.0", "0.1.9"));
        assert!(version_gt("1.0.0", "0.9.9"));
        assert!(!version_gt("0.1.0", "0.1.0"));
        assert!(!version_gt("0.1.0", "0.2.0"));
    }
}
