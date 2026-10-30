use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::webview::WebviewWindowBuilder;
use tauri::{Emitter, Manager, RunEvent, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;

mod agent_webview;
mod account_vault;
mod background;
mod chrome_color;
mod chrome_path;
mod kill_on_close;
mod proc_lock;
mod skill_shell;

const EDITOR_URL: &str = "http://127.0.0.1:5210/";

/// 编辑器自己的端口(`EDITOR_URL` 里那个)。
const EDITOR_PORT: u16 = 5210;

/// 两个舞台端口 = 编辑器端口 +1 / +2(`server/stage-ports.mjs`)。
///
/// R7 之后缺省就是跨源双舞台,这两个端口由编辑器进程起反向代理
/// (`server/vite-plugin-stage-ports.ts`,带 `Origin-Agent-Cluster: ?1`)。
/// 被别的程序占住时编辑器**不会**起不来:它只是不起那一个代理、页面退回同源单舞台,
/// 两个舞台 iframe 也就掉回一个。所以这里只提醒、不拦启动 —— 拦了反而比网页版更糟。
const STAGE_PORTS: [u16; 2] = [EDITOR_PORT + 1, EDITOR_PORT + 2];

/// 启动参数里的 .proc 文件(双击文件、右键「打开方式」)。只认真实存在的文件。
fn proc_arg<I: Iterator<Item = String>>(args: I) -> Option<String> {
    args.filter(|a| a.to_lowercase().ends_with(".proc"))
        .find(|a| std::path::Path::new(a).is_file())
}

/// 启动参数里的 `--quit`:让已经在跑的那一份干净退出(更新补丁 apply-patch.ps1 用)。
/// 第一个参数是 exe 自己,不算。
const QUIT_ARG: &str = "--quit";

/// 第二次启动交给已在跑的实例做什么。
#[derive(Debug, PartialEq, Eq)]
enum SecondLaunch {
    /// 带 `--quit`:走和托盘「关闭」同一条退出路径
    Quit,
    /// 其它:唤回编辑界面,带着 .proc 的话顺带打开
    Open(Option<String>),
}

/// 解析第二次启动的参数(不含 exe 本身)。`--quit` 优先:更新补丁要的是关掉,不是打开文件。
fn second_launch<I: Iterator<Item = String>>(args: I) -> SecondLaunch {
    let args: Vec<String> = args.collect();
    if has_quit_arg(args.iter().cloned()) {
        SecondLaunch::Quit
    } else {
        SecondLaunch::Open(proc_arg(args.into_iter()))
    }
}

fn has_quit_arg<I: Iterator<Item = String>>(mut args: I) -> bool {
    args.any(|a| a.eq_ignore_ascii_case(QUIT_ARG))
}

/// 最小的百分号编码:除了字母数字和 -_.~ 全部转义,前端 URLSearchParams 解得开。
/// 不引 url 编码的 crate,就这一处用。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 编辑器地址。带着要打开的 .proc 时挂成 ?open=<路径>:前端 Shell 会让服务端**先复制一份**
/// 再读副本,原文件不被占用、不被改。
fn editor_url_with_open(open: Option<String>) -> String {
    match open {
        Some(p) => format!("{}?open={}", EDITOR_URL, percent_encode(&p)),
        None => EDITOR_URL.to_string(),
    }
}

/// Only an independently identified test shell can use its explicitly leased port.
/// Production identifiers always keep the existing fixed service binding.
fn account_editor_port(identifier: &str, override_port: Option<&str>) -> Result<u16, String> {
    if !identifier.ends_with(".account-probe") { return Ok(EDITOR_PORT); }
    let port = override_port.ok_or("account probe requires its explicit editor port")?
        .parse::<u16>().map_err(|_| "invalid account probe port")?;
    if !(6340..=6347).contains(&port) && port != 6500 { return Err("account probe port is outside its lease".into()); }
    Ok(port)
}

/// The production account cloud, from the product declaration (`build.rs`). Empty in the community build.
const ACCOUNT_CLOUD_ORIGIN: &str = env!("PROMPTCUT_ACCOUNT_CLOUD_ORIGIN");

fn account_cloud_binding(identifier: &str, production: &str, origin: Option<&str>, pin: Option<&str>) -> Result<(String, Option<String>), String> {
    if !identifier.ends_with(".account-probe") { return Ok((production.into(), None)); }
    // The public-path test uses the production origin and normal system certificate validation.
    if !production.is_empty() && origin == Some(production) && pin.is_none() { return Ok((production.into(), None)); }
    if origin != Some("https://127.0.0.1:6388") { return Err("account probe requires its exact TLS origin".into()); }
    let pin = pin.ok_or("account probe requires its certificate pin")?;
    if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err("invalid account probe certificate pin".into()); }
    Ok(("https://127.0.0.1:6388".into(), Some(pin.into())))
}

