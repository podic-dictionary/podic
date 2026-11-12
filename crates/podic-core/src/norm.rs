//! 与 scripts/pipeline/common.py 中的 norm/zh_term_norm 保持一致的 Rust 版。
//! 查询前对用户输入做同样的规范化（NFKC + casefold；fr 去变音符；ja 片假名→平假名）。

use unicode_normalization::UnicodeNormalization;

pub fn kata_to_hira(s: &str) -> String {
    s.chars()
        .map(|c| {
            let cp = c as u32;
            if (0x30A1..=0x30F6).contains(&cp) {
                char::from_u32(cp - 0x30A1 + 0x3041).unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

/// 查询/判分共用的基础归一：NFKC -> 小写 -> ß/ss -> 空白折叠（norm 的语言特化前缀）
fn base_norm(s: &str) -> String {
    let s: String = s.nfkc().flat_map(|c| c.to_lowercase()).collect();
    let s = s.replace('ß', "ss");
    // 内部连续空白折叠成单空格：词典 headword 从不含连续空白，用户查询里的多空格
    // /换行/制表符折叠后才能命中（幂等，单空格串不受影响）
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn norm(s: &str, lang: &str) -> String {
    let s = base_norm(s);
    match lang {
        "fr" => s.nfkd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect(),
        "ja" => kata_to_hira(&s),
        _ => s,
    }
}

/// 拼写判分键（练习填词题）：与 norm 共用基础归一，但保留重音与书写系统——
/// 考的是词头拼写本身，élevé ≠ eleve、ハ ≠ は。与查询用的 norm 刻意分开
pub fn answer_key(s: &str) -> String {
    base_norm(s)
}

pub fn zh_term_norm(term: &str) -> String {
    let s: String = term.nfkc().flat_map(|c| c.to_lowercase()).collect();
    s.replace(' ', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fr_strips_accents() {
        assert_eq!(norm("Été", "fr"), "ete");
        assert_eq!(norm("père", "fr"), "pere");
    }

    #[test]
    fn ja_kata_to_hira() {
        assert_eq!(norm("ニホン", "ja"), "にほん");
        assert_eq!(norm("たべる", "ja"), "たべる");
    }

    #[test]
    fn en_casefold() {
        assert_eq!(norm("Bank", "en"), "bank");
    }

    #[test]
    fn internal_whitespace_collapsed() {
        assert_eq!(norm("prendre  son \t temps", "fr"), "prendre son temps");
        assert_eq!(norm("well  known", "en"), "well known"); // 单空格幂等
        assert_eq!(norm("  ", "fr"), "");
    }

    #[test]
    fn zh_terms() {
        assert_eq!(zh_term_norm("飞 机"), "飞机");
        assert_eq!(zh_term_norm("Ａｐｐｌｅ"), "apple"); // NFKC 全角转半角
    }

    #[test]
    fn answer_key_keeps_accents() {
        // 拼写判分：大小写/全角/空白宽容，但重音是考点
        assert_eq!(answer_key("Apple"), answer_key("ＡＰＰＬＥ  "));
        assert_eq!(answer_key("straße"), answer_key("STRASSE")); // ß/ss 不作考点
        assert_ne!(answer_key("été"), answer_key("ete"));
        assert_ne!(answer_key("élevé"), answer_key("élève"));
        assert_ne!(answer_key("Häuser"), answer_key("hauser"));
    }
}
