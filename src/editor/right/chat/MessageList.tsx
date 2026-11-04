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
import { tr } from "../../../i18n/index.ts";

/** The only example sentence in an empty chat (used by both local and cloud; the cloud must also be able to make a short video with built-in cards alone, see `scripts/probes/cloud-agent-first-video-probe.mjs`) */
export const EMPTY_EXAMPLE = tr("Quickly create a video for me that shows what the app can do.");

/** Expand callbacks for tool blocks / tool details. Relayed through a ref in AiPanel, so the reference never changes */
export interface RowHandlers {
  toggleTool: (key: string) => void;
  toggleChip: (key: string) => void;
  toggleRun: (key: string) => void;
}

/** The expand state belonging to one message: its keys all start with `<message id>:`, joined into a string for shallow comparison */
function keysFor(set: Set<string>, id: string): string {
  const prefix = id + ":";
  const out: string[] = [];
  for (const k of set) if (k.startsWith(prefix)) out.push(k);
  return out.sort().join("|");
}

/** If this much time has passed between two rounds, insert a time row between them */
const TIME_GAP_MS = 5 * 60 * 1000;
/** If more than this many entries newly appear in one commit, treat it as a whole run swapped in (opening a historical session) and skip the entrance animation */
const MAX_ENTER_ROWS = 2;

/**
 * Roughly when a message happened. Assistant messages have startedAt; user messages do not,
 * but their id is the Date.now() of the moment of sending (in old records, a multi-role reply is
 * `timestamp-task id`, and parseInt gets the prefix).
 * Only accept numbers that look like millisecond timestamps, so a short id made up on the spot is not taken as 1970.
 */
