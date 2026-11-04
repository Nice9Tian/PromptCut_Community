//! The floating window, and the projection of SKILL mode on the shell side.
//!
//! The floating window is one half of "background mode" (the other half is the tray, see background.rs): it appears whenever the editor is collapsed,
//! whether or not it is SKILL mode. A click opens the editor, a right click brings up the "Open editor / Close" menu,
//! and it can be dragged. In SKILL mode it additionally shows what the desktop app sessions are doing, plus the picture of the "last action".
//!
//! Where the state comes from:
//!   * Whether SKILL is on: `active` in `~/Documents/PromptCut-Skill/skill-state.json`, written by the Node side
//!     (server/skill-gate.mjs). It is **polled** here rather than going through frontend events: the page may be reloading and events can be lost,
//!     while the file is always there. At the moment it becomes active the editor is collapsed (SKILL closes the editor by default), and at the moment it changes back
//!     the editor is opened; whatever the user opens or closes in between is up to the user.
//!   * What the sessions are doing: the editor process's `GET /api/agent/desktop` (the grouping data from A4), only while collapsed and SKILL
//!     is on, fetched once per second.
//!   * The picture of the "last action": the page renders it and hands it back to the editor process, which writes it to last-action.png / .json under skillRoot
//!     (server/vite-plugin-skill-state.ts). Here the json's modification time is watched, and when it changes the image is read in and pushed to the floating page.
//!
//! Why not put it in %LOCALAPPDATA%: PromptCut may run inside an MSIX container, in which case writes to %LOCALAPPDATA%
//! are redirected into the package-private directory, and the shell and Node would no longer see the same file. Documents is not redirected.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, WebviewUrl};

use crate::background::{self, UiEvent};

/// The floating window's window label. It must be allowed in capabilities/*.json, otherwise `window.__TAURI__` on the page
/// is empty, and click, right-click and drag cannot be sent. The name is left over from the SKILL-only era and was not changed to avoid touching the permission manifest.
pub const OVERLAY_LABEL: &str = "skill-overlay";

const OVERLAY_W: f64 = 232.0;
const OVERLAY_H: f64 = 72.0;
/// Height of the "last action" preview block: the preview (232 wide at 16:9 is 130) + one caption line + padding
const PREVIEW_BLOCK_H: f64 = 130.0 + 22.0;
const BLOCK_GAP: f64 = 8.0;
/// Margin from the top-right corner of the screen
const OVERLAY_MARGIN: f64 = 16.0;
/// The editor process's port (same as EDITOR_PORT in lib.rs)
const EDITOR_PORT: u16 = 5210;

/// Floating window height = card + preview block (if any). The position stays (top-right corner); it only grows downward.
pub fn overlay_height(preview: bool) -> f64 {
    if preview {
        OVERLAY_H + BLOCK_GAP + PREVIEW_BLOCK_H
    } else {
        OVERLAY_H
    }
}

fn skill_root() -> PathBuf {
    if let Ok(v) = std::env::var("PROMPTCUT_SKILL_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into());
    PathBuf::from(home).join("Documents").join("PromptCut-Skill")
}

fn state_path() -> PathBuf {
    skill_root().join("skill-state.json")
}

fn last_action_json() -> PathBuf {
    skill_root().join("last-action.json")
}

fn last_action_png() -> PathBuf {
    skill_root().join("last-action.png")
}

/// The part of the state file the shell cares about. Unreadable or corrupt is treated as "off": when in doubt, do not collapse the user's window.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SkillState {
    pub active: bool,
    pub since: Option<String>,
}

pub fn parse_state(text: &str) -> SkillState {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return SkillState::default();
    };
    SkillState {
        active: v.get("active").and_then(|x| x.as_bool()).unwrap_or(false),
        since: v.get("since").and_then(|x| x.as_str()).map(str::to_string),
    }
}

fn read_state() -> SkillState {
    fs::read_to_string(state_path()).map(|t| parse_state(&t)).unwrap_or_default()
}

