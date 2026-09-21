//! OpenAI 兼容协议：POST {base}/chat/completions，Bearer 鉴权，SSE data 行流式。
//! 兼容性：部分新模型只认 max_completion_tokens，400 提到 max_tokens 时自动降级重试一次。

use super::sse::SseParser;
use super::{ChatRequest, StreamOutcome, Usage};
use crate::error::Error;
use crate::settings::ProviderConfig;
use crate::Result;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct OpenAiClient {
    http: reqwest::Client,
    url: String,
    api_key: String,
}

impl OpenAiClient {
    pub fn new(cfg: &ProviderConfig) -> Result<Self> {
        let base = if cfg.base_url.is_empty() {
            "https://api.openai.com/v1".to_string()
        } else {
            cfg.base_url.trim_end_matches('/').to_string()
        };
        let url = if base.ends_with("/chat/completions") {
            base
        } else if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        };
        Ok(Self {
            http: reqwest::Client::new(),
            url,
            api_key: cfg.api_key.clone(),
        })
    }

    async fn post(&self, body: &Value) -> Result<reqwest::Response> {
        let resp = self
            .http
            .post(&self.url)
            .bearer_auth(&self.api_key)
            .json(body)
            .send()
            .await?;
        Ok(resp)
    }

    pub async fn stream(
        &self,
        req: &ChatRequest,
        stop: Arc<AtomicBool>,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<StreamOutcome> {
        let mut messages = vec![];
        if let Some(sys) = &req.system {
            messages.push(json!({"role": "system", "content": sys}));
        }
        for m in &req.messages {
            messages.push(json!({"role": m.role, "content": m.content}));
        }
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
        });

        let resp = self.post(&body).await?;
        let resp = if resp.status() == reqwest::StatusCode::BAD_REQUEST {
            let text = resp.text().await.unwrap_or_default();
            if text.contains("max_tokens") {
                // 新版字段名降级重试
                body["max_completion_tokens"] = body["max_tokens"].take();
                let r = self.post(&body).await?;
                if !r.status().is_success() {
                    let t = r.text().await.unwrap_or_default();
                    return Err(Error::Other(format!("OpenAI API: {t}")));
                }
                r
            } else {
                return Err(Error::Other(format!("OpenAI API: {text}")));
            }
        } else if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Other(format!("OpenAI API: {}", text)));
        } else {
            resp
        };

        let mut outcome = StreamOutcome::default();
        let mut parser = SseParser::default();
        let mut resp = resp;
        while let Some(chunk) = resp.chunk().await? {
            if stop.load(Ordering::Relaxed) {
                return Err(Error::Other("已取消".into()));
            }
            for ev in parser.feed(&chunk) {
                if ev.data.trim() == "[DONE]" {
                    return Ok(outcome);
                }
                if let Ok(v) = serde_json::from_str::<Value>(&ev.data) {
                    if let Some(delta) = v
                        .pointer("/choices/0/delta/content")
                        .and_then(|c| c.as_str())
                    {
                        if !delta.is_empty() {
                            outcome.text.push_str(delta);
                            on_delta(delta);
                        }
                    }
                    if let Some(u) = v.get("usage") {
                        outcome.usage = Usage {
                            input: u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                            output: u.get("completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                        };
                    }
                }
            }
        }
        for ev in parser.finish() {
            if let Ok(v) = serde_json::from_str::<Value>(&ev.data) {
                if let Some(delta) = v.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
                    outcome.text.push_str(delta);
                    on_delta(delta);
                }
            }
        }
        Ok(outcome)
    }
}
