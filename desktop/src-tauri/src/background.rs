//! Background mode (A5): closing the editor does not quit; it turns into a tray icon and a floating window that keep running.
//!
//! For the semantics see `docs/semantics/user-workflow.md` "Background mode":
//!   * Closing the editor does not quit the app; it turns into a tray icon and a floating window that keep running;
//!   * Click the tray icon or the floating window to reopen the editor;
//!   * The app quits only when you right-click the tray icon or the floating window and choose "Close".
//!
//! # Why "collapse" means moving off-screen instead of hide()
//!
//! The page must not stop while the editor is collapsed: the Agent in the AI panel and the sessions the desktop app connects through MCP all have their
//! `side: "page"` tools (read the selection, render a frame, hand back the floating window preview, etc.) run in this page.
//! WebView2 stops rendering once hide() is called on it (the child webview in agent_webview.rs hit this long ago),
//! so here we do the same: the main window stays "visible" and is only moved to the left of all monitors, kept out of the taskbar,
//! and not stealing focus. Chromium's own occlusion detection (CalculateNativeWinOcclusion) treats off-screen windows
//! as covered and throttles them, so `agent_webview::browser_args` turns it off together with background throttling.
//!
//! # State machine
//!
//! The pure logic lives in [`transition`], and window operations just do what it dictates, so rules like "close window → collapse", "when collapsed,
//! clicking close again does not quit" and "no longer block window close while quitting" can be tested in `cargo test` without opening a window.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime};

/// The current state of the editor (main window).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiState {
    /// The editor is open (including minimized: minimizing is the user's own business and does not count as collapsing)
    Open,
    /// Collapsed: the main window is off-screen; tray + floating window
    Collapsed,
    /// Quitting: every window close from now on is let through
    Quitting,
}

/// Events that trigger state changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiEvent {
    /// The main window's close was clicked (the × in the title bar, Alt+F4)
    CloseRequested,
    /// Open the editor: tray left click, "Open editor" in the tray or floating window menu, a click on the floating window, second launch
    OpenRequested,
    /// Really quit: "Close" in the tray or floating window menu (and "Quit" in the title bar menu)
    QuitRequested,
    /// SKILL mode turned on (the state file becomes active)
    SkillOn,
    /// SKILL mode turned off
    SkillOff,
}

/// What the state machine asks the window layer to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiAction {
    /// Do nothing (in the close-window event this means "block it, do not close")
    None,
    /// Move the main window off-screen and show the floating window
    Collapse,
    /// Move the main window back and hide the floating window
    Restore,
    /// Already open: just bring it to the front
    Focus,
    /// Take the clean-exit path (sidecar cleanup and lock release are done on the RunEvent side)
    Exit,
    /// Let the window close through (only while quitting)
    AllowClose,
}

/// Pure state transition. Every decision of the window layer comes from here.
pub fn transition(state: UiState, event: UiEvent) -> (UiState, UiAction) {
    use UiAction as A;
    use UiEvent as E;
    use UiState as S;
    match (state, event) {
        (S::Quitting, E::CloseRequested) => (S::Quitting, A::AllowClose),
        (S::Quitting, _) => (S::Quitting, A::None),
        (_, E::QuitRequested) => (S::Quitting, A::Exit),

        (S::Open, E::CloseRequested) => (S::Collapsed, A::Collapse),
        (S::Collapsed, E::CloseRequested) => (S::Collapsed, A::None),

        (S::Open, E::OpenRequested) => (S::Open, A::Focus),
        (S::Collapsed, E::OpenRequested) => (S::Open, A::Restore),

        // SKILL closes the editor by default; if the user opens it afterwards it is not collapsed again (only the moment of "becoming" SKILL counts)
        (S::Open, E::SkillOn) => (S::Collapsed, A::Collapse),
        (S::Collapsed, E::SkillOn) => (S::Collapsed, A::None),
        // Back to Classic mode = open the editor
        (S::Collapsed, E::SkillOff) => (S::Open, A::Restore),
        (S::Open, E::SkillOff) => (S::Open, A::None),
    }
}

