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
            "Podic is a clean, open-source dictionary app for English / French / Japanese ↔ Chinese.\n\n"
            "• Offline lookups: headwords, IPA, senses, inflections and real-usage example sentences\n"
            "• Reverse lookup: type Chinese to find the word\n"
            "• Open data: built from freely-licensed corpora (ECDICT, CFDict, JMdict, Tatoeba)\n"
            "• Optional AI: bring your own API key for deep explanations, generated examples, "
            "sense completion and translation\n\n"
            "No account, no ads, no tracking. All data stays on your device."
        ),
        "keywords": "dictionary,offline,english,french,japanese,chinese,translation,open source",
        "promotionalText": "Open source. Fully offline. Bring your own AI key.",
        "subtitle": "Open-source offline dictionary",
        "whatsNew": "First release on the App Store.",
    },
    "zh-Hans": {
        "description": (
            "Podic 词典是一款干净清爽的开源词典应用，支持英 / 法 / 日三语与中文互查。"
            "全部词典数据来自自由许可的开源语料（ECDICT、CFDICT、JMdict、Tatoeba 等），离线可用，无需注册登录。\n\n"
            "• 离线查词：词头、音标、词性、屈折变形、真实语料例句与中文翻译\n"
            "• 中文反查：输入中文找到对应单词\n"
            "• AI 增强（可选）：自带 API Key 即可启用深度讲解、例句生成、释义补全与整句翻译\n\n"
            "Podic 不收集任何个人数据，无广告、无内置付费；所有数据仅保存在你的设备上。"
        ),
        "keywords": "词典,英语,法语,日语,离线,翻译,开源,英汉词典,日汉,法汉",
        "promotionalText": "开源、离线、无广告；AI 能力自带 Key 即可用。",
        "subtitle": "开源离线词典 英法日",
        "whatsNew": "首个 App Store 版本。",
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


# ---------- 1. 找可编辑版本 ----------
versions = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions")["data"]
editable = [v for v in versions if v["attributes"]["appStoreState"] == "PREPARE_FOR_SUBMISSION"]
if not editable:
    print("无可编辑版本（state != PREPARE_FOR_SUBMISSION）:", [v["attributes"]["appStoreState"] for v in versions])
    sys.exit(1)
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

# 副标题：appInfoLocalizations（en-US 已有则 PATCH；zh-Hans 缺则 CREATE）
infos = api("GET", f"/v1/apps/{APP_ID}/appInfos")["data"]
info_id = infos[0]["id"]
info_locs = api("GET", f"/v1/appInfos/{info_id}/appInfoLocalizations")["data"]
info_by_locale = {l["attributes"]["locale"]: l["id"] for l in info_locs}
for locale, text in LOCALES.items():
    attrs = {"subtitle": text["subtitle"]}
    if locale in info_by_locale:
        api("PATCH", f"/v1/appInfoLocalizations/{info_by_locale[locale]}",
            {"data": {"type": "appInfoLocalizations", "id": info_by_locale[locale], "attributes": attrs}})
    else:
        api("POST", "/v1/appInfoLocalizations",
            {"data": {"type": "appInfoLocalizations", "attributes": {"locale": locale, **attrs},
                      "relationships": {"appInfo": {"data": {"type": "appInfos", "id": info_id}}}}})
    print(f"    副标题 {locale} ✓")

# ---------- 3. 截图 ----------
# 现行 API：先建 appScreenshotSets（按 set 类型），再往 set 里加 appScreenshots 并上传
for fname, set_type in [(SCREENS[0], "APP_IPHONE_67"), (SCREENS[1], "APP_IPAD_PRO_129")] if len(SCREENS) == 2 else []:
    locale = have.get("zh-Hans") or list(have.values())[0]
    raw = open(fname, "rb").read()
    sets = [x for x in api("GET", f"/v1/appStoreVersionLocalizations/{locale}/appScreenshotSets")["data"] if x["attributes"].get("screenshotDisplayType") == set_type]
    if sets:
        set_id = sets[0]["id"]
    else:
        set_id = api("POST", "/v1/appScreenshotSets",
            {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": set_type},
                      "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": locale}}}}}
        )["data"]["id"]
    created = api("POST", "/v1/appScreenshots",
        {"data": {"type": "appScreenshots",
                  "attributes": {"fileName": fname.split("/")[-1], "fileSize": len(raw)},
                  "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}}}})
    shot = created["data"]
    print("SHOT ATTRS:", json.dumps(shot.get("attributes", {}))[:300]); ops = shot.get("attributes", {}).get("uploadOperations") or shot.get("attributes", {}).get("assetDeliveryUploadOperations") or []
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
    print(f"[3] 截图 {set_type} ✓ ({len(raw)//1024}KB)")

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
    valid = [b for b in all_builds if b["attributes"]["processingState"] == "VALID"]
    if not valid:
        print("[6] 无 VALID build，跳过（等 TestFlight 处理完重跑）")
    else:
        api("PATCH", f"/v1/appStoreVersions/{vid}",
            {"data": {"type": "appStoreVersions", "id": vid,
                      "relationships": {"build": {"data": {"type": "builds", "id": valid[0]["id"]}}}}})
        print(f"[6] 关联 build {valid[0]['attributes']['version']} ✓")

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
print("  - 确认无误后点 Submit for Review")
