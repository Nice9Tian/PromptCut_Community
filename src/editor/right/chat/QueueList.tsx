import { useLayoutEffect, useRef, useState } from "react";
import { useQueue, remove, type QueuedItem } from "../../../ai/chatQueue";
import { playEnter, prefersReducedMotion } from "../../enterMotion";
import "./queue.css";
import type { ChatMessage } from "../../../ai/types";
import type { CloudQueueSnapshot, CloudSender } from "../../../ai/chatTypes";
import { accountMessageId, isIdleHead } from "../../../ai/chatTypes";

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
  return <section className="ai-queue" data-pc="cloud-queue" data-queue-revision={props.queue?.queueRevision} aria-label="云端持久队列">
    {queuedLook ? (
      <div className="ai-queue-head pc-cloud-render-queued" data-pc="cloud-queue-render-queued">
        云端渲染正在给别的项目用，排在第 {renderQueuePos} 位，轮到了会接着做。
      </div>
    ) : waitingJobs ? (
      <div className="ai-queue-head pc-cloud-waiting-jobs" data-pc="cloud-queue-waiting-jobs">
        上一条消息发起的后台作业（转写、镜头识别等）还在做，做完就处理你这条消息。
      </div>
    ) : (
      <div className="ai-queue-head">已排队 {items.length} 条 · 等待执行服务</div>
    )}
    {items.length > 0 && (
      <ol className="ai-queue-list">{items.map(item => {
        const id = accountMessageId(item.messageId), message = props.messages.find(row => row.id === id);
        return <li className="ai-queue-item" key={item.messageId} data-message-id={item.messageId} data-queue-position={item.position}>
          <span className="ai-queue-no">第 {item.position} 条</span>
          <span className="pc-cloud-sender">{props.senders?.[id]?.name ?? '发送者正在读取'}</span>
          <span className="ai-queue-text">{message?.text ?? '消息正在读取'}</span>
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
    lastHead.current = halted ? `已暂停 · 排队中 ${items.length} 条` : `排队中 ${items.length} 条 · Agent 完成后自动发送`;
  }

  // 幽灵行按原来的位置插回去(按原下标从小到大插,前面插进去的正好把后面的位置补齐)
  type Row = { ghost: false; it: QueuedItem; no: number } | { ghost: true; g: Ghost };
  const rows: Row[] = items.map((it, i) => ({ ghost: false, it, no: i + 1 }));
  for (const g of [...ghosts].sort((a, b) => a.at - b.at)) rows.splice(Math.min(g.at, rows.length), 0, { ghost: true, g });

  return (
    <section className="ai-queue" data-pc={leaving ? undefined : "ai-queue"} aria-label="输入队列" ref={sectionRef}>
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
              title="发出队首这一条,之后照常按顺序自动发送"
              onClick={onResume}
            >
              继续
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
                <span className={`ai-queue-text${it.text ? "" : " is-faint"}`}>{it.text || "(只有附件)"}</span>
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
                  <span className="ai-queue-text is-faint">输入框里有内容,替换成这一条?</span>
                  <button
                    type="button"
                    className="ai-queue-btn is-accent"
                    data-pc="queue-edit-confirm"
                    onClick={() => { setConfirmEdit(null); onEdit(it); }}
                  >
                    替换
                  </button>
                  <button type="button" className="ai-queue-btn" onClick={() => setConfirmEdit(null)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <span className={`ai-queue-text${it.text ? "" : " is-faint"}`} title={it.text || undefined}>
                    {it.text || "(只有附件)"}
                  </span>
                  {files.length > 0 && (
                    <span className="ai-queue-files" title={files.map((f) => f.name).join("\n")}>
                      附件 {files.length}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ai-queue-btn is-accent"
                    data-pc="queue-insert"
                    title={running ? "现在就发这一条:会打断当前运行" : "现在就发这一条"}
                    onClick={() => onInsert(it)}
                  >
                    插入
                  </button>
                  <button
                    type="button"
                    className="ai-queue-btn"
                    data-pc="queue-edit"
                    title="放回输入框修改,并移出队列"
                    onClick={() => (hasDraft() ? setConfirmEdit(it.id) : onEdit(it))}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ai-queue-btn ai-queue-x"
                    data-pc="queue-remove"
                    title="从队列里删掉"
                    aria-label={`删除第 ${no} 条`}
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
