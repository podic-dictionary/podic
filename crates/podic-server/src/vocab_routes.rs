//! 词汇自测路由：出题（POST /api/vocab-tests）、判分完成（/finish）、历史（GET）。
//! 测量口径见 podic_core::vocab_test 模块注释。

use crate::error::{ApiError, ApiResult};
use crate::routes::lock;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use podic_core::store::{self, VocabTestRow};
use podic_core::vocab_test::{
    allocate_samples, assign_bands, build_domain, estimate, interleave_bands, sample_band, Band,
    DOMAIN_RULE_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// 生成一次不可变抽样计划。题量 60/120；语言必须已装且可测（有 freq>0 词头）
pub async fn create_vocab_test(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> ApiResult<Json<Value>> {
    let lang = input
        .get("lang")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let question_count = input.get("question_count").and_then(|v| v.as_i64()).unwrap_or(60);
    if !matches!(question_count, 60 | 120) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "question_count 只支持 60 或 120".into()));
    }
    let core = lock(&state);
    let installed = core.packs.langs();
    let pack = core
        .packs
        .get(&lang)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "该语言没有已安装的词典".into()))?
        .clone();
    // 域构建在锁内做：本地单用户，一次扫描 ms 级；简单优先不做 TEMP 表缓存
    let mut domain = build_domain(&core.conn, &lang, &installed).map_err(|_| {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "该词典没有词频数据（freq 全为 0），暂不能测量".into(),
        )
    })?;
    assign_bands(&mut domain);
    let units = &domain.units;

    let band_count = units.last().map(|u| u.band + 1).unwrap_or(0);
    let pops: Vec<i64> = (0..band_count)
        .map(|b| units.iter().filter(|u| u.band == b).count() as i64)
        .collect();
    let samples = allocate_samples(&pops, question_count);

    // 层内抽样后层间交错出题（高频层靠前但不连排；空层不会卡死，见 core 测试）
    let per_band: Vec<Vec<_>> = (0..band_count)
        .map(|b| sample_band(units, b, samples[b]))
        .collect();
    let mut items: Vec<Value> = podic_core::vocab_test::interleave_bands(per_band)
        .into_iter()
        .enumerate()
        .map(|(i, u)| {
            json!({
                "id": format!("t{}", i + 1),
                "band": u.band,
                "headword": u.headword,
                "ipa": u.ipa,
            })
        })
        .collect();

    let bands: Vec<Band> = (0..band_count)
        .map(|b| Band { id: b, population: pops[b], sample_size: samples[b] })
        .collect();
    // 出题用与存档一致的计划快照：finish 判分只认这份 plan
    let plan = json!({
        "bands": bands,
        "items": items,
    });
    let id = podic_core::vocab_test::new_test_id();
    let row = VocabTestRow {
        id: id.clone(),
        lang: lang.clone(),
        pack_id: pack.pack_id.clone(),
        pack_version: pack.version.clone(),
        domain_rule: DOMAIN_RULE_VERSION.into(),
        population_size: units.len() as i64,
        question_count: items.len() as i64,
        plan_json: serde_json::to_string(&plan).unwrap_or_default(),
        answers_json: None,
        result_json: None,
        created_at: String::new(),
        finished_at: None,
    };
    store::vocab_test_prune(&core.conn)?;
    store::vocab_test_insert(&core.conn, &row)?;

    let domain_label = if band_count <= 1 {
        "本词典常用词范围（无细分词频）"
    } else {
        "本词典高频词头范围（按词频分层）"
    };
    Ok(Json(json!({
        "id": id,
        "lang": lang,
        "pack_id": pack.pack_id,
        "pack_version": pack.version,
        "domain_rule": DOMAIN_RULE_VERSION,
        "domain_label": domain_label,
        "population_size": units.len(),
        "question_count": items.len(),
        "bands": bands,
        "items": items,
    })))
}

#[derive(Deserialize, Serialize)]
pub struct VocabAnswer {
    item_id: String,
    known: bool,
}

