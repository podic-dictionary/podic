//! 每日一句：分层抽词（复用 vocab_test 的测量域）→ 词典例句优先 → AI 单句兜底。
//! 普通 JSON 端点（AI 等待约 2~5s，前端统一 loading）；锁纪律：全部 DB 查询在
//! 持锁段内完成，AI 网络调用放锁外，写缓存时再拿锁。

use crate::error::{ApiError, ApiResult};
use crate::routes::lock;
use crate::state::{AppState, SharedCore};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use podic_core::ai::prompt;
use podic_core::ai::{AnyClient, ChatRequest, Msg};
use podic_core::vocab_test::{assign_bands, build_domain, recommend_band, sample_band, Unit};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// 每日一句 AI prompt 版本：缓存键含此值。改动 prompt.rs 的 daily 生成规则
/// 或输出结构时必须递增，否则改版后仍会命中旧缓存拿到旧句子
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

fn parse_daily_json(raw: &str) -> Option<(String, Vec<String>)> {
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

    // 层解析：请求参数 > 服务端按语言偏好 > auto
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

    let (band, reason, known_sample, manual) = match pref.mode.as_str() {
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
    };

    // 抽词：带排除重抽（同层两个候选，排除词命中就取另一个）。
    // 层里唯一词恰好是被排除的（换一句但没有第二个词）：原样返回并给 note 说明
    let exclude = input
        .exclude_headword
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (mut unit, mut dup_note) = {
        let two = sample_band(&units, band, 2);
        match two.iter().find(|u| Some(u.headword.as_str()) != exclude) {
            Some(u) => (u.clone(), None),
            None => (
                two.first().cloned().unwrap_or_else(|| sample_band(&units, band, 1).into_iter().next().unwrap()),
                exclude.map(|_| "本层只有这一个词，没有别的可换".to_string()),
            ),
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

    // AI 缓存（键含 prompt 版本：升级自动失效）与 Provider 配置
    let ai_key = format!(
        "daily:{DAILY_PROMPT_VERSION}:{}:{}:{}:{}",
        lang, pack.pack_id, pack.version, norm
    );
    let cached_ai = chosen
        .is_none()
        .then(|| podic_core::store::ai_cache_get(&core.conn, &ai_key).and_then(|raw| parse_daily_json(&raw)))
        .flatten();
    let provider = input
        .provider_id
        .clone()
        .and_then(|pid| core.settings.providers.iter().find(|p| p.id == pid).cloned());

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
        entry_ctx,
        ai_key,
        cached_ai,
        provider,
        model: input.model.clone(),
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

    // ---- AI 生成（锁外；30s 超时；失败不缓存） ----
    let Some(provider) = picked.provider else {
        return Ok(Json(json!({
            "word": word,
            "level": level,
            "bands": bands_json,
            "sentence": null,
            "message": "这个词暂无词典例句。配置 AI 后可以自动生成一句。",
        })));
    };
    let model = picked
        .model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| provider.active_model.clone());
    if model.is_empty() {
        return Ok(Json(json!({
            "word": word,
            "level": level,
            "bands": bands_json,
            "sentence": null,
            "message": "该 AI Provider 未配置模型，无法生成例句。",
        })));
    }
    let p = prompt::build("daily", &picked.headword, picked.entry_ctx.as_ref());
    let chat = ChatRequest {
        model: model.clone(),
        system: Some(p.system),
        messages: vec![Msg { role: "user".into(), content: p.user }],
        max_tokens: p.max_tokens,
        temperature: p.temperature,
    };
    let client = AnyClient::new(&provider).map_err(|e| {
        ApiError(StatusCode::BAD_GATEWAY, format!("AI 配置有误：{e}"))
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    let collected = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let mut full = String::new();
        let mut on_delta = |delta: &str| full.push_str(delta);
        client.stream(&chat, stop, &mut on_delta).await.map(|_| full)
    })
    .await;
    let full = match collected {
        Ok(Ok(text)) if !text.trim().is_empty() => text,
        Ok(Ok(_)) => return Err(ApiError(StatusCode::BAD_GATEWAY, "AI 返回了空内容，请换一句试试".into())),
        Ok(Err(e)) => return Err(ApiError(StatusCode::BAD_GATEWAY, format!("AI 生成失败：{e}"))),
        Err(_) => return Err(ApiError(StatusCode::GATEWAY_TIMEOUT, "AI 生成超时，请换一句或重试".into())),
    };
    let Some((text, translation)) = parse_daily_json(&full) else {
        return Err(ApiError(StatusCode::BAD_GATEWAY, "AI 输出格式异常，请换一句试试".into()));
    };
    // 校验通过才进缓存，且缓存规范化后的 JSON（混合类型等不合规原文不入库，
    // 读回来二次解析也只会得到干净结构）；坏输出/超时不污染
    {
        let core = lock(&state);
        let canonical = json!({"text": text, "translation": translation}).to_string();
        let _ = podic_core::store::ai_cache_put(&core.conn, &picked.ai_key, "daily", &model, &canonical);
    }
    Ok(Json(json!({
        "word": word,
        "level": level,
        "bands": bands_json,
        "sentence": {"text": text, "translation": translation, "source": "ai", "cached": false, "id": null},
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
    entry_ctx: Option<Value>,
    ai_key: String,
    cached_ai: Option<(String, Vec<String>)>,
    provider: Option<podic_core::settings::ProviderConfig>,
    model: Option<String>,
}
