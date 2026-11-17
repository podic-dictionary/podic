//! 服务端 TTS 合成：libloading 动态加载 sherpa-onnx C API，把已装的端侧
//! 模型直接在 server 侧合成 wav（POST /api/tts/synthesize）。
//!
//! 动机：网页版（8787 等浏览器入口）没有壳桥，只有系统 Web Speech——
//! Windows 没装 fr/ja 系统语音就哑了。而网页连的 podic-server 本来就
//! 管着模型文件，合成放在 server 侧顺理成章；速度不变调由前端
//! `<audio>.playbackRate`（preservesPitch）完成，与壳内 AudioTrack 行为一致。
//!
//! 引擎库（libsherpa-onnx-c-api.so + libonnxruntime.so）放
//! `{data_dir}/tts/lib/`，不存在则本功能整体不可用（前端回退系统语音），
//! 不进二进制也不进 git。C struct 按 sherpa-onnx v1.13.8 c-api.h 逐字段
//! 复刻——字段布局与 .so 版本强耦合，升级库必须同步对表。选 v1.13.8 而非
//! v2.0.1：v2 移除了 VITS 的 espeak-ng 前端（piper 系模型没法直接合成，
//! 要调用方自行音素化），v1 的 data_dir 仍然可用，supertonic 两者都有。

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::os::raw::c_float;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use libloading::Library;

use podic_core::tts;

// ---------------- sherpa-onnx v2.0.1 C API struct 复刻 ----------------
// 只用到 vits / supertonic 两个 family 的字段，其余 family 的 struct 仍须
// 完整复刻占位（SherpaOnnxOfflineTtsModelConfig 内嵌全部 family struct，
// 布局偏移必须与 .so 一致）

