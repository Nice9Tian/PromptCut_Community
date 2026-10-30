use std::path::Path;

/// Chromium's ANGLE loader does not initialize when its executable path uses
/// the Windows verbatim prefix. Keep the resolved location, but pass Chrome
/// an ordinary drive/UNC path. Sandbox authorization still uses canonical paths.
pub fn cache_dir(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", unc)
    } else if let Some(drive) = text.strip_prefix(r"\\?\") {
        drive.to_owned()
    } else {
        text.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chromium_paths() {
        assert_eq!(cache_dir(Path::new(r"\\?\C:\Program Files\PromptCut\chrome")), r"C:\Program Files\PromptCut\chrome");
        assert_eq!(cache_dir(Path::new(r"\\?\UNC\server\share\chrome")), r"\\server\share\chrome");
        assert_eq!(cache_dir(Path::new(r"C:\PromptCut\chrome")), r"C:\PromptCut\chrome");
    }
}
