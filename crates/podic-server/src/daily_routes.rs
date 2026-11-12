//! 每日一句：分层抽词（复用 vocab_test 的测量域）→ 词典例句优先 → AI 单句兜底。
//! 普通 JSON 端点（AI 等待约 2~5s，前端统一 loading）；锁纪律：全部 DB 查询在
//! 持锁段内完成，AI 网络调用放锁外，写缓存时再拿锁。

use crate::error::{ApiError, ApiResult};
use crate::routes::lock;
use crate::state::{AppState, SharedCore};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use podic_core::vocab_test::{assign_bands, build_domain, recommend_band, sample_band, Unit};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// 每日一句 AI prompt 版本：编进 ai 请求的 context，参与缓存键哈希。
/// 改动 prompt.rs 的 daily 生成规则或输出结构时必须递增，否则改版后
/// 仍会命中旧缓存拿到旧句子
const DAILY_PROMPT_VERSION: &str = "v1";

#[derive(Clone, Deserialize)]
pub struct DailyLevelIn {
    /// "auto"（按最近单词量测试推荐）| "manual"（手选 band）
    pub mode: String,
    #[serde(default)]
    pub band: Option<usize>,
}

#[derive(Deserialize)]
pub struct DailySentenceIn {
    pub lang: String,
    /// 指定词头：AI 生成完成后前端回捞快路径用（跳过随机抽样直接定位该词）。
    /// 不指定 = 随机抽词。词头找不到时（词典刚更新）退回随机抽样
    #[serde(default)]
    pub headword: Option<String>,
    /// 省略 = 用服务端按语言存的偏好；都没有 = auto
    #[serde(default)]
    pub level: Option<DailyLevelIn>,
    /// 「换一句」排除当前词
    #[serde(default)]
    pub exclude_headword: Option<String>,
    /// AI 兜底用；词典例句命中时不需要
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// 词典包变化后清抽词域缓存（import/remove/install 处调用）
pub fn invalidate_domain_cache(state: &SharedCore, lang: &str) {
    let prefix = format!("{lang}|");
    state
        .daily_domains
        .lock()
        .unwrap()
        .retain(|k, _| !k.starts_with(&prefix));
}

/// 取（或构建）某词典的分层词域缓存。key = lang|pack_id|version，
/// 超过两个语种就整表清掉（个人设备，域最大 ~2 万词，重建 ~250ms）
fn domain_for(state: &SharedCore, lang: &str, pack_id: &str, version: &str) -> Result<Arc<Vec<Unit>>, ApiError> {
    let key = format!("{lang}|{pack_id}|{version}");
    if let Some(u) = state.daily_domains.lock().unwrap().get(&key) {
        return Ok(u.clone());
    }
    let core = lock(state);
    let installed = core.packs.langs();
    let mut domain = build_domain(&core.conn, lang, &installed).map_err(|_| {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "这个词典没有可用于分层抽词的词频数据".into(),
        )
    })?;
    assign_bands(&mut domain);
    let mut cache = state.daily_domains.lock().unwrap();
    if cache.len() >= 2 {
        cache.clear();
    }
    let units = Arc::new(std::mem::take(&mut domain.units));
    cache.insert(key, units.clone());
    Ok(units)
}

/// 从最近一次同词典版本的已完成测试解析各层 (sample_size, known)
fn band_stats_of_last_test(
    state: &SharedCore,
    lang: &str,
    pack_id: &str,
    version: &str,
) -> Option<(Vec<(i64, i64)>, String)> {
    let core = lock(state);
    // 按词典版本精确取最近完成的一次；创建时间排序会把交错完成的旧版本结果误当最新
    let row = podic_core::store::vocab_test_latest_for_pack(&core.conn, lang, pack_id, version).ok()??;
    let result: Value = serde_json::from_str(row.result_json.as_deref()?).ok()?;
    let bands = result.get("bands")?.as_array()?;
    let stats: Vec<(i64, i64)> = bands
        .iter()
        .map(|b| {
            (
                b.get("sample_size").and_then(|v| v.as_i64()).unwrap_or(0),
                b.get("known").and_then(|v| v.as_i64()).unwrap_or(0),
            )
        })
        .collect();
    if stats.is_empty() {
        return None;
    }
    Some((stats, row.id))
}

