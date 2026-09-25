//! 四类 AI 任务提示词：讲解 / 例句 / 翻译 / 兜底释义。
//! 返回 (system, user, max_tokens, temperature)。

use crate::lookup::Entry;
use serde_json::Value;

pub const LANG_NAMES: &[(&str, &str)] = &[("en", "英语"), ("fr", "法语"), ("ja", "日语"), ("zh", "中文")];

pub fn lang_name(code: &str) -> &str {
    LANG_NAMES.iter().find(|(c, _)| *c == code).map(|(_, n)| *n).unwrap_or(code)
}

/// 把词条摘要压成紧凑文本，喂给提示词
pub fn entry_summary(e: &Entry) -> Value {
    serde_json::json!({
        "lang": e.lang,
        "headword": e.headword,
        "reading": e.reading,
        "pos": e.pos,
        "gender": e.gender,
        "senses": e.senses,
    })
}

pub struct Prompt {
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
    pub temperature: f32,
}

pub fn build(task: &str, text: &str, context: Option<&Value>) -> Prompt {
    match task {
        "explain" => Prompt {
            system: "你是一位精通英法日三语的语言老师，面向中文母语者。用简体中文回答，用 Markdown，简明准确，不堆砌套话。".into(),
            user: match context {
                Some(ctx) => format!(
                    "请深度讲解词条：\n```json\n{}\n```\n用户补充：{text}\n\n按以下四部分输出，用 ## 小标题：\n## 核心词义（各义项一句话概括，标注词性）\n## 词源与构词\n## 近义辨析（列出 2-4 个易混词，说明区别，给出对应中文）\n## 常见搭配与例句（3-5 个，例句后附中文翻译）",
                    serde_json::to_string(ctx).unwrap_or_default()
                ),
                None => format!("请深度讲解词语「{text}」，按以下四部分输出，用 ## 小标题：\n## 核心词义\n## 词源与构词\n## 近义辨析\n## 常见搭配与例句"),
            },
            max_tokens: 2400,
            temperature: 0.4,
        },
        "examples" => Prompt {
            system: "你是例句生成器。只输出 JSON，不要多余文字。".into(),
            user: match context {
                Some(ctx) => format!(
                    "为词条生成 5 个例句（覆盖不同义项和常见搭配，难度由易到难，句长适中）：\n```json\n{}\n```\n输出格式：{{\"sentences\": [{{\"text\": \"例句\", \"zh\": \"中文翻译\"}}]}}",
                    serde_json::to_string(ctx).unwrap_or_default()
                ),
                None => format!("为词语「{text}」生成 5 个例句（含中文翻译）。输出格式：{{\"sentences\": [{{\"text\": \"例句\", \"zh\": \"中文翻译\"}}]}}"),
            },
            max_tokens: 2000,
            temperature: 0.7,
        },
        "translate" => Prompt {
            system: "你是专业翻译。直接输出译文，不要解释、不要原文复述。保留原文的段落结构。专有名词首次出现时可括注原文。".into(),
            user: text.to_string(),
            max_tokens: 3000,
            temperature: 0.2,
        },
        // 阅读器点词补全：词典完全 miss 时生成结构化词条，入库用户词典。
        // 严格 JSON（无围栏）：senses 每项必须含 zh（服务端入库前有 schema 校验）
        "complete" => {
            let ctx = context.cloned().unwrap_or(Value::Null);
            let lang = ctx.get("lang").and_then(|v| v.as_str()).unwrap_or("");
            let sentence = ctx.get("sentence").and_then(|v| v.as_str()).unwrap_or("");
            Prompt {
                system: "你是双语词典编纂者。只输出 JSON，不要围栏、不要多余文字。".into(),
                user: format!(
                    "查词典补全词条。词语：{text}（{lang}，{lang_name}）\n所在句：{sentence}\n\
                     若是屈折形式，先还原原形。输出格式：\n\
                     {{\"headword\": \"原形\", \"reading\": \"读音或假名，无则空串\", \"pos\": [\"词性缩写如 n./v./adj.\"], \"senses\": [{{\"pos\": [\"n.\"], \"zh\": \"中文释义\"}}], \"note\": \"一句话用法提示，可空串\"}}\n\
                     senses 最多 3 条，每条必须含非空 zh。专有名词按 pos=[\"n.\"] 给一条释义。",
                    lang_name = lang_name(lang),
                ),
                max_tokens: 600,
                temperature: 0.2,
            }
        }
        // 阅读器划选解析：整句/词组的翻译 + 语法解析 + 结合上下文的语境理解
        "analyze" => {
            let ctx = context.cloned().unwrap_or(Value::Null);
            let pretty = serde_json::to_string(&ctx).unwrap_or_default();
            Prompt {
                system: "你是一位精通英法日三语的语言老师，面向中文母语者。用简体中文回答，Markdown，控制在 300 字内，不堆砌套话。".into(),
                user: format!(
                    "解析选中的内容：{text}\n上下文：\n```json\n{pretty}\n```\n\
                     按以下三部分输出，用 ## 小标题：\n\
                     ## 译文（整段翻译）\n## 解析（关键词汇、语法结构、固定搭配）\n## 语境（结合上下文说明这句话的作用与含义）"
                ),
                max_tokens: 1200,
                temperature: 0.3,
            }
        }
        _ => {
            // fallback：词典缺释义时的兜底
            Prompt {
                system: "你是词典编纂者。面向中文母语者，简体中文输出，Markdown。".into(),
                user: match context {
                    Some(ctx) => format!(
                        "词典中该词条缺少中文释义，请补全。词条数据：\n```json\n{}\n```\n用户查询：{text}\n\n输出：该词的中文释义（按义项列出，标注词性），如有常用搭配或用法提示一并给出。开头单独一行注明：*AI 生成内容，仅供参考*",
                        serde_json::to_string(ctx).unwrap_or_default()
                    ),
                    None => format!(
                        "请给出「{text}」的词典式中文释义（按义项列出，标注词性），如有常用搭配或用法提示一并给出。开头单独一行注明：*AI 生成内容，仅供参考*"
                    ),
                },
                max_tokens: 1500,
                temperature: 0.3,
            }
        }
    }
}
