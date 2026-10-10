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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LanguageConfig {
    /// 2-4 位 ASCII 小写语言码（兼作 SQL schema 名，禁 main/temp/auto 等）
    pub code: String,
    /// 展示名（如「德语」）
    pub name: String,
    /// 切换器/角标用的简写（如「英」「En」）；缺省取 name 前两字符
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
}

/// 语言码合法性（与 packs.rs validate 的包语言约束一致）：2-4 位 ASCII 小写字母。
/// `is` 这类 SQL 关键字码是合法语言码，靠 schema 名加引号支持（见 lookup/packs）。
pub fn valid_lang_code(code: &str) -> bool {
    let n = code.chars().count();
    (2..=4).contains(&n) && code.chars().all(|c| c.is_ascii_lowercase())
}

/// 注册语言默认值（serde 缺字段 + impl Default 共用；derive Default 会给空 Vec，必须手写）
pub fn default_languages() -> Vec<LanguageConfig> {
    vec![
        LanguageConfig { code: "en".into(), name: "英语".into(), short: Some("英".into()) },
        LanguageConfig { code: "fr".into(), name: "法语".into(), short: Some("法".into()) },
        LanguageConfig { code: "ja".into(), name: "日语".into(), short: Some("日".into()) },
        LanguageConfig { code: "de".into(), name: "德语".into(), short: Some("德".into()) },
        LanguageConfig { code: "es".into(), name: "西班牙语".into(), short: Some("西".into()) },
        LanguageConfig { code: "ru".into(), name: "俄语".into(), short: Some("俄".into()) },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    /// 词典包更新 manifest 地址（GitHub release 直链或自定义；空 = 用 DEFAULT_MANIFEST_URL）
    #[serde(default)]
    pub manifest_url: String,
    /// 注册语言列表（切换器/查询默认范围/分词语种校验的单一来源）。
    /// 无包语言靠 LLM 查询时补全进 user_dict。
    #[serde(default = "default_languages")]
    pub languages: Vec<LanguageConfig>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            providers: Vec::new(),
            manifest_url: String::new(),
            languages: default_languages(),
        }
    }
}

/// 词典包更新源默认地址（podic-dictionary/dict 的 packs release 下载目录，
/// 内含 {lang}-metainfo.json 与词典包文件）。国内网络可整串套镜像前缀
/// （如 https://gh-proxy.com/ + 本地址）；自定义源也支持旧式 manifest.json 直链
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/podic-dictionary/dict/releases/latest/download/";

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
