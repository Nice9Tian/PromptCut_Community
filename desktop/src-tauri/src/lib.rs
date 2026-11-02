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
mod ui_text;

const EDITOR_URL: &str = "http://127.0.0.1:5210/";

/// The editor's own port (the one in `EDITOR_URL`).
const EDITOR_PORT: u16 = 5210;

/// The two stage ports = editor port +1 / +2 (`server/stage-ports.mjs`).
///
/// Since R7 the default is the cross-origin dual stage, and these two ports are served by reverse proxies the editor process starts
/// (`server/vite-plugin-stage-ports.ts`, with `Origin-Agent-Cluster: ?1`).
/// When another program occupies one, the editor does **not** fail to start: it merely skips that one proxy and the page falls back to the same-origin single stage,
/// so the two stage iframes drop back to one. Hence we only warn here and do not block startup: blocking would be worse than the web version.
const STAGE_PORTS: [u16; 2] = [EDITOR_PORT + 1, EDITOR_PORT + 2];

/// The .proc file in the launch arguments (double-clicking the file, right-click "Open with"). Only files that actually exist count.
fn proc_arg<I: Iterator<Item = String>>(args: I) -> Option<String> {
    args.filter(|a| a.to_lowercase().ends_with(".proc"))
        .find(|a| std::path::Path::new(a).is_file())
}

/// `--quit` in the launch arguments: makes the already running instance exit cleanly (used by the update patch apply-patch.ps1).
/// The first argument is the exe itself and does not count.
const QUIT_ARG: &str = "--quit";

/// What a second launch asks the already running instance to do.
#[derive(Debug, PartialEq, Eq)]
enum SecondLaunch {
    /// With `--quit`: take the same exit path as the tray "Close"
    Quit,
    /// Otherwise: bring the editor back, and open the .proc as well if one is given
    Open(Option<String>),
}

/// Parse the arguments of the second launch (excluding the exe itself). `--quit` takes priority: the update patch wants to shut down, not open a file.
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

/// Minimal percent-encoding: everything except letters, digits and -_.~ is escaped, and the frontend's URLSearchParams can decode it.
/// We do not pull in a url-encoding crate, since this is the only place that needs it.
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

/// Editor URL. When there is a .proc to open, it is attached as ?open=<path>: the frontend Shell has the server **make a copy first**
/// and then read the replica, so the original file is neither held open nor modified.
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
            eprintln!("[titlebar] cannot locate the app data directory: {e}");
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
                .set_title(ui_text::text("PromptCut — Reset Python libraries", &[]))
                .set_description(ui_text::text("This deletes {0}. The engine has to be downloaded again the next time you transcribe. Continue?", &[&path.display()]))
                .set_level(rfd::MessageLevel::Warning)
                .set_buttons(rfd::MessageButtons::OkCancel)
                .show();
            if confirm == rfd::MessageDialogResult::Ok {
                match fs::remove_dir_all(&path) {
                    Ok(_) => rfd::MessageDialog::new()
                        .set_title("PromptCut")
                        .set_description(ui_text::text("Deleted. It is downloaded again the next time you use speech recognition.", &[]))
                        .set_level(rfd::MessageLevel::Info)
                        .show(),
                    Err(e) => rfd::MessageDialog::new()
                        .set_title(ui_text::text("PromptCut — Deletion failed", &[]))
                        .set_description(ui_text::text("Deletion failed: {0}", &[&e]))
                        .set_level(rfd::MessageLevel::Error)
                        .show(),
                };
            }
        }
        "about" => show_about(&handle, &runtime_dir),
        // The title bar menu's "Quit" and the tray / floating window right-click "Close" take the same path (background.rs):
        // When collapsed, first move the main window back to its original position and then quit; sidecar cleanup and lock release are done in RunEvent
        "quit" => {
            background::dispatch(&handle, background::UiEvent::QuitRequested);
        }
        _ => {}
    }
}

