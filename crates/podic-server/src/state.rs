use podic_core::packs::PackManager;
use podic_core::settings::Settings;
use rusqlite::Connection;
use std::collections::HashMap;
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
}

impl Core {
    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn save_settings(&self) -> std::io::Result<()> {
        self.settings.save(&self.settings_path())
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
