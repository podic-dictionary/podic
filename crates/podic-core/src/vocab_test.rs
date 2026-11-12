//! 词汇自测：对已装词典包按词频分层抽样，估算「认识单词数」。
//!
//! 借鉴 VST（Nation & Beglar 2007）的分层抽样思想但刻意不同：
//! 计量单位是词典词头（非词族）、题型是自报认识/不认识（非四选一），
//! 结果表述为「本次词典范围内约认识 X 个词头 + 抽样区间」，不冒充标准词汇量。
//!
//! 域规则 headword-domain-v1：freq>0 的合格词头按 freq DESC 排序，头部约 2 万个
//! （同分组整体纳入，不按 id 截断），按序位切 2000/3000/5000/10000 四层。

use rusqlite::Connection;
use serde::Serialize;

pub const DOMAIN_RULE_VERSION: &str = "headword-domain-v1";

/// 测验会话 id：randomblob 十六进制（SQLite 自带随机源，不引入 rand 依赖）
pub fn new_test_id() -> String {
    let conn = Connection::open_in_memory().ok();
    conn.and_then(|c| {
        c.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get::<_, String>(0))
            .ok()
    })
    .unwrap_or_else(|| {
        // 内存库都开不了属极端环境：退化纳秒 id，保证可用性
        use std::time::{SystemTime, UNIX_EPOCH};
        format!(
            "{:032x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
    })
}

/// 目标域容量：freq 排序后的头部词头数（同分组可整体超出）
const TARGET_POPULATION: usize = 20_000;
/// 分层边界（域内序位）：0-2000 / 2001-5000 / 5001-10000 / 10001-
const BAND_EDGES: [usize; 3] = [2_000, 5_000, 10_000];

/// 词典内没有 freq>0 的合格词头，无法测量
#[derive(Debug)]
pub struct NotMeasurable;

/// 域内一个单位：去重后的词头（保留重音原形）
#[derive(Debug, Clone)]
pub struct Unit {
    pub headword: String,
    pub ipa: Option<String>,
    pub band: usize,
}

/// 测量域：按 freq DESC 排序的词头 + 每个词头所属的 freq 组号（层边界吸附组边界用）
pub struct Domain {
    pub units: Vec<Unit>,
    /// groups[i] = units[i] 的 freq 组序号（同组 = 同 freq 值）
    pub groups: Vec<usize>,
}

/// 分层信息
#[derive(Debug, Clone, Serialize)]
pub struct Band {
    pub id: usize,
    pub population: i64,
    pub sample_size: i64,
}

/// 抽中的测试题
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: String,
    pub band: usize,
    pub headword: String,
    pub ipa: Option<String>,
}

/// 拼写判分同款基础键（NFKC/小写/ß→ss/空白折叠，保留重音）：
/// 同词头不同大小写/全角变体视为同一个词，但 élevé 与 eleve 是两个词
fn unit_key(s: &str) -> String {
    crate::norm::answer_key(s)
}

/// 词头资格：至少含一个字母；只允许字母、组合记号与内部连字符/撇号/长音等正字法字符。
/// 排除数字串、含空格短语、URL、纯符号
pub fn eligible_headword(w: &str) -> bool {
    use unicode_normalization::UnicodeNormalization;
    let mut has_letter = false;
    for c in w.nfkd() {
        if c.is_alphabetic() {
            has_letter = true;
        } else if !(unicode_normalization::char::is_combining_mark(c)
            || matches!(c, '-' | '\'' | '\u{2019}' | '·' | '\u{30FC}'))
        {
            return false;
        }
    }
    has_letter
}

