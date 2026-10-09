---
title: 为新语言创建词典包
---

# 为新语言创建词典包

注册一门语言后就能直接用 AI 补词（查不到的词自动生成并存入用户词典）。如果你想要**批量、离线、可分享**的完整词库，可以在电脑上用下面的流程自己构建词典包，再导入 App——效果与内置的英/法/日词典一致。

## 先做一个三词小包（10 分钟上手）

**1. 准备词条文件** `data/work/de/entries.jsonl`（每行一个词条的 JSON）：

```json
{"headword":"Haus","norm":"haus","pos":["n."],"gender":"n","freq":100,"senses":[{"pos":["n."],"zh":"房屋；住宅"}],"zh_terms":[["房屋",0,"manual"]]}
{"headword":"gehen","norm":"gehen","pos":["v."],"freq":90,"senses":[{"pos":["v."],"zh":"走；去"}],"zh_terms":[["走",0,"manual"]]}
{"headword":"gut","norm":"gut","pos":["adj."],"freq":80,"senses":[{"pos":["adj."],"zh":"好的"}],"zh_terms":[["好",0,"manual"]]}
```

字段说明：`headword` 词头（保留大小写）；`norm` 检索键（小写，见下方 norm 规则）；`senses` 释义数组（`zh` 必填）；`zh_terms` 中文反查词，格式 `[中文词, 义项下标, 来源]`；`freq` 越大排序越靠前。

**2. 打包**（需 Python 3 与本仓库代码，`git clone https://github.com/podic-dictionary/podic` 后在仓库根目录执行）：

```bash
python3 scripts/pipeline/build_pack.py --lang de --pack-id community-de \
  --version 0.1.0 --sources manual --out packs/community-de-0.1.0.db
```

**3. 校验并导入**：先 `python3 scripts/pipeline/validate_pack.py packs/community-de-0.1.0.db`，通过后在 App「设置 → 词典包管理 → 导入本地词典包」选择 .db 文件。

**4. 验收**：注册 de 语言后查 `Haus` 精确命中；查「房屋」中文反查命中。

## norm 规则（命中率的关键）

查询和建库必须用同一套规范化：**NFKC → 小写 → 连续空白折叠**。注意各语言差异：法语额外去变音符号（é→e），日语片假名转平假名，**其他语言保留变音符**（德语 Häuser 的 norm 是 `häuser` 不是 `hauser`）。脚本 `generate_entries_llm.py` 会自动计算 norm，不需要手写。

## 用 LLM 批量生成词条

准备一个词单文件（每行一个词，或 `词\t频次`），然后：

```bash
python3 scripts/pipeline/generate_entries_llm.py \
  --lang de --language-name 德语 \
  --words words.txt \
  --model glm-5.3-flash --batch 20 --limit 5000
```

- 支持 OpenAI 兼容与 Anthropic 协议（环境变量配置 API 地址与密钥）
- 断点续跑：中断后重跑同一命令只补缺失的词
- 产出 `data/work/de/entries.jsonl` + 空 `forms.jsonl`，接着走上面的打包命令

**质量建议**：模型输出有错误率，生成后先 `validate_pack.py` 查结构，再人工抽查 20 条以上再导入；导入的词条在查询时与内置词典同权重展示。

## 导入与替换规则

- **一种语言只有一个生效的包**：导入同语言的新包会替换旧包（旧文件保留在包目录，重启后生效新包）
- 语言码必须与注册语言一致（2-4 位小写字母）
- 自定义包建议用 `community-` 前缀的 pack_id 与官方包区分

## 分享你的包

词典包是单个 .db 文件，直接发文件即可。如果你的词条来自开放数据（如 Wiktionary 系 CC BY-SA），分享时需保留数据来源署名；LLM 生成的内容建议标注模型名，供使用者判断质量。
