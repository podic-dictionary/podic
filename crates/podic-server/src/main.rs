use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let addr = args.next().unwrap_or_else(|| "127.0.0.1:8787".to_string());
    let data_dir = PathBuf::from(args.next().unwrap_or_else(|| "podic-data".to_string()));

    podic_server::serve(&addr, data_dir, PathBuf::from("dist"))
        .await
        .expect("服务运行失败");
}
