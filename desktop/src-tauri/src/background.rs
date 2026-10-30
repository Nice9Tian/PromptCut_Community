//! 后台运行(A5):关掉编辑界面不退出,转成托盘图标和悬浮窗继续跑。
//!
//! 语义见 `docs/semantics/user-workflow.md`「后台运行」:
//!   * 关闭编辑界面不退出软件,转为托盘图标和悬浮窗继续运行;
//!   * 点托盘图标或悬浮窗重新打开编辑界面;
//!   * 只有在托盘图标或悬浮窗上右键选「关闭」才退出。
//!
//! # 「收起」为什么是挪到屏幕外而不是 hide()
//!
//! 编辑界面收起时页面不能停:AI 栏里的 Agent、桌面 APP 经 MCP 接进来的会话,它们的
//! `side: "page"` 工具(读选区、渲一帧、交回悬浮窗预览……)都在这份页面里执行。
//! WebView2 被 hide() 之后会停渲染(agent_webview.rs 里的子 webview 早就踩过),
//! 所以这里跟它一样:主窗留着「可见」,只是挪到所有显示器的左边外面、不进任务栏、
//! 不抢焦点。Chromium 自己的遮挡判断(CalculateNativeWinOcclusion)会把屏幕外的窗口
//! 当成被挡住而降频,所以 `agent_webview::browser_args` 里一并把它和后台降频关掉。
//!
//! # 状态机
//!
//! 纯逻辑放在 [`transition`] 里,窗口操作只按它给的动作做 —— 这样「关窗→收起」「收起时
//! 再点关闭不退出」「退出中不再拦关窗」这些规则能在 `cargo test` 里测,不必开窗。

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime};

/// 编辑界面(主窗口)现在的样子。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiState {
    /// 编辑界面开着(含最小化:最小化是用户自己的事,不算收起)
    Open,
    /// 收起了:主窗在屏幕外,托盘 + 悬浮窗
    Collapsed,
    /// 正在退出:之后的关窗一律放行
    Quitting,
}

/// 触发状态变化的事。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiEvent {
    /// 点了主窗的关闭(标题栏的 ×、Alt+F4)
    CloseRequested,
    /// 要打开编辑界面:托盘左键、托盘或悬浮窗菜单「打开编辑界面」、单击悬浮窗、第二次启动
    OpenRequested,
    /// 真退出:托盘或悬浮窗菜单「关闭」(以及标题栏菜单「退出」)
    QuitRequested,
    /// SKILL 模式打开(状态文件变成 active)
    SkillOn,
    /// SKILL 模式关掉
    SkillOff,
}

/// 状态机要窗口层做的事。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiAction {
    /// 什么都不做(关窗事件里意味着「拦下,不关」)
    None,
    /// 主窗挪到屏幕外、出悬浮窗
    Collapse,
    /// 主窗挪回来、收悬浮窗
    Restore,
    /// 已经开着:只把它提到前面
    Focus,
    /// 走干净退出(sidecar 清理、锁释放由 RunEvent 那一头做)
    Exit,
    /// 关窗放行(只在退出途中)
    AllowClose,
}

/// 纯状态转移。所有窗口层的决定都从这里来。
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

        // SKILL 缺省关闭编辑界面;用户之后自己打开的,不再被收回去(只认「变成」SKILL 的那一下)
        (S::Open, E::SkillOn) => (S::Collapsed, A::Collapse),
        (S::Collapsed, E::SkillOn) => (S::Collapsed, A::None),
        // 回到传统式 = 打开编辑界面
        (S::Collapsed, E::SkillOff) => (S::Open, A::Restore),
        (S::Open, E::SkillOff) => (S::Open, A::None),
    }
}

/// 托盘菜单与悬浮窗右键菜单共用的两项的 id。
pub const MENU_OPEN: &str = "pc-bg-open";
pub const MENU_QUIT: &str = "pc-bg-quit";

