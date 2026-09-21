//! podic-core：词典包、查询、AI 客户端等核心逻辑。
//! 纯库，不依赖 HTTP 框架，方便将来被 Tauri 直接复用。

pub mod ai;
pub mod error;
pub mod lookup;
pub mod norm;
pub mod packs;
pub mod settings;
pub mod store;
pub mod update;

pub use error::Error;
pub type Result<T> = std::result::Result<T, Error>;
