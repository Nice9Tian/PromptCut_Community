import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { DEBUG_INLINE_LIMIT, copyDebugReport, downloadReportFile, saveReportToFile } from "../../ai/debug";
import { SUBMIT_URL, submitBlockedReason, submitReport } from "../../ai/reportSubmit";
import "./ReportDialog.css";

/** 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」):在线构建里剪掉「请本机编辑器进程写盘」那条路 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * 诊断报告的子窗口:报告摆在文本框里,底下三个出口 —— 复制 / 保存为文件 / 提交。
 *
 * 以前是「点一下 Debugger,报告自己按长度选了条路走掉」。用户看不到报告长什么样,
 * 也没得挑:短的进剪贴板,长的直接落盘弹个文件夹。这里改成先把东西摆出来,
 * 三条路各是一个按钮,走哪条由用户定。
 *
 * 太长的报告**锁住复制**:几百 KB 粘进聊天框既贴不动也没人看,与其让用户
 * 复制成功却发不出去,不如当场说清楚「请改用保存为文件」。
 */
export function ReportDialog(props: {
  open: boolean;
  /** 窗口标题,比如「环境诊断」 */
  title: string;
  /** 报告正文;为空表示还在收集 */
  text: string;
  /** 存文件时的文件名前缀,不给就用 title */
  label?: string;
  /** 顶上那句说明这份报告里有什么 */
  hint?: string;
  /**
   * 「保存为文件」的做法;不给时:桌面版请本机编辑器写盘并打开所在文件夹,在线页面在浏览器里下载一份
   * (在线页面不请求编辑器进程的 `/api/*`)。返回给用户看的回执。
   */
  saveFile?: (text: string, label: string) => Promise<string> | string;
  onClose: () => void;
}): JSX.Element | null {
  const { open, title, text, hint, onClose } = props;
  const label = props.label || title;
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 每次重新打开都从干净状态开始,免得上次那句「已复制」还挂着
  useEffect(() => {
    if (open) { setBusy(""); setMsg(null); }
  }, [open]);

  // Esc 关掉子窗口。捕获阶段拦下来并 stopPropagation:外层 AI 设置对话框自己也听
  // Esc,不拦的话按一下会把两层一起关掉。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const chars = text.length;
  const kb = Math.round(chars / 1024);
  const tooLongToCopy = chars > DEBUG_INLINE_LIMIT;
  const submitBlocked = submitBlockedReason(text);
  const collecting = !text;

  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  };

  const doCopy = () => run("copy", async () => {
    await copyDebugReport(text);
    return "已复制到剪贴板,直接粘贴给我们就行";
  });

  const doSave = () => run("save", async () => {
    if (props.saveFile) return await props.saveFile(text, label);
    if (ONLINE_BUILD) return downloadReportFile(text, label);
    const out = await saveReportToFile(text, label);
    return `已保存并打开了所在文件夹:${out.file}`;
  });

  const doSubmit = () => run("submit", () => submitReport(text, label));

  return createPortal(
    // 盖在 AI 设置对话框上面,所以 z-index 要比它高一档(那边是 10000)
    <div className="rpt-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rpt-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="rpt-head">
          <div className="rpt-title">{title}</div>
          <button className="rpt-x" onClick={onClose} title="关闭" aria-label="关闭">×</button>
        </div>

        <div className="rpt-meta">
          <span>{collecting ? "正在收集…" : `${chars.toLocaleString()} 字符 · 约 ${kb}KB`}</span>
          {hint && <span className="rpt-hint">{hint}</span>}
        </div>

        <textarea
          className="rpt-text"
          readOnly
          spellCheck={false}
          value={collecting ? "" : text}
          placeholder="正在收集…"
          onFocus={(e) => { if (!tooLongToCopy) e.currentTarget.select(); }}
        />

        {tooLongToCopy && (
          <div className="rpt-warn">
            报告超过 {DEBUG_INLINE_LIMIT.toLocaleString()} 字符,已锁定「复制」——
            这么长的内容粘进聊天框贴不动也看不了。请用「保存为文件」,把生成的 txt 发给我们。
          </div>
        )}

        {msg && <div className={`rpt-msg${msg.tone === "err" ? " is-err" : ""}`}>{msg.text}</div>}

        <div className="rpt-actions">
          <button
            className="rpt-btn"
            disabled={collecting || tooLongToCopy || busy !== ""}
            title={tooLongToCopy ? "报告太长,粘不动。请改用「保存为文件」" : "把报告复制到剪贴板"}
            onClick={doCopy}
          >
            {busy === "copy" ? "复制中…" : "复制"}
          </button>
          <button
            className="rpt-btn"
            disabled={collecting || busy !== ""}
            title={ONLINE_BUILD ? "下载成文件" : "存成 txt 并打开所在文件夹"}
            onClick={doSave}
          >
            {busy === "save" ? "保存中…" : "保存为文件"}
          </button>
          <span className="rpt-spacer" />
          <button
            className="rpt-btn rpt-primary"
            disabled={collecting || submitBlocked !== "" || busy !== ""}
            title={submitBlocked || `发送到 ${SUBMIT_URL}`}
            onClick={doSubmit}
          >
            {busy === "submit" ? "提交中…" : "提交"}
          </button>
        </div>
        {submitBlocked && !collecting && <div className="rpt-note">{submitBlocked}</div>}
      </div>
    </div>,
    document.body,
  );
}