/// IDs of the two items shared by the tray menu and the floating window's right-click menu.
pub const MENU_OPEN: &str = "pc-bg-open";
pub const MENU_QUIT: &str = "pc-bg-quit";

/// Menu item → event. An unrecognized id (from another menu) returns None.
pub fn menu_event(id: &str) -> Option<UiEvent> {
    match id {
        MENU_OPEN => Some(UiEvent::OpenRequested),
        MENU_QUIT => Some(UiEvent::QuitRequested),
        _ => None,
    }
}

/// A rectangle in physical pixels (a monitor or a window).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    fn right(&self) -> i64 {
        self.x as i64 + self.w as i64
    }
    fn bottom(&self) -> i64 {
        self.y as i64 + self.h as i64
    }
    /// Whether they overlap (area greater than zero)
    pub fn overlaps(&self, o: &Rect) -> bool {
        (self.x as i64) < o.right()
            && (o.x as i64) < self.right()
            && (self.y as i64) < o.bottom()
            && (o.y as i64) < self.bottom()
    }
}

/// Gap from all monitors. Leave a bit extra so the window shadow or DPI rounding does not graze the screen edge.
const OFFSCREEN_GAP: i64 = 256;

/// Where the main window goes when collapsed: one window width plus the gap to the left of the leftmost monitor, with its top edge aligned to the topmost monitor.
///
/// Not -32000: that is the coordinate Windows gives minimized windows, and some programs (and Windows itself) that see it will treat it as
/// "minimized". Nor can we just use a fixed value like x = -4000: when a monitor is arranged to the left of the primary screen, a negative coordinate may land right on a screen.
pub fn offscreen_position(monitors: &[Rect], win_w: u32, win_h: u32) -> (i32, i32) {
    let min_x = monitors.iter().map(|m| m.x as i64).min().unwrap_or(0);
    let min_y = monitors.iter().map(|m| m.y as i64).min().unwrap_or(0);
    let _ = win_h;
    let x = min_x - win_w as i64 - OFFSCREEN_GAP;
    // Clamped within i32; even if it really gets clamped, it is still to the left of all monitors
    let x = x.clamp(i32::MIN as i64 / 2, i32::MAX as i64);
    (x as i32, min_y.clamp(i32::MIN as i64 / 2, i32::MAX as i64) as i32)
}

/// Whether to use the remembered position when moving back: use it if some monitor still overlaps it, otherwise (a monitor was unplugged or the arrangement changed) leave it to
/// the caller to center.
pub fn restore_position(saved: Rect, monitors: &[Rect]) -> Option<(i32, i32)> {
    if monitors.iter().any(|m| m.overlaps(&saved)) {
        Some((saved.x, saved.y))
    } else {
        None
    }
}

/// The main window's state before collapsing, used to restore it when it moves back. Position and size are those of the "restored" state (a maximized window is restored first and then recorded).
#[derive(Clone, Copy, Debug)]
struct Saved {
    rect: Rect,
    maximized: bool,
}

struct Inner {
    state: UiState,
    saved: Option<Saved>,
}

/// Process-level state. `lib.rs` calls `.manage(Background::new())` before setup.
pub struct Background(Mutex<Inner>);

impl Background {
    pub fn new() -> Self {
        Background(Mutex::new(Inner { state: UiState::Open, saved: None }))
    }
}

impl Default for Background {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether it is collapsed right now. The floating window's polling thread uses it to decide whether to push progress.
pub fn is_collapsed<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Background>()
        .map(|b| b.0.lock().map(|g| g.state == UiState::Collapsed).unwrap_or(false))
        .unwrap_or(false)
}