/// 构建测量域：freq>0 的合格词头去重，按 freq DESC 排序取头部约 2 万。
/// 同 freq 分组整体纳入（巨组不按 id 劈开，de/ja 这类粗词频包域会大于 2 万）。
/// groups 记录每单位所属 freq 组序号，供分层时把边界吸附到组边界
pub fn build_domain(conn: &Connection, lang: &str, installed: &[String]) -> std::result::Result<Domain, NotMeasurable> {
    if !installed.iter().any(|l| l == lang) {
        return Err(NotMeasurable);
    }
    crate::lookup::check_lang(lang).map_err(|_| NotMeasurable)?;
    let sql = format!(
        "SELECT headword, ipa, freq FROM \"{}\".entry WHERE freq > 0 ORDER BY freq DESC, id",
        lang
    );
    let mut stmt = conn.prepare(&sql).map_err(|_| NotMeasurable)?;
    let mut rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })
        .map_err(|_| NotMeasurable)?;

    let mut seen = std::collections::HashSet::new();
    let mut collected: Vec<(String, Option<String>)> = Vec::new();
    let mut group_sizes: Vec<usize> = Vec::new(); // 每个 freq 组的合格词头数
    // 逐组（同 freq 值）缓冲，组读完（freq 变化 / EOF）才并入：巨组要么整个收下
    // 要么整个不要，不会按 id 劈开。越过容量目标后不再收新组（同组继续收完）
    let mut group: Vec<(String, Option<String>)> = Vec::new();
    let mut cur_freq = f64::NAN;
    let mut done = false;
    let mut flush = |collected: &mut Vec<_>, group_sizes: &mut Vec<_>, group: &mut Vec<_>, done: &mut bool| {
        if group.is_empty() {
            return;
        }
        if *done {
            group.clear();
            return;
        }
        group_sizes.push(group.len());
        collected.append(group);
        if collected.len() >= TARGET_POPULATION {
            *done = true;
        }
    };
    for row in rows.flatten() {
        let (hw, ipa, freq) = row;
        if freq != cur_freq {
            flush(&mut collected, &mut group_sizes, &mut group, &mut done);
            if done {
                break; // 容量已满（整组已收）：停止扫描
            }
            cur_freq = freq;
        }
        if !eligible_headword(&hw) {
            continue;
        }
        let key = unit_key(&hw);
        if !seen.insert(key) {
            continue; // 同键变体（大小写/全角）不重复计
        }
        group.push((hw, ipa));
    }
    flush(&mut collected, &mut group_sizes, &mut group, &mut done);
    if collected.is_empty() {
        return Err(NotMeasurable);
    }
    let mut groups = Vec::with_capacity(collected.len());
    for (gi, size) in group_sizes.iter().enumerate() {
        groups.extend(std::iter::repeat_n(gi as usize, *size));
    }
    let units = collected
        .into_iter()
        .map(|(headword, ipa)| Unit { headword, ipa, band: 0 })
        .collect();
    Ok(Domain { units, groups })
}

/// 给排好序的域分层：序位边界吸附 freq 组边界——跨边界的巨组整体落进
/// 边界较早的一侧（右移边界到组末尾），杜绝「用 id 顺序把同频词拆成难度档」。
/// 单组语言（ja 全同分）自然退化为单层
pub fn assign_bands(domain: &mut Domain) {
    let n = domain.units.len();
    let mut b = 0usize;
    let mut i = 0usize;
    while i < n {
        let g = domain.groups[i];
        let mut j = i;
        while j < n && domain.groups[j] == g {
            j += 1;
        }
        // 组起点落位：越过几条边界就属于第几层（边界右移 = 组归较早层）
        while b < BAND_EDGES.len() && i >= BAND_EDGES[b] {
            b += 1;
        }
        for u in &mut domain.units[i..j] {
            u.band = b;
        }
        i = j;
    }
}

/// 层分配题量：均分，余数给大层；某层人口不足分配量则全取（普查），
/// 差额先顺延给相邻层、末尾剩余再回流到仍有容量的层——保证总量
/// 达到 min(total, Σpopulation)，不让末层小导致题量短缺
pub fn allocate_samples(pops: &[i64], total: i64) -> Vec<i64> {
    let h = pops.len();
    if h == 0 {
        return vec![];
    }
    let total = total.min(pops.iter().sum());
    let base = total / h as i64;
    let mut alloc = vec![base; h];
    let mut rem = total - base * h as i64;
    let mut order: Vec<usize> = (0..h).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(pops[i]));
    for &i in &order {
        if rem == 0 {
            break;
        }
        alloc[i] += 1;
        rem -= 1;
    }
    // 正向顺延：人口不足的层全取，差额转给相邻下一层。设计取舍：相邻层与
    // 普查层的词频最接近、答题率最相似，补采它对总估计的方差贡献最小；
    // 不选「最大层优先」——最大层往往答题率差异最大，加样收益反而低
    let mut surplus = 0i64;
    for i in 0..h {
        let want = alloc[i] + surplus;
        if pops[i] < want {
            surplus = want - pops[i];
            alloc[i] = pops[i];
        } else {
            alloc[i] = want;
            surplus = 0;
        }
    }
    // 末尾剩余回流：按剩余容量从大到小补，直到分完
    while surplus > 0 {
        let mut room: Vec<usize> = (0..h).filter(|&i| alloc[i] < pops[i]).collect();
        room.sort_by_key(|&i| std::cmp::Reverse(pops[i] - alloc[i]));
        if room.is_empty() {
            break;
        }
        let mut s = surplus;
        for &i in &room {
            if s == 0 {
                break;
            }
            let give = s.min(pops[i] - alloc[i]);
            alloc[i] += give;
            s -= give;
        }
        surplus = s;
    }
    alloc
}

