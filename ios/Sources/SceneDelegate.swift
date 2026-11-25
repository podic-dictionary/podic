import UIKit

/// iOS 26+ 上不接 UIScene 生命周期会直接崩（EXC_BREAKPOINT：
/// UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption），
/// 所以窗口从 AppDelegate 搬到 SceneDelegate。
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let vc = ViewController()
        window.rootViewController = vc
        window.makeKeyAndVisible()
        self.window = window

        // 截图/自动化入口：simctl launch com.felix021.podic -search hi -lang en
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-search"), i + 1 < args.count {
            let lang = args.firstIndex(of: "-lang").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
            vc.runSearch(query: args[i + 1], lang: lang)
        }
        // 冷启动深链接：scene 化之后 URL 走 connectionOptions，不再出现在 launchOptions
        if let url = connectionOptions.urlContexts.first?.url {
            _ = openDeepLink(url, in: vc)
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? ViewController)?.recoverServerIfNeeded()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let vc = window?.rootViewController as? ViewController else { return }
        for ctx in URLContexts {
            _ = openDeepLink(ctx.url, in: vc)
        }
    }

    /// 深链接：podic://search?q=hi&lang=en / podic://translate?text=hi -> 前端 hash 路由
    func openDeepLink(_ url: URL, in vc: ViewController) -> Bool {
        guard url.scheme == "podic", let host = url.host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return false }
        let q = components.percentEncodedQuery.map { "?\($0)" } ?? ""
        vc.openHash("/\(host)\(q)")
        return true
    }
}
