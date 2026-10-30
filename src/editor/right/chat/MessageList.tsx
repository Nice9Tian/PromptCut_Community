import React, { useRef, useLayoutEffect, useReducer } from "react";
import type { ChatMessage } from "../../../ai/types";
import type { CloudSender } from "../../../ai/chatTypes";
import type { useInstallJobs } from "../../../ai/sttInstallStore";
import { UserBubble, type RewindHandlers } from "./UserBubble";
import { AgentBubble } from "./AgentBubble";
import { RoleAvatar } from "../RoleAvatar";
import { playEnter } from "../../enterMotion";
import type { ViewMode } from "./viewPrefs";
import type { InboundAgentMessage } from "../../../ai/types";
import { inboundPlan } from "./rowPlan";
import { HeightBook, isAtBottom, planSegments, prefixOffsets, shouldWindow, touchRecent, windowRange, type Segment } from "./listWindow";
import "./chat.css";

/** 空对话里唯一的示例句(本机与云端都用它;云端用它也要能只靠内置卡做出一支短片,见 `scripts/probes/cloud-agent-first-video-probe.mjs`) */
export const EMPTY_EXAMPLE = "为我快速创建一个视频告诉我软件都可以做什么。";

/** 工具方块 / 工具详情的展开回调。AiPanel 里经 ref 中转,引用永远不变 */
export interface RowHandlers {
  toggleTool: (key: string) => void;
  toggleChip: (key: string) => void;
  toggleRun: (key: string) => void;
}

/** 一条消息里属于它自己的展开状态:key 都以 `<消息id>:` 开头,取出来拼成字符串好做浅比较 */
function keysFor(set: Set<string>, id: string): string {
  const prefix = id + ":";
  const out: string[] = [];
  for (const k of set) if (k.startsWith(prefix)) out.push(k);
  return out.sort().join("|");
}

/** 两轮之间隔了这么久,就在中间插一行时间 */
const TIME_GAP_MS = 5 * 60 * 1000;
/** 一次提交里新冒出来超过这么多条,就当是整段换进来的(打开历史会话),不放入场动画 */
const MAX_ENTER_ROWS = 2;

/**
 * 一条消息大概发生在什么时候。助手消息有 startedAt;用户消息没有,
 * 但它的 id 就是发送那一刻的 Date.now()(旧记录里多角色回复的是 `时间戳-任务id`,parseInt 取得到前缀)。
 * 只认像毫秒时间戳的数,别把随手起的短 id 当成 1970 年。
 */