/// 层内均匀抽样（部分 Fisher-Yates），返回抽中单位
pub fn sample_band(units: &[Unit], band: usize, n: i64) -> Vec<Unit> {
    let idxs: Vec<usize> = units
        .iter()
        .enumerate()
        .filter(|(_, u)| u.band == band)
        .map(|(i, _)| i)
        .collect();
    let take = (n as usize).min(idxs.len());
    let mut idxs = idxs;
    // Fisher-Yates 前缀
    for i in 0..take {
        let j = i + (fastrand_idx(idxs.len() - i));
        idxs.swap(i, j);
    }
    idxs[..take].iter().map(|&i| units[i].clone()).collect()
}

/// 轻量伪随机（抽样用，非密码用途）：基于地址熵 + 计数的 LCG
fn fastrand_idx(bound: usize) -> usize {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = const { Cell::new(0) };
    }
    let s = STATE.with(|c| {
        let mut s = c.get() ^ std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9E3779B97F4A7C15);
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        c.set(s);
        s
    });
    if bound == 0 {
        0
    } else {
        (s % bound as u64) as usize
    }
}

/// 层间交错出题：高频层靠前但不连排。终止按「已取题数」计——空层（巨组跨边界
/// 后的中间层）没有题可出，不参与终止判定，否则循环永不退出
pub fn interleave_bands(per_band: Vec<Vec<Unit>>) -> Vec<Unit> {
    let total_items: usize = per_band.iter().map(|v| v.len()).sum();
    let mut items = Vec::with_capacity(total_items);
    let mut cursors = vec![0usize; per_band.len()];
    while items.len() < total_items {
        let mut progress = false;
        for (b, cur) in cursors.iter_mut().enumerate() {
            if items.len() >= total_items {
                break;
            }
            if *cur >= per_band[b].len() {
                continue;
            }
            items.push(per_band[b][*cur].clone());
            *cur += 1;
            progress = true;
        }
        if !progress {
            break; // 防御：全部层空
        }
    }
    items
}