/// Advance the state machine one step, then operate the windows according to the action. Returns the action (close-window interception needs it).
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, event: UiEvent) -> UiAction {
    let Some(bg) = app.try_state::<Background>() else {
        return UiAction::None;
    };
    let action = {
        let mut g = match bg.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let (next, action) = transition(g.state, event);
        g.state = next;
        action
    };
    match action {
        UiAction::Collapse => collapse(app),
        UiAction::Restore => restore(app),
        UiAction::Focus => focus_main(app),
        UiAction::Exit => exit(app),
        UiAction::None | UiAction::AllowClose => {}
    }
    action
}

/// The main window's close event. Returns true = block it (do not close).
pub fn on_close_requested<R: Runtime>(app: &AppHandle<R>) -> bool {
    dispatch(app, UiEvent::CloseRequested) != UiAction::AllowClose
}

/// The main window. **Do not use `get_webview_window("main")`**: once the main window holds the agent's child webview
/// (agent_webview.rs), it is no longer a WebviewWindow of the "one window, one webview" kind, and that lookup
/// returns None: this is how the old SKILL collapse (`main.hide()`) and the "bring the window back" on second launch
/// silently stopped working. Window-level operations all live on `Window`; looking up by window is the right way.
fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Window<R>> {
    app.get_window("main")
}

fn monitors_of<R: Runtime>(w: &tauri::Window<R>) -> Vec<Rect> {
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            w: m.size().width,
            h: m.size().height,
        })
        .collect()
}

fn set_saved<R: Runtime>(app: &AppHandle<R>, saved: Option<Saved>) {
    if let Some(bg) = app.try_state::<Background>() {
        if let Ok(mut g) = bg.0.lock() {
            g.saved = saved;
        }
    }
}

fn take_saved<R: Runtime>(app: &AppHandle<R>) -> Option<Saved> {
    app.try_state::<Background>()
        .and_then(|bg| bg.0.lock().ok().and_then(|mut g| g.saved.take()))
}

/// Collapse: remember the position, move the main window off-screen (still "visible", so the page keeps running), keep it out of the taskbar and do not steal focus; show the floating window.
fn collapse<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = main_window(app) {
        if main.is_minimized().unwrap_or(false) {
            let _ = main.unminimize();
        }
        let maximized = main.is_maximized().unwrap_or(false);
        if maximized {
            // A maximized window cannot be moved; restore it first, record the restored position, and maximize it again when moving back
            let _ = main.unmaximize();
        }
        let pos = main.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
        let size = main.outer_size().unwrap_or(PhysicalSize::new(1600, 960));
        set_saved(
            app,
            Some(Saved {
                rect: Rect { x: pos.x, y: pos.y, w: size.width, h: size.height },
                maximized,
            }),
        );
        let (x, y) = offscreen_position(&monitors_of(&main), size.width, size.height);
        let _ = main.set_skip_taskbar(true);
        let _ = main.set_focusable(false);
        let _ = main.set_position(PhysicalPosition::new(x, y));
        // In case it was hidden earlier through hide() by another path (the old SKILL collapse), make sure here that it is still "visible"
        let _ = main.show();
    }
    crate::skill_shell::show_overlay(app);
}

