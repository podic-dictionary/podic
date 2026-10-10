//! 词典包管理：发现、校验、ATTACH/DETACH、导入、删除。
//! 词典包 = 单文件 SQLite，schema v1 见 scripts/pipeline/build_pack.py。

use crate::error::Error;
use crate::Result;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct PackInfo {
    pub lang: String,
    pub pack_id: String,
    pub version: String,
    pub built_at: String,
    pub entry_count: i64,
    pub sources: Value,
    pub file_name: String,
}

/// 校验 db 文件是否为合法词典包，返回其 meta（lang 必须是 2-4 个小写字母，供作 SQL schema 名）
/// 版本号比较键："0.2.10" > "0.2.9"（按数字段；非数字段按 0）
fn version_key(v: &str) -> Vec<u64> {
    v.split('.')
        .map(|p| p.split('-').next().unwrap_or("0").parse().unwrap_or(0))
        .collect()
}

pub fn validate(path: &Path) -> Result<(PackInfo, String)> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut map: HashMap<String, String> = HashMap::new();
    let mut stmt = conn.prepare("SELECT key, value FROM meta")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    let get = |k: &str| -> Result<String> {
        map.get(k).cloned().ok_or_else(|| Error::Other(format!("包缺少 meta.{k}")))
    };
    let schema_version: i64 = get("schema_version")?.parse().map_err(|_| Error::Other("schema_version 非法".into()))?;
    if schema_version != SCHEMA_VERSION {
        return Err(Error::Other(format!(
            "包 schema 版本 {schema_version} 与应用支持的 {SCHEMA_VERSION} 不匹配"
        )));
    }
    let lang = get("lang")?;
    if !lang.chars().all(|c| c.is_ascii_lowercase()) || !(2..=4).contains(&lang.len()) {
        return Err(Error::Other(format!("包 lang 非法: {lang}")));
    }
    let info = PackInfo {
        lang: lang.clone(),
        pack_id: get("pack_id")?,
        version: get("version")?,
        built_at: get("built_at")?,
        entry_count: get("entry_count").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
        sources: serde_json::from_str(&get("sources").unwrap_or_else(|_| "[]".into())).unwrap_or(Value::Array(vec![])),
        file_name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    Ok((info, lang))
}

pub struct PackManager {
    packs_dir: PathBuf,
    installed: HashMap<String, PackInfo>, // lang -> info（即已 ATTACH 的）
}

