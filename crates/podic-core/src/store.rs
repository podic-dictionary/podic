//! 应用主库（app.db）：生词本 + AI 结果缓存 + AI 生成内容叠加。

use crate::Result;
use rusqlite::Connection;
use serde::Serialize;

pub fn init_app_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS favorite (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lang TEXT NOT NULL,
            headword TEXT NOT NULL,
            norm TEXT NOT NULL,
            snapshot TEXT,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(lang, norm)
        );
        CREATE TABLE IF NOT EXISTS ai_cache (
            key TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            model TEXT,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS user_overlay (
            lang TEXT NOT NULL,
            headword TEXT NOT NULL,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            model TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (lang, headword, kind)
        );",
    )?;
    Ok(())
}

// ---------------- 生词本 ----------------

#[derive(Debug, Clone, Serialize)]
pub struct Favorite {
    pub id: i64,
    pub lang: String,
    pub headword: String,
    pub norm: String,
    pub snapshot: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
}

pub fn list_favorites(conn: &Connection) -> Result<Vec<Favorite>> {
    let mut stmt = conn.prepare(
        "SELECT id, lang, headword, norm, snapshot, note, created_at FROM favorite ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Favorite {
            id: r.get(0)?,
            lang: r.get(1)?,
            headword: r.get(2)?,
            norm: r.get(3)?,
            snapshot: r.get(4)?,
            note: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

pub fn add_favorite(
    conn: &Connection,
    lang: &str,
    headword: &str,
    norm: &str,
    snapshot: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO favorite(lang, headword, norm, snapshot) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![lang, headword, norm, snapshot],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn remove_favorite(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM favorite WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------- AI 缓存 ----------------

pub fn ai_cache_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT content FROM ai_cache WHERE key = ?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

pub fn ai_cache_put(conn: &Connection, key: &str, kind: &str, model: &str, content: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_cache(key, kind, model, content) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![key, kind, model, content],
    )?;
    Ok(())
}

// ---------------- AI 生成内容叠加（按词条持久化，下次查看直接加载） ----------------

/// 取某词条某类 AI 产出；kind=None 返回全部类别 (kind -> content)
pub fn overlay_get_all(conn: &Connection, lang: &str, headword: &str) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT kind, content, created_at FROM user_overlay WHERE lang = ?1 AND headword = ?2",
    )?;
    let rows = stmt.query_map([lang, headword], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    Ok(rows.flatten().collect())
}

pub fn overlay_put(
    conn: &Connection,
    lang: &str,
    headword: &str,
    kind: &str,
    model: &str,
    content: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO user_overlay(lang, headword, kind, content, model) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![lang, headword, kind, content, model],
    )?;
    Ok(())
}