/// 缓存内容解析（ai_run 存的是 LLM 原始输出，可能带围栏）：结构合法且
/// 字段干净才当有效句子；坏缓存当未命中（下次前端重新生成覆盖）
fn parse_cached_daily(raw: &str) -> Option<(String, Vec<String>)> {
    let mut s = raw.trim();
    if let Some(t) = s.strip_prefix("```json").or_else(|| s.strip_prefix("```")) {
        s = t;
    }
    if let Some(t) = s.strip_suffix("```") {
        s = t;
    }
    let v: Value = serde_json::from_str(s.trim()).ok()?;
    let text = v.get("text")?.as_str()?.trim().to_string();
    if text.is_empty() || text.len() > 500 {
        return None;
    }
    let translation: Vec<String> = v
        .get("translation")?
        .as_array()?
        .iter()
        .filter_map(|x| x.as_str().map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty() && t.len() <= 500)
        .collect();
    if translation.is_empty() {
        return None;
    }
    Some((text, translation))
}

/// 与 /api/ai/run 完全一致的缓存键算法：task\0model\0text\0context。
/// 每日一句的「词先行」改造后，AI 生成交由前端走 /api/ai/run（流式+取消），
/// 生成结果由该接口统一写入 ai_cache；本接口用同款键读缓存，保证
/// 「前端刚生成过的句子，下次抽到同词直接命中」
fn ai_run_cache_key(task: &str, model: &str, text: &str, context: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(task.as_bytes());
    hasher.update([0]);
    hasher.update(model.as_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    hasher.update([0]);
    hasher.update(context.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// POST /api/daily-sentence
pub async fn daily_sentence(
    State(state): State<AppState>,
    Json(input): Json<DailySentenceIn>,
) -> ApiResult<Json<Value>> {
    let lang = input.lang.trim().to_string();
    if lang.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "lang 必填".into()));
    }

    // ---- 持锁段拆三步：①一次取齐设置与词典信息 ②domain_for 内部自己拿锁
    // ③再拿锁做词条定位/例句/缓存检查。Mutex 不可重入，嵌套 lock 会死锁
    let picked = {
    let (pref, lang_name) = {
        let core = lock(&state);
        // 404 校验在这里只看已装列表；pack 详情由下一段锁统一取
        if !core.packs.langs().iter().any(|l| l == &lang) {
            return Err(ApiError(StatusCode::NOT_FOUND, "该语言没有已安装的词典".into()));
        }
        let pref = core.settings.daily_sentence.as_ref().and_then(|d| d.levels_by_lang.get(&lang).cloned());
        let lang_name = core
            .settings
            .languages
            .iter()
            .find(|l| l.code == lang)
            .map(|l| l.name.clone())
            .unwrap_or_else(|| lang.clone());
        (pref, lang_name)
    };
    let core = lock(&state);
    let installed = core.packs.langs().clone();
    let pack = core
        .packs
        .get(&lang)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "该语言没有已安装的词典".into()))?
        .clone();
    drop(core);

    let units = domain_for(&state, &lang, &pack.pack_id, &pack.version)?;

    // 指定词头（回捞场景）：直接取该词所在层，跳过推荐与随机抽样。
    // 抽到的词没词典例句时前端拿 ai_request 走流式生成，完成后必须能原样
    // 捞回同一个词——否则随机重抽到别的词，缓存键对不上，前端误报「生成无效」
    let specified = input
        .headword
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|hw| units.iter().find(|u| u.headword == hw).cloned());

    // 层解析：请求参数 > 服务端按语言偏好 > auto；指定词头时层随词走
    let pref = input
        .level
        .clone()
        .or_else(|| pref.map(|p| DailyLevelIn { mode: p.mode, band: p.band }))
        .unwrap_or(DailyLevelIn { mode: "auto".into(), band: None });
    let band_count = units.iter().map(|u| u.band + 1).max().unwrap_or(0);
    let band_counts: Vec<usize> = (0..band_count)
        .map(|b| units.iter().filter(|u| u.band == b).count())
        .collect();
    let lowest_nonempty = band_counts.iter().position(|c| *c > 0).unwrap_or(0);

    let (band, reason, known_sample, manual) = match &specified {
        Some(u) => (u.band, String::new(), None, true),
        None => match pref.mode.as_str() {
        "manual" => {
            let b = pref.band.unwrap_or(lowest_nonempty);
            let b = if b < band_count && band_counts[b] > 0 {
                b
            } else {
                lowest_nonempty // 手选层因词典变化失效时退到最易层
            };
            (b, String::new(), None, true)
        }
        _ => match band_stats_of_last_test(&state, &lang, &pack.pack_id, &pack.version) {
            Some((stats, _test_id)) => match recommend_band(&stats) {
                Some(b) if b < band_count && band_counts[b] > 0 => {
                    let (n, k) = stats[b];
                    let why = format!("根据上次{lang_name}测试推荐；该层抽测 {n} 词，认识 {k} 词");
                    (b, why, Some((k, n)), false)
                }
                _ => (
                    lowest_nonempty,
                    "上次测试结果与本词典不匹配，先从常用词开始".into(),
                    None,
                    false,
                ),
            },
            None => (
                lowest_nonempty,
                "先从常用词开始，做了单词量测试后会按结果推荐".into(),
                None,
                false,
            ),
        },
        },
    };

    // 抽词：指定词头直接用；否则带排除重抽（同层两个候选，排除词命中就取另一个）。
    // 层里唯一词恰好是被排除的（换一句但没有第二个词）：原样返回并给 note 说明
    let exclude = input
        .exclude_headword
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (mut unit, mut dup_note) = match specified {
        Some(u) => (u, None),
        None => {
            let two = sample_band(&units, band, 2);
            match two.iter().find(|u| Some(u.headword.as_str()) != exclude) {
                Some(u) => (u.clone(), None),
                None => (
                    two.first().cloned().unwrap_or_else(|| sample_band(&units, band, 1).into_iter().next().unwrap()),
                    exclude.map(|_| "本层只有这一个词，没有别的可换".to_string()),
                ),
            }
        }
    };

    // ---- 再拿锁：词条定位 + 例句 + AI 缓存/Provider（一次 guard 用到底） ----
    // norm 必须在最终词条确定后再算：定位失败重抽换词后，缓存键/词条要跟新词走，
    // 否则词 A 的键会存进词 B 的句子（复核 R3）
    let core = lock(&state);
    let find_entry = |norm: &str| -> Option<i64> {
        let sql = format!("SELECT id FROM \"{lang}\".entry WHERE norm = ?1 LIMIT 1");
        core.conn.query_row(&sql, [norm], |r| r.get(0)).ok()
    };
    let mut norm = podic_core::norm::norm(&unit.headword, &lang);
    let mut entry_id = find_entry(&norm);
    if entry_id.is_none() {
        // 防御：域缓存与词条表版本错位（词典刚更新）——换一个候选再试
        unit = sample_band(&units, band, 3)
            .into_iter()
            .find(|u| Some(u.headword.as_str()) != exclude)
            .unwrap_or(unit);
        norm = podic_core::norm::norm(&unit.headword, &lang);
        entry_id = find_entry(&norm);
    }
    let entry_id = entry_id
        .ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "词条定位失败，请重试".into()))?;

    // 词典例句优先：取评分最高的若干句，首选带译文的
    let sentences =
        podic_core::lookup::examples(&core.conn, &installed, &lang, entry_id, 5).unwrap_or_default();
    let chosen = sentences
        .iter()
        .find(|s| s.translation.as_array().is_some_and(|a| !a.is_empty()))
        .or_else(|| sentences.first());

    // 词条上下文（ senses 帮 AI 选对义项）；lookup 失败给 None，prompt 有无上下文两分支
    let entry_ctx: Option<Value> =
        podic_core::lookup::lookup(&core.conn, &installed, &[lang.clone()], &unit.headword, 1, true)
            .ok()
            .and_then(|v| v.into_iter().next())
            .and_then(|e| serde_json::to_value(e).ok());

    // AI 请求参数与缓存键：与 /api/ai/run 同款哈希（键含 prompt 版本）。
    // 无词典例句时词先行返回，AI 生成交给前端走 /api/ai/run（流式+可取消），
    // 生成结果由 ai_run 统一落 ai_cache——下次抽到同词本接口直接命中
    let provider = input
        .provider_id
        .clone()
        .and_then(|pid| core.settings.providers.iter().find(|p| p.id == pid).cloned());
    let resolved_model = provider.as_ref().map(|p| {
        input
            .model
            .clone()
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| p.active_model.clone())
    });
    let ai_context = json!({"prompt_version": DAILY_PROMPT_VERSION, "entry": entry_ctx});
    let ai_cache_key = resolved_model
        .as_deref()
        .map(|m| ai_run_cache_key("daily", m, &unit.headword, &ai_context))
        .unwrap_or_default();
    let cached_ai = chosen.is_none().then(|| {
        resolved_model
            .as_deref()
            .and_then(|_| podic_core::store::ai_cache_get(&core.conn, &ai_cache_key))
            .and_then(|raw| parse_cached_daily(&raw))
    }).flatten();

    PickOutcome {
        note: dup_note,
        headword: unit.headword,
        ipa: unit.ipa,
        entry_id,
        band,
        reason,
        known_sample,
        manual,
        band_counts,
        pack_sentence: chosen.map(|s| (s.text.clone(), s.translation.clone(), s.id)),
        ai_context,
        ai_cache_key,
        cached_ai,
        provider,
        resolved_model,
    }
};

    let bands_json: Vec<Value> = picked
        .band_counts
        .iter()
        .enumerate()
        .map(|(b, c)| json!({"id": b, "count": c}))
        .collect();
    let mut level = json!({
        "mode": if picked.manual { "manual" } else { "auto" },
        "band": picked.band,
        "reason": picked.reason,
    });
    if let Some(note) = &picked.note {
        level["note"] = json!(note);
    }
    if let Some((k, n)) = picked.known_sample {
        level["known"] = json!(k);
        level["sample_size"] = json!(n);
    }
    let word = json!({"headword": picked.headword, "entry_id": picked.entry_id, "ipa": picked.ipa});

    // ---- 词典例句命中：直接返回，不碰 AI ----
    if let Some((text, translation, sid)) = picked.pack_sentence {
        return Ok(Json(json!({
            "word": word,
            "level": level,
            "bands": bands_json,
            "sentence": {"text": text, "translation": translation, "source": "pack", "cached": false, "id": sid},
        })));
    }

    // ---- AI 缓存命中 ----
    if let Some((text, translation)) = picked.cached_ai {
        return Ok(Json(json!({
            "word": word,
            "level": level,
            "bands": bands_json,
            "sentence": {"text": text, "translation": translation, "source": "ai", "cached": true, "id": null},
        })));
    }

    // ---- 无句子无缓存：词先行返回，生成交给前端 ----
    // 词头此时已在屏幕上；前端拿 ai_request 走 /api/ai/run 流式生成（可取消），
    // 生成结果由 ai_run 落 ai_cache（键与本接口一致），下次同词直接命中快路径。
    // 「设置→词典未命中时自动补全=手动」时前端不自动发起，由用户点「生成例句」
    let message = if picked.provider.is_none() {
        "这个词暂无词典例句。配置 AI 后可以自动生成一句。"
    } else {
        "该 AI Provider 未配置模型，无法生成例句。"
    };
    if picked.resolved_model.as_deref().unwrap_or("").is_empty() {
        return Ok(Json(json!({
            "word": word,
            "level": level,
            "bands": bands_json,
            "sentence": null,
            "message": message,
        })));
    }
    let model = picked.resolved_model.unwrap_or_default();
    Ok(Json(json!({
        "word": word,
        "level": level,
        "bands": bands_json,
        "sentence": null,
        "ai_request": {"task": "daily", "text": picked.headword, "context": picked.ai_context, "model": model},
    })))
}

/// 持锁段一次性取齐的全部信息（锁释放后只用 owned 数据）
struct PickOutcome {
    /// 单词层换不出别的词等非致命提示；前端展示在推荐说明旁
    note: Option<String>,
    headword: String,
    ipa: Option<String>,
    entry_id: i64,
    band: usize,
    reason: String,
    known_sample: Option<(i64, i64)>,
    manual: bool,
    band_counts: Vec<usize>,
    pack_sentence: Option<(String, Value, i64)>,
    ai_context: Value,
    ai_cache_key: String,
    cached_ai: Option<(String, Vec<String>)>,
    provider: Option<podic_core::settings::ProviderConfig>,
    resolved_model: Option<String>,
}
