import UIKit
import WebKit

/// WKWebView 指向设备内 podic 后端（127.0.0.1:{port}）。
/// 首启把 Bundle 里的 web/ 与 packs/*.db 落到 Documents/data（packs 不覆盖已有文件）。
class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private(set) var webView: WKWebView!
    /// 待执行的深链接查询（podic:// URL / launch 参数 -search hi -lang en），页面加载完后执行
    var pendingSearch: (query: String, lang: String?)?
    /// SPA 渲染用的离屏 WebView（同屏只留一个，新请求会换掉旧的）
    private var renderView: WKWebView?
    /// 进行中渲染请求的 token（换请求/超时后置空，迟到回调靠它丢弃）
    private var renderToken: String?
    /// 本地后端端口（恢复流程要对比重启前后是否换了 origin）
    private var serverPort: Int32 = 0
    /// 恢复流程互斥：探活/重启/重载一次只跑一个（didBecomeActive 可能连发）
    private var recovering = false

    override func loadView() {
        webView = WKWebView(frame: .zero)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.configuration.userContentController.add(self, name: "podicRender")
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
                    serverPort = port
                    // 端口进统一日志：真机「Load failed」排查时 simctl/log 直接可查
                    NSLog("podic server on 127.0.0.1:\(port)")
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

    /// 深链接路由：podic://search?q=… -> location.hash = "#/search?q=…"（前端 hash 路由消费）。
    /// 页面未加载完成时挂起，didFinish 后重放
    private var pendingHash: String?

    func openHash(_ hash: String) {
        let js = "location.hash=\(Self.jsJson(hash))"
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            if result == nil { self?.pendingHash = hash } // 页面未就绪：加载完重放
        }
    }

    private func flushPendingHash() {
        guard let h = pendingHash else { return }
        pendingHash = nil
        openHash(h)
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

    /// 回前台/解锁后探活本地后端；挂了就重启并重载页面（保留当前路径与 hash）。
    /// iOS 挂起可能让 listener 被系统回收（TN2277）或后端线程退出，壳不恢复的话
    /// 所有 /api 请求会永久 Load failed（每日一句打开即请求，最先暴露）
    func recoverServerIfNeeded() {
        guard !recovering, serverPort > 0 else { return }
        recovering = true
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(serverPort)/api/health")!)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            let healthy = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                guard let self else { return }
                defer { self.recovering = false }
                guard !healthy else { return }
                NSLog("podic health check failed after resume, restarting server")
                let newPort = podic_restart_server()
                guard newPort > 0 else {
                    NSLog("podic server restart failed")
                    return
                }
                if newPort == self.serverPort {
                    self.webView.reload() // 同端口：页面重新请求即可
                    return
                }
                // 换端口 = 换 origin：保留当前路径/查询/hash 重载，尽量回到原界面
                self.serverPort = newPort
                var comps = URLComponents()
                comps.scheme = "http"
                comps.host = "127.0.0.1"
                comps.port = Int(newPort)
                if let cur = self.webView.url.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) {
                    comps.path = cur.path
                    comps.query = cur.query
                    comps.fragment = cur.fragment
                } else {
                    comps.path = "/"
                }
                if let url = comps.url {
                    self.webView.load(URLRequest(url: url))
                }
            }
        }.resume()
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated {
            if webView === self.webView {
                self.flushPendingSearch()
                self.flushPendingHash()
            } else {
                self.renderViewDidFinish(webView)
            }
        }
    }

    /// 只拦主视图的外链导航（教程等 http(s) 非本机地址 → 系统浏览器）；
    /// SPA 渲染的离屏 WebView 共用本 delegate，必须放行任意站点
    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        MainActor.assumeIsolated {
            guard webView === self.webView,
                  let url = navigationAction.request.url,
                  ["http", "https"].contains(url.scheme ?? ""),
                  url.host != "127.0.0.1", url.host != "localhost" else {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
        }
    }

    /// window.open / target=_blank：不开内嵌新窗，外链交给系统浏览器
    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                             for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        MainActor.assumeIsolated {
            if let url = navigationAction.request.url {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }

    /// WebContent 进程被系统回收（内存压力）时页面白屏：重载恢复
    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        MainActor.assumeIsolated {
            if webView === self.webView {
                self.webView.reload()
            }
        }
    }

    // MARK: - SPA 原生渲染（阅读抓取 fallback）
    // JS 调 webkit.messageHandlers.podicRender.postMessage({url, token})；
    // 渲染完成后回 window.__podicRenderResult(token, html)。空 html 表示失败/超时

    nonisolated func userContentController(_ userContentController: WKUserContentController,
                                           didReceive message: WKScriptMessage) {
        guard message.name == "podicRender",
              let m = message.body as? [String: String],
              let url = m["url"], let token = m["token"] else { return }
        MainActor.assumeIsolated { self.startRender(url: url, token: token) }
    }

    private func startRender(url: String, token: String) {
        renderView?.navigationDelegate = nil
        renderView = nil
        renderToken = nil

        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844)) // 离屏，给个常规视口尺寸
        wv.navigationDelegate = self
        renderView = wv
        renderToken = token

        wv.load(URLRequest(url: URL(string: url)!))
        // 总超时兜底
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            if self?.renderToken == token { self?.finishRender("") }
        }
    }

    private func renderViewDidFinish(_ wv: WKWebView) {
        // SPA hydration 等待；具体站点的渲染时长玄学，先固定 2.5s
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            wv.evaluateJavaScript("document.documentElement.outerHTML") { result, _ in
                MainActor.assumeIsolated {
                    // token/视图已被新请求换掉时静默丢弃
                    if self?.renderView === wv { self?.finishRender(result as? String ?? "") }
                }
            }
        }
    }

    private func finishRender(_ html: String) {
        guard let token = renderToken else { return }
        renderToken = nil
        webView.evaluateJavaScript(
            "window.__podicRenderResult?.(\(Self.jsJson(token)), \(Self.jsJson(html)))",
            completionHandler: nil
        )
        renderView?.navigationDelegate = nil
        renderView = nil
    }

    /// 字符串 -> JS 字面量（JSON 编码去数组括号）
    private static func jsJson(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes]),
              var str = String(data: data, encoding: .utf8), str.count >= 2 else { return "\"\"" }
        str.removeFirst()
        str.removeLast()
        return str
    }

    /// Bundle Resources/web 与 Resources/packs -> Documents/data
    private func installAssets(dataDir: URL) {
        guard let resource = Bundle.main.resourceURL else { return }
        let fm = FileManager.default

        // web 按 index.html 指纹替换：vite 产物资源名带内容 hash，前端有变 index.html 必变。
        // 只判「目录存在」会让升级用户永远留着旧前端（新后端配旧 JS）
        let web = dataDir.appendingPathComponent("web", isDirectory: true)
        let newHtml = try? Data(contentsOf: resource.appendingPathComponent("web/index.html"))
        let oldHtml = try? Data(contentsOf: web.appendingPathComponent("index.html"))
        if newHtml != nil && newHtml != oldHtml {
            try? fm.removeItem(at: web)
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