impl PackManager {
    pub fn new(packs_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&packs_dir)?;
        Ok(Self { packs_dir, installed: HashMap::new() })
    }

    pub fn packs_dir(&self) -> &Path {
        &self.packs_dir
    }

    pub fn list(&self) -> Vec<PackInfo> {
        let mut v: Vec<PackInfo> = self.installed.values().cloned().collect();
        v.sort_by(|a, b| a.lang.cmp(&b.lang));
        v
    }

    pub fn get(&self, lang: &str) -> Option<&PackInfo> {
        self.installed.get(lang)
    }

    pub fn langs(&self) -> Vec<String> {
        let mut v: Vec<String> = self.installed.keys().cloned().collect();
        v.sort();
        v
    }

    /// 启动时扫描 packs/ 目录并挂载词典包：**每种语言只挂版本最高的一个**，
    /// 落败的旧版本文件（在线更新/重导入淘汰下来的）直接清理。
    /// read_dir 顺序在不同文件系统上不稳定，不择优的话「旧内置包 + 在线
    /// 更新包」并存时，重启后哪个生效纯看运气
    pub fn scan_and_attach(&mut self, conn: &Connection) -> Result<Vec<PackInfo>> {
        // 一遍收集 (lang, version_key, path)；坏包跳过（不挂也不删）
        let mut found: Vec<(String, Vec<u64>, std::path::PathBuf)> = vec![];
        for entry in std::fs::read_dir(&self.packs_dir)? {
            let path = entry?.path();
            if !path.extension().map(|e| e == "db").unwrap_or(false) {
                continue;
            }
            match validate(&path) {
                Ok((info, lang)) => found.push((lang, version_key(&info.version), path)),
                Err(e) => eprintln!("跳过无效词典包 {}: {e}", path.display()),
            }
        }
        // 每语言版本最高的路径
        let mut best: std::collections::HashMap<&str, &std::path::Path> = std::collections::HashMap::new();
        let mut best_ver: std::collections::HashMap<&str, &[u64]> = std::collections::HashMap::new();
        for (lang, ver, path) in &found {
            match best_ver.get(lang.as_str()) {
                Some(v) if *v > ver.as_slice() => {}
                _ => {
                    best.insert(lang, path);
                    best_ver.insert(lang, ver);
                }
            }
        }
        let mut attached = vec![];
        for (lang, _, path) in &found {
            if best.get(lang.as_str()) != Some(&path.as_path()) {
                let _ = std::fs::remove_file(path); // 同语言落败的旧文件，清理
                continue;
            }
            match self.attach(conn, path) {
                Ok(info) => attached.push(info),
                Err(e) => eprintln!("跳过无效词典包 {}: {e}", path.display()),
            }
        }
        Ok(attached)
    }

    /// ATTACH 一个包文件（若同 lang 已挂载则先 DETACH 替换）
    pub fn attach(&mut self, conn: &Connection, path: &Path) -> Result<PackInfo> {
        let (info, lang) = validate(path)?;
        if self.installed.contains_key(&lang) {
            self.detach(conn, &lang)?;
        }
        // schema 名加引号：支持 `is` 等 SQL 关键字语言码（裸拼会语法错误）
        conn.execute_batch(&format!("ATTACH DATABASE '{}' AS \"{lang}\"", path.to_string_lossy().replace('\'', "''")))?;
        self.installed.insert(lang, info.clone());
        Ok(info)
    }

    pub fn detach(&mut self, conn: &Connection, lang: &str) -> Result<()> {
        if self.installed.remove(lang).is_some() {
            conn.execute_batch(&format!("DETACH DATABASE \"{lang}\""))?;
        }
        Ok(())
    }

    /// 导入上传的 db 字节：写临时文件 -> 校验 -> 落正式文件名 -> ATTACH
    pub fn import(&mut self, conn: &Connection, bytes: &[u8]) -> Result<PackInfo> {
        let tmp = self.packs_dir.join(format!("import-{}.tmp", std::process::id()));
        std::fs::write(&tmp, bytes)?;
        let result = (|| {
            let (info, _lang) = validate(&tmp)?;
            let dest = self.packs_dir.join(format!("{}-{}.db", info.pack_id, info.version));
            if dest.exists() {
                std::fs::remove_file(&dest)?;
            }
            std::fs::rename(&tmp, &dest)?;
            self.attach(conn, &dest)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    pub fn remove(&mut self, conn: &Connection, lang: &str) -> Result<()> {
        let info = self.installed.get(lang).cloned();
        if let Some(info) = info {
            let path = self.packs_dir.join(&info.file_name);
            self.detach(conn, lang)?;
            std::fs::remove_file(path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小合法包：只有 meta 表（scan/attach 不读词条表）
    fn mini_pack(dir: &std::path::Path, lang: &str, version: &str) -> std::path::PathBuf {
        let path = dir.join(format!("{lang}-dict-{version}.db"));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        conn.execute(
            "INSERT INTO meta VALUES('schema_version','1'),('lang',?1),('pack_id',?2),('version',?3),('built_at','test')",
            rusqlite::params![lang, format!("{lang}-dict"), version],
        )
        .unwrap();
        conn.execute("UPDATE meta SET value = ?1 WHERE key = 'version'", [version])
            .unwrap();
        conn.close().unwrap();
        path
    }

    /// 同语言多版本并存（旧内置 + 在线更新）：只挂版本最高的，落败文件被清理
    #[test]
    fn scan_picks_latest_version_per_lang_and_prunes_losers() {
        let dir = std::env::temp_dir().join(format!("podic-packs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir); // 重跑残留
        std::fs::create_dir_all(&dir).unwrap();
        let old = mini_pack(&dir, "fr", "0.1.0");
        let new = mini_pack(&dir, "fr", "0.2.0");
        let en = mini_pack(&dir, "en", "0.1.0"); // 其他语言不受影响

        let mut packs = PackManager::new(dir.clone()).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let attached = packs.scan_and_attach(&conn).unwrap();

        assert_eq!(attached.len(), 2);
        let fr = attached.iter().find(|i| i.lang == "fr").unwrap();
        assert_eq!(fr.version, "0.2.0");
        assert!(!old.exists(), "落败旧版本应被清理");
        assert!(new.exists() && en.exists(), "胜出者与其他语言保留");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