/// 分层估计 + Wilson/Bonferroni 区间。
/// pops 各层人口、knowns 各层答认数、samples 各层实际作答数；普查层（n=N）用精确值。
/// 返回 (估计, 下界, 上界)
pub fn estimate(pops: &[i64], knowns: &[i64], samples: &[i64]) -> (i64, i64, i64) {
    // 非普查层数 → Bonferroni 分配 α
    let free: Vec<usize> = (0..pops.len())
        .filter(|&i| samples[i] > 0 && samples[i] < pops[i])
        .collect();
    let h = free.len();
    let z = match h {
        0 => 0.0,
        1 => 1.959_964,
        2 => 2.241_403,
        3 => 2.393_980,
        _ => 2.497_705,
    };
    let mut point = 0f64;
    let mut low = 0f64;
    let mut high = 0f64;
    for i in 0..pops.len() {
        let n = samples[i].max(0) as f64;
        let np = pops[i].max(0) as f64;
        let k = knowns[i].max(0) as f64;
        if n <= 0.0 {
            continue;
        }
        let p = (k / n).clamp(0.0, 1.0);
        point += np * p;
        if n >= np {
            // 普查：精确
            low += np * p;
            high += np * p;
            continue;
        }
        // Wilson 区间（Bonferroni：z 已按层数校正）
        let z2 = z * z;
        let denom = 1.0 + z2 / n;
        let center = (p + z2 / (2.0 * n)) / denom;
        let half = z * ((p * (1.0 - p) / n + z2 / (4.0 * n * n)).sqrt()) / denom;
        low += np * (center - half).max(0.0);
        high += np * (center + half).min(1.0);
    }
    (point.round() as i64, low.floor() as i64, high.ceil() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 分层_单组退化单层_巨组不劈开() {
        // 模拟 ja：全部同分（1 组 22000）→ 只有一层，不按 id 伪造难度档
        let mut d = Domain {
            units: (0..22000)
                .map(|i| Unit { headword: format!("w{i}"), ipa: None, band: 0 })
                .collect(),
            groups: vec![0; 22000],
        };
        assign_bands(&mut d);
        assert!(d.units.iter().all(|u| u.band == 0));

        // 模拟 de：小组若干 + 巨组（0.1，32614）跨过全部边界 → 巨组整体落在其起点的层，
        // 不被边界劈开
        let mut units = vec![];
        let mut groups = vec![];
        for i in 0..1500 {
            units.push(Unit { headword: format!("a{i}"), ipa: None, band: 0 });
            groups.push(i); // 每个词一个小组
        }
        let n_giant = 32614;
        for i in 0..n_giant {
            units.push(Unit { headword: format!("b{i}"), ipa: None, band: 0 });
            groups.push(9999);
        }
        let mut d = Domain { units, groups };
        assign_bands(&mut d);
        // 巨组起点在 1500（< 2000）：整组落第 0 层
        assert!(d.units.iter().skip(1500).all(|u| u.band == 0));
        // 边界前的部分小组正常分层
        assert_eq!(d.units[0].band, 0);

        // 正常词频（组小）：四层边界按序位切
        let mut units = vec![];
        let mut groups = vec![];
        for i in 0..25000 {
            units.push(Unit { headword: format!("w{i}"), ipa: None, band: 0 });
            groups.push(i);
        }
        let mut d = Domain { units, groups };
        assign_bands(&mut d);
        assert_eq!(d.units[0].band, 0);
        assert_eq!(d.units[1999].band, 0);
        assert_eq!(d.units[2000].band, 1);
        assert_eq!(d.units[4999].band, 1);
        assert_eq!(d.units[5000].band, 2);
        assert_eq!(d.units[9999].band, 2);
        assert_eq!(d.units[10000].band, 3);
    }

    #[test]
    fn 资格过滤_排除短语数字与符号() {
        assert!(eligible_headword("apple"));
        assert!(eligible_headword("élevé"));
        assert!(eligible_headword("mother-in-law"));
        assert!(eligible_headword("ハイキング"));
        assert!(eligible_headword("北京")); // Han 是字母
        assert!(!eligible_headword("3D"));
        assert!(!eligible_headword("take off")); // 含空格短语
        assert!(!eligible_headword("http://x.co"));
        assert!(!eligible_headword("..."));
        assert!(!eligible_headword("")); // 无字母
    }

    #[test]
    fn 层分配_普查顺延与均分() {
        // 四层均分 60
        assert_eq!(allocate_samples(&[2000, 3000, 5000, 10000], 60), vec![15, 15, 15, 15]);
        // 第一层人口 10（不足 15）：全取 10，差额 5 给下一层
        let alloc = allocate_samples(&[10, 3000, 5000, 10000], 60);
        assert_eq!(alloc, vec![10, 20, 15, 15]);
        // 总体比题量还小：全部普查
        assert_eq!(allocate_samples(&[10, 20], 60), vec![10, 20]);
        // 单层
        assert_eq!(allocate_samples(&[22000], 60), vec![60]);
        // 末层只有 1 个词：差额回流到前面的层，总量仍兑现 60（评审 R08 场景）
        assert_eq!(allocate_samples(&[2000, 1], 60).iter().sum::<i64>(), 60);
        assert_eq!(allocate_samples(&[2000, 3000, 5000, 1], 60).iter().sum::<i64>(), 60);
        // 分配不超过各层人口
        for (p, a) in [2000i64, 3000, 5000, 1].iter().zip(allocate_samples(&[2000, 3000, 5000, 1], 60)) {
            assert!(a <= *p);
        }
    }

    #[test]
    fn 交错出题_空层不卡死() {
        // 评审 R01 场景：[6000, 0, 6000] 的人口 → [20, 0, 40] 的抽样，中间层为空。
        // 交错循环必须终止且出满 60 题
        let band0: Vec<Unit> = (0..20)
            .map(|i| Unit { headword: format!("a{i}"), ipa: None, band: 0 })
            .collect();
        let band1: Vec<Unit> = vec![];
        let band2: Vec<Unit> = (0..40)
            .map(|i| Unit { headword: format!("c{i}"), ipa: None, band: 2 })
            .collect();
        let items = interleave_bands(vec![band0, band1, band2]);
        assert_eq!(items.len(), 60);
        assert_eq!(items.iter().filter(|u| u.band == 0).count(), 20);
        assert_eq!(items.iter().filter(|u| u.band == 2).count(), 40);
        // 全空输入
        assert!(interleave_bands(vec![vec![], vec![]]).is_empty());
    }

    #[test]
    fn 估计与区间_文档样例() {
        // 方案文档核对样例：V≈8933，区间约 [4480, 14014]
        let pops = [2000i64, 3000, 5000, 10000];
        let knowns = [14i64, 12, 8, 3];
        let samples = [15i64, 15, 15, 15];
        let (v, lo, hi) = estimate(&pops, &knowns, &samples);
        assert_eq!(v, 8933);
        assert_eq!(lo, 4480);
        assert_eq!(hi, 14014);
    }

    #[test]
    fn 估计_全对全错与普查() {
        // 全认识（含普查层）：点估计=总人口；Wilson 下界保守略低于点值，上界封顶
        let (v, lo, hi) = estimate(&[1000, 4000], &[200, 800], &[200, 200]);
        assert_eq!(v, 5000);
        assert_eq!(hi, 5000); // 上界封顶人口
        assert!((1000..5000).contains(&lo)); // 下界保守但不塌到 0
        // 全不认识：点估计与下界为 0；上界是 Wilson 置信上界（>0 但远小于人口）——
        // 0/100 的抽样本就有可能漏掉真认识的词
        let (v, lo, hi) = estimate(&[1000, 4000], &[0, 0], &[100, 100]);
        assert_eq!(v, 0);
        assert_eq!(lo, 0);
        assert!(hi > 0 && hi <= 500);
        // 普查层用精确值，抽样层给区间
        let (v, lo, hi) = estimate(&[100, 9900], &[100, 50], &[100, 100]);
        assert_eq!(v, 100 + 4950);
        assert!(lo <= v && v <= hi);
    }
}

/// 每日一句的难度层推荐：按最近一次同词典版本的测试结果挑「大概率不熟悉」的层。
/// 入参按层序给 (sample_size, known)。规则（保守门槛，非统计保证）：
/// ① 样本数 <10 的层不参与（整层被测完的除外——不会发生，抽测上限 120）；
/// ② 优先取认识率 20%~70% 且最接近 35% 的层（并列取更常用层，stable sort 保证）；
/// ③ 全部 >70% → 最高可用层；全部 <20% → 最低可用层；无合格证据 → None（调用方兜底最易层）
pub fn recommend_band(bands: &[(i64, i64)]) -> Option<usize> {
    let eligible: Vec<usize> = bands
        .iter()
        .enumerate()
        .filter(|(_, (n, known))| *n >= 10 && *known >= 0 && known <= n)
        .map(|(i, _)| i)
        .collect();
    if eligible.is_empty() {
        return None;
    }
    let p = |i: usize| bands[i].1 as f64 / bands[i].0 as f64;
    let mut in_range: Vec<usize> = eligible
        .iter()
        .copied()
        .filter(|i| (0.20..=0.70).contains(&p(*i)))
        .collect();
    if !in_range.is_empty() {
        in_range.sort_by_key(|i| ((p(*i) - 0.35).abs() * 1000.0).round() as i64);
        return Some(in_range[0]);
    }
    if eligible.iter().all(|i| p(*i) > 0.70) {
        return eligible.iter().copied().max();
    }
    if eligible.iter().all(|i| p(*i) < 0.20) {
        return eligible.iter().copied().min();
    }
    // 防御：混合态但都不在区间（数学上不可能）——取最接近 35%
    let mut all = eligible;
    all.sort_by_key(|i| ((p(*i) - 0.35).abs() * 1000.0).round() as i64);
    Some(all[0])
}

#[cfg(test)]
mod recommend_tests {
    use super::recommend_band;

    #[test]
    fn 无证据返回none() {
        assert_eq!(recommend_band(&[]), None);
        assert_eq!(recommend_band(&[(5, 1), (8, 3)]), None); // 样本不足
    }

    #[test]
    fn 区间内取最接近三成五() {
        // 42% vs 36%：36% 距 35% 更近 → 层1
        assert_eq!(recommend_band(&[(50, 21), (50, 18)]), Some(1));
        // 34% vs 36%：并列距离 1% → 取更常用层 0
        assert_eq!(recommend_band(&[(50, 17), (50, 18)]), Some(0));
    }

    #[test]
    fn 全认识取最高层_全不认识取最低层() {
        assert_eq!(recommend_band(&[(50, 45), (50, 48)]), Some(1));
        assert_eq!(recommend_band(&[(50, 3), (50, 5)]), Some(0));
    }

    #[test]
    fn 零样本层被跳过() {
        // 层1 没抽到样本，只在层0（40%）与层2（20%）之间选 → 40% 更近 35%
        assert_eq!(recommend_band(&[(50, 20), (0, 0), (50, 10)]), Some(0));
    }
}
