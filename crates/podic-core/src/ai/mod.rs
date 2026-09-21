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
