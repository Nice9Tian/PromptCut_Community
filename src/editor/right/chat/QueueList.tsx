import { useLayoutEffect, useRef, useState } from "react";
import { useQueue, remove, type QueuedItem } from "../../../ai/chatQueue";
import { playEnter, prefersReducedMotion } from "../../enterMotion";
import "./queue.css";
import type { ChatMessage } from "../../../ai/types";
import type { CloudQueueSnapshot, CloudSender } from "../../../ai/chatTypes";
import { accountMessageId, isIdleHead } from "../../../ai/chatTypes";
import { tr } from "../../../i18n/index.ts";

/** Server FIFO is already accepted; local insert/edit/remove controls do not apply. */
export function CloudQueueList(props: { queue?: CloudQueueSnapshot | null; messages: ChatMessage[]; senders?: Record<string, CloudSender>;
  /** 云端的执行服务在问(`info.executorMounted`):在问时,对话空闲时排第一的那条马上就开始,不算排队;不在问时消息真在排着等,照旧列出来 */
  executorMounted?: boolean }) {
  // 对话空闲时排第一的那条马上开始,不算排队(它的气泡下写「已发出，等待云端开始处理…」,见 events.ts 的 isIdleHead)
  const items = props.queue?.items.filter(item => item.state === 'queued' && !(props.executorMounted && isIdleHead(props.queue, item)))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) ?? [];
  const waitingJobs = props.messages.some(m => m.role === 'assistant' && m.pending && (m.progress?.waitingJobs || m.progress?.phase === 'waiting_jobs'));
  const queuedLook = props.messages.find(m => m.role === 'assistant' && m.pending && ((m.progress as Record<string, any>)?.renderQueuePosition || m.progress?.phase === 'render_queued'));
  const renderQueuePos = (queuedLook?.progress as Record<string, any>)?.renderQueuePosition ?? 1;
  if (!items.length && !waitingJobs && !queuedLook) return null;
  return <section className="ai-queue" data-pc="cloud-queue" data-queue-revision={props.queue?.queueRevision} aria-label={tr("Persistent cloud queue")}>
    {queuedLook ? (
      <div className="ai-queue-head pc-cloud-render-queued" data-pc="cloud-queue-render-queued">
        {tr("The cloud render is busy with another project. You are No. {0} in the queue and it will continue when your turn comes.", renderQueuePos)}
      </div>
    ) : waitingJobs ? (
      <div className="ai-queue-head pc-cloud-waiting-jobs" data-pc="cloud-queue-waiting-jobs">
        {tr("The background job started by the previous message (transcription, shot detection, etc.) is still running. Your message will be handled once it finishes.")}
      </div>
    ) : (
      <div className="ai-queue-head">{tr("{0} queued · waiting for the execution service", items.length)}</div>
    )}
    {items.length > 0 && (
      <ol className="ai-queue-list">{items.map(item => {
        const id = accountMessageId(item.messageId), message = props.messages.find(row => row.id === id);
        return <li className="ai-queue-item" key={item.messageId} data-message-id={item.messageId} data-queue-position={item.position}>
          <span className="ai-queue-no">{tr("No. {0}", item.position)}</span>
          <span className="pc-cloud-sender">{props.senders?.[id]?.name ?? tr("Loading sender")}</span>
          <span className="ai-queue-text">{message?.text ?? tr("Loading message")}</span>
        </li>;
      })}</ol>
    )}
  </section>;
}

/** 离开队列的那一行淡出、收起的时长,和 queue.css 的 ai-queue-row-leave 一致 */
const LEAVE_MS = 160;

/** 刚离开队列的一行:在原来的位置(at)留一会儿演淡出,不带任何按钮和自动化钩子 */
interface Ghost {
  item: QueuedItem;
  at: number;
}

export interface QueueListProps {
  tabId: string;
  /** 这一页此刻在跑(streaming) */
  running: boolean;
  /** 「插入」:从队列拿出这一条立刻发送 —— 正在跑的那一轮会被打断(send 开头的 abort) */
  onInsert: (item: QueuedItem) => void;
  /** 「编辑」:这一条放回输入框并移出队列。要不要替换输入框里的内容,这里已经问过了 */
  onEdit: (item: QueuedItem) => void;
  /** 「继续」:解除暂停,空闲的话马上发队首 */
  onResume: () => void;
  /** 输入框里此刻有没有内容;有的话「编辑」先确认是否替换 */
  hasDraft: () => boolean;
}

/**
 * 输入队列,摆在思考条带和输入区之间;队列空着就不渲染。
 *
 * Agent 跑着的时候用户交上来的话排在这里,这一轮落定后由 useAiChat 按顺序自动发出。
 * 用户点了「停止」队列就暂停,头部换成「已暂停」和「继续」。
 *
 * 进出有动效:新排进来的行淡入(队列从空变有时整块上浮淡入),发出去 / 删掉 / 拿去编辑的行
 * 在原位淡出并收起;队列清空时头部跟着收起,整块不会「啪」地消失。
 */
