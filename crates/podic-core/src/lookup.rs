//! 词条查询：精确 → 屈折变体 → FTS 模糊 → 前缀 → 中文反查，五级合并。
//! 每个 ATTACH 的包是一个 schema（en/fr/ja），SQL 里的 schema 名已校验为小写字母。

use crate::error::Error;
use crate::Result;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub lang: String,
    pub entry_id: i64,
    pub headword: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipa: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    pub freq: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub senses: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
    pub matched_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SuggestItem {
    pub lang: String,
    pub headword: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sentence {
    pub id: i64,
    pub text: String,
    pub translation: Value,
}

const SELECT_ENTRY: &str =
    "e.id, e.headword, e.reading, e.ipa, e.pos, e.gender, e.freq, e.senses, e.extra";

fn parse_json(s: Option<String>) -> Option<Value> {
    s.and_then(|v| serde_json::from_str(&v).ok())
}

fn row_to_entry(lang: &str, matched_by: &str, rule: Option<String>, row: &rusqlite::Row) -> rusqlite::Result<Entry> {
    Ok(Entry {
        lang: lang.to_string(),
        entry_id: row.get(0)?,
        headword: row.get(1)?,
        reading: row.get(2)?,
        ipa: parse_json(row.get(3)?),
        pos: parse_json(row.get(4)?),
        gender: row.get(5)?,
        freq: row.get(6)?,
        senses: parse_json(row.get(7)?),
        extra: parse_json(row.get(8)?),
        matched_by: matched_by.to_string(),
        rule,
    })
}

fn check_lang(lang: &str) -> Result<()> {
    if lang.is_empty() || !lang.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(Error::Other(format!("非法 lang: {lang}")));
    }
    Ok(())
}

/// FTS5 MATCH 查询词转义为短语
fn fts_escape(q: &str) -> String {
    format!("\"{}\"", q.replace('"', "\"\""))
}

/// 用户词典（AI 补录）条目转 Entry：负 id 避免与包内 id 撞 seen 键
fn user_entry(ud: &crate::store::UserDictEntry) -> Entry {
    let mut extra = serde_json::Map::new();
    extra.insert("source".into(), Value::String(ud.source.clone()));
    if let Some(m) = &ud.model {
        extra.insert("model".into(), Value::String(m.clone()));
    }
    Entry {
        lang: ud.lang.clone(),
        entry_id: -ud.id,
        headword: ud.headword.clone(),
        reading: ud.reading.clone(),
        ipa: None,
        pos: parse_json(ud.pos.clone()),
        gender: None,
        freq: 0.0,
        senses: parse_json(Some(ud.senses.clone())),
        extra: Some(Value::Object(extra)),
        matched_by: "user".into(),
        rule: None,
    }
}

