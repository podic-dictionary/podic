use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// AI Provider 配置：支持 OpenAI 兼容与 Anthropic 两种协议，
/// 一个 Provider 可配多个模型，随时切换。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    /// OpenAI 兼容: 形如 https://api.openai.com/v1
    /// Anthropic: 留空 = 官方 https://api.anthropic.com
    #[serde(default)]
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub active_model: String,
    /// 模型展示名称（real model name -> 显示别名），缺省用原名
    #[serde(default)]
    pub labels: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    /// 词典包更新 manifest 地址（GitHub release 直链或自定义）
    #[serde(default)]
    pub manifest_url: String,
}

impl Settings {
    pub fn load(path: &Path) -> std::io::Result<Settings> {
        match std::fs::read_to_string(path) {
            Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
            Err(_) => Ok(Settings::default()),
        }
    }

    /// 原子写：先写临时文件再 rename
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// 默认配置文件路径：<data_dir>/settings.json
pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}
