//! 悬浮窗,以及 SKILL 模式在外壳这一侧的投影。
//!
//! 悬浮窗是「后台运行」的一半(另一半是托盘,见 background.rs):编辑界面收起时就出现,
//! 不管是不是 SKILL 模式。单击它打开编辑界面,右键出「打开编辑界面 / 关闭」菜单,
//! 拖得动。SKILL 模式下它额外显示桌面 APP 会话在做什么、以及「上一步动作」的画面。
//!
//! 状态从哪来:
//!   * SKILL 开没开:`~/Documents/PromptCut-Skill/skill-state.json` 的 `active`,由 Node 那边写
//!     (server/skill-gate.mjs)。这里**轮询**它,不走前端事件 —— 页面可能正在重载、事件会丢,
//!     文件一直在。变成 active 的那一下收起编辑界面(SKILL 缺省关闭编辑界面),变回来的那一下
//!     打开编辑界面;中间用户自己打开、关上都随用户。
//!   * 会话在做什么:编辑器进程的 `GET /api/agent/desktop`(A4 的分组数据),只在收起且 SKILL
//!     开着时每秒取一次。
//!   * 「上一步动作」的画面:页面渲好交回编辑器进程,写到 skillRoot 下的 last-action.png / .json
//!     (server/vite-plugin-skill-state.ts)。这里盯 json 的修改时间,变了就把图读进来推给悬浮页。
//!
//! 为什么不放 %LOCALAPPDATA%:PromptCut 有可能跑在 MSIX 容器里,那时对 %LOCALAPPDATA%
//! 的写入会被重定向进包私有目录,壳和 Node 看到的就不是同一个文件了。Documents 不会。

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

/// 悬浮窗的窗口标签。capabilities/*.json 里要放行它,否则页面上 `window.__TAURI__`
/// 是空的,单击、右键、拖动都发不出来。名字是 SKILL 专用时代留下的,没改是为了不动权限清单。
pub const OVERLAY_LABEL: &str = "skill-overlay";

const OVERLAY_W: f64 = 232.0;
const OVERLAY_H: f64 = 72.0;
/// 「上一步动作」预览块的高度:预览(232 宽按 16:9 是 130)+ 说明一行 + 内边距
const PREVIEW_BLOCK_H: f64 = 130.0 + 22.0;
const BLOCK_GAP: f64 = 8.0;
/// 离屏幕右上角的边距
const OVERLAY_MARGIN: f64 = 16.0;
/// 编辑器进程的端口(与 lib.rs 的 EDITOR_PORT 相同)
const EDITOR_PORT: u16 = 5210;

/// 悬浮窗高度 = 卡片 + 预览块(有的话)。位置不动(右上角),只往下长。
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

/// 状态文件里外壳关心的部分。读不到、坏了都按「关着」处理 —— 拿不准的时候别把用户的窗口收起来。
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

/// 推给悬浮窗的状态。会话只留悬浮窗用得上的几个字段(厂商、正在做的、上一步),
/// 报告正文之类不带,免得每秒往悬浮页塞几十 KB。
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct OverlayState {
    /// 是不是 SKILL 模式:决定悬浮窗写「SKILL 模式」还是「后台运行中」
    pub skill: bool,
    pub since: Option<String>,
    /// 编辑器进程连得上吗(连不上时悬浮窗写一句,别让人以为 Agent 在干活)
    pub editor_up: bool,
    pub sessions: Vec<serde_json::Value>,
}

/// 从 `/api/agent/desktop` 的回应里挑出悬浮窗要的字段。
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

/// 拆一份 HTTP/1.1 回应:状态码 + 正文(认 Content-Length 与 chunked)。拆不开就 None。
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

/// 向编辑器进程要一次 JSON。最多读 1 MiB;超时、连不上都返回 None。
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

/// 悬浮窗下面那张预览图。
#[derive(Serialize, Clone, Default)]
pub struct PreviewInfo {
    pub tool: Option<String>,
    pub clip_id: Option<String>,
    pub t: Option<f64>,
    pub at: Option<String>,
    /// data:image/png;base64,… 直接给 <img> 用
    pub data_url: Option<String>,
}

