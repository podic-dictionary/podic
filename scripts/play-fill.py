#!/usr/bin/env python3
"""Google Play 商店材料自动填报（podic Android Closed Testing）。

用法: python3 scripts/play-fill.py <service-account.json> [--aab path] [--assets dir] [--track closed]
前置条件（Console 网页操作，API 做不了）：
  1. Play Console 已创建应用 com.felix021.podic（草稿即可）
  2. 设置 -> API 访问权限：把服务账号关联到 Play 账号并授予
     「查看应用信息 + 发布到测试轨道」权限
填报内容：
  - 上传 AAB 到指定轨道（release status=draft，不会自动放量）
  - zh-CN / en-US 商店文案（标题/简短/完整描述）
  - 手机截图（最多 4 张）+ 512 图标 + 1024x500 特色图片
不含（只能网页填）：内容分级问卷、数据安全表单、目标受众、测试人员名单。
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse
import urllib.error

SA_PATH = [a for a in sys.argv[1:] if a.endswith(".json")][0]
PKG = "com.felix021.podic"
AAB = "android/app/build/outputs/bundle/release/app-release.aab"
ASSETS = "store-assets/play"
TRACK = "alpha"  # 老版 API 轨道名，Console 里显示为「封闭测试」（closed 会 404）

sa = json.load(open(SA_PATH))
proxy = os.environ["PODIC_PROXY"]  # 访问 googleapis 用的代理（如 http://<proxy-host>:7890）
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy, "http": proxy}))
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def token():
    pem = tempfile.NamedTemporaryFile(mode="w", suffix=".pem", delete=False)
    pem.write(sa["private_key"])
    pem.close()
    os.chmod(pem.name, 0o600)
    iat = int(time.time())
    claims = {"iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/androidpublisher",
              "aud": "https://oauth2.googleapis.com/token", "iat": iat, "exp": iat + 3600}
    si = b64u(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()) + "." + b64u(json.dumps(claims).encode())
    der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", pem.name],
                         input=si.encode(), capture_output=True, check=True).stdout
    data = urllib.parse.urlencode(
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": si + "." + b64u(der)}).encode()
    tok = json.load(opener.open(urllib.request.Request("https://oauth2.googleapis.com/token", data=data)))
    os.unlink(pem.name)
    return tok["access_token"]


TOK = token()


def api(method, path, body=None, raw=None, ctype="application/json"):
    url = path if path.startswith("http") else \
        f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{PKG}/{path}"
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with opener.open(req) as resp:
            b = resp.read()
            return json.loads(b) if b else {}
    except urllib.error.HTTPError as e:
        print(f"!! {method} {path} -> {e.code}: {e.read().decode()[:500]}")
        raise


# ---------- 0. Listing 文案 ----------
L10N = {
    "zh-CN": {
        "title": "Podic 词典：开源离线英法日语典",
        "shortDescription": "干净清爽的开源词典，英法日与中文互查，离线可用，AI 增强自带 Key。",
        "fullDescription": (
            "Podic 是一款干净清爽的开源词典应用，支持英 / 法 / 日三语与中文互查。\n"
            "全部词典数据来自自由许可的开源语料（ECDICT、CFDICT、JMdict、Tatoeba 等），"
            "安装即含全部离线数据，无需注册登录，无广告、无内置付费。\n\n"
            "【功能】\n"
            "• 离线查词：词头、音标、词性、屈折变形、真实语料例句与中文翻译\n"
            "• 三语支持：英语（77 万+ 词头）、法语（音标 + 词性 + 阴阳性 + 屈折）、日语（汉字 + 假名读音 + 变形还原）\n"
            "• 中文反查：输入中文即可找到对应单词\n"
            "• 生词本：收藏单词、随手复习\n"
            "• 整句翻译：任意句子译成中文（可选）\n"
            "• AI 增强（可选）：自带 API Key 即可启用深度讲解、例句生成、释义补全；不配置则完全不影响使用\n\n"
            "【开源】\n"
            "应用源代码与词典数据管道全部公开可审计，遵循各数据源的自由许可并逐一署名。\n\n"
            "【隐私】\n"
            "不收集任何个人数据：无账号体系、无统计分析、无广告追踪，所有数据仅保存在设备上。\n"
            "隐私政策：https://podic-dictionary.github.io/podic-site/privacy.html"
        ),
    },
    "en-US": {
        "title": "Podic - Open-source Dictionary",
        "shortDescription": "Clean open-source offline dictionary: English, French, Japanese to Chinese.",
        "fullDescription": (
            "Podic is a clean, open-source dictionary app for English / French / Japanese <-> Chinese.\n"
            "All dictionary data comes from freely-licensed open corpora (ECDICT, CFDict, JMdict, Tatoeba). "
            "Everything is bundled for fully offline use - no account, no ads, no in-app purchases.\n\n"
            "FEATURES\n"
            "- Offline lookups: headwords, IPA, senses, inflections and real-usage example sentences with Chinese translations\n"
            "- Three languages: English (770k+ headwords), French (IPA + gender + inflections), Japanese (kanji + readings + deinflection)\n"
            "- Reverse lookup: type Chinese to find the word\n"
            "- Favorites for vocabulary building\n"
            "- Full-sentence translation (optional)\n"
            "- AI enhancements (optional): bring your own API key for deep explanations, generated examples and sense completion\n\n"
            "OPEN SOURCE\n"
            "Source code and the data pipeline are fully public and auditable; every data source is credited under its license.\n\n"
            "PRIVACY\n"
            "No personal data is collected: no accounts, no analytics, no ads or tracking. All data stays on your device.\n"
            "Privacy policy: https://podic-dictionary.github.io/podic-site/privacy.html"
        ),
    },
}

# ---------- 1. 打开 edit ----------
edit = api("POST", "edits", {})
edit_id = edit["id"]
print(f"[1] edit={edit_id}")

# ---------- 2. 上传 AAB 并挂到轨道（draft，不自动放量）----------
if "--aab" in sys.argv:
    AAB = sys.argv[sys.argv.index("--aab") + 1]
size = os.path.getsize(AAB)
have = [b["versionCode"] for b in api("GET", f"edits/{edit_id}/bundles").get("bundles", [])]
if have:
    vc = have[0]
    print(f"[2] AAB 已在 edit 里，跳过上传（versionCode={vc}）")
else:
    bundle = api("POST",
                 f"https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/"
                 f"{PKG}/edits/{edit_id}/bundles?uploadType=media",
                 raw=open(AAB, "rb").read(), ctype="application/octet-stream")
    vc = bundle["versionCode"]
    print(f"[2] AAB 上传 ✓ versionCode={vc} ({size // 1048576}MB)")
track_body = {"track": TRACK, "releases": [{"name": f"0.2.2 ({vc})", "versionCodes": [vc], "status": "draft"}]}
api("PUT", f"edits/{edit_id}/tracks/{TRACK}", track_body)
print(f"[2] 轨道 {TRACK} 挂 versionCode={vc}（draft）✓")

# ---------- 3. 商店文案 ----------
# 踩坑：v3 没有 listings.create；update(PUT) 是 upsert，不存在的语言会直接建
for lang, t in L10N.items():
    api("PUT", f"edits/{edit_id}/listings/{lang}", {"language": lang, **t})
    print(f"[3] {lang} 文案 ✓")

# ---------- 4. 图片（先清后传，幂等）----------
if "--assets" in sys.argv:
    ASSETS = sys.argv[sys.argv.index("--assets") + 1]


def upload_image(lang, etype, path):
    existing = api("GET", f"edits/{edit_id}/listings/{lang}/{etype}") or {"images": []}
    for im in existing.get("images", []):
        api("DELETE", f"edits/{edit_id}/listings/{lang}/{etype}/{im['id']}")
    data = open(path, "rb").read()
    url = ("https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/"
           f"{PKG}/edits/{edit_id}/listings/{lang}/{etype}?uploadType=media")
    api("POST", url, raw=data, ctype="image/png")


shots = ["phone-1-search-en.png", "phone-2-search-fr.png", "phone-3-ai-explain.png", "phone-4-translate.png"]
for lang in L10N:
    for s in shots:
        upload_image(lang, "phoneScreenshots", os.path.join(ASSETS, s))
    upload_image(lang, "featureGraphic", os.path.join(ASSETS, "feature-graphic.png"))
    upload_image(lang, "icon", os.path.join(ASSETS, "app-icon-512.png"))
    print(f"[4] {lang} 图片 ✓（{len(shots)} 截图 + 特色图 + 图标）")

# ---------- 5. 提交 edit（仅草稿变更，不发布）----------
api("POST", f"edits/{edit_id}:commit")
print("[5] commit ✓（AAB 与素材均在草稿态，Console 里人工复核后手动放量）")