/// 提交全部答案，服务端按计划计算并保存结果。重复提交相同答案幂等返回，
/// 换答案返回 409（抽样计划在出题时已固定，不允许事后改写）
pub async fn finish_vocab_test(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> ApiResult<Json<Value>> {
    let answers: Vec<VocabAnswer> = serde_json::from_value(
        input.get("answers").cloned().unwrap_or(Value::Null),
    )
    .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "answers 格式非法".into()))?;

    let core = lock(&state);
    let row = store::vocab_test_get(&core.conn, &id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "测验不存在".into()))?;

    // 校验答案精确覆盖计划：不重不漏，known 为布尔（serde 已保证类型）。
    // 放在幂等分支之前——已完成的测验收到畸形请求也先按 400 拒，绕不过契约
    let plan: Value = serde_json::from_str(&row.plan_json)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "计划快照损坏".into()))?;
    let plan_items = plan
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "计划快照损坏".into()))?;
    let band_of: HashMap<&str, usize> = plan_items
        .iter()
        .filter_map(|it| {
            Some((
                it.get("id")?.as_str()?,
                it.get("band")?.as_u64()? as usize,
            ))
        })
        .collect();
    if answers.len() != plan_items.len() {
        return Err(ApiError(StatusCode::BAD_REQUEST, format!("需要全部 {} 题的答案", plan_items.len())));
    }
    let mut seen = std::collections::HashSet::new();
    for a in &answers {
        if !band_of.contains_key(a.item_id.as_str()) || !seen.insert(a.item_id.clone()) {
            return Err(ApiError(StatusCode::BAD_REQUEST, format!("题目 {} 非法或重复", a.item_id)));
        }
    }

    if let Some(stored) = &row.result_json {
        // 幂等：同答案重放（顺序无关）返回原结果；换答案拒绝
        let same = row
            .answers_json
            .as_deref()
            .and_then(|a| serde_json::from_str::<Vec<VocabAnswer>>(a).ok())
            .map(|stored_answers| {
                let as_map = |v: &[VocabAnswer]| -> std::collections::HashSet<(String, bool)> {
                    v.iter().map(|a| (a.item_id.clone(), a.known)).collect()
                };
                as_map(&stored_answers) == as_map(&answers)
            })
            .unwrap_or(false);
        if same {
            return Ok(Json(json!({
                "id": row.id,
                "finished": true,
                "result": serde_json::from_str::<Value>(stored).unwrap_or(Value::Null),
            })));
        }
        return Err(ApiError(StatusCode::CONFLICT, "该测验已完成，不能修改答案".into()));
    }

    let bands: Vec<Value> = plan
        .get("bands")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let pops: Vec<i64> = bands.iter().filter_map(|b| b.get("population")?.as_i64()).collect();
    let samples: Vec<i64> = bands.iter().filter_map(|b| b.get("sample_size")?.as_i64()).collect();
    let mut knowns = vec![0i64; pops.len()];
    for a in &answers {
        if a.known {
            let b = band_of[a.item_id.as_str()];
            knowns[b] += 1;
        }
    }
    let (est, low, high) = estimate(&pops, &knowns, &samples);
    let band_results: Vec<Value> = bands
        .iter()
        .enumerate()
        .map(|(i, b)| {
            json!({
                "id": i,
                "population": pops[i],
                "sample_size": samples[i],
                "known": knowns[i],
            })
        })
        .collect();
    let result = json!({
        "estimate": est,
        "low": low,
        "high": high,
        "population_size": row.population_size,
        "bands": band_results,
        "method": "stratified-wilson-bonferroni",
    });
    let answers_json = serde_json::to_string(&answers).unwrap_or_default();
    store::vocab_test_finish(&core.conn, &id, &answers_json, &result.to_string())?;
    Ok(Json(json!({
        "id": id,
        "finished": true,
        "result": result,
    })))
}

/// 某语言已完成的历史结果（倒序，limit ≤ 50）
pub async fn list_vocab_tests(
    State(state): State<AppState>,
    Query(p): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let lang = p.get("lang").cloned().ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "缺少 lang".into()))?;
    let limit = p
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 50);
    let core = lock(&state);
    let rows = store::vocab_test_history(&core.conn, &lang, limit)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "lang": r.lang,
                "pack_version": r.pack_version,
                "domain_rule": r.domain_rule,
                "population_size": r.population_size,
                "question_count": r.question_count,
                "created_at": r.created_at,
                "finished_at": r.finished_at,
                "result": r.result_json.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}