/// Move back: return to the remembered position (center if the monitor is gone), reappear in the taskbar, take focus; hide the floating window.
fn restore<R: Runtime>(app: &AppHandle<R>) {
    crate::skill_shell::hide_overlay(app);
    let saved = take_saved(app);
    if let Some(main) = main_window(app) {
        let _ = main.set_focusable(true);
        let _ = main.set_skip_taskbar(false);
        match saved.and_then(|s| restore_position(s.rect, &monitors_of(&main)).map(|p| (p, s))) {
            Some(((x, y), s)) => {
                if s.maximized {
                    // The window-state plugin records "the position before maximizing" as the coordinates from before the last Moved (prev_x).
                    // When the restored position happens to equal the maximized coordinates, maximize emits no Moved, so prev stays at the off-screen
                    // coordinates, and un-maximizing the window at the next launch leaves it invisible (hit in testing on the laptop). First move it aside by
                    // one pixel and then back, so that prev always lands on screen.
                    let _ = main.set_position(PhysicalPosition::new(x + 1, y));
                }
                let _ = main.set_position(PhysicalPosition::new(x, y));
                if s.maximized {
                    let _ = main.maximize();
                }
            }
            None => {
                let _ = main.center();
                if saved.map(|s| s.maximized).unwrap_or(false) {
                    let _ = main.maximize();
                }
            }
        }
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = main_window(app) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// Quit. When collapsed, first move the main window (hidden) back to the remembered position, otherwise the window-state plugin would, on exit,
/// record off-screen coordinates; child-process cleanup and .proc lock release happen in the RunEvent in `lib.rs`,
/// taking the same path as the original title bar "Quit".
fn exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(saved) = take_saved(app) {
        if let Some(main) = main_window(app) {
            // Hide first, then move, so nothing flashes on screen; window-state does not record "visible" (that bit was removed in lib.rs).
            // If it was maximized before collapsing, we only restore it to the pre-maximize position here and do not maximize again: a hidden window that gets maximized
            // becomes visible, and in testing (a dev build on the laptop) the maximize had not yet taken effect at the moment of quitting,
            // so window-state recorded the maximized coordinates with the normal size, leaving the window askew in the top-left corner on the next launch.
            // The cost is that in this case the next launch is not maximized.
            let _ = main.hide();
            let _ = main.set_position(PhysicalPosition::new(saved.rect.x, saved.rect.y));
        }
    }
    crate::skill_shell::hide_overlay(app);
    app.exit(0);
}

/// A two-item menu: Open editor / Close. The tray and the floating window's right-click share this layout (each builds its own instance).
pub fn build_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(manager, MENU_OPEN, crate::ui_text::text("Open editor", &[]), true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(manager)?;
    let quit = MenuItem::with_id(manager, MENU_QUIT, crate::ui_text::text("Quit", &[]), true, None::<&str>)?;
    Menu::with_items(manager, &[&open, &sep, &quit])
}

/// Tray icon: always present; left click opens the editor, right click shows the menu. Menu events go through the app-level
/// `on_menu_event` (see [`install_menu_handler`]); the tray does not hook it separately, to avoid one click firing twice.
pub fn install_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("promptcut-tray")
        .tooltip("PromptCut")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                dispatch(tray.app_handle(), UiEvent::OpenRequested);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Clicks on the tray menu and the floating window's right-click menu both come in here.
pub fn install_menu_handler<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        if let Some(e) = menu_event(event.id().as_ref()) {
            dispatch(app, e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use UiAction as A;
    use UiEvent as E;
    use UiState as S;

    const ALL_EVENTS: [UiEvent; 5] =
        [E::CloseRequested, E::OpenRequested, E::QuitRequested, E::SkillOn, E::SkillOff];

    #[test]
    fn close_collapses_instead_of_quitting() {
        assert_eq!(transition(S::Open, E::CloseRequested), (S::Collapsed, A::Collapse));
        // A close arriving when already collapsed (for example by some route other than Task Manager) still does not quit
        assert_eq!(transition(S::Collapsed, E::CloseRequested), (S::Collapsed, A::None));
    }

    #[test]
    fn only_quit_request_exits() {
        for s in [S::Open, S::Collapsed] {
            for e in ALL_EVENTS {
                let (_, a) = transition(s, e);
                assert_eq!(a == A::Exit, e == E::QuitRequested, "{s:?} + {e:?} -> {a:?}");
            }
        }
    }

    #[test]
    fn quitting_absorbs_everything_but_lets_windows_close() {
        for e in ALL_EVENTS {
            let (s, a) = transition(S::Quitting, e);
            assert_eq!(s, S::Quitting);
            let expect = if e == E::CloseRequested { A::AllowClose } else { A::None };
            assert_eq!(a, expect, "{e:?}");
        }
    }

    #[test]
    fn open_request_restores_or_focuses() {
        assert_eq!(transition(S::Collapsed, E::OpenRequested), (S::Open, A::Restore));
        assert_eq!(transition(S::Open, E::OpenRequested), (S::Open, A::Focus));
    }

    #[test]
    fn skill_mode_collapses_once_and_leaving_reopens() {
        assert_eq!(transition(S::Open, E::SkillOn), (S::Collapsed, A::Collapse));
        assert_eq!(transition(S::Collapsed, E::SkillOn), (S::Collapsed, A::None));
        assert_eq!(transition(S::Collapsed, E::SkillOff), (S::Open, A::Restore));
        assert_eq!(transition(S::Open, E::SkillOff), (S::Open, A::None));
    }

    #[test]
    fn full_cycle() {
        // open → close collapses it → opened from the tray → SKILL collapse → user opens it to co-edit → right-click Close
        let mut s = S::Open;
        let mut acts = vec![];
        for e in [E::CloseRequested, E::OpenRequested, E::SkillOn, E::OpenRequested, E::QuitRequested, E::CloseRequested] {
            let (n, a) = transition(s, e);
            s = n;
            acts.push(a);
        }
        assert_eq!(acts, vec![A::Collapse, A::Restore, A::Collapse, A::Restore, A::Exit, A::AllowClose]);
        assert_eq!(s, S::Quitting);
    }

    #[test]
    fn menu_ids_map_to_events() {
        assert_eq!(menu_event(MENU_OPEN), Some(E::OpenRequested));
        assert_eq!(menu_event(MENU_QUIT), Some(E::QuitRequested));
        assert_eq!(menu_event("something-else"), None);
        assert_ne!(MENU_OPEN, MENU_QUIT);
    }

    fn off_all(monitors: &[Rect], w: u32, h: u32) -> bool {
        let (x, y) = offscreen_position(monitors, w, h);
        let r = Rect { x, y, w, h };
        monitors.iter().all(|m| !m.overlaps(&r))
    }

    #[test]
    fn offscreen_single_monitor() {
        let m = [Rect { x: 0, y: 0, w: 1920, h: 1080 }];
        assert_eq!(offscreen_position(&m, 1600, 960), (-1600 - 256, 0));
        assert!(off_all(&m, 1600, 960));
    }

    #[test]
    fn offscreen_with_monitor_left_of_primary() {
        // A secondary monitor placed left of the primary one and higher up: negative coordinates are on screen, so -4000 cannot be hardcoded
        let m = [
            Rect { x: 0, y: 0, w: 2560, h: 1440 },
            Rect { x: -3840, y: -600, w: 3840, h: 2160 },
        ];
        let (x, y) = offscreen_position(&m, 3000, 1800);
        assert!(x < -3840);
        assert_eq!(y, -600);
        assert!(off_all(&m, 3000, 1800));
        assert_ne!(x, -32000);
    }

    #[test]
    fn offscreen_without_monitor_info() {
        assert_eq!(offscreen_position(&[], 1200, 720), (-1200 - 256, 0));
    }

    #[test]
    fn restore_falls_back_when_monitor_gone() {
        let saved = Rect { x: -1800, y: 100, w: 1600, h: 960 };
        let left = Rect { x: -1920, y: 0, w: 1920, h: 1080 };
        let primary = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        assert_eq!(restore_position(saved, &[primary, left]), Some((-1800, 100)));
        // The left monitor was unplugged: do not restore to a place that cannot be seen
        assert_eq!(restore_position(saved, &[primary]), None);
    }

    #[test]
    fn rect_overlap_edges() {
        let a = Rect { x: 0, y: 0, w: 100, h: 100 };
        assert!(!a.overlaps(&Rect { x: 100, y: 0, w: 10, h: 10 }), "merely touching edges is not an overlap");
        assert!(a.overlaps(&Rect { x: 99, y: 99, w: 10, h: 10 }));
    }
}
