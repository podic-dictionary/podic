#!/usr/bin/env python3
"""App Store Connect 元数据自动填报（podic iOS v1.0 提审准备）。

用法: python3 scripts/asc-fill.py <AuthKey.p8> <KEY_ID> <ISSUER_ID> [--app-id ID] [--screenshots iphone.png ipad.png]
          [--contact-first F] [--contact-last L] [--contact-phone +86…] [--contact-email E]
凭据从命令行传入（不落盘）；App id 缺省 6814098026（com.felix021.podic）。
填充范围：版本描述/关键词/推广文本/版权、截图（6.9" + 13" iPad）、年龄分级问卷（全否 => 4+）、
分类（Reference/教育）、隐私政策 URL、关联 latest VALID build、审核联系人。
不含：App Privacy 声明（API 无端点，网页选 Data Not Collected）、最终「提交审核」按钮（手动触发）。
"""
import base64
import json
import os
import subprocess
import sys
import time
import re
import urllib.request

APP_ID = sys.argv[sys.argv.index("--app-id") + 1] if "--app-id" in sys.argv else "6814098026"
ARGS = [a for a in sys.argv[1:] if not a.startswith("-")]
p8, kid, iss = ARGS[0], ARGS[1], ARGS[2]

SCREENS = []
if "--screenshots" in sys.argv:
    i = sys.argv.index("--screenshots")
    SCREENS = sys.argv[i + 1 : i + 3]  # iphone.png ipad.png


def opt(name, default=""):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

# 审核联系人（App Review Information，电话必填、需合法格式如 +8613…）
CONTACT_FIRST, CONTACT_LAST = opt("--contact-first", "felix"), opt("--contact-last", "021")
CONTACT_PHONE = opt("--contact-phone")
CONTACT_EMAIL = opt("--contact-email", "felix021@gmail.com")
CONTACT_NOTES = "Fully offline dictionary app. No account, no login, no demo account needed."

PRIVACY_URL = "https://podic-dictionary.github.io/podic-site/privacy.html"
COPYRIGHT = "Copyright © 2026 felix021"

LOCALES = {
    "en-US": {
        "description": (
            "Podic is a clean, open-source dictionary app for English / French / Japanese / German / "
            "Spanish / Russian / Italian / Portuguese ↔ Chinese, with one-tap installation of all eight "
            "dictionaries; you can also register any language and import custom dictionary packs. "
            "Dictionary data comes from freely-licensed corpora (ECDICT, CFDict, JMdict, Tatoeba and more). "
            "Fully offline — no account needed.\n\n"
            "• Offline lookups: headwords, IPA, senses, inflections and real-usage example sentences with translations\n"
            "• Reverse lookup: type Chinese to find the word\n"
            "• Wordbook practice: word→meaning, spelling and listening modes with mastery tracking\n"
            "• Vocabulary size test: frequency-stratified sampling per dictionary\n"
            "• Daily sentence: a random word each day with a real example (dictionary first, AI fallback)\n"
            "• System TTS read-aloud for words and example sentences\n"
            "• Reading: paste or fetch articles, tap any word to look it up, mark new words\n"
            "• Optional AI: bring your own API key for deep explanations, generated examples, "
            "sense completion and translation\n\n"
            "No account, no ads, no tracking. All data stays on your device."
        ),
        "keywords": "dictionary,offline,english,french,japanese,german,spanish,russian,italian,portuguese,chinese",
        "promotionalText": "Open source. Fully offline. 8 dictionaries, practice, vocab test and daily sentence. Bring your own AI key.",
        "subtitle": "Open-source offline dictionary",
        "whatsNew": "New: wordbook practice (meaning/spelling/listening with mastery tracking), per-language vocabulary size test, and a daily sentence (dictionary example first, AI fallback). System TTS read-aloud for words and examples, plus navigation and UX fixes.",
    },
    "zh-Hans": {
        "description": (
            "Podic 词典是一款干净清爽的开源词典应用，支持英 / 法 / 日 / 德 / 西 / 俄 / 意 / 葡八语与中文互查，"
            "八语词典一键在线安装，也可注册任意语言、导入自定义词典包。"
            "词典数据来自自由许可的开源语料（ECDICT、CFDICT、JMdict、Tatoeba 等），离线可用，无需注册登录。\n\n"
            "• 离线查词：词头、音标、词性、屈折变形、真实语料例句与中文翻译\n"
            "• 中文反查：输入中文找到对应单词\n"
            "• 生词本练习：词义、拼写、听音三种题型，自动追踪熟练度\n"
            "• 词汇量自测：按词典词频分层抽样，估计词汇量\n"
            "• 每日一句：随机抽词学例句，词典例句优先，AI 生成兜底\n"
            "• 系统朗读：调用系统 TTS 朗读单词与例句\n"
            "• 阅读增强：粘贴或抓取文章，点词即查，生词一键标记\n"
            "• AI 增强（可选）：自带 API Key 即可启用深度讲解、例句生成、释义补全与整句翻译\n\n"
            "Podic 不收集任何个人数据，无广告、无内置付费；所有数据仅保存在你的设备上。"
        ),
        "keywords": "词典,英语,法语,日语,德语,西班牙语,俄语,意大利语,葡萄牙语,离线,开源",
        "promotionalText": "开源、离线、无广告；生词练习、词汇量自测、每日一句；AI 能力自带 Key 即可用。",
        "subtitle": "开源离线词典 八语互查",
        "whatsNew": "新增生词本练习（词义/拼写/听音，熟练度追踪）、分语言词汇量自测、每日一句（词典例句优先、AI 生成兜底）；系统 TTS 朗读单词与例句；返回键导航与多项体验修复。",
    },
}

