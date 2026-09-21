package com.felix021.podic

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var canGoBackInApp = false

    /// JS 侧同步「能否应用内返回」（非查词页/有二级页）。WebView 的 canGoBack 不认
    /// pushState 条目，所以返回语义由 JS 桥接驱动
    inner class PodicBridge {
        @JavascriptInterface
        fun setCanGoBack(v: Boolean) {
            canGoBackInApp = v
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = WebViewClient()
            addJavascriptInterface(PodicBridge(), "PodicAndroid")
            setBackgroundColor(Color.rgb(0xf7, 0xf9, 0xf4)) // 纸底色，起动力避免白闪
        }
        // WebView 忽略自身 padding，包一层容器把系统栏 inset 落在容器上
        // （targetSdk 35+ 强制 edge-to-edge，不加会状态栏压 header、手势条盖底部导航）
        val root = android.widget.FrameLayout(this).apply { addView(webView) }
        setContentView(root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                v.setPadding(0, bars.top, 0, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            }
            android.view.WindowInsets.CONSUMED
        }

        Thread {
            val dataDir = File(filesDir, "data").apply { mkdirs() }
            try {
                AssetsInstaller.install(this, dataDir)
            } catch (e: Exception) {
                android.util.Log.e("podic", "assets install", e)
            }
            val port = PodicNative.startServer(dataDir.absolutePath, 0) // 0=内核挑空闲端口，杜绝端口冲突
            runOnUiThread {
                if (port > 0) {
                    webView.loadUrl("http://127.0.0.1:$port")
                } else {
                    webView.loadData("podic 后端启动失败，请重启应用", "text/plain", null)
                }
            }
        }.start()
    }

    /// 返回语义：JS 能处理（二级页/其他 tab）就交给 JS 回上级；查词栈底弹退出确认
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (canGoBackInApp) {
            webView.evaluateJavascript("window.__podicGoBack?.()", null)
        } else {
            android.app.AlertDialog.Builder(this)
                .setMessage("退出 Podic？")
                .setPositiveButton("退出") { _, _ -> finish() }
                .setNegativeButton("取消", null)
                .show()
        }
    }
}
