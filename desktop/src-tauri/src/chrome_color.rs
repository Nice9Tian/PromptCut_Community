//! 读窗口原生菜单栏(文件 / 工具 / 外观 / 帮助那一行)当前显示的颜色。
//!
//! 为什么是「采样屏幕像素」而不是查系统颜色:菜单栏由 Windows 画,亮 / 暗主题、
//! 高对比度、Win10 / Win11 各不一样,`GetSysColor(COLOR_MENUBAR)` 在暗色模式下给的
//! 还是亮色值。直接看屏幕上那一行画出来是什么颜色,永远和用户眼睛看到的一致。
//! 前端拿到之后在网页顶部铺一条从这个颜色过渡到导航栏底色的渐变,菜单栏和导航栏
//! 之间就不再是一道生硬的分界。
//!
//! 采样点:客户区上边往上几个像素(那里正是菜单栏),横向取客户区右侧靠边的位置 ——
//! 菜单文字都在左边,右边是纯背景。窗口不可见 / 最小化时屏幕上那个位置是别的东西,
//! 前端只在窗口可见且有焦点时调,这里不再判断。

use tauri::Runtime;

#[derive(serde::Serialize)]
pub struct MenuBarColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[cfg(windows)]
#[tauri::command]
pub fn menu_bar_color<R: Runtime>(window: tauri::WebviewWindow<R>) -> Option<MenuBarColor> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID};

    let inner = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    if size.width < 80 {
        return None;
    }
    // 三个采样点取中位:万一哪一点正好落在分隔线或文字上
    let ys = [inner.y - 6, inner.y - 10, inner.y - 14];
    let x = inner.x + size.width as i32 - 40;
    let mut samples: Vec<[u8; 3]> = Vec::new();
    unsafe {
        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return None;
        }
        for y in ys {
            let c = GetPixel(hdc, x, y);
            if c.0 != CLR_INVALID {
                let v = c.0;
                samples.push([(v & 0xff) as u8, ((v >> 8) & 0xff) as u8, ((v >> 16) & 0xff) as u8]);
            }
        }
        ReleaseDC(None, hdc);
    }
    if samples.is_empty() {
        return None;
    }
    samples.sort_by_key(|s| s[0] as u32 + s[1] as u32 + s[2] as u32);
    let m = samples[samples.len() / 2];
    Some(MenuBarColor { r: m[0], g: m[1], b: m[2] })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn menu_bar_color<R: Runtime>(_window: tauri::WebviewWindow<R>) -> Option<MenuBarColor> {
    None
}