pub fn lookup(conn: &Connection, langs: &[String], query: &str, limit: usize) -> Result<Vec<Entry>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let limit = limit.clamp(1, 100);
    // (matched_by 优先级, freq 降序) 排序用的桶
    let mut out: Vec<Entry> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let has_cjk = q.chars().any(|c| {
        matches!(c as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF | 0x3040..=0x30FF)
    });

    for lang in langs {
        check_lang(lang)?;
        let norm_q = crate::norm::norm(q, lang);
        // 日语促音容错：にっほん 也应命中 にほん（构建时已为含 っ 的读音生成脱落变体）
        let candidates: Vec<String> = if lang == "ja" && norm_q.contains('っ') {
            vec![norm_q.clone(), norm_q.replace('っ', "")]
        } else {
            vec![norm_q.clone()]
        };

        // ① norm 精确 + ② form 屈折精确 + ②' user_dict（AI 补录）
        for cand in &candidates {
            let sql = format!("SELECT {SELECT_ENTRY} FROM {lang}.entry e WHERE e.norm = ?1");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![cand], |r| row_to_entry(lang, "exact", None, r))?;
            for r in rows {
                let e = r?;
                if seen.insert((lang.clone(), e.entry_id)) {
                    out.push(e);
                }
            }

            let sql = format!(
                "SELECT {SELECT_ENTRY}, f.rule FROM {lang}.form f JOIN {lang}.entry e ON e.id = f.entry_id \
                 WHERE f.form_norm = ?1 ORDER BY e.freq DESC"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![cand], |r| {
                let rule: Option<String> = r.get(9)?;
                row_to_entry(lang, "form", rule, r)
            })?;
            for r in rows {
                let e = r?;
                if seen.insert((lang.clone(), e.entry_id)) {
                    out.push(e);
                }
            }

            // 用户词典命中（norm 精确 + form 镜像）。包优先去重：仅当包里已有该 headword
            // 且本次查询确实能经包解析到它（surface 就是它，或包 form 把 surface 指到它）时跳过；
            // 包缺该屈折形时保留 user 词条——这正是 AI 补全的价值所在
            let pack_covers = |ud_norm: &str| -> Result<bool> {
                let sql = format!(
                    "SELECT EXISTS(SELECT 1 FROM {lang}.entry e WHERE e.norm = ?1 \
                     AND (e.norm = ?2 OR EXISTS(SELECT 1 FROM {lang}.form f WHERE f.form_norm = ?2 AND f.entry_id = e.id)))"
                );
                Ok(conn.query_row(&sql, rusqlite::params![ud_norm, cand], |r| r.get::<_, i64>(0))? == 1)
            };
            for src in [
                crate::store::user_dict_by_norm(conn, lang, cand)?,
                crate::store::user_dict_by_form(conn, lang, cand)?,
            ]
            .into_iter()
            .flatten()
            {
                if seen.insert((lang.clone(), -src.id)) && !pack_covers(&src.norm)? {
                    out.push(user_entry(&src));
                }
            }
        }

        // ③ FTS 模糊（多词查询主要命中 zh_text / headword）
        if q.chars().count() >= 2 {
            let sql = format!(
                "SELECT {SELECT_ENTRY} FROM {lang}.entry_fts fts JOIN {lang}.entry e ON e.id = fts.rowid \
                 WHERE entry_fts MATCH ?1 ORDER BY rank LIMIT ?2"
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                if let Ok(rows) = stmt.query_map(rusqlite::params![fts_escape(q), limit as i64], |r| {
                    row_to_entry(lang, "fts", None, r)
                }) {
                    for r in rows.flatten() {
                        if seen.insert((lang.clone(), r.entry_id)) {
                            out.push(r);
                        }
                    }
                }
            }
        }

        // ④ 前缀（利用 idx_entry_norm 的索引范围扫描）
        let upper = format!("{}\u{10FFFF}", crate::norm::norm(q, lang));
        let sql = format!(
            "SELECT {SELECT_ENTRY} FROM {lang}.entry e WHERE e.norm >= ?1 AND e.norm < ?2 ORDER BY e.freq DESC LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![norm_q, upper, limit as i64],
            |r| row_to_entry(lang, "prefix", None, r),
        )?;
        for r in rows {
            let e = r?;
            if seen.insert((lang.clone(), e.entry_id)) {
                out.push(e);
            }
        }

        // ⑤ 中文反查索引（查询含 CJK 时）
        if has_cjk {
            let term = crate::norm::zh_term_norm(q);
            let sql = format!(
                "SELECT {SELECT_ENTRY} FROM {lang}.zh_index z JOIN {lang}.entry e ON e.id = z.entry_id \
                 WHERE z.term_norm = ?1 ORDER BY e.freq DESC"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![term], |r| row_to_entry(lang, "zh", None, r))?;
            for r in rows {
                let e = r?;
                if seen.insert((lang.clone(), e.entry_id)) {
                    out.push(e);
                }
            }
        }
    }

    const PRIO: &[&str] = &["exact", "form", "user", "fts", "prefix", "zh"];
    out.sort_by(|a, b| {
        let pa = PRIO.iter().position(|m| *m == a.matched_by).unwrap_or(9);
        let pb = PRIO.iter().position(|m| *m == b.matched_by).unwrap_or(9);
        pa.cmp(&pb).then(b.freq.partial_cmp(&a.freq).unwrap_or(std::cmp::Ordering::Equal))
    });
    out.truncate(limit);
    Ok(out)
}

pub fn suggest(conn: &Connection, langs: &[String], prefix: &str, limit: usize) -> Result<Vec<SuggestItem>> {
    let p = prefix.trim();
    if p.is_empty() {
        return Ok(vec![]);
    }
    let limit = limit.clamp(1, 20);
    let mut out = vec![];
    for lang in langs {
        check_lang(lang)?;
        let lower = crate::norm::norm(p, lang);
        let upper = format!("{lower}\u{10FFFF}");
        let sql = format!(
            "SELECT e.headword, e.reading FROM {lang}.entry e \
             WHERE e.norm >= ?1 AND e.norm < ?2 ORDER BY e.freq DESC LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![lower, upper, limit as i64], |r| {
            Ok(SuggestItem { lang: lang.to_string(), headword: r.get(0)?, reading: r.get(1)? })
        })?;
        out.extend(rows.flatten());
        // 用户词典并入联想（表小，UNIQUE(lang,norm) 索引范围扫描）
        let sql = "SELECT headword, reading FROM user_dict WHERE lang = ?1 AND norm >= ?2 AND norm < ?3 LIMIT 5";
        if let Ok(mut stmt) = conn.prepare(sql) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![lang, lower, upper], |r| {
                Ok(SuggestItem { lang: lang.to_string(), headword: r.get(0)?, reading: r.get(1)? })
            }) {
                out.extend(rows.flatten());
            }
        }
    }
    Ok(out)
}