function timeOf(m: ChatMessage): number | null {
  if (typeof m.startedAt === "number") return m.startedAt;
  const n = parseInt(m.id, 10);
  return Number.isFinite(n) && n > 1e12 ? n : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 时间分隔行的写法:M月D日 HH:mm */
function formatStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

interface MessageRowProps {
  sender?: CloudSender;
  m: ChatMessage;
  view: ViewMode;
  showThinking: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  openRuns: Set<string>;
  /** 这条消息自己的展开 key(见 keysFor):memo 只看它,别的消息点开点收不牵动这一条 */
  openKeys: string;
  runKeys: string;
  /** 稳定引用的回调(AiPanel 里用 ref 中转),不然每次渲染都是新函数、memo 白做 */
  on: RowHandlers;
  /** 用户气泡上「回退到这里」的回调,同样是稳定引用;不给就不显示回退入口 */
  rewind?: RewindHandlers;
  /** 「Agent 操作」此刻显示的是不是这一轮(只对 Agent 回复有意义) */
  selected?: boolean;
  /** 点 Agent 回复的气泡:「Agent 操作」切到这一轮;稳定引用 */
  onSelectRound?: (id: string) => void;
}

/**
 * 一条消息的气泡(连同左边的头像)。
 *
 * 为什么单独成组件并 memo:Agent 一轮几百次工具调用,每个流式片段都 setMessages 一次;
 * 以前整个列表在 AiPanel 里 map 出来,每个片段都把**所有**历史消息重渲一遍(重新 partsOf、
 * renderMarkdown、JSON.stringify),历史到 1200 次工具时实测每片段 114 ms,界面卡死。
 * 流式只换最后一条的对象,其余消息引用不变 —— memo 之后它们一次都不重渲。
 */
// 标纯调用:否则本模块被 chat.css 的引入带进在线构建时,这一行算副作用,连带工具图标、ToolVisual 背后的 /api 调用都留下(M8 遗留 L24)
const MessageRow = /* @__PURE__ */ React.memo(function MessageRow(props: MessageRowProps) {
  const { m } = props;
  // 用户消息靠右、不放头像
  if (m.role === "user") {
    return (
      <div className="ai-row ai-row--user" data-pc-msg={m.id}>
        {props.sender && <span className="pc-cloud-sender" data-pc="cloud-message-sender" data-account-id={props.sender.accountId}>{props.sender.name}</span>}
        <UserBubble m={m} rewind={props.rewind} />
      </div>
    );
  }
  // Agent 消息靠左:28px 圆形头像 + 气泡。带 roleId 的(旧记录里的角色回复)头像按角色取色取字;普通对话就是「AI」
  return (
    <div className="ai-row ai-row--assistant" data-pc-msg={m.id}>
      <span className="ai-row-avatar">
        {m.roleId ? <RoleAvatar roleId={m.roleId} size={28} /> : <span className="ai-avatar-ai" aria-hidden="true">AI</span>}
      </span>
      <AgentBubble m={m} showThinking={props.showThinking} selected={props.selected} onSelect={props.onSelectRound} />
    </div>
  );
}, (a, b) =>
  a.m === b.m && a.view === b.view && a.showThinking === b.showThinking && a.installJobs === b.installJobs &&
  a.openKeys === b.openKeys && a.runKeys === b.runKeys && a.on === b.on && a.rewind === b.rewind &&
  a.sender === b.sender && a.selected === b.selected && a.onSelectRound === b.onSelectRound
);

export interface MessageListProps {
  senders?: Record<string, CloudSender>;
  messages: ChatMessage[];
  view: ViewMode;
  showThinking: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  openRuns: Set<string>;
  rowHandlers: RowHandlers;
  /** 空对话时点了示例句:把那句填进输入框 */
  onPickExample: (text: string) => void;
  /** 用户气泡上「回退到这里」的回调(稳定引用,见 UserBubble 的 RewindHandlers);不给就不显示回退入口 */
  rewind?: RewindHandlers;
  /** 「Agent 操作」此刻显示的那一轮(ActivityPanel 的 useRoundSelection) */
  selectedRound?: string | null;
  /** 点 Agent 回复的气泡:让「Agent 操作」切到这一轮(稳定引用) */
  onSelectRound?: (id: string) => void;
}

/** 列表里的一条:消息气泡、时间分隔行、「收到其他 Agent 的消息」小字、编排折叠块。每条渲染出来恰好是滚动区的一个直接子元素 */
type EntryKind = "user" | "assistant" | "time" | "note";
interface Entry {
  key: string;
  kind: EntryKind;
  render: () => React.ReactElement;
}

/** 没量过的条先按这些高度估;同类量满几条后改按它们的平均值(HeightBook) */
const DEFAULT_HEIGHTS: Record<EntryKind, number> = { user: 60, assistant: 200, time: 20, note: 20 };
/** 最近点过、按过键的几条保持渲染,气泡自己的状态(翻到哪一页、确认层开着)不因滚远被卸载而丢 */
const PIN_CAP = 8;
/** 还没量到滚动区高度时(第一次渲染)按这么高算窗口 */
const FALLBACK_VIEW_H = 800;
/**
 * 这一条的内容此刻真的排了版(没被 content-visibility: auto 跳过)。checkVisibility 只看祖先是否跳过内容,
 * 所以问它的第一个子元素;老浏览器没有这个参数时当作排了。
 */
function visibleForLayout(el: Element): boolean {
  const probe = el.firstElementChild;
  if (!probe) return true;
  const fn = (probe as Element & { checkVisibility?: (o?: { contentVisibilityAuto?: boolean }) => boolean }).checkVisibility;
  return typeof fn === "function" ? fn.call(probe, { contentVisibilityAuto: true }) : true;
}

/** 上下余量:可视高度的一半,至少 300px */
const overscanFor = (h: number) => Math.max(300, h / 2);

/**
 * 消息滚动区:贴底跟随、编排折叠块的插入位置、两轮之间的时间分隔、窗口化都在这里。
 *
 * 窗口化(C6.5 遗留):条数超过 WINDOW_MIN_ENTRIES(150)时只渲染可视区附近的几条(listWindow.ts),
 * 上下没渲染的用占位 div 顶住滚动条。消息高度不固定:渲染出来的每条都挂 ResizeObserver,实测高度按 key 记在 HeightBook 里,
 * 没量过的按同类平均估。流式中的那条、最后一条、有焦点的、最近动过的几条不论在哪都渲染。
 *
 * 滚动位置不靠浏览器的滚动锚定(overflow-anchor: none,见 chat.css),自己锚:不贴底时记住视口顶上第一条的位置,
 * 上面的条换了高度、占位换了估计、窗口挪了,在绘制之前把它挪回原处;贴底时照旧滚到底。
 */
export function MessageList(props: MessageListProps) {
  const { messages, view, showThinking, installJobs, expanded, openRuns, rowHandlers, onPickExample, rewind, selectedRound, onSelectRound } = props;
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  /**
   * 贴底跟随。
   *
   * 原来是在内容长出来之后才量「离底部还有多远」——那时候 scrollHeight 已经包含
   * 新内容了,只要这一批比阈值高,就会被判成「用户自己滚上去了」,于是再也不跟随。
   * 所以要在**内容变化之前**就把「当时在不在底部」记下来:onScroll 里维护 stickRef,
   * 那是用户最后一次表态。
   *
   * 不贴底时不往底部拽 —— 内容追加在下方,看的那一段不动;上方有高度变化时由锚点挪回。
   */
  const stickRef = useRef(true);

  const bookRef = useRef<HeightBook | null>(null);
  if (!bookRef.current) bookRef.current = new HeightBook(DEFAULT_HEIGHTS);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  /** 最近一次量到的滚动位置与可视高度 */
  const viewRef = useRef({ scrollTop: 0, clientHeight: 0 });
  /** 这一次渲染的布局:偏移表、是否窗口化、窗口范围;onScroll 里拿它判断要不要重渲 */
  const layoutRef = useRef<{ off: number[]; windowed: boolean; first: number; last: number }>({ off: [0], windowed: false, first: 0, last: 0 });
  /** 渲染出来的条,按 DOM 顺序(不含占位) */
  const shownRef = useRef<string[]>([]);
  const kindRef = useRef(new Map<string, EntryKind>());
  const elKeyRef = useRef(new WeakMap<Element, string>());
  const keyElRef = useRef(new Map<string, HTMLElement>());
  const observedRef = useRef(new Set<Element>());
  const roRef = useRef<ResizeObserver | null>(null);
  /**
   * 不贴底时的锚:视口顶上第一条,和它顶边在滚动内容里的位置(离内容顶边多远,不随滚动变)。
   * 按内容位置记而不是按离视口多远记:用户滚了一下、滚动事件还没到时布局先变了(ResizeObserver 先回调),
   * 按视口距离挪回会把用户这一下滚动也一起撤掉。
   */
  const anchorRef = useRef<{ key: string; contentTop: number } | null>(null);
  const pinnedRef = useRef<string[]>([]);
  /** 上一次落定(或滚动事件)时的内容高度与可视高度;隐藏期间清空 */
  const lastMetricsRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
  /** 上一次 settle 落定后的滚动位置:滚动事件报上来的还是这个位置,就是 settle 自己挪的回声 */
  const settledTopRef = useRef(-1);
  const focusKeyRef = useRef<string | null>(null);

  const computeRange = (off: number[]) => {
    const h = viewRef.current.clientHeight || FALLBACK_VIEW_H;
    return windowRange(off, { scrollTop: viewRef.current.scrollTop, clientHeight: h, stick: stickRef.current }, { overscan: overscanFor(h) });
  };

  const captureAnchor = () => {
    const box = messagesScrollRef.current;
    if (!box || box.getClientRects().length === 0) return;
    anchorRef.current = null;
    const br = box.getBoundingClientRect();
    const top = br.top;
    for (const key of shownRef.current) {
      const el = keyElRef.current.get(key);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // 只认和视口有交集的:视口里只有占位时不锚(强制渲染的最后一条远在下面,拿它当锚会把视口拖着跑)
      if (r.top >= br.bottom) return;
      if (r.bottom > top) {
        anchorRef.current = { key, contentTop: r.top - top + box.scrollTop };
        return;
      }
    }
  };

  /** 布局变了之后、绘制之前:贴底的滚到底,不贴底的把锚挪回原处 */
  const settle = () => {
    const box = messagesScrollRef.current;
    if (!box) return;
    // 分页不在前台(display:none)时量什么都是 0:不动,等它显示出来 ResizeObserver 再叫一次
    if (box.getClientRects().length === 0) {
      lastMetricsRef.current = null;
      return;
    }
    /*
     * 「当时在不在底部」按变化之前的内容高度判断:用户刚滚到底(或刚往上翻)、滚动事件还没派发,
     * 布局先变了(新进来的几条量出了真高度)——这时 stickRef 还是旧的表态。拿上一次的内容高度、可视高度
     * 和此刻的滚动位置比,就是用户最后停在哪儿。刚从隐藏变可见时滚动位置被清零了,不算数,沿用 stickRef。
     */
    const prev = lastMetricsRef.current;
    if (prev) {
      const atPrevBottom = isAtBottom(prev.scrollHeight, box.scrollTop, prev.clientHeight);
      // 内容变矮、滚动位置被浏览器夹回底部时,按旧高度算会「离底很远」:那也还是在底部
      const atNowBottom = isAtBottom(box.scrollHeight, box.scrollTop, box.clientHeight);
      if (stickRef.current) stickRef.current = atPrevBottom || atNowBottom;
      else stickRef.current = atPrevBottom;
    }
    if (stickRef.current) {
      box.scrollTop = box.scrollHeight;
    } else {
      const a = anchorRef.current;
      const el = a ? keyElRef.current.get(a.key) : undefined;
      if (a && el) {
        const d = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - a.contentTop;
        if (Math.abs(d) > 0.5) box.scrollTop += d;
      }
    }
    viewRef.current = { scrollTop: box.scrollTop, clientHeight: box.clientHeight };
    lastMetricsRef.current = { scrollHeight: box.scrollHeight, clientHeight: box.clientHeight };
    settledTopRef.current = box.scrollTop;
    captureAnchor();
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  const onMessagesScroll = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    // 自己在 settle 里挪出来的滚动也会派发滚动事件,等它到的时候内容可能又长了一截:那不是用户的表态,不重判贴底
    if (Math.abs(el.scrollTop - settledTopRef.current) >= 1) stickRef.current = isAtBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    viewRef.current = { scrollTop: el.scrollTop, clientHeight: el.clientHeight };
    lastMetricsRef.current = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    captureAnchor();
    const lay = layoutRef.current;
    if (!lay.windowed) return;
    const r = computeRange(lay.off);
    if (r.first !== lay.first || r.last !== lay.last) bump();
  };

  // 实测高度:渲染出来的每一条和滚动区本身都挂着。隐藏的分页(display:none)量出来全是 0,不记
  useLayoutEffect(() => {
    const ro = new ResizeObserver((list) => {
      const box = messagesScrollRef.current;
      if (!box || box.getClientRects().length === 0) return;
      let changed = false;
      for (const e of list) {
        if (e.target === box) {
          changed = true;
          continue;
        }
        const key = elKeyRef.current.get(e.target);
        const kind = key ? kindRef.current.get(key) : undefined;
        if (!key || !kind) continue;
        // 被 content-visibility 跳过、还没真正排过版的行,量到的是 contain-intrinsic-size 的占位值,不是真高度:不记
        if (!visibleForLayout(e.target)) continue;
        const h = e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height;
        if (bookRef.current!.set(key, kind, h)) changed = true;
      }
      // 有尺寸通知就说明布局动了(哪怕记账没变,比如占位值换成真高度而这个高度早就记过):先落定,再看要不要重算窗口
      settleRef.current();
      if (changed) bump();
    });
    roRef.current = ro;
    if (messagesScrollRef.current) ro.observe(messagesScrollRef.current);
    const observed = observedRef.current;
    return () => {
      ro.disconnect();
      observed.clear();
      roRef.current = null;
    };
  }, []);

  /*
   * 新消息淡入、上浮一点(enterMotion)。只给「刚追加进来」的一两条放:第一次渲染时已有的历史、
   * 打开历史会话一口气换进来的整段都不演 —— 几十条一起动既看不清也白花力气。
   * 见过的 id 记下来,之后流式更新、分页切回来都不再放。窗口外没渲染的那条自然不演。
   */
  const seenIds = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const seen = seenIds.current;
    if (!seen) {
      seenIds.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh: string[] = [];
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      fresh.push(m.id);
    }
    const box = messagesScrollRef.current;
    if (!box || fresh.length === 0 || fresh.length > MAX_ENTER_ROWS) return;
    for (const id of fresh) playEnter(box.querySelector(`[data-pc-msg="${CSS.escape(id)}"]`), "pc-enter-rise");
  }, [messages]);

  /** 到上一条为止最晚的时间点;新一轮(用户消息)离它超过 TIME_GAP_MS 就插时间行 */
  let lastAt: number | null = null;

  // 只装其他 Agent 消息的用户消息不画,挂到紧跟着的回复上(在「Agent 操作」里显示);每一轮的回复各画各的气泡,不合并(rowPlan.ts)
  const { inboundOnly, orphanNote } = inboundPlan(messages);

  /*
   * 摊平成一条条(Entry):每条渲染出来是滚动区的一个直接子元素,key 各自独立 ——
   * 窗口挪动、前后插时间行 / 编排块,MessageRow 都不会换位置重挂(memo 和展开状态都保得住)。
   * 这里只记怎么画,真正建元素只对窗口里的那几条做。
   */
  const entries: Entry[] = [];
  /** 流式中的消息画在哪一条里(并进前面气泡的,画在组头那一条) */
  const liveKeys = new Set<string>();
  messages.forEach((m) => {
    const hidden = inboundOnly.has(m.id);
    const at = timeOf(m);
    if (!hidden && m.role === "user" && at !== null && lastAt !== null && at - lastAt >= TIME_GAP_MS) {
      const stampAt = at;
      entries.push({ key: `${m.id}:time`, kind: "time", render: () => <div key={`${m.id}:time`} className="ai-time-sep">{formatStamp(stampAt)}</div> });
    }
    // 不画出来的(收到的 Agent 消息)也照样推进时间点,不然后面会多出时间分隔行
    const end = typeof m.finishedAt === "number" ? m.finishedAt : at;
    if (end !== null) lastAt = lastAt === null ? end : Math.max(lastAt, end);
    if (inboundOnly.has(m.id)) {
      const orphan = orphanNote.get(m.id);
      if (orphan) {
        entries.push({
          key: `${m.id}:inbound`,
          kind: "note",
          render: () => (
            <div key={`${m.id}:inbound`} className="ai-inbound-note">
              收到 {orphan} 条其他 Agent 的消息,等 Agent 开始处理
            </div>
          ),
        });
      }
    } else {
      if (m.pending) liveKeys.add(m.id);
      entries.push({
        key: m.id,
        kind: m.role === "user" ? "user" : "assistant",
        render: () => (
          <MessageRow
            key={m.id}
            m={m}
            sender={props.senders?.[m.id]}
            view={view}
            showThinking={showThinking}
            installJobs={installJobs}
            expanded={expanded}
            openRuns={openRuns}
            openKeys={keysFor(expanded, m.id)}
            runKeys={keysFor(openRuns, m.id)}
            on={rowHandlers}
            rewind={rewind}
            selected={m.role === "assistant" && selectedRound === m.id}
            onSelectRound={m.role === "assistant" ? onSelectRound : undefined}
          />
        ),
      });
    }
  });

  const n = entries.length;
  const book = bookRef.current;
  const off = prefixOffsets(entries.map((e) => book.get(e.key, e.kind)));
  const windowed = shouldWindow(n);
  let segments: Segment[];
  let range = { first: 0, last: n };
  if (windowed) {
    range = computeRange(off);
    const keep = new Set<string>(pinnedRef.current);
    if (focusKeyRef.current) keep.add(focusKeyRef.current);
    for (const k of liveKeys) keep.add(k);
    const forced: number[] = [n - 1];
    entries.forEach((e, i) => {
      if (keep.has(e.key)) forced.push(i);
    });
    segments = planSegments(off, range.first, range.last, forced);
  } else {
    segments = entries.map((_, index) => ({ kind: "item" as const, index }));
  }
  layoutRef.current = { off, windowed, first: range.first, last: range.last };
  const shown: string[] = [];
  const kinds = kindRef.current;
  kinds.clear();
  for (const e of entries) kinds.set(e.key, e.kind);
  for (const s of segments) if (s.kind === "item") shown.push(entries[s.index].key);
  shownRef.current = shown;

  // 每次提交之后、绘制之前:把渲染出来的条和 DOM 对上号、挂上测量,再贴底或挪回锚点。
  // 不给依赖数组 —— 流式输出每来一段都是一次提交,每次提交都要重新贴住。
  useLayoutEffect(() => {
    const box = messagesScrollRef.current;
    const ro = roRef.current;
    if (!box) return;
    const keys = shownRef.current;
    const map = new Map<string, HTMLElement>();
    const observed = observedRef.current;
    const alive = new Set<Element>();
    let i = 0;
    for (const child of Array.from(box.children)) {
      const el = child as HTMLElement;
      if (el.dataset.pcVspacer !== undefined) continue;
      const key = keys[i++];
      if (key === undefined) break;
      map.set(key, el);
      elKeyRef.current.set(el, key);
      alive.add(el);
      if (ro && !observed.has(el)) {
        ro.observe(el);
        observed.add(el);
      }
      // 滚出视口被 content-visibility 跳过的行按实测高度占位,量到的就是真高度,不会在估计值和真值之间来回跳
      const h = bookRef.current!.measured(key);
      if (h !== undefined && el.classList.contains("ai-row")) el.style.containIntrinsicSize = `auto ${Math.round(h)}px`;
    }
    for (const el of [...observed]) {
      if (alive.has(el)) continue;
      ro?.unobserve(el);
      observed.delete(el);
    }
    keyElRef.current = map;
    // 对话换了、消息被回退掉:丢掉不再出现的高度记录
    const bk = bookRef.current!;
    if (bk.size > 2 * kindRef.current.size + 200) bk.prune(new Set(kindRef.current.keys()));
    settle();
  });

  /** 事件落在哪一条上:从事件目标往上找到滚动区的直接子元素 */
  const entryKeyOf = (node: EventTarget | null): string | null => {
    const box = messagesScrollRef.current;
    let el: Node | null = node instanceof Node ? node : null;
    while (el && el.parentNode !== box) el = el.parentNode;
    return el instanceof Element ? (elKeyRef.current.get(el) ?? null) : null;
  };
  const touch = (e: React.SyntheticEvent) => {
    const key = entryKeyOf(e.target);
    if (key) pinnedRef.current = touchRecent(pinnedRef.current, key, PIN_CAP);
  };

  return (
    <div
      className="ai-messages"
      ref={messagesScrollRef}
      onScroll={onMessagesScroll}
      onPointerDown={touch}
      onKeyDown={touch}
      onFocus={(e) => {
        focusKeyRef.current = entryKeyOf(e.target);
      }}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !messagesScrollRef.current?.contains(next)) focusKeyRef.current = null;
      }}
    >
      {messages.length === 0 ? (
        <div className="ai-empty-state">
          {/* 空对话只留这一条示例句,本机与云端相同〔用户 2026-10-07 定〕 */}
          <button type="button" className="ai-empty-example" data-pc="ai-empty-example" onClick={() => onPickExample(EMPTY_EXAMPLE)}>
            {EMPTY_EXAMPLE}
          </button>
        </div>
      ) : (
        segments.map((s) =>
          s.kind === "spacer" ? (
            <div key={`spacer:${s.from}:`} className="ai-vspacer" data-pc-vspacer="" aria-hidden="true" style={{ height: s.height }} />
          ) : (
            entries[s.index].render()
          ),
        )
      )}
    </div>
  );
}
