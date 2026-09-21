# Google Play Closed Testing 上架清单

## 已填报（2026-09-21，play-fill.py 全链路 commit 成功）

- AAB versionCode 5（0.2.2，131MB，release.keystore 签名）已传 **alpha 轨道（=封闭测试），
  draft 态**——Console 里人工复核后手动放行
- zh-CN / en-US 商店文案（标题/简短/完整描述）已写入
- 4 张手机截图 + 特色图 + 图标已写入（双语 listing 各一套）
- 重出材料后重跑：`python3 scripts/play-fill.py ~/.config/podic/podic@google-play@gcp.json`

## 需要在 Play Console（play.google.com/console）网页做

### 一、API 打通（已完成 ✓）

应用已建 + 服务账号（GCP 项目 `abstract-stage-…` 下，json 在配置仓）已关联授权。

API 踩坑记录：
- 轨道名是老版命名（production/alpha/beta/internal），`closed` 会 404；alpha 即封闭测试
- v3 没有 `listings.create`；`PUT listings/{lang}`（update）是 upsert，新语言直接建
- commit 403 但 message 里才是真实错误（如简短描述超 80 字符），别被状态码骗了
- edit 不 commit 会过期作废，AAB 得重传（131MB/次）

### 二、只能网页填的（API 无端点）

| 项 | 填法 |
|---|---|
| 隐私政策 | https://podic-dictionary.github.io/podic-site/privacy.html |
| 数据安全 | 选「不收集任何数据」；后续问题全部按无收集走 |
| 内容分级 | 问卷全部选否 -> 定级「所有人」；类别：应用 |
| 目标受众 | 13 岁及以上，不面向儿童；非新闻/政府/疫情应用 |
| 应用访问 | 全部功能可用，无需登录凭据（审核备注可写 fully offline, no account） |
| 测试人员 | closed 轨道建 email list（新个人账号要求 **12 名测试员连续 14 天** 才能申请正式发布） |
| 国家/地区 | 按需勾选 |

### 三、发布（剩余步骤）

Console -> 测试 -> 封闭测试：草稿 release（vc5）已在，补数据安全/内容分级等第二节的表单 ->
添加测试人员名单（≥12 人）-> 放量发布。审核通常数小时到 2 天。

## 备注

- 131MB 已接近 150MB 限制：后续做「空壳 + 应用内下载词典包」（P8 已规划），或改用
  Play Asset Delivery（install-time pack）
- 截图采集：adb 驱动真机（查词 hi/avion、AI 面板、翻译页），feature graphic 由
  chromium 渲染 `~/tmp/play/feature.html` 生成