/// 中文反查：zh_index 精确 + FTS zh_text 模糊
pub fn reverse(conn: &Connection, langs: &[String], term: &str, limit: usize) -> Result<Vec<Entry>> {
    let q = term.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let limit = limit.clamp(1, 100);
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for lang in langs {
        check_lang(lang)?;
        let t = crate::norm::zh_term_norm(q);
        let sql = format!(
            "SELECT {SELECT_ENTRY} FROM {lang}.zh_index z JOIN {lang}.entry e ON e.id = z.entry_id \
             WHERE z.term_norm = ?1 ORDER BY e.freq DESC LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![t, limit as i64], |r| row_to_entry(lang, "zh", None, r))?;
        for r in rows.flatten() {
            if seen.insert((lang.clone(), r.entry_id)) {
                out.push(r);
            }
        }
        // FTS 兜底（连续汉字整 token 命中）
        let sql = format!(
            "SELECT {SELECT_ENTRY} FROM {lang}.entry_fts fts JOIN {lang}.entry e ON e.id = fts.rowid \
             WHERE entry_fts MATCH ?1 ORDER BY rank LIMIT ?2"
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![fts_escape(q), limit as i64], |r| {
                row_to_entry(lang, "zh-fts", None, r)
            }) {
                for r in rows.flatten() {
                    if seen.insert((lang.clone(), r.entry_id)) {
                        out.push(r);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| {
        let pa = if a.matched_by == "zh" { 0 } else { 1 };
        let pb = if b.matched_by == "zh" { 0 } else { 1 };
        pa.cmp(&pb).then(b.freq.partial_cmp(&a.freq).unwrap_or(std::cmp::Ordering::Equal))
    });
    out.truncate(limit);
    Ok(out)
}

pub fn examples(conn: &Connection, lang: &str, entry_id: i64, limit: usize) -> Result<Vec<Sentence>> {
    check_lang(lang)?;
    let limit = limit.clamp(1, 20);
    let sql = format!(
        "SELECT s.id, s.text, s.translation FROM {lang}.entry_sentence es \
         JOIN {lang}.sentence s ON s.id = es.sentence_id \
         WHERE es.entry_id = ?1 ORDER BY es.score DESC LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![entry_id, limit as i64], |r| {
        Ok(Sentence {
            id: r.get(0)?,
            text: r.get(1)?,
            translation: parse_json(r.get(2)?).unwrap_or(Value::Array(vec![])),
        })
    })?;
    Ok(rows.flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 内存库 + init_app_db（user_dict 在 main）+ ATTACH 一个最小 en 包 schema
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::store::init_app_db(&conn).unwrap();
        conn.execute("ATTACH ':memory:' AS en", []).unwrap();
        conn.execute_batch(
            "CREATE TABLE en.entry(id INTEGER PRIMARY KEY, norm TEXT NOT NULL, headword TEXT NOT NULL,
                reading TEXT, ipa TEXT, pos TEXT, gender TEXT, freq REAL NOT NULL DEFAULT 0, senses TEXT, extra TEXT);
             CREATE TABLE en.form(form_norm TEXT NOT NULL, entry_id INTEGER NOT NULL, rule TEXT);",
        )
        .unwrap();
        conn
    }

    fn insert_entry(conn: &Connection, norm: &str, headword: &str, freq: f64) {
        conn.execute(
            "INSERT INTO en.entry(norm, headword, freq) VALUES (?1, ?2, ?3)",
            rusqlite::params![norm, headword, freq],
        )
        .unwrap();
    }

    fn upsert_ud(conn: &Connection, headword: &str, senses: &str, alt_norm: Option<&str>) {
        crate::store::user_dict_upsert(conn, "en", headword, None, None, senses, "ai", None, alt_norm, None)
            .unwrap();
    }

    #[test]
    fn user_dict_hit_ranked_above_prefix() {
        let conn = fixture();
        upsert_ud(&conn, "blorp", r#"[{"pos":["n."],"zh":"测试词"}]"#, None);
        insert_entry(&conn, "blorpish", "blorpish", 50.0);
        let langs = vec!["en".to_string()];

        let items = lookup(&conn, &langs, "blorp", 20).unwrap();
        assert_eq!(items[0].matched_by, "user");
        assert!(items[0].entry_id < 0);
        assert_eq!(items[0].senses.as_ref().unwrap()[0]["zh"], "测试词");
        assert_eq!(items[1].matched_by, "prefix");

        // suggest 联想并入用户词典
        let s = suggest(&conn, &langs, "blor", 10).unwrap();
        assert!(s.iter().any(|x| x.headword == "blorp"));
    }

    #[test]
    fn pack_entry_shadows_dup_user_dict() {
        let conn = fixture();
        insert_entry(&conn, "manger", "manger", 100.0);
        // AI 补录 manger（包里已有）+ 屈折镜像 mangeait
        upsert_ud(&conn, "manger", r#"[{"pos":["v."],"zh":"吃"}]"#, Some("mangeait"));
        let langs = vec!["en".to_string()];

        // surface 原形：包 exact 命中，user 平行弱词条被去重
        let items = lookup(&conn, &langs, "manger", 20).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].entry_id > 0);

        // 包缺 mangeait 这条屈折形：user 词条（form 镜像）应保留——AI 补全的价值所在
        let items = lookup(&conn, &langs, "mangeait", 20).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].matched_by, "user");
        assert_eq!(items[0].headword, "manger");

        // 包补上该屈折形后：user 被去重，只剩包词条
        conn.execute("INSERT INTO en.form(form_norm, entry_id, rule) VALUES ('mangeait', 1, 'impf')", [])
            .unwrap();
        let items = lookup(&conn, &langs, "mangeait", 20).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].matched_by, "form");
    }
}
