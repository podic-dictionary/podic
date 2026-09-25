//! 阅读器分词：粘贴的文章一次性切成 token（段落 → [Token]），前端零分词成本。
//!
//! - en/fr：按 Unicode 字母收词，词内允许撇号/连字符（折叠弯引号后），CJK 连续段判非词
//! - ja：贪婪最长匹配（≤MAX_TOKEN_CHARS）查词表（entry.norm ∪ form.form_norm ∪ user_dict.norm），
//!   全 miss 退单字（norm 照记，点击可触发 AI 补全回流词表）
//!
//! 踩坑：词典包 norm 里的撇号全部是 ASCII `'`（en 1.4 万条、fr 77 条，U+2019 为 0 条），
//! 而 NFKC 不会把 ’(U+2019) 折成 '(U+0027)——分词时必须先折叠（’→'，–/—→-），否则
//! don’t / l’homme 全链路 miss，还会触发 AI 给词典里已有的词建平行弱词条。

use crate::norm::norm;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// ja 贪婪匹配的最大字符数（词表实测最长 norm 22 字符，覆盖 >99.9% 词条）
const MAX_TOKEN_CHARS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    /// 原文表面形（已折叠弯引号/弯连字符）
    pub t: String,
    pub is_word: bool,
    /// 查询键 = norm(t)；非词为空串
    pub norm: String,
    /// 词后是否跟空白（en/fr 排版用；ja 恒 false）
    pub space_after: bool,
}

/// 折叠排版变体字符为词典 norm 口径的 ASCII：’‘→'、‐(U+2010) ‑(U+2011)→-
/// 注意 –(en dash) / —(em dash) 是句读符号，不折叠（否则 well—known 会被错并成一个词）
fn fold(c: char) -> char {
    match c {
        '’' | '‘' => '\'',
        '‐' | '‑' => '-',
        _ => c,
    }
}

/// 词内字符集。调用点都在 fold 之后：’‘已折成 '，‐ ‑已折成 -
fn is_intra_word(c: char) -> bool {
    matches!(c, '\'' | '-')
}

fn is_cjk(c: char) -> bool {
    let cp = c as u32;
    (0x4E00..=0x9FFF).contains(&cp)
        || (0x3400..=0x4DBF).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0x3040..=0x30FF).contains(&cp) // 平假名/片假名（混排在 en/fr 文里时按非词处理）
        || (0xFF66..=0xFF9D).contains(&cp) // 半角片假名
}

/// 是否够格算「词」：含至少一个字母（排除纯数字/标点）
fn wordish(s: &str) -> bool {
    s.chars().any(char::is_alphabetic)
}

/// 单词 token 的 norm；不可查的（纯数字等）返回 None
fn word_norm(t: &str, lang: &str) -> Option<String> {
    if !wordish(t) {
        return None;
    }
    Some(norm(t, lang))
}

pub fn tokenize(lang: &str, text: &str, vocab: Option<&HashSet<String>>) -> Vec<Vec<Token>> {
    let ja = lang == "ja";
    text.split('\n')
        .map(|line| {
            let cs: Vec<char> = line.chars().map(fold).collect();
            let mut toks: Vec<Token> = Vec::new();
            let mut i = 0usize;
            while i < cs.len() {
                let c = cs[i];
                if c.is_whitespace() {
                    if let Some(last) = toks.last_mut() {
                        last.space_after = true;
                    }
                    i += 1;
                    continue;
                }
                if ja {
                    let max = MAX_TOKEN_CHARS.min(cs.len() - i);
                    let mut hit: Option<(usize, String)> = None;
                    for len in (1..=max).rev() {
                        let sub: String = cs[i..i + len].iter().collect();
                        let n = norm(&sub, lang);
                        if vocab.is_some_and(|v| v.contains(&n)) {
                            hit = Some((len, n));
                            break;
                        }
                    }
                    match hit {
                        Some((len, n)) => {
                            toks.push(Token {
                                t: cs[i..i + len].iter().collect(),
                                is_word: true,
                                norm: n,
                                space_after: false,
                            });
                            i += len;
                        }
                        None => {
                            // 单字回退：norm 照记，点击可触发 AI 补全（自愈回流词表）
                            let t: String = cs[i..i + 1].iter().collect();
                            toks.push(Token {
                                space_after: false,
                                is_word: c.is_alphabetic(),
                                norm: word_norm(&t, lang).unwrap_or_default(),
                                t,
                            });
                            i += 1;
                        }
                    }
                    continue;
                }
                // en/fr：CJK 段整段判非词（中英混排时不给 en 词典喂中文 run）
                if is_cjk(c) {
                    let j = i + 1 + cs[i + 1..].iter().take_while(|&&x| is_cjk(x)).count();
                    toks.push(Token {
                        t: cs[i..j].iter().collect(),
                        is_word: false,
                        norm: String::new(),
                        space_after: false,
                    });
                    i = j;
                    continue;
                }
                if c.is_alphanumeric() {
                    // 收词：字母数字 + 词内撇号/连字符（两侧都是字母才算词内）
                    let mut j = i + 1;
                    while j < cs.len() {
                        let x = cs[j];
                        if x.is_alphanumeric() {
                            j += 1;
                        } else if is_intra_word(x)
                            && j > i
                            && j + 1 < cs.len()
                            && (cs[j - 1].is_alphabetic() && cs[j + 1].is_alphabetic())
                        {
                            j += 1;
                        } else {
                            break;
                        }
                    }
                    let t: String = cs[i..j].iter().collect();
                    toks.push(Token {
                        space_after: false,
                        is_word: wordish(&t),
                        norm: word_norm(&t, lang).unwrap_or_default(),
                        t,
                    });
                    i = j;
                    continue;
                }
                // 其余（标点/符号/数字串）：非词 token，原样保留
                let j = i
                    + 1
                    + cs[i + 1..]
                        .iter()
                        .take_while(|c: &&char| !c.is_alphanumeric() && !c.is_whitespace() && !is_cjk(**c))
                        .count();
                toks.push(Token {
                    t: cs[i..j].iter().collect(),
                    is_word: false,
                    norm: String::new(),
                    space_after: false,
                });
                i = j;
            }
            toks
        })
        .collect()
}

