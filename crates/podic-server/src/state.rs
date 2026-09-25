use podic_core::packs::PackManager;
use podic_core::settings::Settings;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// 共享核心：主库连接 + 已 ATTACH 的词典包 + 设置。
/// 个人自用场景，单 Mutex 足够；所有查询都是短事务。
pub struct Core {
    pub conn: Connection,
    pub packs: PackManager,
    pub data_dir: PathBuf,
    pub settings: Settings,
    /// 阅读器 ja 分词词表（norm 集合，构建 ~0.5s，按 lang 缓存；en/fr 分词不需要）
    pub reader_vocab: HashMap<String, HashSet<String>>,
}

impl Core {
    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn save_settings(&self) -> std::io::Result<()> {
        self.settings.save(&self.settings_path())
    }

    /// 词典包 / 用户词典变化后失效对应语种的分词词表
    pub fn invalidate_vocab(&mut self, lang: &str) {
        self.reader_vocab.remove(lang);
    }

    /// 取（或构建）ja 分词词表；返回的引用只在下一次取 &mut self 之前有效
    pub fn vocab_for(&mut self, lang: &str) -> &std::collections::HashSet<String> {
        if !self.reader_vocab.contains_key(lang) {
            let v = podic_core::reader::build_vocab(&self.conn, lang).unwrap_or_default();
            self.reader_vocab.insert(lang.to_string(), v);
        }
        self.reader_vocab.get(lang).unwrap()
    }
}

/// AI 任务取消句柄：task_id -> stop flag
pub type AiTasks = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<Mutex<Core>>,
    pub ai_tasks: AiTasks,
    pub task_seq: Arc<std::sync::atomic::AtomicU64>,
}

pub type SharedCore = AppState;
