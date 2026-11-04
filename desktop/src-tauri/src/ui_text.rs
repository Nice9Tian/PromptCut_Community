//! Text the desktop shell shows by itself: the tray menu and the native dialogs it opens before or
//! outside the editor. The editor's own text lives in `src/i18n`; the shell starts before the editor
//! and cannot reach the language chosen there, so these few lines follow the Windows display
//! language. English is the source, as everywhere else; `{0}` `{1}` are filled in by [`text`].

use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lang {
    En,
    Zh,
    Ja,
}

/// (English, Simplified Chinese, Japanese)
const ROWS: &[(&str, &str, &str)] = &[
    ("Open editor", "打开编辑界面", "編集画面を開く"),
    ("Quit", "关闭", "終了"),
    ("PromptCut — Reset Python libraries", "PromptCut — 重置 Python 库", "PromptCut — Python ライブラリのリセット"),
    (
        "This deletes {0}. The engine has to be downloaded again the next time you transcribe. Continue?",
        "会删除 {0}，下次转写时需要重新下载引擎，继续吗？",
        "{0} を削除します。次に文字起こしをするとき、エンジンをもう一度ダウンロードする必要があります。続けますか？",
    ),
    (
        "Deleted. It is downloaded again the next time you use speech recognition.",
        "已删除，下次使用语音识别时会重新下载",
        "削除しました。次に音声認識を使うときにもう一度ダウンロードされます。",
    ),
    ("PromptCut — Deletion failed", "PromptCut — 删除失败", "PromptCut — 削除に失敗しました"),
    ("Deletion failed: {0}", "删除失败: {0}", "削除に失敗しました: {0}"),
    (
        "Port in use\n\nPort {0} is used by another program. Close it and start again.",
        "端口被占用\n\n端口 {0} 被别的程序占用，请关掉它再启动。",
        "ポートが使用中です\n\nポート {0} は別のプログラムが使用しています。そのプログラムを終了してから起動し直してください。",
    ),
    (
        "Stage ports in use\n\nPorts {0} are used by another program.\n\nPromptCut starts as usual, but the preview falls back to a single stage on one origin (the background prerender stage cannot be used, so scrubbing and playback are heavier than usual). Close the programs using these ports and restart to restore it.",
        "舞台端口被占用\n\n端口 {0} 被别的程序占用。\n\nPromptCut 照常启动，但预览舞台会退回同源单舞台模式（后台预渲染舞台用不上，拖动和播放会比平时吃力）。关掉占用这些端口的程序再重启就能恢复。",
        "ステージ用のポートが使用中です\n\nポート {0} は別のプログラムが使用しています。\n\nPromptCut は通常どおり起動しますが、プレビューは同一オリジンの単一ステージに戻ります（バックグラウンドの事前レンダリング用ステージが使えないため、ドラッグや再生がいつもより重くなります）。これらのポートを使っているプログラムを終了して再起動すると元に戻ります。",
    ),
    ("Could not create the sidecar command: {0}", "无法创建 sidecar 命令: {0}", "sidecar コマンドを作成できません: {0}"),
    ("Could not start the Node process: {0}", "无法启动 Node 进程: {0}", "Node プロセスを起動できません: {0}"),
    ("Node exited (code={0}). See the log:\n{1}", "Node 已退出（code={0}），请查看日志:\n{1}", "Node が終了しました（code={0}）。ログを確認してください:\n{1}"),
    ("Startup timed out. See the log:\n{0}", "启动超时，请查看日志:\n{0}", "起動がタイムアウトしました。ログを確認してください:\n{0}"),
    ("unknown", "未知", "不明"),
    ("not installed", "未安装", "未インストール"),
    (
        "PromptCut\n\nShell version: {0}\nApp: {1}\nNode: {2}\nChrome: {3}\nFFmpeg: {4}\nPython: {5}",
        "PromptCut\n\n壳版本: {0}\n应用: {1}\nNode: {2}\nChrome: {3}\nFFmpeg: {4}\nPython: {5}",
        "PromptCut\n\nシェルのバージョン: {0}\nアプリ: {1}\nNode: {2}\nChrome: {3}\nFFmpeg: {4}\nPython: {5}",
    ),
    ("About PromptCut", "关于 PromptCut", "PromptCut について"),
    (
        "This project file is open in another PromptCut ({0})",
        "这个项目文件正被另一个 PromptCut 打开({0})",
        "このプロジェクトファイルは別の PromptCut で開かれています（{0}）",
    ),
];

fn lang() -> Lang {
    static LANG: OnceLock<Lang> = OnceLock::new();
    *LANG.get_or_init(|| {
        #[cfg(windows)]
        {
            // The primary language of the user's display language: 0x04 Chinese, 0x11 Japanese
            let id = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() } & 0x3ff;
            match id {
                0x04 => Lang::Zh,
                0x11 => Lang::Ja,
                _ => Lang::En,
            }
        }
        #[cfg(not(windows))]
        {
            Lang::En
        }
    })
}

fn pick(lang: Lang, en: &'static str) -> &'static str {
    if lang == Lang::En {
        return en;
    }
    match ROWS.iter().find(|row| row.0 == en) {
        Some(row) if lang == Lang::Zh => row.1,
        Some(row) => row.2,
        None => en,
    }
}

fn fill(template: &str, args: &[&dyn std::fmt::Display]) -> String {
    let mut out = template.to_string();
    for (i, arg) in args.iter().enumerate() {
        out = out.replace(&format!("{{{i}}}"), &arg.to_string());
    }
    out
}

/// `en` in the display language, with `{0}`, `{1}` … replaced by `args`
pub fn text(en: &'static str, args: &[&dyn std::fmt::Display]) -> String {
    fill(pick(lang(), en), args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holes(s: &str) -> Vec<usize> {
        let mut found: Vec<usize> = (0..10).filter(|i| s.contains(&format!("{{{i}}}"))).collect();
        found.sort();
        found
    }

    #[test]
    fn every_row_keeps_its_placeholders() {
        for (en, zh, ja) in ROWS {
            assert_eq!(holes(en), holes(zh), "{en}");
            assert_eq!(holes(en), holes(ja), "{en}");
        }
    }

    #[test]
    fn picks_the_language_and_fills_in_order() {
        assert_eq!(fill(pick(Lang::Zh, "Deletion failed: {0}"), &[&"x"]), "删除失败: x");
        assert_eq!(fill(pick(Lang::Ja, "Quit"), &[]), "終了");
        assert_eq!(fill(pick(Lang::En, "Node exited (code={0}). See the log:\n{1}"), &[&1, &"a.log"]), "Node exited (code=1). See the log:\na.log");
        assert_eq!(pick(Lang::Zh, "not in the table"), "not in the table");
    }
}