export function QueueList(props: QueueListProps) {
  const { tabId, running, onInsert, onEdit, onResume, hasDraft } = props;
  const { items, paused } = useQueue(tabId);
  /** 正在确认「替换输入框内容」的那一条 */
  const [confirmEdit, setConfirmEdit] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const prevItems = useRef(items);
  /** 队列清空、头部收起时还显示着的那句话(清空前最后一次的头部文字) */
  const lastHead = useRef("");

  useLayoutEffect(() => {
    const before = prevItems.current;
    if (before === items) return;
    prevItems.current = items;
    const was = new Set(before.map((it) => it.id));
    const now = new Set(items.map((it) => it.id));
    if (before.length === 0 && items.length > 0) {
      playEnter(sectionRef.current, "pc-enter-rise");
    } else {
      // 列表自己会滚,行不做位移(多出来的几像素会让滚动条闪一下),只淡入
      for (const it of items) {
        if (!was.has(it.id)) playEnter(listRef.current?.querySelector(`[data-pc-queue="${CSS.escape(it.id)}"]`), "pc-enter-fade");
      }
    }
    // 系统要求减少动效时不留幽灵行:没有动画的话,那只是一行白白多挂 160ms 的死字
    if (prefersReducedMotion()) return;
    const gone: Ghost[] = before.flatMap((item, at) => (now.has(item.id) ? [] : [{ item, at }]));
    if (gone.length === 0) return;
    setGhosts((cur) => [...cur, ...gone]);
    window.setTimeout(() => setGhosts((cur) => cur.filter((g) => !gone.includes(g))), LEAVE_MS);
  }, [items]);

  if (items.length === 0 && ghosts.length === 0) return null;

  /** 只剩幽灵行:队列刚清空,正在收起 */
  const leaving = items.length === 0;
  // 用户停掉了,或者这会儿根本没在跑(没有谁会来发队首):都按暂停显示,给一个「继续」
  const halted = paused || !running;
  if (!leaving) {
    lastHead.current = halted ? tr("Paused · {0} queued", items.length) : tr("{0} queued · will send automatically when the Agent finishes", items.length);
  }

  // 幽灵行按原来的位置插回去(按原下标从小到大插,前面插进去的正好把后面的位置补齐)
  type Row = { ghost: false; it: QueuedItem; no: number } | { ghost: true; g: Ghost };
  const rows: Row[] = items.map((it, i) => ({ ghost: false, it, no: i + 1 }));
  for (const g of [...ghosts].sort((a, b) => a.at - b.at)) rows.splice(Math.min(g.at, rows.length), 0, { ghost: true, g });

  return (
    <section className="ai-queue" data-pc={leaving ? undefined : "ai-queue"} aria-label={tr("Input queue")} ref={sectionRef}>
      <div className={`ai-queue-head${halted && !leaving ? " is-paused" : ""}${leaving ? " is-leaving" : ""}`}>
        {leaving ? (
          <span className="ai-queue-head-text">{lastHead.current}</span>
        ) : halted ? (
          <>
            <span className="ai-queue-head-text">{lastHead.current}</span>
            <button
              type="button"
              className="ai-queue-btn is-accent"
              data-pc="queue-resume"
              title={tr("Send the first message in the queue now; the rest then send automatically in order as usual")}
              onClick={onResume}
            >
              {tr("Resume")}
            </button>
          </>
        ) : (
          <span className="ai-queue-head-text">{lastHead.current}</span>
        )}
      </div>
      <ol className="ai-queue-list" ref={listRef}>
        {rows.map((row) => {
          if (row.ghost) {
            const it = row.g.item;
            return (
              <li key={`ghost:${it.id}`} className="ai-queue-item is-leaving" aria-hidden="true">
                <span className="ai-queue-no" />
                <span className={`ai-queue-text${it.text ? "" : " is-faint"}`}>{it.text || tr("(attachments only)")}</span>
              </li>
            );
          }
          const { it, no } = row;
          const files = it.attachments ?? [];
          return (
            <li key={it.id} className="ai-queue-item" data-pc-queue={it.id}>
              <span className="ai-queue-no">{no}</span>
              {confirmEdit === it.id ? (
                <>
                  <span className="ai-queue-text is-faint">{tr("The input box has content. Replace it with this one?")}</span>
                  <button
                    type="button"
                    className="ai-queue-btn is-accent"
                    data-pc="queue-edit-confirm"
                    onClick={() => { setConfirmEdit(null); onEdit(it); }}
                  >
                    {tr("Replace")}
                  </button>
                  <button type="button" className="ai-queue-btn" onClick={() => setConfirmEdit(null)}>
                    {tr("Cancel")}
                  </button>
                </>
              ) : (
                <>
                  <span className={`ai-queue-text${it.text ? "" : " is-faint"}`} title={it.text || undefined}>
                    {it.text || tr("(attachments only)")}
                  </span>
                  {files.length > 0 && (
                    <span className="ai-queue-files" title={files.map((f) => f.name).join("\n")}>
                      {tr("Attachments {0}", files.length)}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ai-queue-btn is-accent"
                    data-pc="queue-insert"
                    title={running ? tr("Send this one now: interrupts the current run") : tr("Send this one now")}
                    onClick={() => onInsert(it)}
                  >
                    {tr("Insert")}
                  </button>
                  <button
                    type="button"
                    className="ai-queue-btn"
                    data-pc="queue-edit"
                    title={tr("Move back to the input box to edit, and remove from the queue")}
                    onClick={() => (hasDraft() ? setConfirmEdit(it.id) : onEdit(it))}
                  >
                    {tr("Edit")}
                  </button>
                  <button
                    type="button"
                    className="ai-queue-btn ai-queue-x"
                    data-pc="queue-remove"
                    title={tr("Remove from the queue")}
                    aria-label={tr("Delete item {0}", no)}
                    onClick={() => remove(tabId, it.id)}
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
