#!/usr/bin/env python3
"""Google Play 轨道发布工具（service account 走 Android Publisher API v3）。

用法:
  PODIC_PROXY=http://… python3 scripts/play-release.py                     # 只读：列出各轨道
  PODIC_PROXY=http://… python3 scripts/play-release.py --track alpha \\
      --aab android/app/build/outputs/bundle/release/app-release.aab \\
      --version-code 12 --name "0.5.0 (12)" --notes-zh "……" [--notes-en "…"]

- 轨道: alpha = closed testing（beta/production 同理）；internal = internal testing
- 上传 AAB 必须走 media-upload 端点（?uploadType=media），普通端点把二进制当
  JSON 解析报 Invalid JSON payload / Unexpected token PK——踩过一次，别再踩
- service account: ~/.config/podic/podic@google-play@gcp.json（走 PODIC_PROXY 代理）
- 发布流程: 建 edit -> 上传 bundle -> 挂 track（completed 全量）-> commit
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PKG = "com.felix021.podic"
BASE = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{PKG}"
UPBASE = f"https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{PKG}"


def get_token(opener):
    sa = json.load(open(os.path.expanduser("~/.config/podic/podic@google-play@gcp.json")))
    b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    pem = tempfile.NamedTemporaryFile(mode="w", suffix=".pem", delete=False)
    pem.write(sa["private_key"])
    pem.close()
    os.chmod(pem.name, 0o600)
    try:
        iat = int(time.time())
        claims = {"iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/androidpublisher",
                  "aud": "https://oauth2.googleapis.com/token", "iat": iat, "exp": iat + 600}
        si = b64u(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()) + "." + b64u(json.dumps(claims).encode())
        der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", pem.name],
                             input=si.encode(), capture_output=True, check=True).stdout
        data = urllib.parse.urlencode(
            {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
             "assertion": si + "." + b64u(der)}).encode()
        return json.load(opener.open(
            urllib.request.Request("https://oauth2.googleapis.com/token", data=data)))["access_token"]
    finally:
        os.unlink(pem.name)


def resumable_upload(opener, tok, eid, path, chunk=8 << 20, retries=6):
    """分块断点续传上传 AAB。

    一次 140MB 的 uploadType=media 走代理常见「发完没响应/SSL EOF」（2026-11-25 连踩两次，
    22 分钟挂死）；resumable 协议每块独立请求，断点由 Range 头对齐，单块失败只重传该块。
    """
    total = os.path.getsize(path)
    req = urllib.request.Request(
        f"{UPBASE}/edits/{eid}/bundles?uploadType=resumable", method="POST", data=b"",
        headers={"Authorization": "Bearer " + tok,
                 "X-Upload-Content-Type": "application/octet-stream",
                 "X-Upload-Content-Length": str(total),
                 "Content-Length": "0"})
    resp = opener.open(req)
    url = resp.headers["Location"]
    print(f"resumable: {total/1048576:.1f}MB，chunk {chunk>>20}MB")

    off = 0
    with open(path, "rb") as f:
        while off < total:
            f.seek(off)
            data = f.read(chunk)
            end = off + len(data) - 1
            for attempt in range(1, retries + 1):
                try:
                    r = urllib.request.Request(
                        url, method="PUT", data=data,
                        headers={"Authorization": "Bearer " + tok,
                                 "Content-Type": "application/octet-stream",
                                 "Content-Length": str(len(data)),
                                 "Content-Range": f"bytes {off}-{end}/{total}"})
                    body = opener.open(r, timeout=180).read()
                    up = json.loads(body) if body else {}
                    print(f"上传完成 versionCode={up.get('versionCode')}")
                    return up
                except urllib.error.HTTPError as e:
                    # 308 = 还没传完；Range 头告诉服务器已经收了多少
                    if e.code == 308:
                        rng = e.headers.get("Range")
                        off = int(rng.split("-")[1]) + 1 if rng else off
                        break
                    if e.code in (401, 403, 404):
                        sys.exit(f"!! 上传块被拒 {e.code}: {e.read().decode()[:300]}")
                    print(f"  块 {off}-{end} 失败 {e.code}（第 {attempt} 次），重试")
                except Exception as e:  # noqa: BLE001 网络层异常种类多，统一重试
                    print(f"  块 {off}-{end} 网络异常 {type(e).__name__}: {e}（第 {attempt} 次），重试")
                time.sleep(min(2 ** attempt, 30))
                # 询问服务器已收到哪，避免盲目重发整块
                q = urllib.request.Request(
                    url, method="PUT", data=b"",
                    headers={"Authorization": "Bearer " + tok,
                             "Content-Length": "0",
                             "Content-Range": f"bytes */{total}"})
                try:
                    body = opener.open(q, timeout=60).read()
                    return json.loads(body) if body else {}
                except urllib.error.HTTPError as e2:
                    if e2.code == 308:
                        rng = e2.headers.get("Range")
                        off = int(rng.split("-")[1]) + 1 if rng else off
                        break
            else:
                sys.exit(f"!! 块 {off}-{end} 重试 {retries} 次仍失败")
        else:
            return {}
    sys.exit("!! 上传结束但未拿到 bundle 信息")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", choices=["internal", "alpha", "beta", "production"])
    ap.add_argument("--aab")
    ap.add_argument("--version-code")
    ap.add_argument("--name")
    ap.add_argument("--notes-zh", dest="notes_zh")
    ap.add_argument("--notes-en", dest="notes_en")
    args = ap.parse_args()

    # 中国大陆机器需 PODIC_PROXY 走代理；海外机器可直连
    if os.environ.get("PODIC_PROXY"):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler(
            {"https": os.environ["PODIC_PROXY"], "http": os.environ["PODIC_PROXY"]}))
    else:
        opener = urllib.request.build_opener()
    tok = get_token(opener)

    def api(method, url, body=None, raw=None, ctype="application/json"):
        req = urllib.request.Request(url, method=method,
                                     data=raw if raw is not None else (json.dumps(body).encode() if body else None),
                                     headers={"Authorization": "Bearer " + tok})
        if raw is not None:
            req.add_header("Content-Type", ctype)
        elif body:
            req.add_header("Content-Type", "application/json")
        try:
            b = opener.open(req).read()
            return json.loads(b) if b else {}
        except urllib.error.HTTPError as e:
            sys.exit(f"!! {method} {url} -> {e.code}: {e.read().decode()[:500]}")

    # 只读模式：列出各轨道现状
    if not args.track:
        eid = api("POST", BASE + "/edits", {})["id"]
        try:
            for t in api("GET", f"{BASE}/edits/{eid}/tracks").get("tracks", []):
                print("track:", t["track"])
                for r in t.get("releases", []):
                    print("  ", r.get("name"), r["status"], r.get("versionCodes"),
                          "fraction:", r.get("userFraction"))
        finally:
            api("DELETE", f"{BASE}/edits/{eid}")
        return

    # 发布模式
    for k, v in [("--aab", args.aab), ("--version-code", args.version_code),
                 ("--name", args.name), ("--notes-zh", args.notes_zh)]:
        if not v:
            sys.exit(f"发布模式缺 {k}")
    eid = api("POST", BASE + "/edits", {})["id"]
    print("edit:", eid)
    up = resumable_upload(opener, tok, eid, args.aab)
    if str(up.get("versionCode")) != str(args.version_code):
        sys.exit(f"上传的 versionCode={up.get('versionCode')} 与预期 {args.version_code} 不符"
                 "（aab 的 versionCode 先于参数，以 aab 为准改参数）")
    print("bundle 上传: versionCode", up["versionCode"])
    notes = [{"language": "zh-CN", "text": args.notes_zh}]
    if args.notes_en:
        notes.append({"language": "en-US", "text": args.notes_en})
    api("PUT", f"{BASE}/edits/{eid}/tracks/{args.track}", {
        "track": args.track,
        "releases": [{"name": args.name, "versionCodes": [str(args.version_code)],
                      "status": "completed", "releaseNotes": notes}]})
    print(f"{args.track} 轨道已挂 {args.version_code}")
    api("POST", f"{BASE}/edits/{eid}:commit")
    print("commit ✓ 发布完成")


if __name__ == "__main__":
    main()
