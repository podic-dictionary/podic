import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        let vc = ViewController()
        window?.rootViewController = vc
        window?.makeKeyAndVisible()
        // simctl launch com.felix021.podic -search hi -lang en（自动化截图/测试入口）
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-search"), i + 1 < args.count {
            let lang = args.firstIndex(of: "-lang").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
            vc.runSearch(query: args[i + 1], lang: lang)
        }
        // 冷启动深链接：podic:// URL 也可能出现在 launchOptions
        if let url = launchOptions?[.url] as? URL {
            _ = openDeepLink(url)
        }
        return true
    }

    /// 深链接：podic://search?q=hi&lang=en / podic://translate?text=hi -> 前端 hash 路由
    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        openDeepLink(url)
        return true
    }

    private func openDeepLink(_ url: URL) -> Bool {
        guard url.scheme == "podic", let vc = window?.rootViewController as? ViewController,
              let host = url.host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return false }
        let q = components.percentEncodedQuery.map { "?\($0)" } ?? ""
        vc.openHash("/\(host)\(q)")
        return true
    }
}
