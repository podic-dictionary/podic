# 构建前端 + Rust，运行时只带二进制与 dist
FROM node:24-slim AS web
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src ./src
COPY index.html vite.config.ts tsconfig.json ./
RUN pnpm build

FROM rust:1-slim AS rust
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p podic-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust /app/target/release/podic-server /app/podic-server
COPY --from=web /app/dist /app/dist
# 词典包放 /data/packs，宿主机可只读挂载在线更新产物
ENV PODIC_DATA=/data
VOLUME /data
EXPOSE 8787
CMD ["/app/podic-server", "0.0.0.0:8787", "/data"]
