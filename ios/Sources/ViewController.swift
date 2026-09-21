import UIKit
import WebKit

/// WKWebView 指向设备内 podic 后端（127.0.0.1:{port}）。
/// 首启把 Bundle 里的 web/ 与 packs/*.db 落到 Documents/data（packs 不覆盖已有文件）。
class ViewController: UIViewController, WKNavigationDelegate {
    private(set) var webView: WKWebView!
    /// 待执行的深链接查询（podic:// URL / launch 参数 -search hi -lang en），页面加载完后执行
    var pendingSearch: (query: String, lang: String?)?

    override func loadView() {
        webView = WKWebView(frame: .zero)
        webView.navigationDelegate = self
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let dataDir = docs.appendingPathComponent("data", isDirectory: true)
            try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
            installAssets(dataDir: dataDir)

            let dirCString = dataDir.path.cString(using: .utf8)!
            let port = podic_start_server(dirCString, 0) // 0=内核挑空闲端口，杜绝端口冲突
            DispatchQueue.main.async { [self] in
                if port > 0 {
                    webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)")!))
                } else {
                    webView.loadHTMLString("podic 后端启动失败，请重启应用", baseURL: nil)
                }
            }
        }
    }

    /// 深链接查询入口（AppDelegate 的 URL/启动参数都会走到这里）
    func runSearch(query: String, lang: String?) {
        pendingSearch = (query, lang)
        flushPendingSearch()
    }

    private func flushPendingSearch(retry: Int = 10) {
        guard let s = pendingSearch else { return }
        if webView.isLoading {
            if retry > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.flushPendingSearch(retry: retry - 1) } }
            return
        }
        let q = s.query.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        let jsLang = s.lang.map { ", '\($0)'" } ?? ""
        webView.evaluateJavaScript(
            "(function(){ if (window.__podicSearch) { __podicSearch('\(q)'\(jsLang)); return true } return false })()"
        ) { [weak self] result, error in
            NSLog("podic flush retry=\(retry) result=\(String(describing: result)) error=\(String(describing: error))")
            // __podicSearch 尚未挂载（首启解压资产期间 load 未开始/React bundle 未执行）：
            // 保留 pending 继续重试；didFinish 也会再兜底触发一次
            if (result as? Bool) != true, retry > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self?.pendingSearch = s
                    self?.flushPendingSearch(retry: retry - 1)
                }
            } else if (result as? Bool) == true {
                self?.pendingSearch = nil
            }
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated { self.flushPendingSearch() }
    }

    /// Bundle Resources/web 与 Resources/packs -> Documents/data
    private func installAssets(dataDir: URL) {
        guard let resource = Bundle.main.resourceURL else { return }
        let fm = FileManager.default

        // web：每次启动按 Bundle 版本替换（粗略：目录不存在才拷；升级场景交给 Marker/版本号策略，先保持与 Android 一致的简化版）
        let web = dataDir.appendingPathComponent("web", isDirectory: true)
        if !fm.fileExists(atPath: web.path) {
            try? fm.copyItem(at: resource.appendingPathComponent("web"), to: web)
        }

        let packs = dataDir.appendingPathComponent("packs", isDirectory: true)
        try? fm.createDirectory(at: packs, withIntermediateDirectories: true)
        if let entries = try? fm.contentsOfDirectory(atPath: resource.appendingPathComponent("packs").path) {
            for name in entries where name.hasSuffix(".db") {
                let dest = packs.appendingPathComponent(name)
                if fm.fileExists(atPath: dest.path) { continue }
                try? fm.copyItem(at: resource.appendingPathComponent("packs").appendingPathComponent(name), to: dest)
            }
        }
    }
}