/// State pushed to the floating window. Sessions keep only the few fields the floating window can use (vendor, what is being done, last step),
/// and things like report bodies are not included, so we do not stuff tens of KB into the floating page every second.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct OverlayState {
    /// Whether it is SKILL mode: decides whether the floating window says "SKILL mode" or "Running in the background"
    pub skill: bool,
    pub since: Option<String>,
    /// Whether the editor process is reachable (when it is not, the floating window shows a line, so people do not think the Agent is working)
    pub editor_up: bool,
    pub sessions: Vec<serde_json::Value>,
}

/// Pick out the fields the floating window needs from the response of `/api/agent/desktop`.
pub fn trim_sessions(body: &str) -> Option<Vec<serde_json::Value>> {
    let v = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let list = v.get("sessions")?.as_array()?;
    Some(
        list.iter()
            .map(|s| {
                let mut o = serde_json::Map::new();
                for k in ["id", "vendor", "label", "current", "lastSeen"] {
                    if let Some(x) = s.get(k) {
                        o.insert(k.into(), x.clone());
                    }
                }
                if let Some(last) = s.get("last") {
                    let mut l = serde_json::Map::new();
                    for k in ["tool", "ok", "at"] {
                        if let Some(x) = last.get(k) {
                            l.insert(k.into(), x.clone());
                        }
                    }
                    o.insert("last".into(), serde_json::Value::Object(l));
                }
                serde_json::Value::Object(o)
            })
            .collect(),
    )
}

/// Parse an HTTP/1.1 response: status code + body (handles Content-Length and chunked). Returns None if it cannot be parsed.
pub fn parse_http_response(raw: &[u8]) -> Option<(u16, Vec<u8>)> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    let mut chunked = false;
    let mut length: Option<usize> = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        } else if k == "content-length" {
            length = v.parse().ok();
        }
    }
    if chunked {
        let mut out = Vec::new();
        let mut rest = body;
        loop {
            let eol = rest.windows(2).position(|w| w == b"\r\n")?;
            let size_str = std::str::from_utf8(&rest[..eol]).ok()?;
            let size = usize::from_str_radix(size_str.split(';').next()?.trim(), 16).ok()?;
            rest = &rest[eol + 2..];
            if size == 0 {
                return Some((status, out));
            }
            if rest.len() < size {
                return None;
            }
            out.extend_from_slice(&rest[..size]);
            rest = rest.get(size + 2..)?;
        }
    }
    match length {
        Some(n) if body.len() >= n => Some((status, body[..n].to_vec())),
        Some(_) => None,
        None => Some((status, body.to_vec())),
    }
}

/// Request JSON once from the editor process. Reads at most 1 MiB; both a timeout and a failed connection return None.
fn http_get(path: &str, timeout: Duration) -> Option<String> {
    let addr = format!("127.0.0.1:{EDITOR_PORT}").parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.take(1 << 20).read_to_end(&mut buf);
    let (status, body) = parse_http_response(&buf)?;
    if status != 200 {
        return None;
    }
    String::from_utf8(body).ok()
}

/// The preview image below the floating window.
#[derive(Serialize, Clone, Default)]
pub struct PreviewInfo {
    pub tool: Option<String>,
    pub clip_id: Option<String>,
    pub t: Option<f64>,
    pub at: Option<String>,
    /// data:image/png;base64,… used directly by <img>
    pub data_url: Option<String>,
}

/// Read the preview. Returns (the json's modification timestamp, content); None if unreadable: having no preview is the norm, not an error.
fn read_preview() -> Option<(u128, PreviewInfo)> {
    use base64::Engine;
    let meta = fs::metadata(last_action_json()).ok()?;
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())?;
    let v = serde_json::from_str::<serde_json::Value>(&fs::read_to_string(last_action_json()).ok()?).ok()?;
    let png = fs::read(last_action_png()).ok()?;
    // A png that is half-written cannot be decoded; the Node side writes a temp file first and then renames it, so what we read is either complete or absent
    if png.len() < 8 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    Some((
        stamp,
        PreviewInfo {
            tool: v.get("tool").and_then(|x| x.as_str()).map(str::to_string),
            clip_id: v.get("clipId").and_then(|x| x.as_str()).map(str::to_string),
            t: v.get("t").and_then(|x| x.as_f64()),
            at: v.get("at").and_then(|x| x.as_str()).map(str::to_string),
            data_url: Some(data_url),
        },
    ))
}