/// Holds the sidecar process ID so we can kill the whole tree on exit.
struct SidecarPid(Mutex<Option<u32>>);

/// Commands originating from the WebView title bar that must remain native.
/// Keeping these actions in Rust preserves the old menu's Explorer, reset and
/// About behavior while the visible menu is now rendered by the themed UI.
#[tauri::command]
fn desktop_titlebar_command(handle: tauri::AppHandle, command: String) {
    let app_data_dir = match handle.path().app_data_dir() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[titlebar] 无法定位应用数据目录: {e}");
            return;
        }
    };
    let export_dir = dirs_home().join("Videos").join("PromptCut");
    let runtime_dir = resolve_runtime_dir(&handle);
    match command.as_str() {
        "open-export" => open_in_explorer(&export_dir),
        "open-data" => open_in_explorer(&app_data_dir),
        "open-pylibs" => open_in_explorer(&app_data_dir.join("pylibs")),
        "open-models" => open_in_explorer(&app_data_dir.join("models")),
        "open-logs" => {
            if let Ok(path) = handle.path().app_log_dir() {
                open_in_explorer(&path);
            }
        }
        "reset-pylibs" => {
            let path = app_data_dir.join("pylibs");
            let confirm = rfd::MessageDialog::new()
                .set_title("PromptCut — 重置 Python 库")
                .set_description(&format!("会删除 {}，下次转写时需要重新下载引擎，继续吗？", path.display()))
                .set_level(rfd::MessageLevel::Warning)
                .set_buttons(rfd::MessageButtons::OkCancel)
                .show();
            if confirm == rfd::MessageDialogResult::Ok {
                match fs::remove_dir_all(&path) {
                    Ok(_) => rfd::MessageDialog::new()
                        .set_title("PromptCut")
                        .set_description("已删除，下次使用语音识别时会重新下载")
                        .set_level(rfd::MessageLevel::Info)
                        .show(),
                    Err(e) => rfd::MessageDialog::new()
                        .set_title("PromptCut — 删除失败")
                        .set_description(&format!("删除失败: {e}"))
                        .set_level(rfd::MessageLevel::Error)
                        .show(),
                };
            }
        }
        "about" => show_about(&handle, &runtime_dir),
        // 标题栏菜单的「退出」和托盘、悬浮窗右键的「关闭」走同一条路(background.rs):
        // 收起状态下先把主窗挪回原位再退,sidecar 清理与锁释放在 RunEvent 里做
        "quit" => {
            background::dispatch(&handle, background::UiEvent::QuitRequested);
        }
        _ => {}
    }
}

/* ── .proc 独占锁的三个命令 ──────────────────────────────────────────────
 *
 * 真正的独占只有外壳做得到:Windows 的共享模式由内核管,进程一死内核就收走。
 * Node 那半(server/vite-plugin-skill-state.ts)负责原子创建锁文件和 pid 兜底,
 * 内核那一层的句柄由这里握着 —— 两半合起来才既挡得住并发、又不会因为进程被强杀
 * 而留下一把永远解不开的锁。锁的是旁路的 `<name>.proc.lock`,不是 .proc 本体
 * (锁本体会把自家 sidecar 的读写一起挡掉,见 proc_lock.rs 的说明)。
 *
 * 前端在浏览器里跑时这几个命令不存在,那边只走 Node 那半 —— 够用,只是少了
 * 「被强杀也能自动解锁」这一层。
 */

#[tauri::command]
fn acquire_proc_lock(
    locks: tauri::State<'_, proc_lock::ProcLocks>,
    proc_path: String,
) -> Result<(), String> {
    proc_lock::acquire(&locks, &proc_path)
}

#[tauri::command]
fn release_proc_lock(locks: tauri::State<'_, proc_lock::ProcLocks>, proc_path: String) {
    proc_lock::release(&locks, &proc_path);
}