# ---------- JWT ----------
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
header = b64u(json.dumps({"alg": "ES256", "kid": kid}).encode())
payload = b64u(json.dumps({"iss": iss, "exp": int(time.time()) + 1200, "aud": "appstoreconnect-v1"}).encode())
si = header + b"." + payload
der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", p8], input=si, capture_output=True, check=True).stdout


def rint(buf, i):
    assert buf[i] == 0x02
    ln = buf[i + 1]
    return buf[i + 2 : i + 2 + ln], i + 2 + ln


r, i = rint(der, 2)
s, _ = rint(der, i)
r = r.lstrip(b"\x00") if len(r) > 32 else r
s = s.lstrip(b"\x00") if len(s) > 32 else s
JWT = (si + b"." + b64u(r.rjust(32, b"\x00") + s.rjust(32, b"\x00"))).decode()

BASE = "https://api.appstoreconnect.apple.com"


def api(method, path, body=None, raw=None, raw_type=None, raise_on_error=True):
    url = path if path.startswith("http") else BASE + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + JWT)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if raw_type:
        req.add_header("Content-Type", raw_type)
    try:
        with urllib.request.urlopen(req) as resp:
            payload_bytes = resp.read()
            return json.loads(payload_bytes) if payload_bytes else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"!! {method} {path} -> {e.code}: {body[:800]}")
        if raise_on_error:
            raise
        return {"__err": e.code, "body": body}


