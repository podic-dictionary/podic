plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 解析配置仓 env.sh（PODIC_CONFIG_DIR 可重定向，默认 ~/.config/podic）。
// 只填充未设置的 PODIC_* 变量：显式环境变量优先，便于 CI 覆盖。
// 值中的 $PODIC_CONFIG_DIR 引用在此展开。
val configEnv: Map<String, String> by lazy {
    val dir = System.getenv("PODIC_CONFIG_DIR")
        ?: "${System.getProperty("user.home")}/.config/podic"
    val f = File(dir, "env.sh")
    if (!f.isFile) emptyMap()
    else f.readLines()
        .filter { val t = it.trim(); t.isNotEmpty() && !t.startsWith("#") && "=" in t }
        .associate {
            val (k, v) = it.split("=", limit = 2)
            k.trim() to v.trim().trim('"').replace("\$PODIC_CONFIG_DIR", dir)
        }
}
fun podicEnv(key: String): String? =
    System.getenv(key)?.takeIf { it.isNotBlank() } ?: configEnv[key]

android {
    namespace = "com.felix021.podic"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.felix021.podic"
        minSdk = 26
        targetSdk = 36
        versionCode = 7
        versionName = "0.2.3"
        ndk { abiFilters += setOf("arm64-v8a", "x86_64") }
    }

    signingConfigs {
        // debug 用配置仓的 pinned keystore：所有构建机签名一致，升级不判签名冲突
        getByName("debug") {
            storeFile = File(podicEnv("PODIC_DEBUG_KEYSTORE") ?: error("缺 PODIC_DEBUG_KEYSTORE（配置仓 env.sh）"))
            storePassword = podicEnv("PODIC_DEBUG_STORE_PASS") ?: error("缺 PODIC_DEBUG_STORE_PASS")
            keyAlias = podicEnv("PODIC_DEBUG_ALIAS") ?: "podic-debug"
            keyPassword = podicEnv("PODIC_DEBUG_STORE_PASS")
        }
    }

    buildTypes {
        // debug = dev 包：包名 .dev 后缀、桌面名 Podic Dev（见 src/debug/res），可与正式版共存
        getByName("debug") {
            applicationIdSuffix = ".dev"
        }
        getByName("release") {
            isMinifyEnabled = false
            val releaseStore = podicEnv("PODIC_RELEASE_KEYSTORE")
            if (releaseStore != null && File(releaseStore).isFile) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = File(releaseStore)
                    storePassword = podicEnv("PODIC_RELEASE_STORE_PASS")
                    keyAlias = podicEnv("PODIC_RELEASE_ALIAS") ?: "podic-release"
                    keyPassword = podicEnv("PODIC_RELEASE_STORE_PASS")
                }
            } else {
                // 还没接 Play 发布时，release 先用 debug 签名直装
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // .so 随包解压安装（WebView 进程加载更稳）
    packaging { jniLibs { useLegacyPackaging = true } }
}
