//! Anthropic 协议：POST {base}/v1/messages，x-api-key + anthropic-version，SSE 事件流。
//! 文本增量只取 content_block_delta 的 text_delta；message_stop 结束（无 [DONE]）。

use super::sse::SseParser;
use super::{ChatRequest, StreamOutcome, Usage};
use crate::error::Error;
use crate::settings::ProviderConfig;
use crate::Result;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct AnthropicClient {
    http: reqwest::Client,
    url: String,
    api_key: String,
    use_bearer: bool,
}

impl AnthropicClient {
    pub fn new(cfg: &ProviderConfig) -> Result<Self> {
        let base = if cfg.base_url.is_empty() {
            "https://api.anthropic.com".to_string()
        } else {
            cfg.base_url.trim_end_matches('/').to_string()
        };
        let url = format!("{base}/v1/messages");
        Ok(Self {
            http: reqwest::Client::new(),
            url,
            api_key: cfg.api_key.clone(),
            use_bearer: false,
        })
    }

    async fn post(&self, body: &Value) -> Result<reqwest::Response> {
        let mut req = self
            .http
            .post(&self.url)
            .header("anthropic-version", "2023-06-01")
            .json(body);
        req = if self.use_bearer {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        } else {
            req.header("x-api-key", &self.api_key)
        };
        Ok(req.send().await?)
    }

    pub async fn stream(
        &self,
        req: &ChatRequest,
        stop: Arc<AtomicBool>,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<StreamOutcome> {
        let mut messages = vec![];
        for m in &req.messages {
            messages.push(json!({"role": m.role, "content": m.content}));
        }
        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "stream": true,
            "messages": messages,
        });
        if let Some(sys) = &req.system {
            body["system"] = json!(sys);
        }
        if req.temperature != 1.0 {
            body["temperature"] = json!(req.temperature);
        }
        // 词典场景不需要思考过程；不支持该字段的 API 会在 400 时降级重试
        body["thinking"] = json!({"type": "disabled"});

        let mut resp = self.post(&body).await?;
        // 不认 thinking 字段的 API：去掉后重试一次
        if resp.status() == reqwest::StatusCode::BAD_REQUEST {
            let err_text = resp.text().await.unwrap_or_default();
            if err_text.contains("thinking") {
                if let Some(obj) = body.as_object_mut() {
                    obj.remove("thinking");
                }
                resp = self.post(&body).await?;
                if !resp.status().is_success() {
                    let status = resp.status();
                    let t = resp.text().await.unwrap_or_default();
                    return Err(Error::Other(format!("Anthropic API [{status}]: {err_text} | retry: {t}")));
                }
            } else {
                return Err(Error::Other(format!("Anthropic API [400]: {err_text}")));
            }
        }
        // 部分网关用 Bearer 鉴权：401/403 时自动降级重试一次
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED
            || resp.status() == reqwest::StatusCode::FORBIDDEN
        {
            let text = resp.text().await.unwrap_or_default();
            let mut retry = Self {
                http: self.http.clone(),
                url: self.url.clone(),
                api_key: self.api_key.clone(),
                use_bearer: !self.use_bearer,
            };
            let r2 = retry.post(&body).await?;
            if !r2.status().is_success() {
                let status = r2.status();
                let t2 = r2.text().await.unwrap_or_default();
                return Err(Error::Other(format!("Anthropic API [{status}]: {text} | retry: {t2}")));
            }
            resp = r2;
        } else if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Other(format!("Anthropic API [{status}]: {text}")));
        }

        let mut outcome = StreamOutcome::default();
        let mut parser = SseParser::default();
        let mut resp = resp;
        while let Some(chunk) = resp.chunk().await? {
            if stop.load(Ordering::Relaxed) {
                return Err(Error::Other("已取消".into()));
            }
            for ev in parser.feed(&chunk) {
                if self.handle_event(&ev, &mut outcome, on_delta) {
                    return Ok(outcome);
                }
            }
        }
        for ev in parser.finish() {
            if self.handle_event(&ev, &mut outcome, on_delta) {
                break;
            }
        }
        Ok(outcome)
    }

    /// 返回 true = 流已结束（收到 message_stop）
    fn handle_event(&self, ev: &super::sse::SseEvent, outcome: &mut StreamOutcome, on_delta: &mut impl FnMut(&str)) -> bool {
        let Ok(v) = serde_json::from_str::<Value>(&ev.data) else {
            return false;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("content_block_delta") => {
                if v.pointer("/delta/type").and_then(|t| t.as_str()) == Some("text_delta") {
                    if let Some(text) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                        outcome.text.push_str(text);
                        on_delta(text);
                    }
                }
            }
            Some("message_start") => {
                if let Some(input) = v.pointer("/message/usage/input_tokens").and_then(|x| x.as_u64()) {
                    outcome.usage.input = input;
                }
            }
            Some("message_delta") => {
                if let Some(output) = v.pointer("/usage/output_tokens").and_then(|x| x.as_u64()) {
                    outcome.usage.output = output;
                }
            }
            Some("message_stop") => return true,
            _ => {}
        }
        false
    }
}
