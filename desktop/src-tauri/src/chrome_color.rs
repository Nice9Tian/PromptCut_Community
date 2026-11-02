//! Read the color currently displayed by the window's native menu bar (the File / Tools / Appearance / Help row).
//!
//! Why "sample screen pixels" rather than query the system color: the menu bar is drawn by Windows, and light / dark themes,
//! high contrast and Win10 / Win11 all differ; in dark mode `GetSysColor(COLOR_MENUBAR)` returns
//! the light value anyway. Looking directly at what color that row is drawn in on screen always matches what the user sees.
//! Once the frontend has it, it lays a gradient across the top of the page that fades from this color to the navigation bar's base color, so the menu bar and the navigation bar
//! are no longer separated by a hard boundary.
//!
//! Sampling point: a few pixels above the top edge of the client area (that is exactly where the menu bar is), horizontally at the right side of the client area near the edge:
//! the menu text is all on the left and the right is plain background. When the window is invisible / minimized, that spot on screen holds something else,
//! so the frontend only calls this when the window is visible and focused; no check is made here.

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
    // Take the median of three sampling points, in case one of them lands right on a separator line or on text
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
