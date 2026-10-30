//! Agent 用的浏览器:主窗口里的一块子 webview,而不是一个独立的 Chrome 窗口。
//!
//! # 为什么
//!
//! 以前 agent 上网用的是离屏的 Chrome for Testing:平时挪到屏幕外,撞上登录 / 验证码
//! 再挪回来交给用户。实测毛病一堆 —— Chrome 自己的欢迎页、「要恢复页面吗」气泡、
//! 窗口挪回来却不可见、用户顺手关掉窗口 agent 的会话就没了、防火墙对 chrome.exe 弹窗。
//!
//! 这里改成:壳(WebView2)本身就是浏览器,给 agent 单独开一块子 webview 挂在主窗口里。
//! WebView2 支持 `--remote-debugging-port`,打开之后暴露的调试协议和 Chrome 一模一样,
//! Node 那边的 puppeteer 代码(看图、点击、打字)原样连上来就能用。需要人接手时,
//! 前端把这块 webview 摆到主窗口里该显示的位置;用完再挪回客户区外面。没有第二个窗口,
//! 也就没有「关掉了」这回事。
//!
//! # 端口
//!
//! 启动时随便挑一个空闲端口,写进 `--remote-debugging-port`,通过环境变量
//! `PROMPTCUT_AGENT_CDP` 交给 sidecar。只绑 127.0.0.1。本机任何进程都能连上这个端口
//! 操控 webview —— 本机进程本来就以当前用户身份运行,这不是新的越权面,但要写进文档。
//!
//! # 「隐藏」为什么是挪走而不是 hide()
//!
//! WebView2 被 hide() 之后会停止渲染,agent 靠调试协议截图就全是空白。挪到客户区外面
//! (x = -4000)时它照样在合成,截图正常 —— 和以前 Chrome 放在 -32000 是一个道理。
//!
//! # 声音
//!
//! agent 打开的页面会自动播放视频,用户没在看却在响。所以这块 webview **默认静音**
//! (WebView2 的 IsMuted),只有交给用户、用户自己点了浮层上的喇叭才放开;收回时再静掉。

use std::net::TcpListener;
use std::sync::Mutex;

use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};

/// 子 webview 的标签。
pub const LABEL: &str = "agent";
/// 初始地址。带一个别人不会用的片段,Node 那边找不到注入标记时靠它兜底。
pub const INITIAL_URL: &str = "about:blank#promptcut-agent";
/// 默认视口。和 server/web/browser.mjs 的 VIEWPORT 保持一致:看图算坐标靠它是个常数。
pub const WIDTH: f64 = 1280.0;
pub const HEIGHT: f64 = 800.0;
/// 藏起来时的横坐标:远在客户区左边,任何窗口尺寸下都看不见。
const PARKED_X: f64 = -4000.0;

/// 进程级状态:调试端口、现在显不显示、静没静音。
pub struct AgentBrowser {
    pub port: u16,
    pub visible: Mutex<bool>,
    pub muted: Mutex<bool>,
}

impl AgentBrowser {
    pub fn new(port: u16) -> Self {
        Self { port, visible: Mutex::new(false), muted: Mutex::new(true) }
    }
}

/// 挑一个空闲端口。绑一下再放掉 —— 极小概率被别人抢走,那样 WebView2 起不来调试端口,
/// `agent_webview_info` 会报 `ready: false`,前端退回 Chrome 方案。
pub fn pick_port() -> u16 {
    // 开发期:壳不起 sidecar、直接连仓库里跑着的 dev server 时,那个 server 拿不到壳随机挑的
    // 端口。两边都设同一个 PROMPTCUT_AGENT_CDP 就能对上。正式包里没有这个变量。
    if let Ok(v) = std::env::var("PROMPTCUT_AGENT_CDP") {
        if let Ok(p) = v.trim().parse::<u16>() {
            if p != 0 {
                return p;
            }
        }
    }
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// 给 WebView2 的启动参数。**主窗口和子 webview 必须传一模一样的一串**:同一个用户数据
/// 目录下,第二个 webview 的参数和第一个不一样,WebView2 会直接拒绝创建。
/// 前面三个 feature 是 wry 默认关掉的(Edge 自己的 UI 小玩意),自己给了参数就得自己带上。
///
/// 后面几项是给后台运行(background.rs)的:编辑界面收起时主窗挪在屏幕外,Chromium 自己的
/// 遮挡判断(CalculateNativeWinOcclusion)会把它当成被挡住、把页面标成隐藏,计时器降频、
/// 不再出帧,页面侧的 Agent 工具和悬浮窗预览就跟着停了。关掉遮挡判断和后台降频,页面照常跑。
/// 悬浮窗(skill_shell.rs)也用这一串,三处必须一致。
pub fn browser_args(port: u16) -> String {
    let mut s = String::from(concat!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
        " --disable-background-timer-throttling",
        " --disable-renderer-backgrounding",
        " --disable-backgrounding-occluded-windows",
    ));
    if port != 0 {
        s.push_str(&format!(" --remote-debugging-port={port}"));
    }
    s
}