#[tauri::command]
fn is_proc_locked(locks: tauri::State<'_, proc_lock::ProcLocks>, proc_path: String) -> bool {
    proc_lock::is_locked_by_other(&locks, &proc_path)
}

/// Report both startup failures and a backend exit after the editor loaded.
fn status_eval_script(message: &str) -> String {
    let literal =
        serde_json::to_string(message).unwrap_or_else(|_| "\"(internal error)\"".to_string());
    format!(
        "(function(){{var m={};function w(){{var e=document.getElementById('status');\
         if(e){{e.innerText=m;return;}}\
         e=document.getElementById('pc-service-error');\
         if(!e){{e=document.createElement('div');e.id='pc-service-error';e.setAttribute('role','alert');\
         e.style.cssText='position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;padding:16px;background:#842323;color:white;white-space:pre-wrap;font:14px sans-serif';\
         document.body.appendChild(e);}}\
         e.textContent=m+'\\n编辑器中的未保存内容仍然保留，请勿直接刷新页面。';}}\
         if(document.body){{w();}}else{{document.addEventListener('DOMContentLoaded',w,{{once:true}});}}}})()",
        literal
    )
}

/// Try a raw HTTP GET to `127.0.0.1:<port>` and return the response body
/// (up to 64 KiB) if the connection succeeds within `timeout`.
///
/// `Err` 就是「连不上」,也就是这个端口没人占 —— 舞台端口的预检靠的正是这一条。
fn probe_port_at(port: u16, timeout: Duration) -> Result<String, String> {
    let addr = format!("127.0.0.1:{port}");
    let mut stream =
        TcpStream::connect_timeout(&addr.parse().map_err(|_| addr.clone())?, timeout)
            .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 65536];
    let mut total = 0usize;
    loop {
        match stream.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                if total >= buf.len() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(String::from_utf8_lossy(&buf[..total]).to_string())
}

/// 编辑器端口的预检(老调用点的形状没变)。
fn probe_port(timeout: Duration) -> Result<String, String> {
    probe_port_at(EDITOR_PORT, timeout)
}

/// 哪几个舞台端口已经被占住了。连得上就算被占。
fn occupied_stage_ports(timeout: Duration) -> Vec<u16> {
    STAGE_PORTS
        .iter()
        .copied()
        .filter(|p| probe_port_at(*p, timeout).is_ok())
        .collect()
}

/// Resolve the runtime directory: honour `PROMPTCUT_RUNTIME_DIR` if set,
/// otherwise fall back to `<resource_dir>/runtime`.
fn resolve_runtime_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(v) = env::var("PROMPTCUT_RUNTIME_DIR") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    app.path()
        .resource_dir()
        .expect("failed to resolve resource dir")
        .join("runtime")
}

/// VERSIONS.json schema (all fields optional for robustness).
#[derive(Deserialize, Default)]
#[serde(default)]
struct Versions {
    node: Option<String>,
    chrome: Option<String>,
    ffmpeg: Option<String>,
    python: Option<String>,
    app: Option<String>,
}