# ---------- 1. 找可编辑版本；没有就按 --create-version 建（过审后自动发布）----------
versions = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions")["data"]
editable = [v for v in versions if v["attributes"]["appStoreState"] == "PREPARE_FOR_SUBMISSION"]
if not editable:
    create_ver = opt("--create-version")
    if not create_ver:
        print("无可编辑版本（state != PREPARE_FOR_SUBMISSION）:", [v["attributes"]["appStoreState"] for v in versions])
        sys.exit(1)
    release_type = opt("--release-type", "AFTER_APPROVAL")
    created = api("POST", "/v1/appStoreVersions",
        {"data": {"type": "appStoreVersions",
                  "attributes": {"versionString": create_ver, "platform": "IOS", "releaseType": release_type},
                  "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})
    vid = created["data"]["id"]
    print(f"[1] 新建版本 {create_ver} id={vid}（releaseType={release_type}）")
else:
    vid = editable[0]["id"]
    print(f"[1] 版本 {editable[0]['attributes']['versionString']} id={vid}")

# ---------- 2. 本地化 ----------
locs = api("GET", f"/v1/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]
have = {l["attributes"]["locale"]: l["id"] for l in locs}
print("[2] 现有 locale:", list(have))
for locale, text in LOCALES.items():
    if locale not in have:
        created = api(
            "POST",
            "/v1/appStoreVersionLocalizations",
            {"data": {"type": "appStoreVersionLocalizations", "attributes": {"locale": locale},
                      "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}},
        )
        have[locale] = created["data"]["id"]
        print(f"    创建 locale {locale}")
    # subtitle 在 appInfoLocalization（不在 version localization schema）
    vattrs = {k: v for k, v in text.items() if k not in ("subtitle", "whatsNew")}
    api("PATCH", f"/v1/appStoreVersionLocalizations/{have[locale]}",
        {"data": {"type": "appStoreVersionLocalizations", "id": have[locale], "attributes": vattrs}})
    print(f"    填充 {locale} 描述/关键词/推广文本 ✓")

# 版权
api("PATCH", f"/v1/appStoreVersions/{vid}",
    {"data": {"type": "appStoreVersions", "id": vid, "attributes": {"copyright": COPYRIGHT}}})
print("[2] 版权 ✓")

# 副标题：appInfoLocalizations（en-US 已有则 PATCH；zh-Hans 缺则 CREATE）。
# app 级元数据有时处于锁定态（409 subtitle can not be modified）——非致命，
# 挂上 build 后再重试一次
infos = api("GET", f"/v1/apps/{APP_ID}/appInfos")["data"]
# app 有两个 appInfo（线上 READY_FOR_DISTRIBUTION 锁定态 + PREPARE_FOR_SUBMISSION 可编辑态），
# 副标题/分级挂在锁定的那个上会 409，必须选可编辑的
info_editable = [a for a in infos if a["attributes"].get("state") == "PREPARE_FOR_SUBMISSION"]
info_id = (info_editable or infos)[0]["id"]
info_locs = api("GET", f"/v1/appInfos/{info_id}/appInfoLocalizations")["data"]
info_by_locale = {l["attributes"]["locale"]: l["id"] for l in info_locs}


def patch_subtitle():
    failed = []
    for locale in LOCALES:
        attrs = {"subtitle": LOCALES[locale]["subtitle"]}
        if locale in info_by_locale:
            r = api("PATCH", f"/v1/appInfoLocalizations/{info_by_locale[locale]}",
                {"data": {"type": "appInfoLocalizations", "id": info_by_locale[locale], "attributes": attrs}},
                raise_on_error=False)
        else:
            r = api("POST", "/v1/appInfoLocalizations",
                {"data": {"type": "appInfoLocalizations", "attributes": {"locale": locale, **attrs},
                          "relationships": {"appInfo": {"data": {"type": "appInfos", "id": info_id}}}}},
                raise_on_error=False)
        if "__err" in r:
            failed.append(locale)
    return failed


subtitle_failed = patch_subtitle()
print("    副标题 ✓" if not subtitle_failed else f"    副标题暂锁（稍后重试）: {subtitle_failed}")

def upload_screenshot(set_id, fname, raw):
    """往 appScreenshotSet 里传一张图：创建记录 -> 分片上传 -> 标记完成"""
    created = api("POST", "/v1/appScreenshots",
        {"data": {"type": "appScreenshots",
                  "attributes": {"fileName": fname.split("/")[-1], "fileSize": len(raw)},
                  "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}}}})
    shot = created["data"]
    ops = shot.get("attributes", {}).get("uploadOperations") or shot.get("attributes", {}).get("assetDeliveryUploadOperations") or []
    for op in ops:
        req = urllib.request.Request(op["url"], data=raw[op["offset"] : op["offset"] + op["length"]], method=op["method"])
        headers = op.get("requestHeaders", {})
        if isinstance(headers, list):
            for h in headers:
                if isinstance(h, dict) and h.get("key"):
                    req.add_header(h["key"], h.get("value", ""))
        elif isinstance(headers, dict):
            req.add_header("Content-Type", headers.get("Content-Type", "application/octet-stream"))
        urllib.request.urlopen(req)
    api("PATCH", f"/v1/appScreenshots/{shot['id']}",
        {"data": {"type": "appScreenshots", "id": shot["id"],
                  "attributes": {"uploaded": True, "sourceFileChecksum": __import__("hashlib").md5(raw).hexdigest()}}})
    return shot


def ensure_set(loc_id, set_type):
    """找到（或创建）某 localization 下指定类型的截图 set"""
    sets = [x for x in api("GET", f"/v1/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")["data"] if x["attributes"].get("screenshotDisplayType") == set_type]
    if sets:
        return sets[0]["id"]
    return api("POST", "/v1/appScreenshotSets",
        {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": set_type},
                  "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc_id}}}}}
    )["data"]["id"]

# ---------- 3. 截图 ----------
# 现行 API：先建 appScreenshotSets（按 set 类型），再往 set 里加 appScreenshots 并上传
for fname, set_type in [(SCREENS[0], "APP_IPHONE_67"), (SCREENS[1], "APP_IPAD_PRO_129")] if len(SCREENS) == 2 else []:
    locale = have.get("zh-Hans") or list(have.values())[0]
    raw = open(fname, "rb").read()
    upload_screenshot(ensure_set(locale, set_type), fname, raw)
    print(f"[3] 截图 {set_type} ✓ ({len(raw)//1024}KB)")

# ---------- 3b. 从旧版本克隆截图（API 新建的版本截图为空，不补会被审核拒）----------
# 顺带从旧版本捞审核联系人电话（新版本没有 review detail，而电话是必填项）
clone_from = opt("--clone-from")
if clone_from:
    src = [v for v in versions if v["attributes"]["versionString"] == clone_from]
    if not src:
        print(f"[3b] 找不到版本 {clone_from}，跳过截图克隆")
    else:
        src_vid = src[0]["id"]
        rel = api("GET", f"/v1/appStoreVersions/{src_vid}/relationships/appStoreReviewDetail", raise_on_error=False)["data"]
        if rel.get("id") and not CONTACT_PHONE:
            rd = api("GET", f"/v1/appStoreReviewDetails/{rel['id']}")
            CONTACT_PHONE = rd["data"]["attributes"].get("contactPhone") or ""
        n = 0
        for sl in api("GET", f"/v1/appStoreVersions/{src_vid}/appStoreVersionLocalizations")["data"]:
            slocale = sl["attributes"]["locale"]
            if slocale not in have:
                created = api("POST", "/v1/appStoreVersionLocalizations",
                    {"data": {"type": "appStoreVersionLocalizations", "attributes": {"locale": slocale},
                              "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
                have[slocale] = created["data"]["id"]
            for sset in api("GET", f"/v1/appStoreVersionLocalizations/{sl['id']}/appScreenshotSets")["data"]:
                stype = sset["attributes"]["screenshotDisplayType"]
                dset_id = ensure_set(have[slocale], stype)
                exist = api("GET", f"/v1/appScreenshotSets/{dset_id}/appScreenshots")["data"]
                if exist:
                    continue  # 目标 set 已有图（重跑场景），不动
                for shot in api("GET", f"/v1/appScreenshotSets/{sset['id']}/appScreenshots")["data"]:
                    dl = (shot["attributes"].get("assetDeliveryState") or {}).get("url")
                    if not dl:
                        continue
                    raw = urllib.request.urlopen(dl).read()
                    upload_screenshot(dset_id, shot["attributes"]["fileName"], raw)
                    n += 1
        print(f"[3b] 从 {clone_from} 克隆截图 {n} 张 ✓" + (f"，审核电话 {CONTACT_PHONE}" if CONTACT_PHONE else ""))

# ---------- 3c. 按 --shots-json 批量传截图（[{"locale","set","files":[...]}]）----------
if "--shots-json" in sys.argv:
    spec = json.load(open(os.path.expanduser(sys.argv[sys.argv.index("--shots-json") + 1])))
    for item in spec:
        loc_id = have.get(item["locale"])
        if not loc_id:
            print(f"[3c] {item['locale']} 无 localization，跳过")
            continue
        dset_id = ensure_set(loc_id, item["set"])
        exist = api("GET", f"/v1/appScreenshotSets/{dset_id}/appScreenshots")["data"]
        if exist:
            print(f"[3c] {item['locale']}/{item['set']} 已有 {len(exist)} 张，跳过")
            continue
        for f in item["files"]:
            raw = open(os.path.expanduser(f), "rb").read()
            upload_screenshot(dset_id, os.path.basename(f), raw)
        print(f"[3c] {item['locale']}/{item['set']} 上传 {len(item['files'])} 张 ✓")

# ---------- 4. 年龄分级问卷（全否 => 4+）----------
# 踩坑：字段类型混合——大部分是枚举字符串（NONE/…），v2 新增的几项是 BOOLEAN；
# kidsAgeBand 只接受 FIVE_AND_UNDER/SIX_TO_EIGHT/NINE_TO_ELEVEN，没有就整个别传
req = urllib.request.Request(f"{BASE}/v1/appInfos/{info_id}/ageRatingDeclaration",
                             headers={"Authorization": "Bearer " + JWT})
ard_id = json.load(urllib.request.urlopen(req))["data"]["id"]
AGE_ATTRS = {
    "alcoholTobaccoOrDrugUseOrReferences": "NONE",
    "contests": "NONE",
    "gambling": False,
    "gamblingSimulated": "NONE",
    "horrorOrFearThemes": "NONE",
    "matureOrSuggestiveThemes": "NONE",
    "medicalOrTreatmentInformation": "NONE",
    "profanityOrCrudeHumor": "NONE",
    "sexualContentGraphicAndNudity": "NONE",
    "sexualContentOrNudity": "NONE",
    "unrestrictedWebAccess": False,
    "userGeneratedContent": False,
    "violenceCartoonOrFantasy": "NONE",
    "violenceRealistic": "NONE",
    "violenceRealisticProlongedGraphicOrSadistic": "NONE",
    "advertising": False,
    "ageAssurance": False,
    "gunsOrOtherWeapons": "NONE",
    "healthOrWellnessTopics": False,
    "lootBox": False,
    "messagingAndChat": False,
    "parentalControls": False,
    # 2025 新增必填项（漏一个整个 PATCH 409）
    "socialMedia": "NONE",
    "meetAndGreet": "NONE",
    "contestsWithRealPrizes": "NONE",
}
api("PATCH", f"/v1/ageRatingDeclarations/{ard_id}",
    {"data": {"type": "ageRatingDeclarations", "id": ard_id, "attributes": AGE_ATTRS}})
print("[4] 年龄分级问卷（全否 => 4+）✓")

# ---------- 5. 分类 + 隐私政策 + 支持 URL ----------
# appCategories 的资源 id 就是枚举名（REFERENCE/EDUCATION…），attributes 里没有 name 字段
api("PATCH", f"/v1/appInfos/{info_id}",
    {"data": {"type": "appInfos", "id": info_id, "relationships": {
        "primaryCategory": {"data": {"type": "appCategories", "id": "REFERENCE"}},
        "secondaryCategory": {"data": {"type": "appCategories", "id": "EDUCATION"}}}}})
print("[5] 分类 Reference/Education ✓")
# 隐私政策 URL：appInfoLocalization 属性
for locale in list(have):
    il = info_by_locale.get(locale)
    if il:
        api("PATCH", f"/v1/appInfoLocalizations/{il}",
            {"data": {"type": "appInfoLocalizations", "id": il,
                      "attributes": {"privacyPolicyUrl": PRIVACY_URL}}})
print("[5] 隐私政策 URL ✓")

# ---------- 6. 关联 build（取 latest VALID，版本无 build 时才挂）----------
# 踩坑：/v1/appStoreVersions/{vid}/builds 子路径不存在（404），已挂的 build 走
# relationships/build 单数端点查；候选 build 用 /v1/builds?filter[app]= 列
cur = api("GET", f"/v1/appStoreVersions/{vid}/relationships/build")["data"]
if cur.get("id"):
    print(f"[6] 版本已关联 build（id={cur['id'][:8]}…），跳过")
else:
    all_builds = api("GET", f"/v1/builds?filter[app]={APP_ID}&sort=-version")["data"]
    if "--require-build" in sys.argv:
        want = sys.argv[sys.argv.index("--require-build") + 1]
        match = [b for b in all_builds if str(b["attributes"]["version"]) == want]
        if not match:
            print(f"[6] build {want} 不存在"); sys.exit(1)
        if match[0]["attributes"]["processingState"] != "VALID":
            print(f"[6] build {want} 还没处理完（{match[0]['attributes']['processingState']}），等处理完重跑"); sys.exit(1)
        pick = match[0]
    else:
        valid = [b for b in all_builds if b["attributes"]["processingState"] == "VALID"]
        if not valid:
            print("[6] 无 VALID build，跳过（等 TestFlight 处理完重跑）")
            pick = None
        else:
            pick = valid[0]
    if pick:
        api("PATCH", f"/v1/appStoreVersions/{vid}",
            {"data": {"type": "appStoreVersions", "id": vid,
                      "relationships": {"build": {"data": {"type": "builds", "id": pick["id"]}}}}})
        print(f"[6] 关联 build {pick['attributes']['version']} ✓")

# ---------- 7. 审核联系人 ----------
# 踩坑：appStoreReviewDetails 禁用 GET_COLLECTION（403），id 只能从 version 的
# relationships 端点拿（/appStoreReviewDetail 单数）；PATCH 必须带全 contact* 字段
rel = api("GET", f"/v1/appStoreVersions/{vid}/relationships/appStoreReviewDetail")["data"]
review_attrs = {"contactFirstName": CONTACT_FIRST, "contactLastName": CONTACT_LAST,
                "contactEmail": CONTACT_EMAIL, "demoAccountName": "", "demoAccountPassword": "",
                "demoAccountRequired": False, "notes": CONTACT_NOTES}
if CONTACT_PHONE:
    review_attrs["contactPhone"] = CONTACT_PHONE
if rel.get("id"):
    api("PATCH", f"/v1/appStoreReviewDetails/{rel['id']}",
        {"data": {"type": "appStoreReviewDetails", "id": rel["id"], "attributes": review_attrs}})
    print("[7] 审核联系人 ✓")
else:
    api("POST", "/v1/appStoreReviewDetails",
        {"data": {"type": "appStoreReviewDetails", "attributes": review_attrs,
                  "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
    print("[7] 审核联系人（新建）✓")

print("\n完成。剩余网页操作：")
print("  - App Privacy：选 Data Not Collected（API 无此端点）")
if subtitle_failed:
    subtitle_failed = patch_subtitle()
    print("[7b] 副标题重试 ✓" if not subtitle_failed else f"[7b] 副标题仍锁定（网页手动改）: {subtitle_failed}")

if "--submit" in sys.argv:
    sub = api("POST", "/v1/appStoreSubmissions",
        {"data": {"type": "appStoreSubmissions",
                  "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}},
        raise_on_error=False)
    if "__err" in sub:
        print(f"[8] 提交审核失败: {sub.get('body', '')[:400]}")
        print("  - 请到 ASC 网页手动 Submit for Review（先补上面的网页项）")
    else:
        print("[8] 已提交审核 ✓（过审后按版本 releaseType 自动/手动发布）")
else:
    print("  - 确认无误后点 Submit for Review（或加 --submit 由 API 提交）")
