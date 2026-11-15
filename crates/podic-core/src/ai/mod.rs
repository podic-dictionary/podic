//! AI Provider 抽象：OpenAI 兼容 + Anthropic 双协议，SSE 流式输出。
//! 仅两种协议，用 enum dispatch 避免 dyn Trait / async_trait。

pub mod anthropic;
pub mod openai;
pub mod prompt;
pub mod sse;

use crate::error::Error;
use crate::settings::ProviderConfig;
use crate::Result;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Msg {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Msg>,
    pub max_tokens: u32,
    pub temperature: f32,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Default)]
pub struct StreamOutcome {
    pub text: String,
    pub usage: Usage,
}

pub enum AnyClient {
    OpenAi(openai::OpenAiClient),
    Anthropic(anthropic::AnthropicClient),
}

impl AnyClient {
    pub fn new(cfg: &ProviderConfig) -> Result<Self> {
        match cfg.protocol {
            crate::settings::Protocol::OpenAi => Ok(Self::OpenAi(openai::OpenAiClient::new(cfg)?)),
            crate::settings::Protocol::Anthropic => {
                Ok(Self::Anthropic(anthropic::AnthropicClient::new(cfg)?))
            }
        }
    }

    /// 流式对话；每收到文本增量回调一次。stop 置 true 可中断。
    pub async fn stream(
        &self,
        req: &ChatRequest,
        stop: Arc<AtomicBool>,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<StreamOutcome> {
        if stop.load(Ordering::Relaxed) {
            return Err(Error::Other("已取消".into()));
        }
        match self {
            AnyClient::OpenAi(c) => c.stream(req, stop, on_delta).await,
            AnyClient::Anthropic(c) => c.stream(req, stop, on_delta).await,
        }
    }
}

// ---------- AI 缓存键 ----------

/// AI 结果缓存键：task\0model\0text\0规范化(context)。
/// ai/run（落缓存）与每日一句回捞（读缓存）共用，保证两侧逐字节一致。
pub fn ai_cache_key(task: &str, model: &str, text: &str, context: Option<&serde_json::Value>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(task.as_bytes());
    hasher.update([0]);
    hasher.update(model.as_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    hasher.update([0]);
    hasher.update(
        context
            .map(|c| canon_json(c).to_string())
            .unwrap_or_default()
            .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

/// JSON 数字规范化：整数值的浮点（f64 1.0）统一成整数表示（1）。
/// 服务端 lookup 的 freq=1.0 经前端 JS JSON 往返会变 1（JS number 不区分），
/// 两侧序列化字节不同曾致每日一句回捞键错位（生成键≠回捞键，误报
/// 「生成结果无效」——ja 包词条 freq 全为 1.0 时必现）。统一成整数
/// 表示与前端往返写下的历史缓存天然兼容；非整数（0.85）保持原样。
fn canon_json(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Number(n) => {
            // 无损整数范围才转（超出 i64 的浮点保留原样）
            if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && f.abs() < 9.0e15 {
                    return Value::Number(serde_json::Number::from(f as i64));
                }
            }
            v.clone()
        }
        Value::Array(a) => Value::Array(a.iter().map(canon_json).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), canon_json(x))).collect()),
        _ => v.clone(),
    }
}

#[cfg(test)]
mod cache_key_tests {
    use super::ai_cache_key;
    use serde_json::json;

    /// 根因回归：服务端 f64 1.0 与前端 JS 往返后的 1 必须同键
    #[test]
    fn 键数字规范化_整数值浮点与整数同键() {
        let rust_side = json!({"entry": {"freq": 1.0, "headword": "花婿"}});
        let js_roundtrip = json!({"entry": {"freq": 1, "headword": "花婿"}});
        assert_eq!(
            ai_cache_key("daily", "m", "花婿", Some(&rust_side)),
            ai_cache_key("daily", "m", "花婿", Some(&js_roundtrip)),
        );
    }

    /// 非整数浮点两侧往返都不变，不参与规范化
    #[test]
    fn 键数字规范化_非整数浮点保持原样() {
        let a = json!({"freq": 0.85});
        let b = json!({"freq": 0.85});
        assert_eq!(ai_cache_key("t", "m", "x", Some(&a)), ai_cache_key("t", "m", "x", Some(&b)));
        let int = json!({"freq": 2});
        let float = json!({"freq": 2.5});
        assert_ne!(ai_cache_key("t", "m", "x", Some(&int)), ai_cache_key("t", "m", "x", Some(&float)));
    }
}
