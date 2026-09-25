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
        );
        CREATE TABLE IF NOT EXISTS article (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lang TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            tokens_json TEXT NOT NULL,
            char_count INTEGER NOT NULL DEFAULT 0,
            token_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS user_dict (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lang TEXT NOT NULL,
            norm TEXT NOT NULL,
            headword TEXT NOT NULL,
            reading TEXT,
            pos TEXT,
            senses TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'ai',
            model TEXT,
            cache_key TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(lang, norm)
        );
        CREATE TABLE IF NOT EXISTS user_dict_form (
            form_norm TEXT NOT NULL,
            ud_id INTEGER NOT NULL REFERENCES user_dict(id) ON DELETE CASCADE,
            PRIMARY KEY (form_norm, ud_id)
        );
        CREATE INDEX IF NOT EXISTS idx_udf_id ON user_dict_form(ud_id);
        CREATE TABLE IF NOT EXISTS word_status (
            lang TEXT NOT NULL,
            norm TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('known', 'new')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (lang, norm)
        );",
    )?;
    // 迁移：v0.2.3 user_dict 加 cache_key（AI 词典词条记下生成它的缓存行，删词条连带清缓存）。
    // 新库上面 batch 里那条 ALTER 已生效，这里吞掉 duplicate column 错误即可
    let _ = conn.execute("ALTER TABLE user_dict ADD COLUMN cache_key TEXT", []);
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

