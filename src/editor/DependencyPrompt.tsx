import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { sttStatus } from "./io/stt";
import { runSttInstall } from "./io/runSttInstall";
import { useInstallJobs } from "../ai/sttInstallStore";
import { SttInstallProgress } from "./right/SttInstallProgress";
import "./DependencyPrompt.css";

const DISMISS_KEY = "pc.deps.sttDismissed";

/**
 * 启动时的缺依赖提示。
 *
 * 语音转文字的引擎是按需安装的(几百 MB,不适合塞进安装包),但用户在真的
 * 点「字幕」之前不会知道少了东西 —— 那时才提示就晚了,他已经在等结果了。
 * 所以启动时检查一次,缺了就告诉他缺什么、能不能一键装上。
 *
 * 不是模态框:它挡不住任何操作,用户不想理会就点忽略,记进 localStorage 之后
 * 不再打扰。装引擎不是用完这个软件的前提,不该拿一个非关不可的弹窗堵住入口。
 */
export function DependencyPrompt() {
  const [missing, setMissing] = useState<string[] | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });
  const [startError, setStartError] = useState<string | null>(null);
  const jobs = useInstallJobs();
  const job = jobs.at(-1);

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    sttStatus()
      .then((s) => {
        if (!alive) return;
        const absent = Object.entries(s.engines)
          .filter(([, v]) => !v.installed)
          .map(([name]) => name);
        // 两个引擎装了任意一个就够用,不必两个都装
        setMissing(absent.length === Object.keys(s.engines).length ? absent : []);
      })
      // 内置 Python 都没就绪的话,这个提示上的「安装」按钮同样无能为力,
      // 与其给一个点了会失败的按钮,不如不提示 —— 那是打包环节的问题。
      .catch(() => { if (alive) setMissing([]); });
    return () => { alive = false; };
  }, [dismissed]);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* 无痕模式下记不住,忽略 */ }
    setDismissed(true);
  };

  const startInstall = () => {
    setStartError(null);
    try { runSttInstall("faster-whisper"); }
    catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
  };

  // 装完就自动收起,不用用户再点一次
  useEffect(() => {
    if (job?.phase !== "done") return;
    const timer = window.setTimeout(() => setDismissed(true), 2600);
    return () => window.clearTimeout(timer);
  }, [job?.phase]);

  const show = !dismissed && (missing?.length ?? 0) > 0;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="dep-prompt"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        >
          {job && job.phase !== "failed" ? (
            <SttInstallProgress job={job} />
          ) : (
            <>
              <div className="dep-prompt-title">缺少依赖扩展,请安装:语音转文字引擎</div>
              <div className="dep-prompt-body">
                装上之后才能把视频里的人声转成文字稿,自动配字幕和一键配特效都要用它。
                约几百 MB,装在软件自己的目录里,不动系统的 Python。
              </div>
              {job?.phase === "failed" && <div className="dep-prompt-error">上次安装失败:{job.error}</div>}
              {startError && <div className="dep-prompt-error">{startError}</div>}
              <div className="dep-prompt-actions">
                <button className="dep-prompt-btn is-primary" onClick={startInstall}>
                  {job?.phase === "failed" ? "重试安装" : "安装"}
                </button>
                <button className="dep-prompt-btn" onClick={dismiss}>忽略</button>
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