/// 静音 / 放开。WebView2 的 ICoreWebView2_8::IsMuted,Tauri 没包,自己下去调。
/// 闭包在主线程上跑,这里不等结果:静音失败顶多是有声音,不该让调用方卡住。
#[cfg(windows)]
fn apply_muted<R: Runtime>(wv: &tauri::Webview<R>, muted: bool) -> Result<(), String> {
    wv.with_webview(move |pw| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
        use windows::core::Interface;
        unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                if let Ok(c8) = core.cast::<ICoreWebView2_8>() {
                    let _ = c8.SetIsMuted(muted);
                }
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn apply_muted<R: Runtime>(_wv: &tauri::Webview<R>, _muted: bool) -> Result<(), String> {
    Ok(())
}

/// 拿到子 webview;没有就在主窗口里建一块(藏在客户区外面,静音)。
pub fn ensure<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::Webview<R>, String> {
    if let Some(w) = app.get_webview(LABEL) {
        return Ok(w);
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口还没建好".to_string())?;
    let window = main.as_ref().window();
    let port = app.state::<AgentBrowser>().port;
    let builder = WebviewBuilder::new(
        LABEL,
        WebviewUrl::External(INITIAL_URL.parse().map_err(|e| format!("初始地址不合法: {e}"))?),
    )
    .additional_browser_args(&browser_args(port))
    // 每次导航都打上标记:Node 那边(热重启后)重连时靠它认出这一块。按地址认不行 ——
    // agent 导航过之后地址早就不是初始的那个了。
    .initialization_script("window.__PROMPTCUT_AGENT__ = true;")
    // 这块是给 agent 上网用的,什么站都得能进;新窗口一律在本块里打开,别蹦出第二个窗口
    .on_navigation(|_url| true)
    .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(PARKED_X, 0.0),
            LogicalSize::new(WIDTH, HEIGHT),
        )
        .map_err(|e| format!("建不出 agent webview: {e}"))?;
    let _ = apply_muted(&webview, true);
    *app.state::<AgentBrowser>().muted.lock().unwrap() = true;
    Ok(webview)
}

/// 把子 webview 摆到主窗口里的某个矩形(逻辑像素,和前端的 CSS 像素一致)。保持静音,
/// 放不放开由用户在浮层上决定。
#[tauri::command]
pub fn agent_webview_show<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AgentBrowser>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let wv = ensure(&app)?;
    wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())?;
    wv.show().map_err(|e| e.to_string())?;
    let _ = wv.set_focus();
    *state.visible.lock().unwrap() = true;
    Ok(())
}

/// 挪回客户区外面,尺寸恢复成默认视口(agent 截图要的就是这个尺寸),并重新静音。
#[tauri::command]
pub fn agent_webview_hide<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AgentBrowser>,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        wv.set_size(LogicalSize::new(WIDTH, HEIGHT)).map_err(|e| e.to_string())?;
        wv.set_position(LogicalPosition::new(PARKED_X, 0.0)).map_err(|e| e.to_string())?;
        let _ = apply_muted(&wv, true);
    }
    *state.visible.lock().unwrap() = false;
    *state.muted.lock().unwrap() = true;
    Ok(())
}

/// 静音开关。只有用户在浮层上点喇叭才会调 muted: false。
#[tauri::command]
pub fn agent_webview_mute<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AgentBrowser>,
    muted: bool,
) -> Result<(), String> {
    let wv = ensure(&app)?;
    apply_muted(&wv, muted)?;
    *state.muted.lock().unwrap() = muted;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct AgentInfo {
    pub port: u16,
    pub label: &'static str,
    pub initial_url: &'static str,
    pub ready: bool,
    pub visible: bool,
    pub muted: bool,
}

/// 前端问:壳里有没有 agent webview、调试端口是多少。`ready` 为 false 时前端退回 Chrome。
#[tauri::command]
pub fn agent_webview_info<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AgentBrowser>,
) -> AgentInfo {
    AgentInfo {
        port: state.port,
        label: LABEL,
        initial_url: INITIAL_URL,
        ready: state.port != 0 && app.get_webview(LABEL).is_some(),
        visible: *state.visible.lock().unwrap(),
        muted: *state.muted.lock().unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_args_keep_background_pages_running() {
        let a = browser_args(0);
        assert!(!a.contains("  "), "参数之间只留一个空格: {a}");
        for flag in [
            "CalculateNativeWinOcclusion",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ] {
            assert!(a.contains(flag), "{flag}");
        }
        assert!(!a.contains("remote-debugging-port"));
        assert!(browser_args(5905).ends_with(" --remote-debugging-port=5905"));
    }
}
