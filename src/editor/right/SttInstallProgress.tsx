import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { InstallJob } from "../../ai/sttInstallStore";
import { describe, fractionOf } from "../../ai/sttInstallStore";
import "./SttInstallProgress.css";

/**
 * 安装进度控件。启动时的缺依赖提示和聊天窗口里的 stt_install 都用它,
 * 所以两个入口看到的是同一套状态和同一个样子。
 *
 * 进度条只在真的知道分母时才是确定态(下载单个文件),其余阶段走不确定态动画。
 * 装多少个包在 pip 解完依赖前无从得知,所以这里不编整体百分比。
 */
export function SttInstallProgress(props: { job: InstallJob; compact?: boolean }) {
  const { job, compact } = props;
  const [now, setNow] = useState(Date.now());
  const [logOpen, setLogOpen] = useState(false);
  // 系统开了「减少动态效果」就不要来回扫,CSS 那边会把它显示成一条静态的浅色条
  const reduceMotion = useReducedMotion();

  // 秒表要自己走:安装过程可能几分钟不出新日志,没有心跳的话界面看着像卡死
  useEffect(() => {
    if (job.phase === "done" || job.phase === "failed") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job.phase]);

  const fraction = fractionOf(job);
  const running = job.phase !== "done" && job.phase !== "failed";
  const seconds = Math.floor(((job.finishedAt ?? now) - job.startedAt) / 1000);
  const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;

  return (
    <div className={`stt-install ${job.phase} ${compact ? "is-compact" : ""}`} role="status" aria-live="polite">
      <div className="stt-install-head">
        <span className="stt-install-icon" aria-hidden>
          {job.phase === "done" ? "✓" : job.phase === "failed" ? "✗" : <span className="stt-install-spin" />}
        </span>
        <span className="stt-install-title">
          {job.phase === "done" ? "听写引擎已安装" : job.phase === "failed" ? "听写引擎安装失败" : "正在安装听写引擎"}
          <span className="stt-install-engine">{job.engine}</span>
        </span>
        {running && <span className="stt-install-elapsed">{elapsed}</span>}
      </div>

      <div className="stt-install-bar" aria-hidden>
        {fraction === null ? (
          // 不确定态:一条来回扫的高亮,明确表示「在动但不知道还剩多少」
          <motion.div
            className="stt-install-fill is-indeterminate"
            animate={reduceMotion ? undefined : { x: ["-60%", "160%"] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : (
          <motion.div
            className="stt-install-fill"
            initial={false}
            animate={{ width: `${Math.round(fraction * 100)}%` }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          />
        )}
      </div>

      <div className="stt-install-status">
        <span>{describe(job)}</span>
        {job.phase === "downloading" && job.totalMB !== undefined && job.gotMB !== undefined && (
          // 标清楚这个百分比是「当前这个文件」的,不是整体进度
          <span className="stt-install-sub">
            本文件 {job.gotMB.toFixed(1)}/{job.totalMB.toFixed(1)} MB
            {job.downloaded > 1 ? ` · 已下载 ${job.downloaded} 个包` : ""}
          </span>
        )}
        {job.phase === "resolving" && job.downloaded > 0 && (
          <span className="stt-install-sub">已下载 {job.downloaded} 个包</span>
        )}
      </div>

      {job.phase === "failed" && job.logTail.length > 0 && (
        <details open={logOpen} onToggle={(e) => setLogOpen((e.target as HTMLDetailsElement).open)}>
          <summary>查看安装日志</summary>
          <pre>{job.logTail.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
