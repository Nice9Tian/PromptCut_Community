/**
 * 拓展栏里那块聊天面板(用户 2026-10-26 定,issue #4)。
 *
 * 「详细编辑」一展开，时间轴编辑区就占满整个聊天区(连输入框一起)，聊天搬到这里来 ——
 * 和「画面」「修改前 / 修改后」并排的又一张独立的卡，进场有一下动画(`.ps-ext-chat` 的 `ps-ext-chat-in`)。
 * 它吃掉拓展栏剩下的高度，上面两段照常摊开(用户 2026-10-26 在两个方案里选的「甲」)。
 *
 * **窄，所以旧的都收起来**(issue #4 的原话:「达到两句以后截断为"..."。只保留最新的一条 Agent 回复」):
 *   - 只有**最新那一条 Agent 回复**留全文；
 *   - 其余 Agent 回复和**全部**用户气泡都收成两行，这一轮的「Agent 操作」也折起来，标一句「还有 N 条操作」；
 *   - 真的被截到了才摆出能点开的样子 —— 一行就说完的短句不加("点开看全文"是量出来的，不是猜的，
 *     因为这条栏能拖宽窄，按字数猜会错)；
 *   - 点任一条收起来的气泡，单独展开看全文；重新进详细编辑时这块面板重挂，展开过的又收回去。
 *
 * 气泡用自己的一套类名(`ps-x…`,x = 拓展栏里那块)，不和聊天列的 `.ps-msg` 混:那边是 760px 宽的阅读版式，
 * 这边最窄 250px(`sideWidth.ts` 的 `EXT_WIDTH.min`)，字号、内边距、头像都小一号。
 * 一轮回复怎么拆成「说的话 + 操作」，两边共用 `src/mobile/agentView.ts` 的 `roundView`，不另写一套。
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { ChatMessage } from "../ai/types";
import { activityText, runningTool } from "../editor/right/chat/AgentBubble";
import { isUserBubble, ordinals, partsOf, roundView, splitQuotes } from "../mobile/agentView";

const MARK: Record<string, string> = { done: "✓", run: "…", todo: "·", err: "!", ask: "!" };

/**
 * 一个能收起来的气泡外框。收起来时文字由 CSS 截成两行(`[data-folded]`)，
 * 这里只负责:量一下到底截没截到、藏起来的操作有几条、以及点开。
 */
function Foldable(props: {
  className: string;
  folded: boolean;
  /** 收起来之后藏掉的操作条数 */
  hiddenOps: number;
  onExpand: () => void;
  /** 内容的指纹:变了就重新量 */
  mark: string;
  children: ReactNode;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const p = box.current?.querySelector<HTMLElement>(".ps-xtext");
    if (!p || !props.folded) {
      setClipped(false);
      return;
    }
    const check = () => setClipped(p.scrollHeight - p.clientHeight > 2);
    check();
    // 这条栏能拖宽窄,宽度一变截不截得到就变了
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(p);
    return () => ro.disconnect();
  }, [props.folded, props.mark]);

  // 收起来了、而且**真的**有东西没露出来,才给能点开的样子 —— 一行说完的短句不给(CSS 看的是 `data-more`)
  const more = props.folded && (clipped || props.hiddenOps > 0);
  return (
    <div
      ref={box}
      className={props.className}
      data-folded={props.folded || undefined}
      data-more={more || undefined}
      title={more ? "点开看全文" : undefined}
      onClick={more ? props.onExpand : undefined}
    >
      {props.children}
      {more && props.hiddenOps > 0 && (
        <span className="ps-xmore">… 还有 {props.hiddenOps} 条操作</span>
      )}
    </div>
  );
}

function PanelUserMessage(props: { m: ChatMessage; folded: boolean; onExpand: () => void }): JSX.Element {
  const { quotes, rest } = splitQuotes(props.m.text);
  const body = `${quotes.map((q) => `@${q.label} `).join("")}${rest}`;
  return (
    <div className="ps-xmsg is-me" data-pc="start-ext-chat-msg" data-from="me">
      <Foldable className="ps-xbubble" folded={props.folded} hiddenOps={0} onExpand={props.onExpand} mark={body}>
        <p className="ps-xtext">{body}</p>
      </Foldable>
    </div>
  );
}