/// Place the floating window at the top-right corner of the primary monitor. If monitor info is unavailable, use a conservative position, which is better than not showing it.
fn place_top_right<R: Runtime>(win: &tauri::WebviewWindow<R>) {
    let (sw, scale) = win
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64, m.scale_factor()))
        .unwrap_or((1920.0, 1.0));
    let logical_w = sw / scale;
    let x = (logical_w - OVERLAY_W - OVERLAY_MARGIN).max(0.0);
    let _ = win.set_position(tauri::LogicalPosition::new(x, OVERLAY_MARGIN));
}

fn overlay<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window(OVERLAY_LABEL)
}

/// Whether the user has dragged the floating window during this showing: once dragged, it is no longer placed back at the top-right corner
static OVERLAY_PLACED: AtomicBool = AtomicBool::new(false);

/// Editor collapsed: show the floating window (created only on first use).
pub fn show_overlay<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = overlay(app) {
        let _ = w.show();
        if !OVERLAY_PLACED.swap(true, Ordering::SeqCst) {
            place_top_right(&w);
        }
        return;
    }
    // The launch arguments must be exactly the same as the main window's: with different arguments under the same WebView2 user data directory, the second webview
    // cannot be created (see the notes on agent_webview::browser_args). They were not passed here before, so the floating window might not have started at all.
    let port = app.state::<crate::agent_webview::AgentBrowser>().port;
    match WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
        .title("PromptCut")
        .inner_size(OVERLAY_W, OVERLAY_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        // Keep it out of the taskbar: it is a widget, not a "window"
        .skip_taskbar(true)
        .shadow(false)
        .additional_browser_args(&crate::agent_webview::browser_args(port))
        .build()
    {
        Ok(w) => {
            place_top_right(&w);
            OVERLAY_PLACED.store(true, Ordering::SeqCst);
        }
        Err(e) => {
            // If the floating window cannot be created, the tray icon can still bring the editor back, so the app does not "vanish into thin air"; logging is enough
            eprintln!("[overlay] failed to create the floating window (the tray icon still works): {e}");
        }
    }
}

/// Editor opened: hide the floating window. It is not destroyed; the next collapse just shows it.
pub fn hide_overlay<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = overlay(app) {
        let _ = w.hide();
    }
}