/// 菜单项 → 事件。不认识的 id(别的菜单)返回 None。
pub fn menu_event(id: &str) -> Option<UiEvent> {
    match id {
        MENU_OPEN => Some(UiEvent::OpenRequested),
        MENU_QUIT => Some(UiEvent::QuitRequested),
        _ => None,
    }
}

/// 物理像素的矩形(显示器或窗口)。
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
    /// 有没有重叠(面积大于零)
    pub fn overlaps(&self, o: &Rect) -> bool {
        (self.x as i64) < o.right()
            && (o.x as i64) < self.right()
            && (self.y as i64) < o.bottom()
            && (o.y as i64) < self.bottom()
    }
}

/// 离所有显示器的空隙。多留一点,免得窗口阴影或 DPI 取整蹭到屏幕边上。
const OFFSCREEN_GAP: i64 = 256;

/// 收起时主窗放哪:所有显示器最左边再往左一个窗宽加空隙,上沿对齐最上面的显示器。
///
/// 不用 -32000:那是 Windows 给最小化窗口的坐标,有的程序(和 Windows 自己)见到它会当成
/// 「最小化了」。也不能只放 x = -4000 这种定值:显示器排在主屏左边时,负坐标可能正好在屏上。
pub fn offscreen_position(monitors: &[Rect], win_w: u32, win_h: u32) -> (i32, i32) {
    let min_x = monitors.iter().map(|m| m.x as i64).min().unwrap_or(0);
    let min_y = monitors.iter().map(|m| m.y as i64).min().unwrap_or(0);
    let _ = win_h;
    let x = min_x - win_w as i64 - OFFSCREEN_GAP;
    // 夹在 i32 里;真夹到了也还是在所有显示器左边
    let x = x.clamp(i32::MIN as i64 / 2, i32::MAX as i64);
    (x as i32, min_y.clamp(i32::MIN as i64 / 2, i32::MAX as i64) as i32)
}

/// 挪回来时用不用记下的位置:还有显示器和它重叠就用,否则(显示器拔了、换了排列)交给
/// 调用方居中。
pub fn restore_position(saved: Rect, monitors: &[Rect]) -> Option<(i32, i32)> {
    if monitors.iter().any(|m| m.overlaps(&saved)) {
        Some((saved.x, saved.y))
    } else {
        None
    }
}

/// 收起前主窗的样子,挪回来时照着还原。位置、尺寸是「还原」状态下的(最大化的先还原再记)。
#[derive(Clone, Copy, Debug)]
struct Saved {
    rect: Rect,
    maximized: bool,
}

struct Inner {
    state: UiState,
    saved: Option<Saved>,
}

/// 进程级状态。`lib.rs` 在 setup 之前 `.manage(Background::new())`。
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

/// 现在收没收起。悬浮窗的轮询线程用它决定要不要推进度。
pub fn is_collapsed<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Background>()
        .map(|b| b.0.lock().map(|g| g.state == UiState::Collapsed).unwrap_or(false))
        .unwrap_or(false)
}

/// 走一步状态机,再照动作操作窗口。返回动作(关窗拦截要看它)。
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

/// 主窗的关窗事件。返回 true = 要拦下(不关)。
pub fn on_close_requested<R: Runtime>(app: &AppHandle<R>) -> bool {
    dispatch(app, UiEvent::CloseRequested) != UiAction::AllowClose
}

/// 主窗口。**不能用 `get_webview_window("main")`**:主窗口里加了 agent 的子 webview
/// (agent_webview.rs)之后它就不再是「一个窗口一个 webview」的 WebviewWindow,那个查法
/// 返回 None —— 老的 SKILL 收起(`main.hide()`)和第二次启动时的「叫回窗口」就是这样
/// 悄悄失效的。窗口层的操作都在 `Window` 上,按窗口查就对了。
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