/// ja 分词词表：entry.norm ∪ form.form_norm ∪ user_dict.norm（懒构建一次，~53 万 distinct，数百 ms）
pub fn build_vocab(conn: &Connection, lang: &str) -> Result<HashSet<String>, rusqlite::Error> {
    let mut set = HashSet::new();
    // schema 名（{lang}）不能参数化——小写字母校验由 check_lang / 调用方保证；lang 的值走绑定
    let mut stmt = conn.prepare(&format!(
        "SELECT norm FROM {lang}.entry WHERE norm <> ''
         UNION SELECT form_norm FROM {lang}.form WHERE form_norm <> ''
         UNION SELECT norm FROM main.user_dict WHERE lang = ?1 AND norm <> ''"
    ))?;
    let rows = stmt.query_map([lang], |r| r.get::<_, String>(0))?;
    for n in rows.flatten() {
        set.insert(n);
    }
    Ok(set)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn en_folds_smart_quotes_and_hits_norm() {
        // 弯撇号折叠成 ASCII：don’t → don't → norm "don't"
        let ps = tokenize("en", "don’t stop", None);
        assert_eq!(ps[0][0].t, "don't");
        assert_eq!(ps[0][0].norm, "don't");
        assert!(ps[0][0].is_word);
        // em dash 是句读，不折叠、不并词
        let ps = tokenize("en", "well—known", None);
        assert_eq!(ps[0][0].t, "well");
        assert_eq!(ps[0][1].t, "—");
        assert!(!ps[0][1].is_word);
        assert_eq!(ps[0][2].t, "known");
        // 词内连字符保留
        let ps = tokenize("en", "well‑known", None);
        assert_eq!(ps[0][0].t, "well-known");
        assert_eq!(ps[0][0].norm, "well-known");
    }

    #[test]
    fn en_trims_punctuation_and_skips_numbers() {
        let ps = tokenize("en", "(hello) 123", None);
        assert_eq!(ps[0][0].t, "(");
        assert!(!ps[0][0].is_word);
        assert_eq!(ps[0][1].t, "hello");
        assert_eq!(ps[0][3].t, "123");
        assert!(!ps[0][3].is_word);
    }

    #[test]
    fn fr_deaccents_norm() {
        let ps = tokenize("fr", "Été passé", None);
        assert_eq!(ps[0][0].norm, "ete");
        assert_eq!(ps[0][1].norm, "passe");
    }

    #[test]
    fn fr_elision_keeps_token() {
        // l'homme 保留为整 token（含撇号），norm 带撇号；降级重查在前端做
        let ps = tokenize("fr", "l’homme", None);
        assert_eq!(ps[0][0].t, "l'homme");
        assert_eq!(ps[0][0].norm, "l'homme");
    }

    #[test]
    fn en_cjk_run_is_not_word() {
        let ps = tokenize("en", "said 你好世界 ok", None);
        assert!(!ps[0][1].is_word);
        assert_eq!(ps[0][1].t, "你好世界");
        assert_eq!(ps[0][2].t, "ok");
    }

    #[test]
    fn ja_greedy_match_and_fallback() {
        let mut vocab = HashSet::new();
        vocab.insert(norm("今日", "ja"));
        vocab.insert(norm("良い", "ja"));
        vocab.insert(norm("天気", "ja"));
        vocab.insert(norm("です", "ja"));
        let ps = tokenize("ja", "今日は良い天気ですね。", Some(&vocab));
        let words: Vec<&str> = ps[0].iter().filter(|t| t.is_word).map(|t| t.t.as_str()).collect();
        assert_eq!(words, vec!["今日", "は", "良い", "天気", "です", "ね"]);
        // 未登录单字回退：norm 照记、is_word=true，可点击触发 AI 补全
        let ps = tokenize("ja", "アゼルバイジャン", Some(&vocab));
        assert!(ps[0][0].is_word);
        assert_eq!(ps[0][0].norm, norm("ア", "ja"));
    }

    #[test]
    fn ja_kata_norm_used_for_matching() {
        let mut vocab = HashSet::new();
        vocab.insert(norm("ニホン", "ja")); // 词表里是片假名 norm=にほん
        let ps = tokenize("ja", "ニホン", Some(&vocab));
        assert_eq!(ps[0][0].t, "ニホン");
        assert_eq!(ps[0][0].norm, "にほん");
    }

    #[test]
    fn paragraphs_split_by_newline() {
        let ps = tokenize("en", "first\n\nsecond", None);
        assert_eq!(ps.len(), 3);
        assert_eq!(ps[1].len(), 0);
        assert_eq!(ps[2][0].t, "second");
    }
}
