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
    /// 首义摘要：候选列表直接可读（同历史项的 gloss 位）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gloss: Option<String>,
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

pub(crate) fn check_lang(lang: &str) -> Result<()> {
    if lang.is_empty() || !lang.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(Error::Other(format!("非法 lang: {lang}")));
    }
    Ok(())
}

/// FTS5 MATCH 查询词转义为短语
fn fts_escape(q: &str) -> String {
    format!("\"{}\"", q.replace('"', "\"\""))
}

/// 命中等级（升序）：exact 与 reading 同档——日语假名读音是词的等价叫法而非屈折变形
fn match_level(mb: &str) -> u8 {
    match mb {
        "exact" | "reading" => 0,
        "form" => 1,
        "user" => 2,
        "fts" => 3,
        "prefix" => 4,
        "zh" => 5,
        _ => 6,
    }
}

/// 去重入桶：同一词条多路命中时保留等级最高的一条（先到不一定最强——
/// 同一 entry 可能先被屈折 form 命中、后被读音 reading 命中）
fn push_best(
    out: &mut Vec<Entry>,
    idx_of: &mut std::collections::HashMap<(String, i64), usize>,
    e: Entry,
) {
    let key = (e.lang.clone(), e.entry_id);
    match idx_of.get(&key) {
        Some(&i) => {
            if match_level(&e.matched_by) < match_level(&out[i].matched_by) {
                out[i] = e;
            }
        }
        None => {
            idx_of.insert(key, out.len());
            out.push(e);
        }
    }
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

pub fn lookup(
    conn: &Connection,
    installed: &[String],
    langs: &[String],
    query: &str,
    limit: usize,
    exact_only: bool,
) -> Result<Vec<Entry>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let limit = limit.clamp(1, 100);
    // (命中等级, freq 降序) 排序用的桶；idx_of 支持同一词条多路命中保最强
    let mut out: Vec<Entry> = Vec::new();
    let mut idx_of: std::collections::HashMap<(String, i64), usize> = std::collections::HashMap::new();

    let has_cjk = q.chars().any(|c| {
        matches!(c as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF | 0x3040..=0x30FF)
    });

    for lang in langs {
        check_lang(lang)?;
        // 无包语言（自定义语言）：跳过全部包 SQL，只走 user_dict 命中——
        // 搭配前端 miss → AI complete → 入库 → 重查命中 matched_by:"user" 的补全闭环
        let has_pack = installed.iter().any(|l| l == lang);
        let norm_q = crate::norm::norm(q, lang);
        // 包能力标记：新构建的日语包把真实读音(rule=reading)与促音容错(rule=reading-approx)
        // 分开；旧包（0.1.2 及以前）两类混在 reading 里，只有命中主读音的才敢提权
        let ja_reading2 = lang == "ja"
            && has_pack
            && conn.query_row(
                &format!("SELECT value FROM \"{lang}\".meta WHERE key = 'ja_reading_rules'"),
                [],
                |r| r.get::<_, String>(0),
            ).map(|v| v == "2").unwrap_or(false);
        // 日语促音容错：にっほん 也应命中 にほん（构建时已为含 っ 的读音生成脱落变体）。
        // approx 标记的候选命中一律算容错级（form），不冒充精确/读音
        let candidates: Vec<(String, bool)> = if lang == "ja" && norm_q.contains('っ') {
            vec![(norm_q.clone(), false), (norm_q.replace('っ', ""), true)]
        } else {
            vec![(norm_q.clone(), false)]
        };

        // ① norm 精确 + ② form 屈折精确（日语读音命中提为 reading 档）+ ②' user_dict（AI 补录）。
        // schema 名统一双引号：支持 `is` 这类 SQL 关键字语言码（ATTACH 处同）
        for (cand, approx) in &candidates {
            if has_pack {
                let sql = format!("SELECT {SELECT_ENTRY} FROM \"{lang}\".entry e WHERE e.norm = ?1");
                let mut stmt = conn.prepare(&sql)?;
                let mb = if *approx { "form" } else { "exact" };
                let rule = if *approx { Some("sokuon".to_string()) } else { None };
                let rows = stmt.query_map(rusqlite::params![cand], |r| row_to_entry(lang, mb, rule.clone(), r))?;
                for r in rows {
                    let e = r?;
                    push_best(&mut out, &mut idx_of, e);
                }

                let sql = format!(
                    "SELECT {SELECT_ENTRY}, f.rule FROM \"{lang}\".form f JOIN \"{lang}\".entry e ON e.id = f.entry_id \
                     WHERE f.form_norm = ?1 ORDER BY e.freq DESC"
                );
                let mut stmt = conn.prepare(&sql)?;
                let cand2 = cand.clone();
                let rows = stmt.query_map(rusqlite::params![cand], move |r| {
                    let rule: Option<String> = r.get(9)?;
                    // 日语读音命中（rule=reading）：假名是词的读法、同音多词条是常态，
                    // 视作精确级 matched_by="reading"（前端展示读音匹配组，不出 AI 补全提示）。
                    // 旧包无能力标记时只有命中主读音的提权，次读音保守按屈折处理
                    let (mb, rule_out) = if *approx {
                        // 促音脱落候选命中：一律容错级，rule 覆盖为 sokuon（原始规则此时无意义）
                        ("form", Some("sokuon".into()))
                    } else if lang == "ja" && rule.as_deref() == Some("reading") {
                        let main = r.get::<_, Option<String>>(2)?
                            .map(|s| crate::norm::norm(&s, "ja"));
                        if ja_reading2 || main.as_deref() == Some(cand2.as_str()) {
                            ("reading", rule)
                        } else {
                            ("form", rule)
                        }
                    } else {
                        ("form", rule)
                    };
                    row_to_entry(lang, mb, rule_out, r)
                })?;
                for r in rows {
                    let e = r?;
                    push_best(&mut out, &mut idx_of, e);
                }
            }

            // 用户词典命中（norm 精确 + form 镜像）。包优先去重：仅当包里已有该 headword
            // 且本次查询确实能经包解析到它（surface 就是它，或包 form 把 surface 指到它）时跳过；
            // 包缺该屈折形时保留 user 词条——这正是 AI 补全的价值所在（无包语言恒保留）
            let pack_covers = |ud_norm: &str| -> Result<bool> {
                if !has_pack {
                    return Ok(false);
                }
                let sql = format!(
                    "SELECT EXISTS(SELECT 1 FROM \"{lang}\".entry e WHERE e.norm = ?1 \
                     AND (e.norm = ?2 OR EXISTS(SELECT 1 FROM \"{lang}\".form f WHERE f.form_norm = ?2 AND f.entry_id = e.id)))"
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
                let key = (lang.clone(), -src.id);
                if !idx_of.contains_key(&key) && !pack_covers(&src.norm)? {
                    idx_of.insert(key, out.len());
                    out.push(user_entry(&src));
                }
            }
        }

        if !has_pack {
            continue; // ③④⑤ 全是包 SQL，无包语言到此为止
        }

        // ③④⑤ 模糊扩散：候选词选定/历史点击的精确查询（exact_only）跳过，
        // 只保留 ①exact ②form ②'user'——用户选了 danke 就只看 danke，不捎带 dankend/Dankeschön
        // ③ FTS 模糊（多词查询主要命中 zh_text / headword）
        if !exact_only && q.chars().count() >= 2 {
            let sql = format!(
                "SELECT {SELECT_ENTRY} FROM \"{lang}\".entry_fts fts JOIN \"{lang}\".entry e ON e.id = fts.rowid \
                 WHERE entry_fts MATCH ?1 ORDER BY rank LIMIT ?2"
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                if let Ok(rows) = stmt.query_map(rusqlite::params![fts_escape(q), limit as i64], |r| {
                    row_to_entry(lang, "fts", None, r)
                }) {
                    for r in rows.flatten() {
                        push_best(&mut out, &mut idx_of, r);
                    }
                }
            }
        }

        // ④ 前缀（利用 idx_entry_norm 的索引范围扫描）
        if exact_only {
            continue; // 精确模式：①② 已完成，③④⑤ 跳过
        }
        let upper = format!("{}\u{10FFFF}", crate::norm::norm(q, lang));
        let sql = format!(
            "SELECT {SELECT_ENTRY} FROM \"{lang}\".entry e WHERE e.norm >= ?1 AND e.norm < ?2 ORDER BY e.freq DESC LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![norm_q, upper, limit as i64],
            |r| row_to_entry(lang, "prefix", None, r),
        )?;
        for r in rows {
            let e = r?;
            push_best(&mut out, &mut idx_of, e);
        }

        // ⑤ 中文反查索引（查询含 CJK 时）
        if has_cjk {
            let term = crate::norm::zh_term_norm(q);
            let sql = format!(
                "SELECT {SELECT_ENTRY} FROM \"{lang}\".zh_index z JOIN \"{lang}\".entry e ON e.id = z.entry_id \
                 WHERE z.term_norm = ?1 ORDER BY e.freq DESC"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![term], |r| row_to_entry(lang, "zh", None, r))?;
            for r in rows {
                let e = r?;
                push_best(&mut out, &mut idx_of, e);
            }
        }
    }

    out.sort_by(|a, b| {
        match_level(&a.matched_by)
            .cmp(&match_level(&b.matched_by))
            .then(b.freq.partial_cmp(&a.freq).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.headword.cmp(&b.headword))
            .then_with(|| a.entry_id.cmp(&b.entry_id))
    });
    out.truncate(limit);
    Ok(out)
}

pub fn suggest(
    conn: &Connection,
    installed: &[String],
    langs: &[String],
    prefix: &str,
    limit: usize,
) -> Result<Vec<SuggestItem>> {
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
        if installed.iter().any(|l| l == lang) {
            // 日语联想并入读音前缀：entry.norm 是汉字词头，只扫它输入假名时候选为空
            // （build_ja 已把各 kana 读音写进 form，rule=reading/reading-approx）。
            // 词头前缀与读音前缀合并去重再截断，完整命中与真实读音排前
            if lang == "ja" {
                // 查询含 っ 时也用脱落形查读音（词条读音含 っ 的方向由包内变体覆盖）
                let mut prefixes = vec![lower.clone()];
                if lower.contains('っ') {
                    let dropped = lower.replace('っ', "");
                    if !dropped.is_empty() {
                        prefixes.push(dropped);
                    }
                }
                let mut ids = std::collections::HashSet::new();
                let mut hits: Vec<(bool, bool, SuggestItem, i64)> = vec![]; // (完整命中, 真实读音, item, id)
                for (pi, pref) in prefixes.iter().enumerate() {
                    let p_upper = format!("{pref}\u{10FFFF}");
                    // 词头前缀
                    let sql = format!(
                        "SELECT e.id, e.headword, e.reading, COALESCE(json_extract(e.senses, '$[0].zh'), json_extract(e.senses, '$[0].fr'), json_extract(e.senses, '$[1].zh')) FROM \"{lang}\".entry e \
                         WHERE e.norm >= ?1 AND e.norm < ?2 ORDER BY e.freq DESC LIMIT ?3"
                    );
                    let mut stmt = conn.prepare(&sql)?;
                    let rows = stmt.query_map(rusqlite::params![pref, p_upper, (limit * 2) as i64], |r| {
                        Ok((r.get::<_, i64>(0)?, SuggestItem { lang: lang.to_string(), headword: r.get(1)?, reading: r.get(2)?, gloss: r.get(3)? }))
                    })?;
                    for (id, item) in rows.flatten() {
                        if ids.insert(id) {
                            hits.push((item.headword == *pref || crate::norm::norm(&item.headword, "ja") == *pref, true, item, id));
                        }
                    }
                    // 读音前缀（真实读音优先于促音容错变体；approx 候选排末位只在名额富余时补）
                    let sql = format!(
                        "SELECT e.id, e.headword, e.reading, COALESCE(json_extract(e.senses, '$[0].zh'), json_extract(e.senses, '$[0].fr'), json_extract(e.senses, '$[1].zh')), \
                                MIN(f.form_norm = ?3), MAX(f.rule = 'reading'), MAX(f.rule = 'reading-approx') \
                         FROM \"{lang}\".form f JOIN \"{lang}\".entry e ON e.id = f.entry_id \
                         WHERE f.form_norm >= ?1 AND f.form_norm < ?2 AND f.rule IN ('reading','reading-approx') \
                         GROUP BY e.id ORDER BY e.freq DESC LIMIT ?4"
                    );
                    let mut stmt = conn.prepare(&sql)?;
                    let rows = stmt.query_map(rusqlite::params![pref, p_upper, pref, (limit * 3) as i64], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            SuggestItem { lang: lang.to_string(), headword: r.get(1)?, reading: r.get(2)?, gloss: r.get(3)? },
                            r.get::<_, i64>(4)? == 1, // 完整读音命中
                            r.get::<_, i64>(5)? == 1, // 真实读音
                        ))
                    })?;
                    for (id, item, full, real) in rows.flatten() {
                        if ids.insert(id) {
                            hits.push((full, real && pi == 0, item, id));
                        }
                    }
                }
                // 完整命中 > 真实读音前缀 > 其他；档内 freq 由 SQL 保证顺序，这里稳定化
                hits.sort_by(|a, b| (b.0.cmp(&a.0)).then(b.1.cmp(&a.1)).then(a.3.cmp(&b.3)));
                hits.truncate(limit);
                out.extend(hits.into_iter().map(|(_, _, item, _)| item));
            } else {
                let sql = format!(
                    "SELECT e.headword, e.reading, COALESCE(json_extract(e.senses, '$[0].zh'), json_extract(e.senses, '$[0].fr'), json_extract(e.senses, '$[1].zh')) FROM \"{lang}\".entry e \
                     WHERE e.norm >= ?1 AND e.norm < ?2 ORDER BY e.freq DESC LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(rusqlite::params![lower, upper, limit as i64], |r| {
                    Ok(SuggestItem { lang: lang.to_string(), headword: r.get(0)?, reading: r.get(1)?, gloss: r.get(2)? })
                })?;
                out.extend(rows.flatten());
            }
        }
        // 用户词典并入联想（表小，UNIQUE(lang,norm) 索引范围扫描；无包语言唯一来源）
        let sql = "SELECT headword, reading, COALESCE(json_extract(senses, '$[0].zh'), json_extract(senses, '$[0].fr')) FROM user_dict WHERE lang = ?1 AND norm >= ?2 AND norm < ?3 LIMIT 5";
        if let Ok(mut stmt) = conn.prepare(sql) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![lang, lower, upper], |r| {
                Ok(SuggestItem { lang: lang.to_string(), headword: r.get(0)?, reading: r.get(1)?, gloss: r.get(2)? })
            }) {
                out.extend(rows.flatten());
            }
        }
    }
    Ok(out)
}

