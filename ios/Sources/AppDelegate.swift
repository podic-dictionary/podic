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
        return true
    }

    /// 深链接：podic://search?q=hi&lang=en -> WebView 里 __podicSearch
    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        guard url.scheme == "podic", let vc = window?.rootViewController as? ViewController,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return false }
        let query = components.queryItems?.first(where: { $0.name == "q" })?.value ?? ""
        let lang = components.queryItems?.first(where: { $0.name == "lang" })?.value
        guard !query.isEmpty else { return false }
        vc.runSearch(query: query, lang: lang)
        return true
    }
}