/// 读预览。返回 (json 的修改时间戳, 内容);读不到就 None —— 没预览是常态,不是错。
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
    // 正在被写到一半的 png 会解不出来;Node 那边是先写临时文件再改名,所以读到的要么整要么没有
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

/// 把悬浮窗摆到主显示器右上角。拿不到显示器信息就放个保守的位置,总比不显示强。
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

/// 悬浮窗这一次显示有没有被用户拖过:拖过就不再摆回右上角
static OVERLAY_PLACED: AtomicBool = AtomicBool::new(false);

/// 编辑界面收起:出悬浮窗(第一次用时才建)。
pub fn show_overlay<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = overlay(app) {
        let _ = w.show();
        if !OVERLAY_PLACED.swap(true, Ordering::SeqCst) {
            place_top_right(&w);
        }
        return;
    }
    // 启动参数必须和主窗口一模一样:同一个 WebView2 用户数据目录下参数不同,第二个 webview
    // 会建不出来(agent_webview::browser_args 的说明)。以前这里没带,悬浮窗可能根本起不来。
    let port = app.state::<crate::agent_webview::AgentBrowser>().port;
    match WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
        .title("PromptCut")
        .inner_size(OVERLAY_W, OVERLAY_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        // 不进任务栏:它是个挂件,不是一个「窗口」
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
            // 悬浮窗建不出来还有托盘图标能叫回编辑界面,不至于「软件凭空消失」;记日志就够
            eprintln!("[overlay] 悬浮窗创建失败(托盘图标仍可用): {e}");
        }
    }
}

/// 编辑界面打开:收悬浮窗。不销毁,下次收起直接显示。
pub fn hide_overlay<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = overlay(app) {
        let _ = w.hide();
    }
}

/// 起一个后台线程:盯状态文件,收起时把进度推给悬浮窗;并接上悬浮窗发来的单击、右键。
pub fn spawn_watcher(app: AppHandle) {
    // 悬浮页每次加载完都说一声,这边把手上的状态重推一遍(悬浮窗是第一次收起时才建的,
    // 建好之前推的都丢了)
    let resend = Arc::new(AtomicBool::new(true));
    let r = resend.clone();
    app.listen_any("pc-overlay-ready", move |_| r.store(true, Ordering::SeqCst));

    // 单击悬浮窗 → 打开编辑界面
    let h = app.clone();
    app.listen_any("pc-overlay-open", move |_| {
        background::dispatch(&h, UiEvent::OpenRequested);
    });

    // 右键悬浮窗 → 弹「打开编辑界面 / 关闭」;点了什么由 background::install_menu_handler 处理
    let h = app.clone();
    app.listen_any("pc-overlay-menu", move |_| {
        if let Some(w) = overlay(&h) {
            match background::build_menu(&h) {
                Ok(menu) => {
                    let _ = w.popup_menu(&menu);
                }
                Err(e) => eprintln!("[overlay] 右键菜单建不出来: {e}"),
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
                // 网页那边也想知道(让界面更跟手;页面自己也在轮询)
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
                // 没变就不推:悬浮窗每秒重渲染一次纯属浪费,文字还会闪
                if last_state.as_ref() != Some(&state) {
                    let _ = app.emit_to(OVERLAY_LABEL, "pc-overlay-state", state.clone());
                    last_state = Some(state);
                }
                if st.active {
                    // 「上一步动作」的预览图:json 的修改时间变了才读、才推
                    if let Some((stamp, preview)) = read_preview() {
                        if stamp != last_preview {
                            last_preview = stamp;
                            has_preview = true;
                            let _ = app.emit_to(OVERLAY_LABEL, "pc-skill-preview", preview);
                        }
                    }
                }
                // 窗口高度跟着预览块走(只在 SKILL 下显示预览)
                let key = st.active && has_preview;
                if size_key != Some(key) {
                    size_key = Some(key);
                    if let Some(w) = overlay(&app) {
                        let _ = w.set_size(tauri::LogicalSize::new(OVERLAY_W, overlay_height(key)));
                    }
                }
            }
            if !st.active {
                // 出了 SKILL,下一次进来的预览从头算(上一轮的图不该冒出来)
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
        // 正文没读全
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