pub fn run() {
    let builder = tauri::Builder::default();

    // -- Plugins ----------------------------------------------------------
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            match second_launch(args.into_iter().skip(1)) {
                // `promptcut.exe --quit`(更新补丁):和托盘「关闭」同一条路 —— 收起状态下先把
                // 主窗挪回原位再退,sidecar 清理与 .proc 锁释放在 RunEvent 里做
                SecondLaunch::Quit => {
                    background::dispatch(app, background::UiEvent::QuitRequested);
                }
                SecondLaunch::Open(proc) => {
                    // 第二次启动 = 打开编辑界面(收起在后台的话挪回来)
                    background::dispatch(app, background::UiEvent::OpenRequested);
                    // 多半是双击了一个 .proc:交给已经开着的窗口去开
                    // (前端收到 pc-open-file 后走「复制一份再读」那条路)
                    if let Some(p) = proc {
                        let _ = app.emit("pc-open-file", p);
                    }
                }
            }
        }))
        // 窗口边框不交给 window-state 记:旧版本存下的 "decorated": true 会在启动时
        // 把系统标题栏装回来,和皮肤标题栏叠成两条。边框只由建窗口时的 decorations(false) 决定。
        // 「可见」也不记:后台运行退出前会先把主窗藏起来再挪回原位(background.rs 的 exit),
        // 记下「不可见」的话下次启动主窗就出不来了。主窗启动时总是显示。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init());

    // -- Setup ------------------------------------------------------------
    builder
        .manage(proc_lock::ProcLocks::new())
        // 后台运行的状态机(编辑界面开着 / 收起 / 正在退出),见 background.rs
        .manage(background::Background::new())
        // agent 浏览器的调试端口启动时就定下来:主窗口和子 webview 的启动参数都要带它
        .manage(agent_webview::AgentBrowser::new(agent_webview::pick_port()))
        .invoke_handler(tauri::generate_handler![
            account_vault::account_bridge,
            acquire_proc_lock,
            release_proc_lock,
            is_proc_locked,
            desktop_titlebar_command,
            agent_webview::agent_webview_show,
            agent_webview::agent_webview_hide,
            agent_webview::agent_webview_mute,
            agent_webview::agent_webview_info,
            chrome_color::menu_bar_color
        ])
        .setup(|app| {
            // 带 `--quit` 却走到了这里,说明没有别的实例在跑(有的话单实例插件已经把参数交过去、
            // 本进程早退了)。要退出的东西不在,也就不该反过来起一份新的。
            if has_quit_arg(env::args().skip(1)) {
                std::process::exit(0);
            }
            let handle = app.handle().clone();

            // 双击 .proc 启动时,把路径挂在编辑器地址上带给前端
            let port_override = env::var("PROMPTCUT_ACCOUNT_TEST_EDITOR_PORT").ok();
            let editor_port = account_editor_port(&handle.config().identifier, port_override.as_deref())
                .map_err(std::io::Error::other)?;
            let origin = format!("http://127.0.0.1:{editor_port}");
            let editor_url = if editor_port == EDITOR_PORT { editor_url_with_open(proc_arg(env::args().skip(1))) }
                else { match proc_arg(env::args().skip(1)) { Some(p) => format!("{origin}/?open={}", percent_encode(&p)), None => format!("{origin}/") } };
            let test_cloud = env::var("PROMPTCUT_ACCOUNT_TEST_CLOUD_ORIGIN").ok();
            let test_pin = env::var("PROMPTCUT_ACCOUNT_TEST_CLOUD_PIN").ok();
            let (cloud_origin, cloud_pin) = account_cloud_binding(&handle.config().identifier, ACCOUNT_CLOUD_ORIGIN, test_cloud.as_deref(), test_pin.as_deref())
                .map_err(std::io::Error::other)?;
            handle.manage(account_vault::AccountBridgeBinding { origin, cloud_origin, cloud_pin,
                vault_dir: handle.path().app_data_dir().map_err(std::io::Error::other)?.join("account-v1") });

            // ── Port check ──────────────────────────────────────────
            let mut existing_instance = false;
            if let Ok(body) = probe_port_at(editor_port, Duration::from_secs(2)) {
                if body.contains("PromptCut") {
                    // Another PromptCut is already serving on 5210.
                    existing_instance = true;
                } else {
                    // Port is occupied by something else.
                    rfd::MessageDialog::new()
                        .set_title("PromptCut")
                        .set_description(&format!(
                            "端口被占用\n\n端口 {editor_port} 被别的程序占用，请关掉它再启动。"
                        ))
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                    std::process::exit(1);
                }
            }

            /*
             * 两个舞台端口的预检(R7)。只在「这一份要自己起编辑器」时查 ——
             * 已经有一份 PromptCut 在跑的话,5211 / 5212 本来就该是它占着的。
             *
             * 被占**不拦启动**:编辑器那一侧只是不起那一个反向代理、页面退回同源单舞台,
             * 照样能用。拦掉反而比网页版更糟。但要点名是哪一个,不然用户只会看到
             * 「预览怎么变慢了」而无从查起。
             */
            if !existing_instance {
                let busy = if editor_port == EDITOR_PORT { occupied_stage_ports(Duration::from_millis(400)) }
                    else { [editor_port + 1, editor_port + 2].into_iter().filter(|port| probe_port_at(*port, Duration::from_millis(400)).is_ok()).collect() };
                if !busy.is_empty() {
                    let list = busy
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join("、");
                    rfd::MessageDialog::new()
                        .set_title("PromptCut")
                        .set_description(&format!(
                            "舞台端口被占用\n\n端口 {list} 被别的程序占用。\n\n\
                             PromptCut 照常启动，但预览舞台会退回同源单舞台模式（后台预渲染舞台用不上，\
                             拖动和播放会比平时吃力）。关掉占用这些端口的程序再重启就能恢复。"
                        ))
                        .set_level(rfd::MessageLevel::Warning)
                        .show();
                }
            }

            // ── Runtime directory ───────────────────────────────────
            let runtime_dir = resolve_runtime_dir(&handle);

            // ── App data / log directories ──────────────────────────
            let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let app_log_dir = handle
                .path()
                .app_log_dir()
                .expect("failed to resolve app log dir");
            let pylibs_dir = app_data_dir.join("pylibs");
            let models_dir = app_data_dir.join("models");
            let export_dir = dirs_home().join("Videos").join("PromptCut");

            for d in [&app_data_dir, &app_log_dir, &pylibs_dir, &models_dir, &export_dir] {
                let _ = fs::create_dir_all(d);
            }

            // ── Build the main window ───────────────────────────────
            let opener_handle = handle.clone();
            let opener_handle2 = handle.clone();
            let win = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("PromptCut")
                .inner_size(1600.0, 960.0)
                .min_inner_size(1200.0, 720.0)
                .center()
                .maximizable(true)
                // The webview owns the CodeX-style title bar now. Keeping the native
                // frame hidden also prevents a second, OS-colored menu/title strip.
                .decorations(false)
                // 必须关掉:开着的话 WebView2 会装上 OS 级文件拖放处理,把页面里的 HTML5
                // 拖放事件整个吃掉——素材库拖卡片到时间轴在浏览器里正常、装成桌面版就拖不动,
                // 就是这个原因。本应用不用 Tauri 的文件拖放事件(要接系统拖入文件时,
                // 关掉之后走网页标准的 dataTransfer.files 即可)。
                .disable_drag_drop_handler()
                // 主窗口和 agent 子 webview 共用一个 WebView2 环境,启动参数必须一样(含调试端口)
                .additional_browser_args(&agent_webview::browser_args(
                    handle.state::<agent_webview::AgentBrowser>().port,
                ))
                .on_navigation(move |url| {
                    let host = url.host_str().unwrap_or("");
                    if host == "127.0.0.1"
                        || host == "localhost"
                        || host.ends_with(".localhost")
                    {
                        return true;
                    }
                    let scheme = url.scheme();
                    if scheme == "http" || scheme == "https" {
                        let _ = opener_handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .on_new_window(move |url, _features| {
                    let scheme = url.scheme();
                    if scheme == "http" || scheme == "https" {
                        let _ = opener_handle2.opener().open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            // agent 的浏览器:主窗口里的子 webview,一开始就建好(藏在客户区外面),
            // Node 那边连调试端口时它必须已经在。建不出来只记日志,不影响编辑器本身。
            if let Err(e) = agent_webview::ensure(&handle) {
                eprintln!("[promptcut] agent webview 没建起来: {e}");
            }

            // ── 后台运行:托盘图标、悬浮窗、关窗不退出(background.rs、skill_shell.rs) ──
            // 托盘或悬浮窗右键菜单的点击都从 app 级的菜单事件进来
            background::install_menu_handler(&handle);
            // 托盘建不出来只记日志:还有悬浮窗能叫回编辑界面、右键关闭
            if let Err(e) = background::install_tray(&handle) {
                eprintln!("[promptcut] 托盘图标没建起来: {e}");
            }
            // 盯 SKILL 状态文件(变成 SKILL 时收起编辑界面),收起时给悬浮窗推进度
            skill_shell::spawn_watcher(handle.clone());
            let close_handle = handle.clone();
            win.on_window_event(move |event| {
                // 点关闭不是退出,是收起编辑界面转入后台 —— 页面、sidecar、Agent 的连接都还在跑。
                // 只有托盘或悬浮窗右键「关闭」(以及标题栏菜单「退出」)才真退出。
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if background::on_close_requested(&close_handle) {
                        api.prevent_close();
                    }
                }
            });

            // If there is already an instance running, just navigate to it.
            if existing_instance {
                let _ = win.navigate(editor_url.parse().unwrap());
                return Ok(());
            }

            // ── Environment variables ───────────────────────────────
            let mut envs: HashMap<String, String> = env::vars().collect();

            // Find the original PATH key (Windows uses "Path" with capital P).
            let path_key = envs
                .keys()
                .find(|k| k.eq_ignore_ascii_case("PATH"))
                .cloned()
                .unwrap_or_else(|| "Path".to_string());
            let original_path = envs.get(&path_key).cloned().unwrap_or_default();

            // Current exe directory (sidecar lives next to the main exe).
            let exe_dir = env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|pp| pp.to_path_buf()))
                .unwrap_or_default();

            let new_path = format!(
                "{};{};{};{};{}",
                runtime_dir.join("ffmpeg").display(),
                runtime_dir.join("python").display(),
                runtime_dir.join("python").join("Scripts").display(),
                exe_dir.display(),
                original_path,
            );
            envs.insert(path_key, new_path);
            envs.insert("PUPPETEER_CACHE_DIR".into(), chrome_path::cache_dir(&runtime_dir.join("chrome")));
            envs.insert("BROWSER".into(), "none".into());
            envs.insert("PROMPTCUT_EXPORT_DIR".into(), export_dir.to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_PYTHON".into(), runtime_dir.join("python").join("python.exe").to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_PYLIBS".into(), pylibs_dir.to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_MODELS".into(), models_dir.to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_DATA_DIR".into(), app_data_dir.to_string_lossy().into_owned());
            // agent 浏览器就是壳里的子 webview:把调试端口交给 Node,那边 puppeteer 直接连
            let agent_port = handle.state::<agent_webview::AgentBrowser>().port;
            if agent_port != 0 {
                envs.insert("PROMPTCUT_AGENT_CDP".into(), agent_port.to_string());
                envs.insert("PROMPTCUT_AGENT_URL".into(), agent_webview::INITIAL_URL.into());
            }

            // ── Spawn sidecar ───────────────────────────────────────
            let app_dir = runtime_dir.join("app");
            let sidecar_cmd = handle.shell().sidecar("node").map_err(|e| {
                let msg = format!("无法创建 sidecar 命令: {e}");
                rfd::MessageDialog::new()
                    .set_title("PromptCut")
                    .set_description(&msg)
                    .set_level(rfd::MessageLevel::Error)
                    .show();
                tauri::Error::Anyhow(e.into())
            })?;

            let sidecar_cmd = sidecar_cmd
                .args([
                    "node_modules/vite/bin/vite.js",
                    "--port", &editor_port.to_string(),
                    "--strictPort",
                    "--host", "127.0.0.1",
                ])
                .current_dir(app_dir)
                .env_clear()
                .envs(envs);

            let (mut rx, child) = sidecar_cmd.spawn().map_err(|e| {
                let msg = format!("无法启动 Node 进程: {e}");
                rfd::MessageDialog::new()
                    .set_title("PromptCut")
                    .set_description(&msg)
                    .set_level(rfd::MessageLevel::Error)
                    .show();
                tauri::Error::Anyhow(e.into())
            })?;

            // Store sidecar PID for cleanup.
            let pid = child.pid();
            handle.manage(SidecarPid(Mutex::new(Some(pid))));

            // 再上一道内核级的保险:把 sidecar 放进一个 kill-on-close 的 job object,
            // 外壳进程无论怎么死(崩溃、任务管理器、安装器强杀)都会连它一起带走。
            // 下面那句 taskkill 只在正常退出时跑得到,强杀那条路上一行代码都执行不了 ——
            // 留下的孤儿 ffmpeg 会锁住 runtimefmpegfmpeg.exe,让下次安装写不进去。
            // 失败只记日志:少这层保护就是回到从前,不该因此起不来。
            if let Err(e) = kill_on_close::attach_to_kill_on_close_job(pid) {
                eprintln!("[sidecar] kill-on-close 保护没挂上,非正常退出可能留下孤儿进程: {e}");
            }

            // ── Logging + terminated detection ──────────────────────
            let sidecar_dead = Arc::new(AtomicBool::new(false));
            let sidecar_dead_log = sidecar_dead.clone();
            let log_path = app_log_dir.join("sidecar.log");
            let log_path_str = log_path.to_string_lossy().to_string();
            let win_log = win.clone();

            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                let mut log_file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                    .ok();

                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            if let Some(f) = log_file.as_mut() {
                                let text = String::from_utf8_lossy(&line);
                                let _ = writeln!(f, "{text}");
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            if let Some(f) = log_file.as_mut() {
                                let text = String::from_utf8_lossy(&line);
                                let _ = writeln!(f, "[stderr] {text}");
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            sidecar_dead_log.store(true, Ordering::SeqCst);
                            let code_str = payload
                                .code
                                .map(|c| c.to_string())
                                .unwrap_or_else(|| "unknown".into());
                            let msg = format!(
                                "Node 已退出（code={}），请查看日志:\n{}",
                                code_str, log_path_str
                            );
                            if let Some(f) = log_file.as_mut() {
                                let _ = writeln!(f, "[terminated] code={code_str}");
                            }
                            let _ = win_log.eval(&status_eval_script(&msg));
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // ── Ready polling ───────────────────────────────────────
            let sidecar_dead_poll = sidecar_dead.clone();
            let win_poll = win.clone();
            let log_path_poll = app_log_dir.join("sidecar.log");
            let editor_url_poll = editor_url.clone();

            std::thread::spawn(move || {
                let start = std::time::Instant::now();
                loop {
                    if sidecar_dead_poll.load(Ordering::SeqCst) {
                        // Sidecar already exited; the Terminated handler wrote the message.
                        break;
                    }
                    if start.elapsed() > Duration::from_secs(90) {
                        let msg = format!(
                            "启动超时，请查看日志:\n{}",
                            log_path_poll.to_string_lossy()
                        );
                        let _ = win_poll.eval(&status_eval_script(&msg));
                        break;
                    }
                    if let Ok(body) = probe_port_at(editor_port, Duration::from_secs(2)) {
                        if body.starts_with("HTTP/1.1 200") || body.starts_with("HTTP/1.0 200") {
                            let _ = win_poll.navigate(editor_url_poll.parse().unwrap());
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri application")
        .run(|handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                // 句柄本来在进程退出时就会被内核收走,这里显式放一次是为了「正常退出」
                // 这条路上锁文件能被 Node 那半删掉(它只删自己 pid 写的那份,而删的前提
                // 是没人握着句柄)。不放的话下一次启动要走 pid 兜底那条弱判据。
                proc_lock::release_all(&handle.state::<proc_lock::ProcLocks>());
                kill_sidecar_tree(handle);
            }
            _ => {}
        });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Home directory via %USERPROFILE%.
fn dirs_home() -> PathBuf {
    PathBuf::from(env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into()))
}

/// Kill the sidecar process tree with `taskkill /F /T /PID`.
/// CREATE_NO_WINDOW (0x08000000) prevents a console flash.
fn kill_sidecar_tree(handle: &tauri::AppHandle) {
    let pid = handle
        .try_state::<SidecarPid>()
        .and_then(|s| s.0.lock().ok().and_then(|g| *g));
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
    }
}

/// Open a directory in Windows Explorer, creating it first if needed.
fn open_in_explorer(dir: &PathBuf) {
    let _ = fs::create_dir_all(dir);
    let _ = std::process::Command::new("explorer.exe")
        .arg(dir.as_os_str())
        .spawn();
}

/// Show an About dialog with versions from VERSIONS.json.
fn show_about(handle: &tauri::AppHandle, runtime_dir: &PathBuf) {
    let pkg = handle.package_info();
    let shell_version = format!("{}", pkg.version);

    let versions_path = runtime_dir.join("VERSIONS.json");
    let v: Versions = fs::read_to_string(&versions_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let unknown = "未知".to_string();
    let not_installed = "未安装".to_string();

    let app_ver = v.app.as_deref().unwrap_or(&unknown);
    let node_ver = v.node.as_deref().unwrap_or(&unknown);
    let chrome_ver = v.chrome.as_deref().unwrap_or(&unknown);
    let ffmpeg_ver = v.ffmpeg.as_deref().unwrap_or(&unknown);
    let python_ver = v.python.as_deref().unwrap_or(&not_installed);

    let text = format!(
        "PromptCut\n\n\
         壳版本: {shell_version}\n\
         应用: {app_ver}\n\
         Node: {node_ver}\n\
         Chrome: {chrome_ver}\n\
         FFmpeg: {ffmpeg_ver}\n\
         Python: {python_ver}"
    );

    rfd::MessageDialog::new()
        .set_title("关于 PromptCut")
        .set_description(&text)
        .set_level(rfd::MessageLevel::Info)
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_probe_binding_is_identifier_and_port_scoped() {
        const PROD: &str = "https://accounts.example";
        assert_eq!(account_editor_port("com.promptcut.desktop", Some("6340")).unwrap(), 5210);
        assert_eq!(account_editor_port("com.promptcut.isolated.account-probe", Some("6340")).unwrap(), 6340);
        assert_eq!(account_editor_port("com.promptcut.isolated.account-probe", Some("6347")).unwrap(), 6347);
        assert_eq!(account_editor_port("com.promptcut.isolated.account-probe", Some("6500")).unwrap(), 6500);
        assert_eq!(account_editor_port("com.promptcut.desktop", Some("6500")).unwrap(), 5210);
        for port in ["6499", "6501", "6509", "6510"] {
            assert!(account_editor_port("com.promptcut.isolated.account-probe", Some(port)).is_err());
        }
        assert!(account_editor_port("com.promptcut.isolated.account-probe", None).is_err());
        assert!(account_editor_port("com.promptcut.isolated.account-probe", Some("5210")).is_err());
        assert!(account_editor_port("com.promptcut.isolated.account-probe", Some("6348")).is_err());
        assert!(account_editor_port("com.promptcut.isolated.account-probe", Some("https://evil")).is_err());
        assert_eq!(account_cloud_binding("com.promptcut.desktop", PROD, Some("https://evil"), Some("wrong")).unwrap(), ("https://accounts.example".into(), None));
        assert!(account_cloud_binding("com.promptcut.isolated.account-probe", PROD, Some("https://127.0.0.1:6389"), Some(&"a".repeat(64))).is_err());
        assert!(account_cloud_binding("com.promptcut.isolated.account-probe", PROD, Some("https://127.0.0.1:6388"), None).is_err());
        assert!(account_cloud_binding("com.promptcut.isolated.account-probe", PROD, Some("https://127.0.0.1:6388"), Some("bad")).is_err());
        assert_eq!(account_cloud_binding("com.promptcut.isolated.account-probe", PROD, Some("https://127.0.0.1:6388"), Some(&"a".repeat(64))).unwrap().0, "https://127.0.0.1:6388");
        assert_eq!(account_cloud_binding("com.promptcut.isolated.account-probe", PROD, Some("https://accounts.example"), None).unwrap(), ("https://accounts.example".into(), None));
        for origin in ["http://accounts.example", "https://www.accounts.example", "https://accounts.example/", "https://evil", "https://127.0.0.1:6500"] {
            assert!(account_cloud_binding("com.promptcut.isolated.account-probe", PROD, Some(origin), None).is_err());
        }
        assert!(account_cloud_binding("com.promptcut.isolated.account-probe", PROD, Some("https://accounts.example"), Some(&"a".repeat(64))).is_err());
    }

    fn args(v: &[&str]) -> std::vec::IntoIter<String> {
        v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn quit_arg_wins() {
        assert_eq!(second_launch(args(&["--quit"])), SecondLaunch::Quit);
        assert_eq!(second_launch(args(&["--QUIT"])), SecondLaunch::Quit);
        // 同时带着 .proc 也是退出:更新补丁要的是关掉
        assert_eq!(second_launch(args(&[r"C:\x\a.proc", "--quit"])), SecondLaunch::Quit);
    }

    #[test]
    fn plain_second_launch_opens() {
        assert_eq!(second_launch(args(&[])), SecondLaunch::Open(None));
        // 不存在的 .proc 不算(proc_arg 只认真实文件);像 --quit 却不是的参数也不算
        assert_eq!(second_launch(args(&[r"Z:\nope\a.proc", "--quitx", "quit"])), SecondLaunch::Open(None));
    }

    #[test]
    fn existing_proc_is_passed_through() {
        let dir = std::env::temp_dir().join(format!("pc-second-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.proc");
        std::fs::write(&f, "{}").unwrap();
        let p = f.to_string_lossy().to_string();
        assert_eq!(second_launch(args(&[&p])), SecondLaunch::Open(Some(p.clone())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn has_quit_arg_ignores_exe_position_by_caller() {
        assert!(!has_quit_arg(args(&["promptcut.exe"]).skip(1)));
        assert!(has_quit_arg(args(&["promptcut.exe", "--quit"]).skip(1)));
    }
}
