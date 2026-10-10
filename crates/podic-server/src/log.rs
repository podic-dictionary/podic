//! 服务端日志：Android 上进程的 stdout/stderr 是 /dev/null（zygote 拉起），
//! eprintln 全部丢失；这里桥到 logcat（系统 liblog），其他平台维持 eprintln。
//! 诊断卡死时靠 [podic-http] 等日志定位最后卡点

#[cfg(target_os = "android")]
#[link(name = "log")]
extern "C" {
    fn __android_log_write(prio: i32, tag: *const std::ffi::c_char, text: *const std::ffi::c_char)
        -> i32;
}

pub fn elog(args: std::fmt::Arguments<'_>) {
    let s = format!("[podic] {args}");
    #[cfg(target_os = "android")]
    unsafe {
        // prio=4(INFO)；String 以 NUL 结尾，as_ptr 作 C 字符串安全
        __android_log_write(4, c"podic".as_ptr(), s.as_ptr().cast());
    }
    #[cfg(not(target_os = "android"))]
    eprintln!("{s}");
}

#[macro_export]
macro_rules! plog {
    ($($arg:tt)*) => {
        $crate::log::elog(format_args!($($arg)*))
    };
}
