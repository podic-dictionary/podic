# podic

干净清爽简洁的开源词典：**英 / 法 / 日 ↔ 中文**，桌面级体验的 Web 应用，附加可自配的 AI 能力（翻译、例句、深度讲解、词典缺词兜底）。

- 词典数据全部来自开源项目（ECDICT / Lexique / JMdict / CFDICT / Tatoeba），见 [ATTRIBUTIONS.md](ATTRIBUTIONS.md)
- 词典以「词典包」（单文件 SQLite）形式安装：本地导入，或从 GitHub Release / 自定义 URL 在线更新
- AI 支持 **OpenAI 兼容** 与 **Anthropic** 两种协议，一个 Provider 可配多个模型、随时切换
- 后端为 Rust（`podic-core` 纯库 + `podic-server` Axum 壳），前端 React + Vite + Tailwind

## 使用

```bash
# 前端 + 后端（开发模式）
pnpm install
pnpm build            # 产出 dist/
cargo run --release   # 默认 127.0.0.1:8787，serve dist/ 与 /api
```

打开 http://127.0.0.1:8787 →「词典包」页导入 `.db` 词典包文件（或配置更新源在线安装）→ 查词。

- 数据目录默认 `./podic-data/`（app.db / settings.json / packs/），可用第二个参数指定
- 对局域网开放：`cargo run --release 0.0.0.0:8787`（v1 无鉴权，仅限可信网络）
- AI 配置在「设置」页：填 Provider（协议 / Base URL / API Key / 模型列表）→ 测试连接
- API Key 只保存在服务端 `settings.json`，浏览器永不接触

## 词典包构建（数据管道）

数据来源、清洗规则、LLM 精修与词典包格式的完整说明见 [docs/dictionary-data.md](docs/dictionary-data.md)。

```bash
# 依赖: python3 标准库即可；境外源下载可设置代理环境变量，例如:
# export https_proxy=http://<你的代理地址>:<端口>
bash scripts/pipeline/build_all.sh 0.1.0    # 下载 -> 清洗 -> 建包 -> manifest
```

构建期 LLM 精修（可选，给高频词补中文释义/例句）：

```bash
export ANTHROPIC_API_KEY=sk-...            # 或 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
python3 scripts/pipeline/refine_llm.py --lang fr --limit 5000
python3 scripts/pipeline/refine_llm.py --lang ja --limit 5000 --rank-file data/work/ja/ja_word_freq.tsv
bash scripts/pipeline/build_all.sh 0.1.0   # 重新打包（refined 已有断点续跑，不会重复）
```

发布词典包：

```bash
bash scripts/release.sh 0.1.0   # gh release 上传 packs/*.db.gz + manifest.json
```

App 内「词典包 → 检查更新」读取 manifest 直链（`releases/latest/download/manifest.json`），不消耗 GitHub API 配额。

## 架构

```
src/                 React 前端（查词 / 翻译 / 生词本 / 词典包 / 设置）
crates/podic-core    纯库：词典包管理、五级查询（精确/屈折/FTS/前缀/中文反查）、AI 双协议客户端
crates/podic-server  Axum HTTP 壳（SSE 流式：AI 与下载进度）
crates/podic-mobile  移动壳：Android JNI + iOS C ABI
crates/podic-ohos    鸿蒙壳：HarmonyOS NEXT NAPI（见 docs/harmony.md）
android/ ios/ harmony/  三端宿主工程（WebView + 本地后端）
scripts/pipeline/    Python 数据管道（下载/清洗/建包/精修/发布）
packs/               构建产物 podic-{en,fr,ja}-<ver>.db + manifest.json
```

查询分级：`norm 精确 → 屈折形式(form 表) → FTS 模糊 → 前缀 → 中文反查索引`；
法语变体（如 avions 既是 avion 复数又是 avoir 变位）与日语变形（食べた→食べる）在构建期生成 `form` 表解决。

## Roadmap

- [ ] Tauri 桌面壳（复用 podic-core，零重写）
- [ ] 词典包在线更新频率限制与自动检查
- [ ] 生词本导出（CSV / Anki）
