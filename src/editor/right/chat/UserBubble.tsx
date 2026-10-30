import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../ai/types";
import { LiveMarkdown } from "../../../ai/Markdown";
import { attachIcon } from "./attachIcon";
import { OUTBOX_RESEND_EVENT, OUTBOX_TEXT } from "../../../ai/outbox";
import "./chat.css";
import "./queue.css";

/**
 * 「回退到这里」要用的几样。AiPanel 里经 ref 中转,引用永远不变 —— MessageRow 是 memo 的,
 * 条数、是否在跑这些会变的东西不能当 props 往下传,否则每个流式片段都会把所有用户气泡重渲一遍。
 * 所以都做成函数,点开确认层那一刻现取。
 */
export interface RewindHandlers {
  /** 回退到这条会移除几条消息(含它自己) */
  countFrom: (userMessageId: string) => number;
  /** 这一页此刻是否在跑:在跑的话确认层多一句「会先停止当前运行」 */
  isRunning: () => boolean;
  /** 输入框里此刻有没有内容:有的话提醒会被替换 */
  hasDraft: () => boolean;
  onRewind: (userMessageId: string) => void;
}

/** 「重新发送」发的窗口事件(定义在 outbox.ts,手机页共用) */
export const CLOUD_RESEND_EVENT = OUTBOX_RESEND_EVENT;

/** 逆时针的回退箭头 */
function IconRewind() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3v4h4" />
      <path d="M2.9 7A5.2 5.2 0 1 1 4.6 11.6" />
    </svg>
  );
}

/**
 * 一条用户消息:靠右的强调色气泡,不带头像。
 *
 * 附件排在正文上面,每个一枚文件小胶囊 —— 发出去的是哪几个文件,
 * 一眼对得上刚才输入区里那几张卡,不用去读一串「[附件: a, b, c]」。
 *
 * 悬停时气泡左边出现一个小工具条,里面是「回退到这里」;点了在气泡下面摊开确认层。
 */
export function UserBubble(props: { m: ChatMessage; rewind?: RewindHandlers }) {
  const { m, rewind } = props;
  /** 确认层打开那一刻的快照:会移除几条、是否在跑、输入框里有没有草稿 */
  const [confirm, setConfirm] = useState<{ count: number; running: boolean; draft: boolean } | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  // 打开后焦点先落在「取消」上:误点之后顺手按回车也不会真的回退
  useEffect(() => {
    if (!confirm) return;
    confirmRef.current?.querySelector<HTMLButtonElement>("[data-pc='ai-rewind-cancel']")?.focus();
  }, [confirm]);

  const toggleConfirm = () => {
    if (!rewind) return;
    setConfirm((cur) => (cur ? null : { count: rewind.countFrom(m.id), running: rewind.isRunning(), draft: rewind.hasDraft() }));
  };

  return (
    <div className="ai-user-turn">
      <div className="ai-user-line">
        {rewind && (
          <div className={`ai-user-tools${confirm ? " is-open" : ""}`}>
            <button
              type="button"
              className="pc-icon-btn"
              data-pc="ai-rewind"
              title="回到发这条消息之前:它和之后的对话从界面上移除,这条消息放回输入框"
              aria-label="回退到这里"
              aria-expanded={!!confirm}
              onClick={toggleConfirm}
            >
              <IconRewind />
            </button>
          </div>
        )}
        <div className={`ai-message user${m.sendState === "sending" || m.sendState === "queued" ? " is-sending" : m.sendState === "failed" ? " is-failed" : ""}`}>
          {m.attachments && m.attachments.length > 0 && (
            <div className="ai-bubble-files">
              {m.attachments.map((a, i) => (
                <span key={a.id || i} className="ai-bubble-file" title={a.name}>
                  <span aria-hidden="true">{attachIcon(a.kind)}</span>
                  <span className="ai-bubble-file-name">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {/* 只发了附件时正文是空的,别留一个空段落把气泡撑高 */}
          {m.text ? (
            <div className="ai-message-text">
              <LiveMarkdown text={m.text} live={!!m.pending} />
            </div>
          ) : null}
          {m.sendState === "sending" && <div className="ai-message-send-state" data-pc="cloud-send-state" data-state="sending">发送中…</div>}
          {m.sendState === "accepted" && <div className="ai-message-send-state" data-pc="cloud-send-state" data-state="accepted">已发出，等待云端开始处理…</div>}
          {m.sendState === "queued" && <div className="ai-message-send-state" data-pc="cloud-send-state" data-state="queued">{OUTBOX_TEXT.queued}</div>}
          {m.error && <div className="ai-message-error" data-pc={m.sendState === "failed" ? "cloud-send-failed" : undefined}>{m.error}</div>}
          {m.sendState === "failed" && m.resendable && (
            <button type="button" className="ai-message-resend" data-pc="cloud-resend"
              onClick={() => window.dispatchEvent(new CustomEvent(CLOUD_RESEND_EVENT, { detail: { id: m.id } }))}>
              {OUTBOX_TEXT.resend}
            </button>
          )}
        </div>
      </div>
      {rewind && confirm && (
        <div
          className="ai-rewind-confirm"
          role="alertdialog"
          aria-label="确认回退"
          data-pc="ai-rewind-dialog"
          ref={confirmRef}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setConfirm(null);
          }}
        >
          <p>
            回退后,这条及之后的 {confirm.count} 条消息会被移除,Agent 也会忘掉它们。时间轴上已经做过的修改<strong>不会</strong>撤销。
          </p>
          {confirm.running && <p className="ai-rewind-note">会先停止当前运行。</p>}
          {confirm.draft && <p className="ai-rewind-note">输入框里现有的内容会被这条消息替换。</p>}
          <div className="ai-rewind-actions">
            <button
              type="button"
              className="pc-btn-primary"
              data-pc="ai-rewind-confirm"
              onClick={() => {
                setConfirm(null);
                rewind.onRewind(m.id);
              }}
            >
              回退
            </button>
            <button type="button" className="ai-rewind-cancel" data-pc="ai-rewind-cancel" onClick={() => setConfirm(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