function timeOf(m: ChatMessage): number | null {
  if (typeof m.startedAt === "number") return m.startedAt;
  const n = parseInt(m.id, 10);
  return Number.isFinite(n) && n > 1e12 ? n : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Format of the time separator row: M/D HH:mm (month, day, time) */
function formatStamp(ts: number): string {
  const d = new Date(ts);
  return tr("{0}/{1} {2}:{3}", d.getMonth() + 1, d.getDate(), pad2(d.getHours()), pad2(d.getMinutes()));
}

interface MessageRowProps {
  sender?: CloudSender;
  m: ChatMessage;
  view: ViewMode;
  showThinking: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  openRuns: Set<string>;
  /** This message's own expand keys (see keysFor): memo looks only at them, so expanding or collapsing other messages does not affect this one */
  openKeys: string;
  runKeys: string;
  /** Callbacks with stable references (relayed through a ref in AiPanel); otherwise every render makes a new function and memo is wasted */
  on: RowHandlers;
  /** Callback for "Rewind to here" on a user bubble, also a stable reference; if not given, the rewind entry is not shown */
  rewind?: RewindHandlers;
  /** Whether "Agent activity" currently shows this round (only meaningful for Agent replies) */
  selected?: boolean;
  /** Click an Agent reply bubble: switches "Agent activity" to this round; stable reference */
  onSelectRound?: (id: string) => void;
}

/**
 * The bubble of one message (together with the avatar on the left).
 *
 * Why it is a separate memoized component: one Agent round makes hundreds of tool calls, and every
 * streamed fragment calls setMessages once; previously the whole list was mapped out in AiPanel, so
 * every fragment re-rendered **all** historical messages (partsOf, renderMarkdown and
 * JSON.stringify again), and with 1200 tool calls of history it measured 114 ms per fragment and
 * the UI froze.
 * Streaming replaces only the last entry's object and the other messages keep their references:
 * with memo, they never re-render.
 */
// Mark as a pure call: otherwise, when this module is pulled into the online build by the chat.css import, this line counts as a side effect and keeps the tool icons and the /api calls behind ToolVisual (M8 leftover L24)
const MessageRow = /* @__PURE__ */ React.memo(function MessageRow(props: MessageRowProps) {
  const { m } = props;
  // User messages are right-aligned, with no avatar
  if (m.role === "user") {
    return (
      <div className="ai-row ai-row--user" data-pc-msg={m.id}>
        {props.sender && <span className="pc-cloud-sender" data-pc="cloud-message-sender" data-account-id={props.sender.accountId}>{props.sender.name}</span>}
        <UserBubble m={m} rewind={props.rewind} />
      </div>
    );
  }
  // Agent messages are left-aligned: 28px round avatar + bubble. For ones with a roleId (role replies in old records), the avatar takes its color and letter from the role; a normal chat shows "AI"
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
  /** Clicked the example sentence in an empty chat: fill it into the input box */
  onPickExample: (text: string) => void;
  /** Callback for "Rewind to here" on a user bubble (stable reference, see RewindHandlers of UserBubble); if not given, the rewind entry is not shown */
  rewind?: RewindHandlers;
  /** The round currently shown by "Agent activity" (useRoundSelection of ActivityPanel) */
  selectedRound?: string | null;
  /** Click an Agent reply bubble: make "Agent activity" switch to this round (stable reference) */
  onSelectRound?: (id: string) => void;
}

/** One entry in the list: a message bubble, a time separator row, small text "Received a message from another Agent", or a collapsed arrangement block. Each renders as exactly one direct child of the scroll area */
type EntryKind = "user" | "assistant" | "time" | "note";
interface Entry {
  key: string;
  kind: EntryKind;
  render: () => React.ReactElement;
}

/** Unmeasured entries are first estimated with these heights; once a few of a kind are measured, their average is used instead (HeightBook) */
const DEFAULT_HEIGHTS: Record<EntryKind, number> = { user: 60, assistant: 200, time: 20, note: 20 };
/** The few entries recently clicked or key-pressed stay rendered, so a bubble's own state (which page it is on, a confirmation layer being open) is not lost when scrolling far away unmounts it */
const PIN_CAP = 8;
/** Height to compute the window with before the scroll area height has been measured (first render) */
const FALLBACK_VIEW_H = 800;
/**
 * Whether this entry's content has actually been laid out right now (not skipped by
 * content-visibility: auto). checkVisibility only looks at whether an ancestor skips content,
 * so ask about its first child element; old browsers without this parameter are treated as laid out.
 */
function visibleForLayout(el: Element): boolean {
  const probe = el.firstElementChild;
  if (!probe) return true;
  const fn = (probe as Element & { checkVisibility?: (o?: { contentVisibilityAuto?: boolean }) => boolean }).checkVisibility;
  return typeof fn === "function" ? fn.call(probe, { contentVisibilityAuto: true }) : true;
}

/** Margin above and below: half the visible height, at least 300px */
const overscanFor = (h: number) => Math.max(300, h / 2);

/**
 * Message scroll area: stick-to-bottom following, the insertion position of the collapsed
 * arrangement block, the time separator between two rounds, and windowing all live here.
 *
 * Windowing (C6.5 leftover): when the entry count exceeds WINDOW_MIN_ENTRIES (150), only the
 * entries near the visible area are rendered (listWindow.ts), and spacer divs above and below hold
 * up the scrollbar. Message heights are not fixed: every rendered entry gets a ResizeObserver, the
 * measured height is recorded by key in HeightBook, and unmeasured entries are estimated by the
 * average of their kind. The streaming entry, the last entry, the focused ones and the few recently
 * touched ones are rendered wherever they are.
 *
 * The scroll position does not rely on the browser's scroll anchoring (overflow-anchor: none, see
 * chat.css) but anchors itself: when not stuck to the bottom, it remembers the position of the first
 * entry at the top of the viewport; when entries above change height, a spacer changes its estimate
 * or the window moves, it moves it back to where it was before painting; when stuck to the bottom,
 * it scrolls to the bottom as before.
 */
export function MessageList(props: MessageListProps) {
  const { messages, view, showThinking, installJobs, expanded, openRuns, rowHandlers, onPickExample, rewind, selectedRound, onSelectRound } = props;
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  /**
   * Stick-to-bottom following.
   *
   * It used to measure "how far from the bottom" only after the content had grown: by then
   * scrollHeight already included the new content, so any batch taller than the threshold was judged
   * as "the user scrolled up on their own" and it never followed again.
   * So whether it was at the bottom at that time must be recorded **before the content changes**:
   * onScroll maintains stickRef, which is the user's last statement.
   *
   * When not stuck to the bottom, it does not pull toward the bottom: content is appended below and
   * the part being read does not move; height changes above are moved back by the anchor.
   */
  const stickRef = useRef(true);

  const bookRef = useRef<HeightBook | null>(null);
  if (!bookRef.current) bookRef.current = new HeightBook(DEFAULT_HEIGHTS);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  /** The most recently measured scroll position and visible height */
  const viewRef = useRef({ scrollTop: 0, clientHeight: 0 });
  /** The layout of this render: offset table, whether windowed, window range; onScroll uses it to decide whether to re-render */
  const layoutRef = useRef<{ off: number[]; windowed: boolean; first: number; last: number }>({ off: [0], windowed: false, first: 0, last: 0 });
  /** The rendered entries, in DOM order (spacers excluded) */
  const shownRef = useRef<string[]>([]);
  const kindRef = useRef(new Map<string, EntryKind>());
  const elKeyRef = useRef(new WeakMap<Element, string>());
  const keyElRef = useRef(new Map<string, HTMLElement>());
  const observedRef = useRef(new Set<Element>());
  const roRef = useRef<ResizeObserver | null>(null);
  /**
   * Anchor when not stuck to the bottom: the first entry at the top of the viewport, and the position
   * of its top edge in the scroll content (its distance from the content top, which does not change
   * with scrolling).
   * It is recorded by content position rather than distance from the viewport: if the user scrolls a
   * bit and the layout changes before the scroll event arrives (ResizeObserver calls back first),
   * moving back by viewport distance would also undo the user's scroll.
   */
  const anchorRef = useRef<{ key: string; contentTop: number } | null>(null);
  const pinnedRef = useRef<string[]>([]);
  /** Content height and visible height at the last settle (or scroll event); cleared while hidden */
  const lastMetricsRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
  /** Scroll position after the last settle: if a scroll event reports this same position, it is the echo of settle's own move */
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
      // Only accept entries that intersect the viewport: when the viewport holds only spacers, do not anchor (the force-rendered last entry is far below, and using it as the anchor would drag the viewport along)
      if (r.top >= br.bottom) return;
      if (r.bottom > top) {
        anchorRef.current = { key, contentTop: r.top - top + box.scrollTop };
        return;
      }
    }
  };

  /** After the layout changes, before painting: scroll to the bottom if stuck to the bottom, otherwise move the anchor back to where it was */
  const settle = () => {
    const box = messagesScrollRef.current;
    if (!box) return;
    // When the tab is not in the foreground (display:none), everything measures 0: do nothing, and wait for ResizeObserver to call again once it is shown
    if (box.getClientRects().length === 0) {
      lastMetricsRef.current = null;
      return;
    }
    /*
     * Whether it was "at the bottom" is judged by the content height before the change: the user just
     * scrolled to the bottom (or just scrolled up), the scroll event has not been dispatched yet, and
     * the layout changed first (the newly arrived entries measured their real heights); at that moment
     * stickRef is still the old statement. Comparing the previous content height and visible height
     * with the current scroll position tells where the user last stopped. Right after going from
     * hidden to visible the scroll position was reset to zero, which does not count, so keep using stickRef.
     */
    const prev = lastMetricsRef.current;
    if (prev) {
      const atPrevBottom = isAtBottom(prev.scrollHeight, box.scrollTop, prev.clientHeight);
      // The content got shorter and the browser clamped the scroll position back to the bottom: computing with the old height would say "far from the bottom", but it is still at the bottom
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
    // A scroll that settle moved itself also dispatches a scroll event, and by the time it arrives the content may have grown again: that is not the user's statement, so do not re-judge sticking to the bottom
    if (Math.abs(el.scrollTop - settledTopRef.current) >= 1) stickRef.current = isAtBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    viewRef.current = { scrollTop: el.scrollTop, clientHeight: el.clientHeight };
    lastMetricsRef.current = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    captureAnchor();
    const lay = layoutRef.current;
    if (!lay.windowed) return;
    const r = computeRange(lay.off);
    if (r.first !== lay.first || r.last !== lay.last) bump();
  };

  // Measured heights: every rendered entry and the scroll area itself are observed. A hidden tab (display:none) measures all 0, so do not record
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
        // Rows skipped by content-visibility that have not actually been laid out measure the placeholder value of contain-intrinsic-size, not the real height: do not record
        if (!visibleForLayout(e.target)) continue;
        const h = e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height;
        if (bookRef.current!.set(key, kind, h)) changed = true;
      }
      // A size notification means the layout moved (even if the bookkeeping did not change, e.g. a placeholder value replaced by a real height that was already recorded): settle first, then see whether to recompute the window
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
   * New messages fade in and rise a little (enterMotion). Played only for the one or two entries
   * that were "just appended": history already present on the first render, and a whole run swapped
   * in at once when opening a historical session, are not animated, since dozens moving together are
   * hard to see and waste effort.
   * Seen ids are recorded, and later streaming updates and switching back to the tab do not play it
   * again. An entry outside the window that is not rendered naturally does not animate.
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

  /** The latest time point up to the previous entry; a time row is inserted when a new round (user message) is more than TIME_GAP_MS away from it */
  let lastAt: number | null = null;

  // A user message that holds only messages from other Agents is not drawn, and is attached to the reply that follows it (shown in "Agent activity"); the replies of each round each draw their own bubble, with no merging (rowPlan.ts)
  const { inboundOnly, orphanNote } = inboundPlan(messages);

  /*
   * Flatten into individual entries (Entry): each renders as one direct child of the scroll area,
   * with its own independent key ---
   * when the window moves or time rows / arrangement blocks are inserted before or after, MessageRow
   * is never remounted at a different position (memo and expand state are both preserved).
   * This only records how to draw; elements are actually built only for the few entries in the window.
   */
  const entries: Entry[] = [];
  /** Which entry the streaming message is drawn in (for one merged into a preceding bubble, the entry of the group head) */
  const liveKeys = new Set<string>();
  messages.forEach((m) => {
    const hidden = inboundOnly.has(m.id);
    const at = timeOf(m);
    if (!hidden && m.role === "user" && at !== null && lastAt !== null && at - lastAt >= TIME_GAP_MS) {
      const stampAt = at;
      entries.push({ key: `${m.id}:time`, kind: "time", render: () => <div key={`${m.id}:time`} className="ai-time-sep">{formatStamp(stampAt)}</div> });
    }
    // Entries that are not drawn (received Agent messages) still advance the time point, otherwise extra time separator rows appear later
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
              {tr("Received {0} messages from other Agents, waiting for the Agent to start processing", orphan)}
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

  // After every commit, before paint: match the rendered rows to the DOM, attach measurement, then
  // stick to the bottom or move back to the anchor.
  // No dependency array: streaming output is a commit on every chunk, and every commit has to re-stick.
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
      // Rows scrolled out of the viewport and skipped by content-visibility get a placeholder at their measured height; what we measure is the real height, so it never jumps between estimate and real value
      const h = bookRef.current!.measured(key);
      if (h !== undefined && el.classList.contains("ai-row")) el.style.containIntrinsicSize = `auto ${Math.round(h)}px`;
    }
    for (const el of [...observed]) {
      if (alive.has(el)) continue;
      ro?.unobserve(el);
      observed.delete(el);
    }
    keyElRef.current = map;
    // Chat switched or messages rolled back: drop height records that no longer appear
    const bk = bookRef.current!;
    if (bk.size > 2 * kindRef.current.size + 200) bk.prune(new Set(kindRef.current.keys()));
    settle();
  });

  /** Which row an event landed on: walk up from the event target to the direct child of the scroll area */
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
          {/* An empty chat keeps only this one sample sentence, same for local and cloud (user decision, 2026-10-07) */}
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