/// 中文反查：zh_index 精确 + FTS zh_text 模糊（纯包索引，无包语言无结果）
pub fn reverse(
    conn: &Connection,
    installed: &[String],
    langs: &[String],
    term: &str,
    limit: usize,
) -> Result<Vec<Entry>> {
    let q = term.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let limit = limit.clamp(1, 100);
    let mut out = vec![];
    let mut idx_of: std::collections::HashMap<(String, i64), usize> = std::collections::HashMap::new();
    for lang in langs {
        check_lang(lang)?;
        if !installed.iter().any(|l| l == lang) {
            continue; // 无包语言没有反查索引
        }
        let t = crate::norm::zh_term_norm(q);
        let sql = format!(
            "SELECT {SELECT_ENTRY} FROM \"{lang}\".zh_index z JOIN \"{lang}\".entry e ON e.id = z.entry_id \
             WHERE z.term_norm = ?1 ORDER BY e.freq DESC LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![t, limit as i64], |r| row_to_entry(lang, "zh", None, r))?;
        for r in rows.flatten() {
            push_best(&mut out, &mut idx_of, r);
        }
        // FTS 兜底（连续汉字整 token 命中）
        let sql = format!(
            "SELECT {SELECT_ENTRY} FROM \"{lang}\".entry_fts fts JOIN \"{lang}\".entry e ON e.id = fts.rowid \
             WHERE entry_fts MATCH ?1 ORDER BY rank LIMIT ?2"
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![fts_escape(q), limit as i64], |r| {
                row_to_entry(lang, "zh-fts", None, r)
            }) {
                for r in rows.flatten() {
                    push_best(&mut out, &mut idx_of, r);
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

pub fn examples(conn: &Connection, installed: &[String], lang: &str, entry_id: i64, limit: usize) -> Result<Vec<Sentence>> {
    check_lang(lang)?;
    if !installed.iter().any(|l| l == lang) {
        return Ok(vec![]); // 无包语言没有例句表
    }
    let limit = limit.clamp(1, 20);
    let sql = format!(
        "SELECT s.id, s.text, s.translation FROM \"{lang}\".entry_sentence es \
         JOIN \"{lang}\".sentence s ON s.id = es.sentence_id \
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

        let items = lookup(&conn, &["en".to_string()], &langs, "blorp", 20, false).unwrap();
        assert_eq!(items[0].matched_by, "user");
        assert!(items[0].entry_id < 0);
        assert_eq!(items[0].senses.as_ref().unwrap()[0]["zh"], "测试词");
        assert_eq!(items[1].matched_by, "prefix");

        // suggest 联想并入用户词典
        let s = suggest(&conn, &["en".to_string()], &langs, "blor", 10).unwrap();
        assert!(s.iter().any(|x| x.headword == "blorp"));
    }

    /// 最小 ja 包夹具：可带 meta（ja_reading_rules=2 表示新构建包，缺省模拟旧包）
    fn ja_fixture(reading_rules2: bool) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::store::init_app_db(&conn).unwrap();
        conn.execute("ATTACH ':memory:' AS ja", []).unwrap();
        conn.execute_batch(
            "CREATE TABLE ja.entry(id INTEGER PRIMARY KEY, norm TEXT NOT NULL, headword TEXT NOT NULL,
                reading TEXT, ipa TEXT, pos TEXT, gender TEXT, freq REAL NOT NULL DEFAULT 0, senses TEXT, extra TEXT);
             CREATE TABLE ja.form(form_norm TEXT NOT NULL, entry_id INTEGER NOT NULL, rule TEXT);
             CREATE TABLE ja.meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE ja.zh_index(term TEXT, term_norm TEXT, entry_id INTEGER NOT NULL);
             CREATE VIRTUAL TABLE ja.entry_fts USING fts5(headword, reading, zh_text);",
        )
        .unwrap();
        if reading_rules2 {
            conn.execute("INSERT INTO ja.meta(key, value) VALUES ('ja_reading_rules', '2')", [])
                .unwrap();
        }
        conn
    }

    fn ja_entry(conn: &Connection, norm: &str, headword: &str, reading: &str) -> i64 {
        conn.execute(
            "INSERT INTO ja.entry(norm, headword, reading, freq) VALUES (?1, ?2, ?3, 1.0)",
            rusqlite::params![norm, headword, reading],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn ja_form(conn: &Connection, form_norm: &str, entry_id: i64, rule: &str) {
        conn.execute(
            "INSERT INTO ja.form(form_norm, entry_id, rule) VALUES (?1, ?2, ?3)",
            rusqlite::params![form_norm, entry_id, rule],
        )
        .unwrap();
    }

    #[test]
    fn ja_读音命中与同音词() {
        // 新包（ja_reading_rules=2）：读音命中提为 reading 档，同音词全部返回
        let conn = ja_fixture(true);
        let d1 = ja_entry(&conn, "駄目", "駄目", "だめ");
        let d2 = ja_entry(&conn, "駄眼", "駄眼", "だめ"); // 同音词
        ja_form(&conn, "だめ", d1, "reading");
        ja_form(&conn, "だめ", d2, "reading");
        let d3 = ja_entry(&conn, "溜息", "溜息", "ため");
        ja_form(&conn, "だめ", d3, "reading-approx"); // 促音容错来源（新包区分开）

        let items = lookup(&conn, &["ja".to_string()], &["ja".to_string()], "だめ", 20, false).unwrap();
        let by_id: Vec<(i64, &str)> = items.iter().map(|e| (e.entry_id, e.matched_by.as_str())).collect();
        assert!(by_id.contains(&(d1, "reading")), "主词条应为 reading 档: {by_id:?}");
        assert!(by_id.contains(&(d2, "reading")), "同音词也应为 reading 档: {by_id:?}");
        assert!(by_id.contains(&(d3, "form")), "促音容错来源不提权: {by_id:?}");
        assert_eq!(items[0].matched_by, "reading");

        // 片假名输入归一后同样命中
        let items = lookup(&conn, &["ja".to_string()], &["ja".to_string()], "ダメ", 20, false).unwrap();
        assert!(items.iter().any(|e| e.entry_id == d1 && e.matched_by == "reading"));

        // 汉字词头查询不受影响
        let items = lookup(&conn, &["ja".to_string()], &["ja".to_string()], "駄目", 20, false).unwrap();
        assert_eq!(items[0].matched_by, "exact");
    }

    #[test]
    fn ja_旧包读音保守提权() {
        // 旧包（无能力标记）：reading 混有促音脱落容错，只有命中主读音的才提权
        let conn = ja_fixture(false);
        let d1 = ja_entry(&conn, "駄目", "駄目", "だめ");
        ja_form(&conn, "だめ", d1, "reading");
        let a1 = ja_entry(&conn, "あっさり", "あっさり", "あっさり");
        ja_form(&conn, "あさり", a1, "reading"); // 旧包：脱落变体也叫 reading

        // だめ = 主读音 → 提权
        let items = lookup(&conn, &["ja".to_string()], &["ja".to_string()], "だめ", 20, false).unwrap();
        assert_eq!(items[0].matched_by, "reading");

        // あさり ≠ 主读音（あっさり）→ 保守按 form（且不能把 あっさり 标成精确）
        let items = lookup(&conn, &["ja".to_string()], &["ja".to_string()], "あさり", 20, false).unwrap();
        assert_eq!(items[0].matched_by, "form");
        assert_eq!(items[0].headword, "あっさり");
    }

    #[test]
    fn ja_促音查询容错不冒充精确() {
        // 查询含 っ：にっほん → にほん(日本读音) 命中算容错级 form，不标 exact/reading
        let conn = ja_fixture(true);
        let n1 = ja_entry(&conn, "日本", "日本", "にほん");
        ja_form(&conn, "にほん", n1, "reading");

        let items = lookup(&conn, &["ja".to_string()], &["ja".to_string()], "にっほん", 20, false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].matched_by, "form");
        assert_eq!(items[0].rule.as_deref(), Some("sokuon"));

        // 纯 っ 查询不炸
        assert!(lookup(&conn, &["ja".to_string()], &["ja".to_string()], "っ", 20, false).unwrap().is_empty());
    }

    #[test]
    fn ja_suggest_读音前缀() {
        let conn = ja_fixture(true);
        let d1 = ja_entry(&conn, "駄目", "駄目", "だめ");
        let d2 = ja_entry(&conn, "駄眼", "駄眼", "だめ");
        ja_form(&conn, "だめ", d1, "reading");
        ja_form(&conn, "だめ", d2, "reading");
        let t1 = ja_entry(&conn, "たこ焼き", "たこ焼き", "たこやき");
        ja_form(&conn, "たこやき", t1, "reading");

        // 输入假名前缀能联想出汉字词条（词头 norm 前缀扫不出来）
        let s = suggest(&conn, &["ja".to_string()], &["ja".to_string()], "だ", 8).unwrap();
        let heads: Vec<&str> = s.iter().map(|i| i.headword.as_str()).collect();
        assert!(heads.contains(&"駄目") && heads.contains(&"駄眼"), "同音词都应出现: {heads:?}");

        // 完整读音命中排最前
        let s = suggest(&conn, &["ja".to_string()], &["ja".to_string()], "だめ", 8).unwrap();
        assert_eq!(s[0].headword, "駄目");

        // limit 截断生效
        let s = suggest(&conn, &["ja".to_string()], &["ja".to_string()], "た", 8).unwrap();
        assert!(s.len() <= 8);
    }

    #[test]
    fn pack_entry_shadows_dup_user_dict() {
        let conn = fixture();
        insert_entry(&conn, "manger", "manger", 100.0);
        // AI 补录 manger（包里已有）+ 屈折镜像 mangeait
        upsert_ud(&conn, "manger", r#"[{"pos":["v."],"zh":"吃"}]"#, Some("mangeait"));
        let langs = vec!["en".to_string()];

        // surface 原形：包 exact 命中，user 平行弱词条被去重
        let items = lookup(&conn, &["en".to_string()], &langs, "manger", 20, false).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].entry_id > 0);

        // 包缺 mangeait 这条屈折形：user 词条（form 镜像）应保留——AI 补全的价值所在
        let items = lookup(&conn, &["en".to_string()], &langs, "mangeait", 20, false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].matched_by, "user");
        assert_eq!(items[0].headword, "manger");

        // 包补上该屈折形后：user 被去重，只剩包词条
        conn.execute("INSERT INTO en.form(form_norm, entry_id, rule) VALUES ('mangeait', 1, 'impf')", [])
            .unwrap();
        let items = lookup(&conn, &["en".to_string()], &langs, "mangeait", 20, false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].matched_by, "form");
    }
}

    #[test]
    fn 无包语言只走_user_dict() {
        // 注册了 de 但没有包：user_dict 命中正常，包级查询不炸
        let conn = Connection::open_in_memory().unwrap();
        crate::store::init_app_db(&conn).unwrap();
        crate::store::user_dict_upsert(
            &conn, "de", "Haus", None, None, r#"[{"pos":["n."],"zh":"房屋"}]"#, "ai", None, None, None,
        )
        .unwrap();
        let installed: Vec<String> = vec![];
        let langs = vec!["de".to_string()];

        let items = lookup(&conn, &installed, &langs, "Haus", 20, false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].matched_by, "user");
        assert_eq!(items[0].headword, "Haus");

        // 联想：user_dict 联想照常，entry 联想跳过不报错
        let s = suggest(&conn, &installed, &langs, "ha", 10).unwrap();
        assert!(s.iter().any(|i| i.headword == "Haus"));

        // 反查/例句：无包返回空
        assert!(reverse(&conn, &installed, &langs, "房屋", 10).unwrap().is_empty());
        assert!(examples(&conn, &installed, "de", -1, 5).unwrap().is_empty());

        // 完全 miss 不报错（前端 FallbackCard 依赖空结果触发 AI 补全）
        assert!(lookup(&conn, &installed, &langs, "nichtda", 20, false).unwrap().is_empty());
    }

    #[test]
    fn sql_关键字语言码可挂载查询() {
        // `is`（冰岛语）是 SQL 关键字：schema 名双引号后 ATTACH/查询都正常
        let conn = Connection::open_in_memory().unwrap();
        crate::store::init_app_db(&conn).unwrap();
        conn.execute_batch("ATTACH ':memory:' AS \"is\"").unwrap();
        conn.execute_batch(
            "CREATE TABLE \"is\".entry(id INTEGER PRIMARY KEY, norm TEXT NOT NULL, headword TEXT NOT NULL,
                reading TEXT, ipa TEXT, pos TEXT, gender TEXT, freq REAL NOT NULL DEFAULT 0, senses TEXT, extra TEXT);
             CREATE TABLE \"is\".form(form_norm TEXT NOT NULL, entry_id INTEGER NOT NULL, rule TEXT);",
        )
        .unwrap();
        conn.execute("INSERT INTO \"is\".entry(norm, headword, freq) VALUES ('hús', 'hús', 1.0)", [])
            .unwrap();
        let installed = vec!["is".to_string()];
        let items = lookup(&conn, &installed, &installed, "hús", 20, false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].matched_by, "exact");
    }
