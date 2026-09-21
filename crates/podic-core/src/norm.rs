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

pub fn norm(s: &str, lang: &str) -> String {
    // NFKC -> casefold（Rust 无 casefold，to_lowercase + 少量特例与 Python 对齐）
    let s: String = s.nfkc().flat_map(|c| c.to_lowercase()).collect();
    let s = s.replace('ß', "ss");
    let s = s.trim().to_string();
    match lang {
        "fr" => s.nfkd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect(),
        "ja" => kata_to_hira(&s),
        _ => s,
    }
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
    fn zh_terms() {
        assert_eq!(zh_term_norm("飞 机"), "飞机");
        assert_eq!(zh_term_norm("Ａｐｐｌｅ"), "apple"); // NFKC 全角转半角
    }
}