/// 收起:记下位置,主窗挪到屏幕外(仍「可见」,页面照常跑),不进任务栏、不抢焦点;出悬浮窗。
fn collapse<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = main_window(app) {
        if main.is_minimized().unwrap_or(false) {
            let _ = main.unminimize();
        }
        let maximized = main.is_maximized().unwrap_or(false);
        if maximized {
            // 最大化的窗口挪不动;先还原,记还原后的位置,挪回来时再最大化
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
        // 万一之前被别的路径 hide() 过(老版本的 SKILL 收起),这里确保它还「可见」
        let _ = main.show();
    }
    crate::skill_shell::show_overlay(app);
}

/// 挪回来:回到记下的位置(显示器没了就居中)、进任务栏、拿焦点;收悬浮窗。
fn restore<R: Runtime>(app: &AppHandle<R>) {
    crate::skill_shell::hide_overlay(app);
    let saved = take_saved(app);
    if let Some(main) = main_window(app) {
        let _ = main.set_focusable(true);
        let _ = main.set_skip_taskbar(false);
        match saved.and_then(|s| restore_position(s.rect, &monitors_of(&main)).map(|p| (p, s))) {
            Some(((x, y), s)) => {
                if s.maximized {
                    // window-state 插件把「最大化之前的位置」记成最后一次 Moved 之前的坐标(prev_x)。
                    // 还原位置恰好等于最大化后的坐标时,maximize 不发 Moved,prev 就会停在屏幕外的
                    // 那个坐标上,下次启动再取消最大化窗口就看不见了(笔记本上实测踩到)。先挪到旁边
                    // 一个像素再挪回来,让 prev 一定落在屏幕上。
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

/// 退出。收起状态下先把主窗(藏起来)挪回记下的位置,不然 window-state 插件退出时
/// 记下的是屏幕外的坐标;子进程清理与 .proc 锁释放在 `lib.rs` 的 RunEvent 里,
/// 和原来标题栏「退出」走同一条路。
fn exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(saved) = take_saved(app) {
        if let Some(main) = main_window(app) {
            // 先藏再挪,屏幕上不闪一下;window-state 不记「可见」(lib.rs 里去掉了那一位)。
            // 收起前是最大化的,这里只还原到最大化之前的位置,不再最大化:藏着的窗口一最大化
            // 就会显示出来,而且实测(笔记本上的开发构建)退出那一刻最大化还没生效,
            // window-state 记下的是最大化的坐标加普通尺寸,下次启动窗口歪在左上角。
            // 代价是这种情况下下次启动不是最大化。
            let _ = main.hide();
            let _ = main.set_position(PhysicalPosition::new(saved.rect.x, saved.rect.y));
        }
    }
    crate::skill_shell::hide_overlay(app);
    app.exit(0);
}

/// 两项菜单:打开编辑界面 / 关闭。托盘与悬浮窗右键共用这一份的样子(各建各的实例)。
pub fn build_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(manager, MENU_OPEN, "打开编辑界面", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(manager)?;
    let quit = MenuItem::with_id(manager, MENU_QUIT, "关闭", true, None::<&str>)?;
    Menu::with_items(manager, &[&open, &sep, &quit])
}

/// 托盘图标:常在;左键单击打开编辑界面,右键出菜单。菜单事件走 app 级的
/// `on_menu_event`(见 [`install_menu_handler`]),托盘这边不另外接,免得同一下触发两次。
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

/// 托盘菜单和悬浮窗右键菜单的点击都从这里进。
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
        // 已经收起了再来一次关窗(比如任务管理器之外的途径),还是不退出
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
        // 开着 → 关窗收起 → 托盘点开 → SKILL 收起 → 用户点开一起改 → 右键关闭
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
        // 副屏排在主屏左边、还更高:负坐标就在屏上,不能写死 -4000
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
        // 左边那块屏拔掉了:不还原到看不见的地方
        assert_eq!(restore_position(saved, &[primary]), None);
    }

    #[test]
    fn rect_overlap_edges() {
        let a = Rect { x: 0, y: 0, w: 100, h: 100 };
        assert!(!a.overlaps(&Rect { x: 100, y: 0, w: 10, h: 10 }), "只贴边不算重叠");
        assert!(a.overlaps(&Rect { x: 99, y: 99, w: 10, h: 10 }));
    }
}