pub fn ai_cache_delete(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM ai_cache WHERE key = ?1", [key])?;
    Ok(())
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

pub fn overlay_delete(conn: &Connection, lang: &str, headword: &str, kind: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM user_overlay WHERE lang = ?1 AND headword = ?2 AND kind = ?3",
        rusqlite::params![lang, headword, kind],
    )?;
    Ok(())
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

// ---------------- 阅读：文章 ----------------

#[derive(Debug, Clone, Serialize)]
pub struct ArticleMeta {
    pub id: i64,
    pub lang: String,
    pub title: String,
    pub char_count: i64,
    pub token_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArticleFull {
    #[serde(flatten)]
    pub meta: ArticleMeta,
    pub content: String,
    pub tokens_json: String,
}

pub fn insert_article(
    conn: &Connection,
    lang: &str,
    title: &str,
    content: &str,
    tokens_json: &str,
    char_count: i64,
    token_count: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO article(lang, title, content, tokens_json, char_count, token_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![lang, title, content, tokens_json, char_count, token_count],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 文章列表：绝不取 content / tokens_json（单篇可达数 MB）
pub fn list_articles(conn: &Connection) -> Result<Vec<ArticleMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, lang, title, char_count, token_count, created_at FROM article ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ArticleMeta {
            id: r.get(0)?,
            lang: r.get(1)?,
            title: r.get(2)?,
            char_count: r.get(3)?,
            token_count: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

pub fn get_article(conn: &Connection, id: i64) -> Result<Option<ArticleFull>> {
    let mut stmt = conn.prepare(
        "SELECT id, lang, title, char_count, token_count, created_at, content, tokens_json
         FROM article WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map([id], |r| {
        Ok(ArticleFull {
            meta: ArticleMeta {
                id: r.get(0)?,
                lang: r.get(1)?,
                title: r.get(2)?,
                char_count: r.get(3)?,
                token_count: r.get(4)?,
                created_at: r.get(5)?,
            },
            content: r.get(6)?,
            tokens_json: r.get(7)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn delete_article(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM article WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------- 阅读：用户词典（AI 补录，词典扩充源） ----------------

#[derive(Debug, Clone, Serialize)]
pub struct UserDictEntry {
    pub id: i64,
    pub lang: String,
    pub norm: String,
    pub headword: String,
    pub reading: Option<String>,
    /// JSON 数组：["n.", "v."]
    pub pos: Option<String>,
    /// JSON 数组：[{"pos":["v."],"zh":"吃"}]，与 Entry.senses 同构
    pub senses: String,
    pub source: String,
    pub model: Option<String>,
    /// 生成该词条的 ai_cache 行 key（删词条时连带清缓存，防坏内容复活）
    pub cache_key: Option<String>,
    pub created_at: String,
}

const UD_COLS: &str =
    "id, lang, norm, headword, reading, pos, senses, source, model, cache_key, created_at";

fn row_to_ud(r: &rusqlite::Row) -> rusqlite::Result<UserDictEntry> {
    Ok(UserDictEntry {
        id: r.get(0)?,
        lang: r.get(1)?,
        norm: r.get(2)?,
        headword: r.get(3)?,
        reading: r.get(4)?,
        pos: r.get(5)?,
        senses: r.get(6)?,
        source: r.get(7)?,
        model: r.get(8)?,
        cache_key: r.get(9)?,
        created_at: r.get(10)?,
    })
}

/// 幂等 upsert：UNIQUE(lang, norm) 冲突时更新释义。
/// alt_norm = 点词时的 surface norm（与 headword norm 不同时写入 form 镜像，覆盖屈折形）。
/// 返回 (id, created)。
pub fn user_dict_upsert(
    conn: &Connection,
    lang: &str,
    headword: &str,
    reading: Option<&str>,
    pos: Option<&str>,
    senses: &str,
    source: &str,
    model: Option<&str>,
    alt_norm: Option<&str>,
    cache_key: Option<&str>,
) -> Result<(i64, bool)> {
    let norm = crate::norm::norm(headword, lang);
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM user_dict WHERE lang = ?1 AND norm = ?2",
            [lang, &norm],
            |r| r.get(0),
        )
        .ok();
    let created = existing.is_none();
    conn.execute(
        "INSERT INTO user_dict(lang, norm, headword, reading, pos, senses, source, model, cache_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(lang, norm) DO UPDATE SET
           headword = excluded.headword, reading = excluded.reading, pos = excluded.pos,
           senses = excluded.senses, source = excluded.source, model = excluded.model,
           cache_key = excluded.cache_key",
        rusqlite::params![lang, norm, headword, reading, pos, senses, source, model, cache_key],
    )?;
    let id = match existing {
        Some(id) => id,
        None => conn.last_insert_rowid(),
    };
    if let Some(alt) = alt_norm {
        if !alt.is_empty() && alt != norm {
            conn.execute(
                "INSERT OR IGNORE INTO user_dict_form(form_norm, ud_id) VALUES (?1, ?2)",
                [alt, &id.to_string()],
            )?;
        }
    }
    Ok((id, created))
}

pub fn user_dict_by_norm(conn: &Connection, lang: &str, norm: &str) -> Result<Option<UserDictEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {UD_COLS} FROM user_dict WHERE lang = ?1 AND norm = ?2"
    ))?;
    let mut rows = stmt.query_map([lang, norm], row_to_ud)?;
    Ok(rows.next().transpose()?)
}

/// 屈折镜像命中：surface 的 norm 在 form 表里能到原形词条
pub fn user_dict_by_form(conn: &Connection, lang: &str, form_norm: &str) -> Result<Option<UserDictEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {UD_COLS} FROM user_dict ud
         JOIN user_dict_form f ON f.ud_id = ud.id
         WHERE ud.lang = ?1 AND f.form_norm = ?2"
    ))?;
    let mut rows = stmt.query_map([lang, form_norm], row_to_ud)?;
    Ok(rows.next().transpose()?)
}

pub fn list_user_dict(conn: &Connection, lang: Option<&str>, q: &str) -> Result<Vec<UserDictEntry>> {
    let sql = if q.is_empty() {
        format!("SELECT {UD_COLS} FROM user_dict WHERE (?1 IS NULL OR lang = ?1) ORDER BY id DESC")
    } else {
        format!(
            "SELECT {UD_COLS} FROM user_dict
             WHERE (?1 IS NULL OR lang = ?1) AND (headword LIKE '%' || ?2 || '%' OR norm LIKE '%' || ?2 || '%')
             ORDER BY id DESC"
        )
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![lang, q], row_to_ud)?;
    Ok(rows.flatten().collect())
}

pub fn user_dict_get(conn: &Connection, id: i64) -> Result<Option<UserDictEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {UD_COLS} FROM user_dict WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map([id], row_to_ud)?;
    Ok(rows.next().transpose()?)
}

pub fn delete_user_dict(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM user_dict_form WHERE ud_id = ?1", [id])?;
    conn.execute("DELETE FROM user_dict WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------- 阅读：生词/认识标记（键 = token 的 surface norm，全局按 lang+norm 生效） ----------------

pub fn word_status_list(conn: &Connection, lang: &str) -> Result<Vec<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT norm, status FROM word_status WHERE lang = ?1")?;
    let rows = stmt.query_map([lang], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.flatten().collect())
}

/// status=None 表示清除标记
pub fn word_status_set(conn: &Connection, lang: &str, norm: &str, status: Option<&str>) -> Result<()> {
    match status {
        Some(s) => {
            conn.execute(
                "INSERT INTO word_status(lang, norm, status) VALUES (?1, ?2, ?3)
                 ON CONFLICT(lang, norm) DO UPDATE SET status = excluded.status, updated_at = datetime('now')",
                rusqlite::params![lang, norm, s],
            )?;
        }
        None => {
            conn.execute("DELETE FROM word_status WHERE lang = ?1 AND norm = ?2", [lang, norm])?;
        }
    }
    Ok(())
}
