package com.felix021.podic

import android.content.Context
import java.io.File

/// 把 APK assets 里的前端（web/）和词典包（packs/*.db）落到 filesDir/data。
/// - web：随版本升级全量替换
/// - packs：内置包随版本升级覆盖（含历史版本一次性迁移）；用户自导入的同名包之外不受影响
/// 注：aapt2 打包时会 DEFLATE 压缩 assets，assets.open 读到的是原始字节，直接拷贝即可
object AssetsInstaller {
    fun install(ctx: Context, dataDir: File) {
        val code = try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).longVersionCode.toInt()
        } catch (_: Exception) {
            0
        }
        val marker = File(ctx.filesDir, "installed_version")
        val installed = if (marker.isFile) marker.readText().trim() else null
        val upgraded = installed != code.toString()

        if (upgraded) {
            val web = File(dataDir, "web")
            web.deleteRecursively()
            copyDir(ctx, "web", web)
        }

        val packs = File(dataDir, "packs").apply { mkdirs() }
        val bundledTxt = File(packs, ".bundled.txt")
        val prevBundled = if (bundledTxt.isFile) bundledTxt.readLines().filterTo(mutableSetOf()) { it.isNotBlank() } else mutableSetOf()
        val assetPacks = (ctx.assets.list("packs") ?: emptyArray()).filter { it.endsWith(".db") }

        for (name in assetPacks) {
            val out = File(packs, name)
            // 覆盖条件：还没装过 / 版本升级 / 上次就是内置装的同名包 / 历史版本没记录过清单（一次性迁移）
            val overwrite = !out.isFile || upgraded || name in prevBundled || prevBundled.isEmpty()
            if (!overwrite) continue
            ctx.assets.open("packs/$name").use { input ->
                out.outputStream().use { output -> input.copyTo(output, 1 shl 16) }
            }
        }
        bundledTxt.writeText(assetPacks.joinToString("\n"))

        marker.writeText(code.toString())
    }

    private fun copyDir(ctx: Context, assetPath: String, target: File) {
        val children = ctx.assets.list(assetPath) ?: return
        target.mkdirs()
        for (child in children) {
            val from = "$assetPath/$child"
            val to = File(target, child)
            val sub = ctx.assets.list(from)
            if (sub.isNullOrEmpty()) {
                ctx.assets.open(from).use { input ->
                    to.outputStream().use { output -> input.copyTo(output, 1 shl 16) }
                }
            } else {
                copyDir(ctx, from, to)
            }
        }
    }
}