function PanelAgentMessage(props: { m: ChatMessage; ordinal: number; folded: boolean; onExpand: () => void }): JSX.Element {
  const { m } = props;
  const v = roundView(m, props.ordinal);
  const live = !!m.pending;
  const text = [...v.before, ...v.after].map((s) => s.text).join("\n");
  const ops = v.items;

  return (
    <div className="ps-xmsg is-agent" data-pc="start-ext-chat-msg" data-from="agent" data-live={live || undefined}>
      <span className="ps-xavatar" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.8c.5 4.3 2.1 6.1 6.4 6.6-4.3.5-5.9 2.3-6.4 6.6-.5-4.3-2.1-6.1-6.4-6.6 4.3-.5 5.9-2.3 6.4-6.6Z" />
        </svg>
      </span>
      <Foldable className="ps-xbody" folded={props.folded} hiddenOps={ops.length} onExpand={props.onExpand} mark={text}>
        <p className="ps-xtext">{text || (live ? "" : "（这一轮没有留下文字）")}</p>
        {ops.length > 0 && (
          <div className="ps-xops">
            <div className="ps-xops-head">Agent 操作</div>
            <ul className="ps-xops-list">
              {ops.map((it) => (
                <li key={it.key} data-state={it.state}><span className="ps-op-mark">{MARK[it.state]}</span>{it.kind} · {it.name}</li>
              ))}
            </ul>
          </div>
        )}
        {live && <p className="ps-xlive" data-pc="start-ext-chat-typing">{activityText(m, runningTool(partsOf(m)))}</p>}
        {m.error && <p className="ps-xlive is-err" role="alert">{m.error}</p>}
      </Foldable>
    </div>
  );
}

export function ExtChatPanel(props: {
  messages: readonly ChatMessage[];
  /** 输入框。和聊天列底部那个是同一个 React 状态(`Composer.tsx`)，搬过来草稿不丢 */
  composer: JSX.Element;
  /** 「回到整页」:收起详细编辑，聊天还回中间大区 */
  onBack: () => void;
  /** 没法发消息时的说明，没有消息时显示它 */
  whyNot: string | null;
}): JSX.Element {
  /** 用户自己点开过的那几条，按消息 id 记 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const tail = useRef<HTMLDivElement>(null);

  const shown = props.messages.filter((m) => m.role === "assistant" || isUserBubble(m));
  const order = ordinals(props.messages);
  // 「只保留最新的一条 Agent 回复」:全文的就这一条
  let keep: string | null = null;
  for (let i = shown.length - 1; i >= 0; i--) {
    if (shown[i].role === "assistant") { keep = shown[i].id; break; }
  }

  useLayoutEffect(() => { tail.current?.scrollIntoView({ block: "end" }); }, [props.messages]);

  const expand = (id: string) => setExpanded((s) => new Set(s).add(id));

  return (
    <section className="ps-ext-chat" data-pc="start-ext-chat">
      <div className="ps-ext-chat-head">
        <span className="ps-ext-chat-title">聊天</span>
        <span className="ps-rail-spacer" />
        <button type="button" className="ps-ext-action" data-pc="start-ext-chat-back"
          title="收起详细编辑，聊天回到中间大区" onClick={props.onBack}>
          回到整页
        </button>
      </div>

      <div className="ps-ext-chat-list" data-pc="start-ext-chat-list">
        {shown.length === 0 && (
          <p className="ps-ext-todo" data-pc="start-ext-chat-empty">
            {props.whyNot ?? "这条对话还没有消息，在下面说一句。"}
          </p>
        )}
        {shown.map((m) => {
          const folded = m.id !== keep && !expanded.has(m.id);
          if (m.role === "assistant" && m.id === keep && shown.length > 1) {
            return (
              <div key={m.id}>
                <div className="ps-xlatest">最新一条回复</div>
                <PanelAgentMessage m={m} ordinal={order.get(m.id) ?? 1} folded={false} onExpand={() => expand(m.id)} />
              </div>
            );
          }
          return m.role === "user"
            ? <PanelUserMessage key={m.id} m={m} folded={folded} onExpand={() => expand(m.id)} />
            : <PanelAgentMessage key={m.id} m={m} ordinal={order.get(m.id) ?? 1} folded={folded} onExpand={() => expand(m.id)} />;
        })}
        <div ref={tail} />
      </div>

      {props.composer}
    </section>
  );
}