#[repr(C)]
#[derive(Default)]
struct VitsModelConfig {
    model: *const c_char,
    lexicon: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char, // espeak-ng-data（piper 系音素化前端）
    noise_scale: c_float,
    noise_scale_w: c_float,
    length_scale: c_float,
    dict_dir: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct MatchaModelConfig {
    acoustic_model: *const c_char,
    vocoder: *const c_char,
    lexicon: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    noise_scale: c_float,
    length_scale: c_float,
    dict_dir: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct KokoroModelConfig {
    model: *const c_char,
    voices: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    length_scale: c_float,
    dict_dir: *const c_char,
    lexicon: *const c_char,
    lang: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct KittenModelConfig {
    model: *const c_char,
    voices: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    length_scale: c_float,
}

#[repr(C)]
#[derive(Default)]
struct ZipvoiceModelConfig {
    tokens: *const c_char,
    encoder: *const c_char,
    decoder: *const c_char,
    vocoder: *const c_char,
    data_dir: *const c_char,
    lexicon: *const c_char,
    feat_scale: c_float,
    t_shift: c_float,
    target_rms: c_float,
    guidance_scale: c_float,
}

#[repr(C)]
#[derive(Default)]
struct PocketModelConfig {
    lm_flow: *const c_char,
    lm_main: *const c_char,
    encoder: *const c_char,
    decoder: *const c_char,
    text_conditioner: *const c_char,
    vocab_json: *const c_char,
    token_scores_json: *const c_char,
    voice_embedding_cache_capacity: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SupertonicModelConfig {
    duration_predictor: *const c_char,
    text_encoder: *const c_char,
    vector_estimator: *const c_char,
    vocoder: *const c_char,
    tts_json: *const c_char,
    unicode_indexer: *const c_char,
    voice_style: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct OfflineTtsModelConfig {
    vits: VitsModelConfig,
    num_threads: c_int,
    debug: c_int,
    provider: *const c_char,
    matcha: MatchaModelConfig,
    kokoro: KokoroModelConfig,
    kitten: KittenModelConfig,
    zipvoice: ZipvoiceModelConfig,
    pocket: PocketModelConfig,
    supertonic: SupertonicModelConfig,
}

#[repr(C)]
#[derive(Default)]
struct OfflineTtsConfig {
    model: OfflineTtsModelConfig,
    rule_fsts: *const c_char,
    max_num_sentences: c_int,
    rule_fars: *const c_char,
    silence_scale: c_float,
}

#[repr(C)]
struct GenerationConfig {
    silence_scale: c_float,
    speed: c_float,
    sid: c_int,
    reference_audio: *const c_float,
    reference_audio_len: c_int,
    reference_sample_rate: c_int,
    reference_text: *const c_char,
    num_steps: c_int,
    extra: *const c_char,
}

#[repr(C)]
struct GeneratedAudio {
    samples: *const c_float,
    n: c_int,
    sample_rate: c_int,
}

/// 会话：库 + 函数指针 + 当前引擎。合成全程持锁串行（引擎非线程安全；
/// 与 Android TtsManager 的串行队列同语义）。模型升级（path 变）换引擎。
struct Session {
    _onnx: Library, // 保活：c-api.so 的 NEEDED 依赖，先于 c-api 加载
    lib: Library,
    create: unsafe extern "C" fn(*const OfflineTtsConfig) -> *const c_void,
    destroy: unsafe extern "C" fn(*const c_void),
    generate: unsafe extern "C" fn(*const c_void, *const c_char, *const GenerationConfig, *const c_void, *mut c_void) -> *const GeneratedAudio,
    free_audio: unsafe extern "C" fn(*const GeneratedAudio),
    wave_size: unsafe extern "C" fn(c_int) -> i64,
    wave_to_buf: unsafe extern "C" fn(*const c_float, c_int, c_int, *mut c_char),
    engine: *const c_void,
    /// 当前引擎对应的 (model_id, 版本目录)：不匹配即换
    engine_key: (String, String),
    /// 引擎持用的模型（删除保护）
    acquired: Option<String>,
    /// config 里指针的 CString 保活区
    keep: Vec<CString>,
}

unsafe impl Send for Session {}

static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<Session>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

/// 加载 .so 并解析符号。onnxruntime 先加载（绝对路径 dlopen 后，c-api.so
/// 的 NEEDED 同名 soname 即命中已加载副本，不再走系统搜索路径）
unsafe fn load_libs(lib_dir: &Path) -> Result<(Library, Library), String> {
    let onnx = lib_dir.join("libonnxruntime.so");
    let api = lib_dir.join("libsherpa-onnx-c-api.so");
    if !onnx.is_file() || !api.is_file() {
        return Err("引擎库未安装（tts/lib 缺 .so）".into());
    }
    let onnx = Library::new(&onnx).map_err(|e| format!("加载 libonnxruntime 失败: {e}"))?;
    let lib = Library::new(&api).map_err(|e| format!("加载 libsherpa-onnx-c-api 失败: {e}"))?;
    Ok((onnx, lib))
}

/// 解析符号并拷出函数指针（fn 是 Copy，脱离 Symbol 的生命周期借用）
macro_rules! sym {
    ($lib:expr, $name:literal, $ty:ty) => {{
        let s: libloading::Symbol<'_, $ty> = unsafe { $lib.get($name.as_bytes()) }
            .map_err(|e| format!("符号 {} 缺失: {e}", $name))?;
        *s
    }};
}

/// 按模型 config（JSON）构造引擎配置。文件名映射同 Android TtsManager
/// （vits / supertonic），新 family 在这扩展
unsafe fn build_config(s: &mut Session, m: &tts::TtsInstalled) -> Result<OfflineTtsConfig, String> {
    let dir = CString::new(m.path.as_str()).map_err(|_| "路径含 NUL")?;
    let p = |k: &str| -> Option<CString> {
        let v = m.config.get(m.family.as_str())?.get(k)?.as_str()?;
        if v.is_empty() {
            return None;
        }
        CString::new(format!("{}/{}", dir.to_str().unwrap(), v)).ok()
    };
    let mut cfg = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            num_threads: 2,
            ..Default::default()
        },
        ..Default::default()
    };
    match m.family.as_str() {
        "supertonic" => {
            let f = |k: &str| -> Result<CString, String> { p(k).ok_or(format!("supertonic 配置缺 {k}")) };
            cfg.model.supertonic = SupertonicModelConfig {
                duration_predictor: s.keep.push_ret(f("duration_predictor")?),
                text_encoder: s.keep.push_ret(f("text_encoder")?),
                vector_estimator: s.keep.push_ret(f("vector_estimator")?),
                vocoder: s.keep.push_ret(f("vocoder")?),
                tts_json: s.keep.push_ret(f("tts_json")?),
                unicode_indexer: s.keep.push_ret(f("unicode_indexer")?),
                voice_style: s.keep.push_ret(f("voice_style")?),
            };
        }
        "vits" => {
            let f = |k: &str| -> Result<CString, String> { p(k).ok_or(format!("vits 配置缺 {k}")) };
            cfg.model.vits = VitsModelConfig {
                model: s.keep.push_ret(f("model")?),
                tokens: s.keep.push_ret(f("tokens")?),
                // data_dir（espeak-ng-data）是 piper 系的音素化前端，必传；
                // lexicon（词典型模型）与 dict_dir（中文 jieba）按包内配置可选
                data_dir: p("data_dir").map(|c| s.keep.push_ret(c)).unwrap_or(std::ptr::null()),
                lexicon: p("lexicon").map(|c| s.keep.push_ret(c)).unwrap_or(std::ptr::null()),
                noise_scale: 0.667,
                noise_scale_w: 0.8,
                length_scale: 1.0,
                ..Default::default()
            };
        }
        other => return Err(format!("family {other} 暂不支持 server 侧合成")),
    }
    Ok(cfg)
}

/// CString 压入会话保活区并返回裸指针（引擎 create 期间字符串必须存活）
trait KeepStr {
    fn push_ret(&mut self, c: CString) -> *const c_char;
}
impl KeepStr for Vec<CString> {
    fn push_ret(&mut self, c: CString) -> *const c_char {
        let p = c.as_ptr();
        self.push(c);
        p
    }
}

/// 合成一段文本为 16bit mono wav 字节。lang 用于选模型与 supertonic extra
pub fn synthesize(data_dir: &Path, text: &str, lang: &str) -> Result<Vec<u8>, String> {
    let lib_dir = data_dir.join("tts").join("lib");
    // 找该语言的已装模型（server 侧只认 supertonic / vits）
    let model = tts::installed_models(data_dir)
        .into_iter()
        .find(|m| m.languages.iter().any(|l| l == lang) && matches!(m.family.as_str(), "supertonic" | "vits"))
        .ok_or_else(|| "未安装该语言的语音模型".to_string())?;

    let mut slot = session_slot().lock().unwrap();
    if slot.is_none() {
        let (onnx, lib) = unsafe { load_libs(&lib_dir)? };
        slot.replace(Session {
            _onnx: onnx,
            create: sym!(lib, "SherpaOnnxCreateOfflineTts", unsafe extern "C" fn(*const OfflineTtsConfig) -> *const c_void),
            destroy: sym!(lib, "SherpaOnnxDestroyOfflineTts", unsafe extern "C" fn(*const c_void)),
            generate: sym!(lib, "SherpaOnnxOfflineTtsGenerateWithConfig", unsafe extern "C" fn(*const c_void, *const c_char, *const GenerationConfig, *const c_void, *mut c_void) -> *const GeneratedAudio),
            free_audio: sym!(lib, "SherpaOnnxDestroyOfflineTtsGeneratedAudio", unsafe extern "C" fn(*const GeneratedAudio)),
            wave_size: sym!(lib, "SherpaOnnxWaveFileSize", unsafe extern "C" fn(c_int) -> i64),
            wave_to_buf: sym!(lib, "SherpaOnnxWriteWaveToBuffer", unsafe extern "C" fn(*const c_float, c_int, c_int, *mut c_char)),
            engine: std::ptr::null(),
            engine_key: (String::new(), String::new()),
            acquired: None,
            keep: Vec::new(),
            lib,
        });
    }
    let s = slot.as_mut().unwrap();
    let key = (model.model_id.clone(), model.path.clone());
    if s.engine_key != key {
        unsafe {
            if !s.engine.is_null() {
                (s.destroy)(s.engine);
                s.engine = std::ptr::null();
            }
            if let Some(mid) = s.acquired.take() {
                tts::release(&mid);
            }
            s.keep.clear();
            let cfg = build_config(s, &model)?;
            let eng = (s.create)(&cfg);
            if eng.is_null() {
                return Err("语音引擎加载失败（模型文件损坏或库版本不匹配）".into());
            }
            tts::acquire(&model.model_id);
            s.acquired = Some(model.model_id.clone());
            s.engine = eng;
            s.engine_key = key;
        }
    }
    unsafe {
        let ctext = CString::new(text).map_err(|_| "文本含 NUL")?;
        // supertonic 多语言模型靠 extra 指定语言（同 Android 侧）
        let extra = CString::new(format!(r#"{{"lang":"{lang}"}}"#)).unwrap();
        let gc = GenerationConfig {
            silence_scale: 0.2,
            speed: 1.0, // 倍速一律交给播放端（前端 preservesPitch / 壳 AudioTrack）
            extra: extra.as_ptr(),
            ..std::mem::zeroed()
        };
        let audio = (s.generate)(s.engine, ctext.as_ptr(), &gc, std::ptr::null(), std::ptr::null_mut());
        if audio.is_null() || (*audio).n <= 0 || (*audio).samples.is_null() {
            if !audio.is_null() {
                (s.free_audio)(audio);
            }
            return Err("语音合成失败（空音频）".into());
        }
        let size = (s.wave_size)((*audio).n);
        let mut buf = vec![0u8; size as usize];
        (s.wave_to_buf)((*audio).samples, (*audio).n, (*audio).sample_rate, buf.as_mut_ptr() as *mut c_char);
        (s.free_audio)(audio);
        Ok(buf)
    }
}

/// 释放当前引擎（模型删除/升级前调，避免自持引用挡删除）
pub fn unload() {
    let mut slot = session_slot().lock().unwrap();
    if let Some(s) = slot.as_mut() {
        unsafe {
            if !s.engine.is_null() {
                (s.destroy)(s.engine);
                s.engine = std::ptr::null();
            }
        }
        if let Some(mid) = s.acquired.take() {
            tts::release(&mid);
        }
        s.engine_key = (String::new(), String::new());
        s.keep.clear();
    }
}

#[allow(dead_code)]
fn _cstr_debug(p: *const c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
}
