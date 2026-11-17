package com.felix021.podic

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.PlaybackParams
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/// 端侧语音引擎：sherpa-onnx OfflineTts 懒加载 + 单实例 + 串行队列。
/// 模型清单问本地后端（/api/tts/models，30s 缓存），按语言取已装模型；
/// 引擎加载期间持使用引用（PodicNative.ttsAcquire/Release），删除模型时
/// 后端据此拒绝；删除前 JS 会先发 op=unload 释放。
/// 事件回传统一走 emit(request_id, state, message)，由 MainActivity 注入 JS
class TtsManager(
    private val portProvider: () -> Int,
    private val emit: (requestId: String, state: String, message: String?) -> Unit,
    /// 系统 TTS 兜底（返回 false = 系统不可用/无该语言语音）
    private val systemSpeak: (requestId: String, text: String, lang: String, speed: Float) -> Boolean,
) {
    data class InstalledModel(
        val modelId: String,
        val languages: List<String>,
        val family: String,
        val config: JSONObject?,
    )

    private val queue = Executors.newSingleThreadExecutor()
    private var engine: OfflineTts? = null
    private var engineModelId: String? = null
    private var modelsCache: Pair<Long, List<InstalledModel>>? = null

    @Volatile private var stopCurrent = false
    private var currentTrack: AudioTrack? = null

    /// 排队一次朗读。provider：auto=有端侧模型用引擎否则系统；offline=强制引擎（试听）；
    /// system=强制系统 TTS（引擎对比）。speed：1.0 原速 / 0.75 慢速
    fun speak(requestId: String, text: String, lang: String, speed: Float, provider: String) {
        queue.execute {
            val model = installedModels().firstOrNull { lang in it.languages }
            if (provider == "system" || (provider == "auto" && model == null)) {
                if (!systemSpeak(requestId, text, lang, speed)) {
                    emit(requestId, "error", "系统 TTS 不可用或没有该语言的语音")
                }
                return@execute
            }
            if (model == null) {
                android.util.Log.w("podic", "tts speak: no installed model for lang=$lang (provider=$provider)")
                emit(requestId, "error", "未安装该语言的语音模型")
                return@execute
            }
            val eng = loadEngine(model)
            if (eng == null) {
                emit(requestId, "error", "语音引擎加载失败（模型文件损坏或磁盘空间不足）")
                return@execute
            }
            stopCurrent = false
            val audio = try {
                val gc = GenerationConfig()
                // 倍速不进模型：sherpa VITS 的 speed 只调 duration 采样方差，
                // 0.75 几乎无感、0.2 时快时慢（用户实测两按钮没差别即此）。
                // 统一原速合成，播放端 AudioTrack.setPlaybackParams 精确线性倍速
                gc.speed = 1.0f
                // supertonic 多语言模型靠 extra 指定语言；其他 family 忽略
                if (model.family == "supertonic") gc.extra = mapOf("lang" to lang)
                eng.generateWithConfig(text, gc)
            } catch (e: Exception) {
                emit(requestId, "error", "语音合成失败：${e.message}")
                return@execute
            }
            if (stopCurrent) {
                emit(requestId, "cancelled", null)
                return@execute
            }
            val finished = play(audio.samples, audio.sampleRate, speed)
            emit(requestId, if (finished) "ended" else "cancelled", null)
        }
    }

    /// 停止当前朗读（播放中的合成在下一个检查点退出）
    fun stop() {
        stopCurrent = true
        currentTrack?.pause()
    }

    /// 卸载引擎并释放使用引用（JS 删除模型前调避免 409；装完新模型也调——
    /// 顺带清掉模型清单缓存，装完立即可试听）
    fun unload() {
        queue.execute {
            engine?.release()
            engine = null
            engineModelId?.let { PodicNative.ttsRelease(it) }
            engineModelId = null
            modelsCache = null
        }
    }

    fun shutdown() {
        stop()
        queue.execute {
            engine?.release()
            engine = null
            engineModelId?.let { PodicNative.ttsRelease(it) }
            engineModelId = null
        }
    }

    /// 懒加载并复用引擎；换模型时先卸载旧的。加载成功即 acquire 引用
    private fun loadEngine(m: InstalledModel): OfflineTts? {
        if (engine != null && engineModelId == m.modelId) return engine
        engine?.release()
        engineModelId?.let { PodicNative.ttsRelease(it) }
        engine = null
        engineModelId = null
        val path = PodicNative.ttsModelPath(m.modelId)
        if (path == null) {
            android.util.Log.w("podic", "tts loadEngine: ttsModelPath null for ${m.modelId}")
            return null
        }
        val cfg = buildConfig(m, path)
        if (cfg == null) {
            android.util.Log.w("podic", "tts loadEngine: buildConfig null for ${m.modelId} (family=${m.family})")
            return null
        }
        return try {
            PodicNative.ttsAcquire(m.modelId)
            val e = OfflineTts(config = cfg)
            engine = e
            engineModelId = m.modelId
            e
        } catch (e: Exception) {
            android.util.Log.e("podic", "tts engine load", e)
            PodicNative.ttsRelease(m.modelId)
            null
        }
    }

    /// 按 family 构造引擎配置（supertonic 多语言 / vits 即 piper 系；新 family 在这扩展）
    private fun buildConfig(m: InstalledModel, path: String): OfflineTtsConfig? {
        fun p(obj: JSONObject, key: String): String? =
            obj.optString(key).takeIf { it.isNotEmpty() }?.let { "$path/$it" }
        val mc = when (m.family) {
            "supertonic" -> {
                val sup = m.config?.optJSONObject("supertonic") ?: return null
                OfflineTtsModelConfig(
                    supertonic = OfflineTtsSupertonicModelConfig(
                        durationPredictor = p(sup, "duration_predictor") ?: return null,
                        textEncoder = p(sup, "text_encoder") ?: return null,
                        vectorEstimator = p(sup, "vector_estimator") ?: return null,
                        vocoder = p(sup, "vocoder") ?: return null,
                        ttsJson = p(sup, "tts_json") ?: return null,
                        unicodeIndexer = p(sup, "unicode_indexer") ?: return null,
                        voiceStyle = p(sup, "voice_style") ?: return null,
                    ),
                    numThreads = 2,
                    debug = false,
                )
            }
            "vits" -> {
                val v = m.config?.optJSONObject("vits") ?: return null
                OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = p(v, "model") ?: return null,
                        tokens = p(v, "tokens") ?: return null,
                        lexicon = v.optString("lexicon").takeIf { it.isNotEmpty() }?.let { "$path/$it" } ?: "",
                        dataDir = v.optString("data_dir").takeIf { it.isNotEmpty() }?.let { "$path/$it" } ?: "",
                        dictDir = v.optString("dict_dir").takeIf { it.isNotEmpty() }?.let { "$path/$it" } ?: "",
                    ),
                    numThreads = 2,
                    debug = false,
                )
            }
            else -> return null
        }
        return OfflineTtsConfig(model = mc)
    }

    /// 阻塞播放，返回 true=自然播完，false=被打断。
    /// speed 走 setPlaybackParams（框架自带 sonic 变速不变调），倍速精确线性
    private fun play(samples: FloatArray, rate: Int, speed: Float = 1.0f): Boolean {
        if (samples.isEmpty()) return true
        val minBuf = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuf, samples.size * 4))
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        currentTrack = track
        return try {
            track.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
            if (speed > 0 && kotlin.math.abs(speed - 1f) > 0.01f) {
                track.playbackParams = PlaybackParams().setSpeed(speed).setPitch(1f)
            }
            track.play()
            // 播放头停滞看门狗：正常播放时播放头按采样率推进；音频路由异常
            // （蓝牙断连、输出设备休眠等）会让它停住——不能陪它等一辈子，
            // 停滞超过 4s 按播完收场，朗读会话照常结束
            var lastPos = -1
            var stalledSince = 0L
            while (!stopCurrent) {
                val pos = track.playbackHeadPosition
                if (pos >= samples.size) return true
                if (pos != lastPos) {
                    lastPos = pos
                    stalledSince = 0L
                } else {
                    if (stalledSince == 0L) stalledSince = System.currentTimeMillis()
                    if (System.currentTimeMillis() - stalledSince > 4000) return true
                }
                Thread.sleep(40)
            }
            track.pause()
            track.flush()
            false
        } finally {
            track.release()
            if (currentTrack === track) currentTrack = null
        }
    }

    /// 已装模型清单（本地后端，30s 缓存；失败返回空表走系统 TTS）
    private fun installedModels(): List<InstalledModel> {
        modelsCache?.let { (at, models) ->
            if (System.currentTimeMillis() - at < 30_000) return models
        }
        val port = portProvider()
        val models = if (port <= 0) emptyList() else try {
            val conn = URL("http://127.0.0.1:$port/api/tts/models").openConnection() as HttpURLConnection
            conn.connectTimeout = 2000
            conn.readTimeout = 2000
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val arr = JSONObject(body).getJSONArray("models")
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                InstalledModel(
                    modelId = o.getString("model_id"),
                    languages = o.optJSONArray("languages")
                        ?.let { a -> (0 until a.length()).map { a.getString(it) } }
                        ?: emptyList(),
                    family = o.optString("family"),
                    config = o.optJSONObject("config"),
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
        modelsCache = System.currentTimeMillis() to models
        return models
    }
}
