//! The browser the Agent uses: a child webview inside the main window, not a standalone Chrome window.
//!
//! # Why
//!
//! Previously the agent browsed with an off-screen Chrome for Testing: normally parked off-screen, and when it hit a login / CAPTCHA
//! it was moved back and handed to the user. Testing turned up a pile of problems: Chrome's own welcome page, the "Restore pages?" bubble,
//! the window being invisible after being moved back, the agent's session vanishing when the user casually closed the window, and the firewall prompting for chrome.exe.
//!
//! This is changed here: the shell (WebView2) is itself a browser, so the agent gets its own child webview attached inside the main window.
//! WebView2 supports `--remote-debugging-port`; once it is on, the debugging protocol it exposes is identical to Chrome's,
//! so the puppeteer code on the Node side (screenshots, clicking, typing) can connect as is and just work. When a human needs to take over,
//! the frontend places this webview where it should appear in the main window, and moves it back outside the client area when done. There is no second window,
//! so there is no such thing as "it got closed".
//!
//! # Port
//!
//! At startup an arbitrary free port is picked and written into `--remote-debugging-port`, and handed to the sidecar through the environment variable
//! `PROMPTCUT_AGENT_CDP`. It binds to 127.0.0.1 only. Any process on this machine can connect to this port and
//! control the webview: local processes already run as the current user, so this is not a new privilege-escalation surface, but it must be written into the docs.
//!
//! # Why "hiding" means moving away instead of hide()
//!
//! After WebView2 is hidden with hide() it stops rendering, so the screenshots the agent takes over the debugging protocol are all blank. When it is moved outside the client area
//! (x = -4000) it keeps compositing and screenshots work fine, for the same reason Chrome used to be placed at -32000.
//!
//! # Sound
//!
//! Pages the agent opens autoplay video, making noise while the user is not even looking. So this webview is **muted by default**
//! (WebView2's IsMuted), and is unmuted only after it is handed to the user and the user clicks the speaker on the popover themselves; it is muted again when taken back.

use std::net::TcpListener;
use std::sync::Mutex;

use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};

/// Label of the child webview.
pub const LABEL: &str = "agent";
/// Initial URL. It carries a fragment nobody else would use, as a fallback for when the Node side cannot find the injected marker.
pub const INITIAL_URL: &str = "about:blank#promptcut-agent";
/// Default viewport. Keep it identical to VIEWPORT in server/web/browser.mjs: computing coordinates from screenshots relies on it being a constant.
pub const WIDTH: f64 = 1280.0;
pub const HEIGHT: f64 = 800.0;
/// The x coordinate when hidden: far to the left of the client area, invisible at any window size.
const PARKED_X: f64 = -4000.0;

/// Process-level state: the debugging port, whether it is currently shown, and whether it is muted.
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

/// Pick a free port. Bind it and then release it: there is a tiny chance someone else grabs it, in which case WebView2 cannot bring up the debugging port,
/// `agent_webview_info` reports `ready: false` and the frontend falls back to the Chrome approach.
pub fn pick_port() -> u16 {
    // During development, when the shell does not start the sidecar and connects directly to a dev server running in the repo, that server cannot get the random
    // port the shell picked. Setting the same PROMPTCUT_AGENT_CDP on both sides makes them match. Release builds do not have this variable.
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

/// Launch arguments for WebView2. **The main window and the child webview must pass exactly the same string**: under the same user data
/// directory, if the second webview's arguments differ from the first's, WebView2 simply refuses to create it.
/// The first three features are ones wry turns off by default (Edge's own little UI gimmicks); once you supply the arguments yourself you have to include them yourself.
///
/// The later items are for background mode (background.rs): when the editor is collapsed the main window sits off-screen, and Chromium's own
/// occlusion detection (CalculateNativeWinOcclusion) treats it as covered and marks the page hidden, throttles timers and
/// stops producing frames, so the page-side Agent tools and the floating window preview stop with it. Turning off occlusion detection and background throttling keeps the page running as usual.
/// The floating window (skill_shell.rs) uses this same string too, so all three places must match.
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

/// Mute / unmute. WebView2's ICoreWebView2_8::IsMuted is not wrapped by Tauri, so we call down to it ourselves.
/// The closure runs on the main thread and we do not wait for its result here: a failed mute at worst means some sound, and should not block the caller.
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

/// Get the child webview; if there is none, create one inside the main window (hidden outside the client area, muted).
pub fn ensure<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::Webview<R>, String> {
    if let Some(w) = app.get_webview(LABEL) {
        return Ok(w);
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not created yet".to_string())?;
    let window = main.as_ref().window();
    let port = app.state::<AgentBrowser>().port;
    let builder = WebviewBuilder::new(
        LABEL,
        WebviewUrl::External(INITIAL_URL.parse().map_err(|e| format!("invalid initial URL: {e}"))?),
    )
    .additional_browser_args(&browser_args(port))
    // Mark every navigation: the Node side (after a hot restart) uses this to recognize this webview when it reconnects. Recognizing it by URL does not work:
    // once the agent has navigated, the URL is long since not the initial one.
    .initialization_script("window.__PROMPTCUT_AGENT__ = true;")
    // This webview is for the agent to browse the web, so every site must be reachable; new windows always open inside this webview, so no second window pops up
    .on_navigation(|_url| true)
    .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(PARKED_X, 0.0),
            LogicalSize::new(WIDTH, HEIGHT),
        )
        .map_err(|e| format!("cannot create the agent webview: {e}"))?;
    let _ = apply_muted(&webview, true);
    *app.state::<AgentBrowser>().muted.lock().unwrap() = true;
    Ok(webview)
}

/// Place the child webview at a rectangle inside the main window (logical pixels, the same as the frontend's CSS pixels). It stays muted;
/// whether to unmute is up to the user on the popover.
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

/// Move it back outside the client area, restore its size to the default viewport (the size the agent's screenshots need), and mute it again.
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

/// Mute switch. muted: false is only called when the user clicks the speaker on the popover.
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

/// The frontend asks: is there an agent webview in the shell, and what is the debugging port. When `ready` is false the frontend falls back to Chrome.
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
        assert!(!a.contains("  "), "keep only one space between arguments: {a}");
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