/* ── The three commands for the .proc exclusive lock ──────────────────────────────────────────────
 *
 * True exclusivity can only be done by the shell: Windows share modes are managed by the kernel, and the kernel reclaims them as soon as the process dies.
 * The Node half (server/vite-plugin-skill-state.ts) handles atomic creation of the lock file and the pid fallback,
 * while the kernel-level handle is held here. Only the two halves together can both block concurrent access and avoid, when a process is force-killed,
 * leaving behind a lock that can never be released. What gets locked is the side file `<name>.proc.lock`, not the .proc itself
 * (locking the file itself would also block our own sidecar's reads and writes; see the explanation in proc_lock.rs).
 *
 * These commands do not exist when the frontend runs in a browser, where only the Node half is used: that is enough, it just lacks
 * the "auto-unlock even when force-killed" layer.
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
         e.textContent=m+'\\nUnsaved content in the editor is still preserved. Do not refresh the page directly.';}}\
         if(document.body){{w();}}else{{document.addEventListener('DOMContentLoaded',w,{{once:true}});}}}})()",
        literal
    )
}

/// Try a raw HTTP GET to `127.0.0.1:<port>` and return the response body
/// (up to 64 KiB) if the connection succeeds within `timeout`.
///
/// `Err` means "cannot connect", i.e. nobody occupies this port: this is exactly what the stage port pre-check relies on.
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

/// Pre-check of the editor port (old call sites see the same shape as before).
fn probe_port(timeout: Duration) -> Result<String, String> {
    probe_port_at(EDITOR_PORT, timeout)
}

/// Which stage ports are already occupied. A port that accepts a connection counts as occupied.
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
                // `promptcut.exe --quit` (update patch): the same path as the tray "Close"; when collapsed, first move the
                // main window back to its original position and then quit; sidecar cleanup and .proc lock release are done in RunEvent
                SecondLaunch::Quit => {
                    background::dispatch(app, background::UiEvent::QuitRequested);
                }
                SecondLaunch::Open(proc) => {
                    // A second launch = open the editor (move it back if it is collapsed in the background)
                    background::dispatch(app, background::UiEvent::OpenRequested);
                    // Most likely a .proc was double-clicked: hand it to the window that is already open
                    // (after the frontend receives pc-open-file it takes the "copy first, then read" path)
                    if let Some(p) = proc {
                        let _ = app.emit("pc-open-file", p);
                    }
                }
            }
        }))
        // Do not leave the window border to window-state: a "decorated": true saved by an old version would, at startup,
        // bring the system title bar back, stacking it with the skin title bar into two bars. The border is decided only by decorations(false) when the window is created.
        // "Visible" is not recorded either: before exiting, background mode first hides the main window and then moves it back to its original position (exit in background.rs),
        // and if "invisible" were recorded, the main window would never show up on the next launch. The main window is always shown at startup.
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
        // The background-mode state machine (editor open / collapsed / quitting), see background.rs
        .manage(background::Background::new())
        // The agent browser's debugging port is fixed at startup: both the main window's and the child webview's launch arguments must carry it
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
            // Reaching here with `--quit` means no other instance is running (if there were one, the single-instance plugin would already have passed the arguments on and
            // this process would have exited early). There is nothing to quit, so it must not start a new instance instead.
            if has_quit_arg(env::args().skip(1)) {
                std::process::exit(0);
            }
            let handle = app.handle().clone();

            // When launched by double-clicking a .proc, attach the path to the editor URL to pass it to the frontend
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
                        .set_description(ui_text::text("Port in use\n\nPort {0} is used by another program. Close it and start again.", &[&editor_port]))
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                    std::process::exit(1);
                }
            }

            /*
             * Pre-check of the two stage ports (R7). Only done when "this instance has to start the editor itself":
             * If a PromptCut is already running, 5211 / 5212 are supposed to be held by it anyway.
             *
             * Being occupied **does not block startup**: the editor side just does not start that one reverse proxy, and the page falls back to the same-origin single stage,
             * which still works. Blocking would be worse than the web version. But it must say which one, otherwise the user will only see
             * "why did the preview get slower" with no way to investigate.
             */
            if !existing_instance {
                let busy = if editor_port == EDITOR_PORT { occupied_stage_ports(Duration::from_millis(400)) }
                    else { [editor_port + 1, editor_port + 2].into_iter().filter(|port| probe_port_at(*port, Duration::from_millis(400)).is_ok()).collect() };
                if !busy.is_empty() {
                    let list = busy
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join(", ");
                    rfd::MessageDialog::new()
                        .set_title("PromptCut")
                        .set_description(ui_text::text(
                            "Stage ports in use\n\nPorts {0} are used by another program.\n\nPromptCut starts as usual, but the preview falls back to a single stage on one origin (the background prerender stage cannot be used, so scrubbing and playback are heavier than usual). Close the programs using these ports and restart to restore it.",
                            &[&list],
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
                // This must be turned off: if enabled, WebView2 installs an OS-level file drag-and-drop handler that swallows the page's HTML5
                // drag-and-drop events entirely: dragging a card from the media library to the timeline works in the browser but not once installed as the desktop app,
                // and that is exactly why. This app does not use Tauri's file drag-and-drop events (to accept files dragged in from the system,
                // use the standard web dataTransfer.files once it is off).
                .disable_drag_drop_handler()
                // The main window and the agent child webview share one WebView2 environment, so their launch arguments must be identical (including the debugging port)
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

            // The agent's browser: a child webview inside the main window, created right at the start (hidden outside the client area),
            // it must already exist when the Node side connects to the debugging port. If it cannot be created, only log it; the editor itself is unaffected.
            if let Err(e) = agent_webview::ensure(&handle) {
                eprintln!("[promptcut] agent webview was not created: {e}");
            }

            // ── Background mode: tray icon, floating window, closing the window does not quit (background.rs, skill_shell.rs) ──
            // Clicks on the tray or floating window right-click menu all arrive through the app-level menu event
            background::install_menu_handler(&handle);
            // If the tray cannot be created, only log it: the floating window can still bring the editor back, and right-click Close still works
            if let Err(e) = background::install_tray(&handle) {
                eprintln!("[promptcut] tray icon was not created: {e}");
            }
            // Watch the SKILL state file (collapse the editor when it becomes SKILL) and push progress to the floating window while collapsed
            skill_shell::spawn_watcher(handle.clone());
            let close_handle = handle.clone();
            win.on_window_event(move |event| {
                // Clicking close is not quitting: it collapses the editor into the background, and the page, the sidecar and the Agent connections all keep running.
                // Only "Close" from the tray or floating window right-click (and "Quit" from the title bar menu) really quits.
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
            // The agent browser is just the child webview inside the shell: pass the debugging port to Node, and puppeteer there connects directly
            let agent_port = handle.state::<agent_webview::AgentBrowser>().port;
            if agent_port != 0 {
                envs.insert("PROMPTCUT_AGENT_CDP".into(), agent_port.to_string());
                envs.insert("PROMPTCUT_AGENT_URL".into(), agent_webview::INITIAL_URL.into());
            }

            // ── Spawn sidecar ───────────────────────────────────────
            let app_dir = runtime_dir.join("app");
            let sidecar_cmd = handle.shell().sidecar("node").map_err(|e| {
                let msg = ui_text::text("Could not create the sidecar command: {0}", &[&e]);
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
                let msg = ui_text::text("Could not start the Node process: {0}", &[&e]);
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

            // One more kernel-level safeguard: put the sidecar into a kill-on-close job object,
            // so that however the shell process dies (crash, Task Manager, forced kill by the installer) it takes the sidecar with it.
            // The taskkill below only runs on a normal exit; on the forced-kill path not a single line of code can execute:
            // the orphaned ffmpeg left behind locks runtimefmpegfmpeg.exe and makes the next install unable to write to it.
            // On failure only log it: lacking this layer just returns to the old behavior and must not stop the app from starting.
            if let Err(e) = kill_on_close::attach_to_kill_on_close_job(pid) {
                eprintln!("[sidecar] kill-on-close protection was not attached; an abnormal exit may leave orphan processes: {e}");
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
                            let msg = ui_text::text("Node exited (code={0}). See the log:\n{1}", &[&code_str, &log_path_str]);
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
                        let msg = ui_text::text("Startup timed out. See the log:\n{0}", &[&log_path_poll.to_string_lossy()]);
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
                // The kernel would reclaim the handle at process exit anyway; releasing it explicitly here is for the "normal exit"
                // path, where the lock file can be deleted by the Node half (it only deletes the one written by its own pid, and deletion requires that
                // nobody holds the handle). If we do not release it, the next launch has to fall back to the weak pid criterion.
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

    let unknown = ui_text::text("unknown", &[]);
    let not_installed = ui_text::text("not installed", &[]);

    let app_ver = v.app.as_deref().unwrap_or(&unknown);
    let node_ver = v.node.as_deref().unwrap_or(&unknown);
    let chrome_ver = v.chrome.as_deref().unwrap_or(&unknown);
    let ffmpeg_ver = v.ffmpeg.as_deref().unwrap_or(&unknown);
    let python_ver = v.python.as_deref().unwrap_or(&not_installed);

    let text = ui_text::text(
        "PromptCut\n\nShell version: {0}\nApp: {1}\nNode: {2}\nChrome: {3}\nFFmpeg: {4}\nPython: {5}",
        &[&shell_version, &app_ver, &node_ver, &chrome_ver, &ffmpeg_ver, &python_ver],
    );

    rfd::MessageDialog::new()
        .set_title(ui_text::text("About PromptCut", &[]))
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
        // Carrying a .proc as well is still a quit: the update patch wants it shut down
        assert_eq!(second_launch(args(&[r"C:\x\a.proc", "--quit"])), SecondLaunch::Quit);
    }

    #[test]
    fn plain_second_launch_opens() {
        assert_eq!(second_launch(args(&[])), SecondLaunch::Open(None));
        // A .proc that does not exist does not count (proc_arg only accepts real files); an argument that looks like --quit but is not one does not count either
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
