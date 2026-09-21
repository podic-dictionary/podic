//! 通用 SSE 解析器：OpenAI（纯 data: 行）与 Anthropic（带 event: 行）共用。
//! 规则：按 \n 切行；空行 = 事件边界；data: 可多行拼接；忽略 id:/retry:/注释行。

#[derive(Debug, Clone)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    /// 喂入字节块，返回其中已完成的事件
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            if let Some(ev) = self.handle_line(&line[..line.len() - 1]) {
                out.push(ev);
            }
        }
        out
    }

    /// 流结束时调用，冲刷残留（有些实现不发结尾空行）
    pub fn finish(&mut self) -> Vec<SseEvent> {
        if self.buf.is_empty() {
            return vec![];
        }
        let rest = std::mem::take(&mut self.buf);
        self.handle_line(&rest).into_iter().collect()
    }

    fn handle_line(&mut self, line: &[u8]) -> Option<SseEvent> {
        let line = String::from_utf8_lossy(line);
        let line = line.strip_suffix('\r').unwrap_or(&line);
        if line.is_empty() {
            // 事件边界
            if self.data.is_empty() {
                self.event = None;
                return None;
            }
            let ev = SseEvent {
                event: self.event.take(),
                data: std::mem::take(&mut self.data).join("\n"),
            };
            return Some(ev);
        }
        if let Some(rest) = line.strip_prefix("event:") {
            self.event = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            self.data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
        // 其余行（id/retry/:注释）忽略
        None
    }
}
