use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// API 错误 -> HTTP 响应
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

impl From<podic_core::Error> for ApiError {
    fn from(e: podic_core::Error) -> Self {
        match &e {
            podic_core::Error::Db(rusqlite::Error::QueryReturnedNoRows) => {
                ApiError(StatusCode::NOT_FOUND, "未找到".into())
            }
            _ => ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