/// Start a background thread: watch the state file and push progress to the floating window while collapsed; also hook up the clicks and right-clicks sent by the floating window.
pub fn spawn_watcher(app: AppHandle) {
    // The floating page announces itself every time it finishes loading, and here we re-push the state in hand (the floating window is only created on the first collapse,
    // so everything pushed before it was created is lost)
    let resend = Arc::new(AtomicBool::new(true));
    let r = resend.clone();
    app.listen_any("pc-overlay-ready", move |_| r.store(true, Ordering::SeqCst));

    // Click the floating window → open the editor
    let h = app.clone();
    app.listen_any("pc-overlay-open", move |_| {
        background::dispatch(&h, UiEvent::OpenRequested);
    });

    // Right-click the floating window → pop up "Open editor / Close"; what gets clicked is handled by background::install_menu_handler
    let h = app.clone();
    app.listen_any("pc-overlay-menu", move |_| {
        if let Some(w) = overlay(&h) {
            match background::build_menu(&h) {
                Ok(menu) => {
                    let _ = w.popup_menu(&menu);
                }
                Err(e) => eprintln!("[overlay] cannot create the right-click menu: {e}"),
            }
        }
    });

    std::thread::spawn(move || {
        let mut last_active = false;
        let mut last_state: Option<OverlayState> = None;
        let mut last_preview: u128 = 0;
        let mut has_preview = false;
        let mut size_key: Option<bool> = None;
        loop {
            let st = read_state();

            if st.active != last_active {
                last_active = st.active;
                background::dispatch(&app, if st.active { UiEvent::SkillOn } else { UiEvent::SkillOff });
                // The web page wants to know too (to make the UI more responsive; the page also polls itself)
                let _ = app.emit("pc-skill-mode-changed", st.active);
            }

            if resend.swap(false, Ordering::SeqCst) {
                last_state = None;
                last_preview = 0;
                size_key = None;
            }

            if background::is_collapsed(&app) {
                let (editor_up, sessions) = if st.active {
                    match http_get("/api/agent/desktop", Duration::from_millis(800)) {
                        Some(body) => (true, trim_sessions(&body).unwrap_or_default()),
                        None => (false, Vec::new()),
                    }
                } else {
                    (true, Vec::new())
                };
                let state = OverlayState { skill: st.active, since: st.since.clone(), editor_up, sessions };
                // Do not push if unchanged: re-rendering the floating window every second is pure waste, and the text flickers
                if last_state.as_ref() != Some(&state) {
                    let _ = app.emit_to(OVERLAY_LABEL, "pc-overlay-state", state.clone());
                    last_state = Some(state);
                }
                if st.active {
                    // The "last action" preview image: read and push only when the json's modification time has changed
                    if let Some((stamp, preview)) = read_preview() {
                        if stamp != last_preview {
                            last_preview = stamp;
                            has_preview = true;
                            let _ = app.emit_to(OVERLAY_LABEL, "pc-skill-preview", preview);
                        }
                    }
                }
                // The window height follows the preview block (the preview is shown only in SKILL mode)
                let key = st.active && has_preview;
                if size_key != Some(key) {
                    size_key = Some(key);
                    if let Some(w) = overlay(&app) {
                        let _ = w.set_size(tauri::LogicalSize::new(OVERLAY_W, overlay_height(key)));
                    }
                }
            }
            if !st.active {
                // After leaving SKILL, the preview on the next entry starts from scratch (the image from the previous round must not pop up)
                last_preview = 0;
                has_preview = false;
            }

            std::thread::sleep(Duration::from_millis(1000));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_file_parsing_defaults_to_closed() {
        assert_eq!(parse_state(""), SkillState::default());
        assert_eq!(parse_state("{not json"), SkillState::default());
        assert_eq!(parse_state(r#"{"active":"yes"}"#).active, false);
        let s = parse_state(r#"{"active":true,"since":"2026-09-30T01:02:03Z","closedAt":null}"#);
        assert!(s.active);
        assert_eq!(s.since.as_deref(), Some("2026-09-30T01:02:03Z"));
    }

    #[test]
    fn http_content_length() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        assert_eq!(parse_http_response(raw), Some((200, b"{\"ok\":true}".to_vec())));
        // The body was not fully read
        let short = b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{\"ok\":true}";
        assert_eq!(parse_http_response(short), None);
    }

    #[test]
    fn http_chunked() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"ok\"\r\n6;x=y\r\n:true}\r\n0\r\n\r\n";
        assert_eq!(parse_http_response(raw), Some((200, b"{\"ok\":true}".to_vec())));
        assert_eq!(parse_http_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab"), None);
    }

    #[test]
    fn http_status_and_garbage() {
        assert_eq!(parse_http_response(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"), Some((404, vec![])));
        assert_eq!(parse_http_response(b"garbage"), None);
    }

    #[test]
    fn sessions_are_trimmed() {
        let body = r#"{"ok":true,"sessions":[{"id":"desk-1","vendor":"claude","label":"Claude Code","client":"claude-code",
            "current":{"tool":"update_clip","since":1},"last":{"tool":"get_project","ok":true,"at":2,"ms":5,"error":"x"},
            "recent":[1,2,3],"reports":[{"big":"text"}],"lastSeen":3}]}"#;
        let s = trim_sessions(body).unwrap();
        assert_eq!(s.len(), 1);
        let o = s[0].as_object().unwrap();
        assert_eq!(o["label"], "Claude Code");
        assert_eq!(o["current"]["tool"], "update_clip");
        assert_eq!(o["last"]["tool"], "get_project");
        assert!(o["last"].get("error").is_none());
        assert!(o.get("reports").is_none() && o.get("recent").is_none() && o.get("client").is_none());
        assert_eq!(trim_sessions("{}"), None);
    }

    #[test]
    fn height_grows_only_with_preview() {
        assert_eq!(overlay_height(false), OVERLAY_H);
        assert!(overlay_height(true) > OVERLAY_H + PREVIEW_BLOCK_H);
    }
}
