# 词典数据：来源、构建过程与格式

本文档记录 Podic 词典数据（英/法/日 → 中文）从原始数据到可用词典包的完整链路，供后续复用、重建或扩展新语种时参考。

所有脚本位于 `scripts/pipeline/`，产物在 `data/`（中间产物，gitignore）与 `packs/`（最终词典包，gitignore）。

## 数据源

| 语种 | 来源 | 授权 | 用途 |
|---|---|---|---|
| en | [ECDICT](https://github.com/skywind3000/ECDICT) `ecdict.csv` | MIT | 词表、音标（英式为主）、英文释义、中文释义、考试词表标签、词级变形（exchange 字段）、词频（bnc/frq） |
| fr | [Lexique383](http://www.lexique.org/databases/Lexique383/Lexique383.tsv)（仅 http，下载后强制 md5 校验） | CC BY | 词形、音位转写（转 IPA）、词性、阴阳性、屈折映射（ortho→lemme）、词频 |
| fr | [CFDICT](https://chine.in/maison/cfdict/) `cfdict.u8` | CC BY-SA 3.0 | 中→法词典，反向匹配给法语词条补中文释义 |
| ja | [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) release 的 `jmdict-eng` + `kanjidic2` | CC BY-SA 4.0 | 日语词条（英文 gloss）、汉字信息（笔画/级/音训读） |
| ja | [Yomitan](https://github.com/yomidevs/yomitan) `deinflect.json` | 规则数据 | 正向生成动词/形容词屈折形式（食べる→食べた 等） |
| 例句 | [Tatoeba](https://tatoeba.org/) `sentences.csv` + `links.csv` | CC BY 2.0 FR | 句对及翻译链接；语言码是 ISO 639-3 三字码（eng/fra/jpn/cmn/yue） |

所有下载走 `download_all.py`：支持 `http_proxy` 环境变量代理、md5 校验、skip 复用已下载文件、tar.bz2 自动解压。

## 构建流程

```
download_all.py                      # 原始数据 -> data/raw/
  ├─ build_en.py                     # en 清洗
  ├─ build_fr.py                     # fr 清洗（音位->IPA、屈折表）
  │   └─ build_fr_cfdict.py          #   CFDICT 反向补中文释义
  ├─ build_ja.py                     # ja 清洗（JMdict 合并、正向变形）
  ├─ build_examples.py               # Tatoeba 例句关联（三语种）
  ├─ refine_slice_api.py             # LLM 精修 fr/ja（可选，见下节）
  │   └─ merge_refined.py            #   精修结果合并回 entries.jsonl
  └─ build_pack.py                   # JSONL -> SQLite 词典包
make_manifest.py                     # packs/manifest.json（版本+sha256）
release.sh                           # 发布 release（gh CLI）
```

一键跑前四步（不含精修）：`bash scripts/pipeline/build_all.sh <版本号>`。

### 各语种清洗要点

**英语（build_en.py）**
- ECDICT 的 translation 字段内是字面量 `\n` 分隔多义、行内 `；` 分项；definition 按行对齐进 sense.en
- exchange 字码 → 变形表：p=过去式、d=过去分词、i=ing、3=三单、s=复数、r=比较级、t=最高级；0=原形回指
- phonetic → 英式音标；collins 星级、考试标签（zk 中考/gk 高考/cet4/cet6/ky 考研/toefl/ielts/gre）进 extra.tags

**法语（build_fr.py + build_fr_cfdict.py）**
- Lexique 的 phon 列是音位转写不是 IPA，按映射表转写（鼻化元音 @=ɑ̃ °=ə §=ɔ̃ 1=œ̃ 5=ɛ̃ 8=ɥ 等）；构建结束打印未映射字符集，非空即失败
- 屈折表：所有 ortho→lemme 映射进 forms，rule 记 `词性-性-数`（如 `ver-p3s`、`nom-m-p`）；avions 同时是 avion 的复数和 avoir 的变位，天然双归属
- **聚合键用 lemme 原形（保变音）**：élève（学生）和 élevé（高的）去变音后同为 `eleve`，是两个不同的词，不能合并；norm 字段单独存去变音形式用于查询
- CFDICT 反向匹配按 **headword 精确匹配（casefold 保变音）**——它的法语释义是精确词形，按 norm 匹配会把「垚」的释义错配到 élevé 头上
- 词典库侧 norm 允许重复（普通索引），同 norm 的词条在查询时并列返回

**日语（build_ja.py）**
- JMdict：kanji 表记做 headword、kana 做 reading；POS 前缀映射到活用类（v1/v5*/vs/vk/vz/adj-i…）
- 变形：用 Yomitan deinflect.json 的规则表**正向**展开（kanaOut→kanaIn 反推），深度 ≤3、每词 ≤60 个形式，含促音脱落变体
- kanjidic2 的汉字 grade/strokes/音训读进 extra.kanji（注意字段在 misc 下）

**例句（build_examples.py）**
- 只对每语种词频前 N（默认 50k）的词建索引；en/fr 整词精确匹配，ja 按 headword/reading 子串（≥2 字符）
- **译文只保留中文**（普通话 cmn 优先、粤语 yue 次之），没有中文译文的句子整句不收——词典例句必须有中文翻译
- links.csv 是双向的，遍历时去重

### LLM 精修（fr/ja 中文释义，可选但强烈建议）

fr 的 Lexique 无释义、ja 的 JMdict 只有英文 gloss，中文释义主要靠 LLM 精修生成（当前 fr/ja 全量 6.9 万词已 100% 覆盖）：

1. `make_refine_slices.py`：词表按 500 词/片切分（fr 93 + ja 46 片），输入为 `{headword, reading, pos, gender, glosses}` JSONL
2. `refine_slice_api.py <slice.input.jsonl>`：直调 LLM API（Anthropic Messages 协议，模型用 `PODIC_REFINE_MODEL` 环境变量，默认 glm-5.3-flash），400 词/批，temperature=0，要求输出严格 JSON；产出 `<slice>.output.jsonl`（原子写，可断点续跑）
3. 缺口补打：`patch_gaps_api.py`，只补缺失行；内置两类网关容错——
   - 内容过滤拒批（错误码 `1301` / `SensitiveContentDetected`）：批二分到单词级，过不了的跳过留原释义
   - 网关后端不支持 `thinking:disabled` 参数（InvalidParameter）：自动去掉该字段重发
4. 复核：`refine_review_api.py` 产出 `.fix.jsonl`（只含有问题行的修正）；实践中辅以规则质检更高效——全库扫描「词性前缀缺失/格式异常/残留外文/无中文」，规则能修的归一化修掉（如日语活用类代码 v1/v5r/adj-no → v./adj.），只剩真正错的才交 LLM
5. `merge_refined.py`：汇总所有切片产出（.fix.jsonl 覆盖），按 headword 匹配合并回 entries.jsonl，打 `extra.refined=true` 标记。**重建词表后重跑即可恢复精修**；新增词条生成一个 `slice-9999.input.jsonl` 放进切片目录即可被顺带处理

鉴权：环境变量 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`）。

## 词典包格式（SQLite，schema v1）

每语种一个 `.db` 文件，`build_pack.py --lang <lang> --version <v> --sources <来源列表> --examples`：

```sql
meta(key, value)                    -- schema_version/lang/pack_id/version/built_at/entry_count/sources(JSON)

entry(id, headword, reading, norm, ipa, pos, gender, freq, senses, zh_text, extra)
-- norm: 查询键（NFKC+casefold + fr 去变音 + ja 片假名→平假名），允许重复
-- senses: JSON 数组 [{zh, en?, fr?, kind?, tags?}]
-- pos/gender/extra 均为 JSON；extra.refined 标记 LLM 精修过

form(form_norm, entry_id, rule)     -- 屈折/变体: 查询词形 -> 原形词条 (avions -> avion/avoir)
zh_index(term_norm, entry_id, sense_idx, origin)  -- 中文反查索引 (term, 义项, cfdict/pipeline)
sentence(id, text, translation)     -- translation: JSON 字符串数组（中文优先）
entry_sentence(entry_id, sentence_id, score)      -- 词条-例句关联
entry_fts                           -- FTS5(headword, reading, zh_text), unicode61
```

- `INSERT OR IGNORE` 幂等；norm→id 映射为**一对多**（同 norm 多词条），form/zh_index/例句关联都会写到每个同 norm 词条
- 单文件、无 WAL（journal_mode=DELETE），便于下载替换

### 查询合并（podic-core lookup）

五级召回按优先级合并，结果带 `matched_by` 标记：
1. norm 精确（含去变音/假名归一）
2. form 屈折精确（带 rule 标注「XX 的变形」）
3. FTS 全文（CJK 只适合整词，精确反查靠 zh_index）
4. 前缀范围扫描（`norm >= q AND norm < q || \u{10FFFF}`）
5. zh_index 中文反查

## 复现 / 扩展新语种

```bash
# 全量重建（不含精修）
bash scripts/pipeline/build_all.sh 0.1.0

# 只重建某语种的包（例句数据已就绪时）
python3 scripts/pipeline/build_pack.py --lang fr --version 0.1.0 --sources lexique,cfdict --examples

# 精修（fr/ja）
python3 scripts/pipeline/make_refine_slices.py            # 生成切片
python3 scripts/pipeline/refine_slice_api.py data/work/fr/refine_slices/slice-0000.input.jsonl
python3 scripts/pipeline/merge_refined.py
python3 scripts/pipeline/build_pack.py --lang fr --version 0.1.0 --sources lexique,cfdict --examples

# 发布
python3 scripts/pipeline/make_manifest.py --version 0.1.0 && bash scripts/release.sh
```

扩展新语种的步骤：在 `common.py` 的 SOURCES 注册来源（URL/md5/成员名/解压方式/致谢），新增 `build_<lang>.py` 产出同格式 JSONL，`build_pack.py` 加 lang 分支，前端补语言切换即可。语种特有的归一化（如 norm）在 `common.py` 的 norm() 中扩展。
