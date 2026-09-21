# 数据来源与授权

podic 的词典数据来自以下开源项目，本应用不包含任何专有词典数据。
构建产物（词典包）的 `meta.sources` 记录了每个包实际使用的来源，应用内「设置 → 数据来源与致谢」页同步展示。

## 数据源

| 数据 | 用途 | 授权 | 链接 |
|---|---|---|---|
| ECDICT | 英语词条（释义/音标/词频/考纲标签/词形变化） | MIT | https://github.com/skywind3000/ECDICT |
| CC-CEDICT | 中→英反向匹配，补英语中文释义 | CC BY-SA 4.0 (MDBG) | https://www.mdbg.net/chinese-dictionary/page/cedict |
| Lexique 3.83 | 法语词条（音位转写→IPA、词性、阴阳性、词频、屈折映射） | CC BY 4.0 | http://www.lexique.org |
| CFDICT | 中→法反向匹配，补法语中文释义 | CC BY-SA 3.0 | https://chine.in/cfdict.php |
| JMdict / KANJIDIC2 | 日语词条（读音、词性、英文释义、汉字信息） | CC BY-SA 4.0 (EDRDG) | https://www.edrdg.org/jmdict/j_jmdict.html |
| jmdict-simplified | JMdict 的 JSON 发行版 | CC BY-SA 4.0 | https://github.com/scriptin/jmdict-simplified |
| Tatoeba | 多语种母语者例句及互译 | CC BY 2.0 FR | https://tatoeba.org |
| Yomitan deinflect | 日语变形规则表（构建期使用） | GPL-3.0 | https://github.com/FooSoft/yomichan |

## AI 精修说明

高频词条的中文释义与例句由 LLM 在**构建期**生成并经校对合并（包内标注 `refined`）。
运行时的 AI 兜底内容仅缓存于本机，不写入词典包。

## 分发注意事项

- 词典包中含 CC BY-SA 类数据（CFDICT/JMdict/Tatoeba）：**如对外分发词典包，需以相同方式共享（BY-SA）并保留署名**；个人自用无额外要求。
- CC BY 类数据（Lexique）要求署名，不要求相同方式共享。
- 本应用代码以 MIT 授权，与数据授权相互独立。
