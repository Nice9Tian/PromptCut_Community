import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ToolCallInfo } from "../../../ai/types";
import { reportTitle, type ProgressReport } from "../../../ai/progressReport";
import type { InboundAgentMessage } from "../../../ai/types";
import { findTabByConversation } from "../../../ai/agentTabs";
import { Gif, loadVisualRecord, peekVisualRecord, visualIdOf, type VisualRecord } from "../ToolVisual";
import { usePrerenderBase, withBase } from "../../../render/prerender";
import { KIND_LABEL, bareToolName, toolKind } from "./iconRuns";
import "./agent.css";
import { AgentUndoButton } from "../../sync/AgentUndoButton";

/**
 * 操作详细预览控件:一个 Agent 气泡里**所有**详细内容都在这里展示,一个气泡只放一个。
 *
 * 气泡上面是一排排图标(收到的 Agent 消息、各次操作、阶段 / 本轮小结),图标本身点了不摊开任何清单,
 * 只让这个控件跳到它那一项。控件按先后把每一项排成一页页:
 *   - 收到的 Agent 消息:只给消息内容;
 *   - 有画面的操作:每张看过的图一页、每次有前后动图的修改一页、只有参数差异的一页;
 *     画面上方叠这次操作的头一行(类别、工具名、耗时),下方叠结果里的 note(半透明加深底);
 *   - 没画面的操作(查找 / 读取、界面操作、对话、失败……):一页操作卡 —— 查找给参数和结果内容,对话只给内容,失败只给错误;
 *   - 小结:一页,绿 ✓ / 黄 ! / 红 !,下面是已完成 / 待办 / 问题。
 *
 * 跟踪最新:默认停在最新一项上;还在跑的消息一页页往后翻(下一页渲染好了才翻,两次至少隔 AUTO_STEP_MS),
 * 已经跑完的消息直接停在最后一页。用户点了不是最新的图标、或者往前翻,就不再跟,顶部出「点击跟踪最新」;
 * 点最新的图标、翻回最后一页、点那个按钮,又接着跟。
 *
 * 只能翻到**渲染好的页**:图片加载完(或确定取不回来)、修改页的动图都出来(或确定失败)才算好,文字页天生就好。
 * 往还没好的页翻不会切过去,先让它开始渲染(一次只预先渲染一页),好了再自动切。
 */

/** 拖过这么远就翻页 */
const SWIPE_PX = 40;
/** 甩得够快也翻页(像素 / 毫秒),哪怕没拖满 SWIPE_PX */
const FLING_SPEED = 0.5;
/** 按下之后挪过这么远才算拖动;更短的算点击 */
const DRAG_SLOP = 6;
/** 横向滚轮累计到这么多才翻一页 */
const WHEEL_PX = 60;
/** 翻完一页之后这么久之内的滚轮不算:触控板松手后还有一串惯性事件,不挡的话一甩翻好几页 */
const WHEEL_LOCK_MS = 350;
/** 画框两侧各占这么宽是翻页区 */
const EDGE = 0.22;
/** 还在跑的消息自动往后翻时,两次切换的最短间隔 */
const AUTO_STEP_MS = 1500;
/**
 * 圆点最多显示几个:只显示当前页附近这几个,不把几十页的点全铺出来。
 * 窗口外还有页时,窗口最外侧的点缩小,提示还能往那边翻;其余的页照样缓存着,拖、滚、方向键都翻得到。
 */
const MAX_DOTS = 5;

/** 老消息的工具结果里只有文件路径:认得出的图片才出页(和操作详情里的判断一致) */
const IMG_RE = /\.(png|jpe?g)$/i;

type DiffRow = NonNullable<VisualRecord["diff"]>[number];

/** 小结的颜色:ok = 绿 ✓,warn = 报了问题(黄 !),err = 这一轮出错收尾(红 !) */
export type SummaryTone = "ok" | "warn" | "err";
export const SUMMARY_TONE_TEXT: Record<SummaryTone, string> = { ok: "没有问题", warn: "有问题要看", err: "出错了" };

/** 控件要展示的一项,和气泡上的一个图标一一对应(key 相同) */
export type DetailItem =
  | { type: "inbound"; key: string; messages: InboundAgentMessage[] }
  | { type: "run"; key: string; tools: ToolCallInfo[] }
  | { type: "report"; key: string; report: ProgressReport; tone: SummaryTone };

interface PageBase {
  /** 在这条消息里唯一,当 React key */
  id: string;
  /** 这一页属于哪一项(图标的完整 key) */
  itemKey: string;
  /** 产出这一页的工具名;说明行按它认动作类别 */
  tool: string;
  /** 画面页:产出它的那次操作在所属项里的下标,叠在画面上的头一行和 note 按它取 */
  call?: number;
}

/** 控件的一页 */
export type DetailPage =
  /** 一张看过的图。viaPrerender = 可视化记录里的图,地址挂在预渲染进程上,要拼上它的源 */
  | (PageBase & { kind: "image"; src: string; viaPrerender: boolean; label?: string })
  /** 前后两段动图(加卡只有「后」、删卡只有「前」)+ 参数差异 */
  | (PageBase & { kind: "change"; before?: string; after?: string; beforeLabel: string; afterLabel: string; diff: DiffRow[] })
  /** 只有参数差异,没有动图 */
  | (PageBase & { kind: "diff"; diff: DiffRow[] })
  /** 没有画面的一项操作:操作卡(内容按渲染时的 items 现取) */
  | (PageBase & { kind: "ops" })
  /** 小结 */
  | (PageBase & { kind: "summary" })
  /** 收到的 Agent 消息 */
  | (PageBase & { kind: "inbound" });

const isVisualPage = (p: DetailPage) => p.kind === "image" || p.kind === "change" || p.kind === "diff";

/** 老消息里的文件路径换成页面能打开的地址(和 ToolDetail 里的拼法一致) */
function legacyUrl(f: string): string {
  return f.startsWith("http") || f.startsWith("data:") ? f : `/@fs/${f.replace(/\\/g, "/").replace(/^\/?/, "")}`;
}

/** 一份可视化记录拆成页:每张图一页;有前后动图的一页「修改」;只有参数差异的一页「差异」 */
function recordPages(out: DetailPage[], rec: VisualRecord, idBase: string, itemKey: string, tool: string, call: number) {
  rec.images?.forEach((im, i) => {
    out.push({ kind: "image", id: `${idBase}:i${i}`, itemKey, tool, call, src: im.url, viaPrerender: true, label: im.label });
  });
  if (rec.before || rec.after) {
    out.push({
      kind: "change",
      id: `${idBase}:c`,
      itemKey,
      tool,
      call,
      before: rec.before?.gif,
      after: rec.after?.gif,
      // 标签和 ToolVisual 里一致:只有「后」是新加的卡(或 get_gif 的整段动效),只有「前」是删掉的卡
      beforeLabel: rec.after ? "修改前" : "删掉的卡片",
      afterLabel: rec.before ? "修改后" : rec.tool === "get_gif" ? "整段动效" : "新加的卡片",
      diff: rec.diff ?? [],
    });
  } else if (rec.diff?.length) {
    out.push({ kind: "diff", id: `${idBase}:d`, itemKey, tool, call, diff: rec.diff });
  }
}

/**
 * 按项的先后收集页面。操作项里有出画面的(带可视化记录,或老消息里的图片文件)就出画面页,
 * 记录还没取回来的先跳过,取回来之后下一次渲染就出现;记录取失败的不算有画面。
 * 一个画面都没有的操作项出一页操作卡(至少有一次操作出了结果才出)。
 */
function pagesOf(items: DetailItem[], failed: ReadonlySet<string>): DetailPage[] {
  const out: DetailPage[] = [];
  for (const item of items) {
    if (item.type === "inbound") {
      out.push({ kind: "inbound", id: `${item.key}:inbound`, itemKey: item.key, tool: "" });
      continue;
    }
    if (item.type === "report") {
      out.push({ kind: "summary", id: `${item.key}:summary`, itemKey: item.key, tool: "" });
      continue;
    }
    const done = item.tools.filter((t) => t.ok !== undefined);
    if (!done.length) continue;
    const hasVisual = done.some((t) => {
      const vid = visualIdOf(t.summary);
      return (vid && !failed.has(vid)) || (t.files || []).some((f) => IMG_RE.test(f));
    });
    if (!hasVisual) {
      out.push({ kind: "ops", id: `${item.key}:ops`, itemKey: item.key, tool: item.tools[0].name });
      continue;
    }
    item.tools.forEach((tool, ti) => {
      if (tool.ok === undefined) return;
      const idBase = `${item.key}:${ti}`;
      const vid = visualIdOf(tool.summary);
      if (vid) {
        const rec = peekVisualRecord(vid);
        if (rec) recordPages(out, rec, `${idBase}:${vid}`, item.key, tool.name, ti);
        return;
      }
      (tool.files || []).forEach((f, fi) => {
        if (!IMG_RE.test(f)) return;
        const label = f.split(/[\\/]/).pop();
        out.push({ kind: "image", id: `${idBase}:f${fi}`, itemKey: item.key, tool: tool.name, call: ti, src: legacyUrl(f), viaPrerender: false, label });
      });
    });
  }
  return out;
}

/**
 * 从一串项收集页面。可视化记录走 ToolVisual 的模块级缓存,同一个 id 只取一次;
 * 每取回(或取失败)一份就重算一次,页面随记录陆续出现。
 */
export function useDetailPages(items: DetailItem[]): DetailPage[] {
  const [loadedCount, bump] = useReducer((n: number) => n + 1, 0);
  const mounted = useRef(false);
  /** 这个组件已经发起过的 id:取失败的不在这里反复重试 */
  const tried = useRef(new Set<string>());
  /** 取失败的 id:这些操作按「没画面」出操作卡 */
  const failed = useRef(new Set<string>());

  const idSet = new Set<string>();
  const keyBits: string[] = [];
  for (const item of items) {
    if (item.type !== "run") {
      keyBits.push(`${item.key}|${item.type}`);
      continue;
    }
    for (const t of item.tools) {
      const done = t.ok !== undefined;
      const id = done ? visualIdOf(t.summary) : null;
      if (id) idSet.add(id);
      keyBits.push(`${item.key}|${done ? 1 : 0}|${id ?? ""}|${done ? (t.files || []).join(",") : ""}`);
    }
  }
  const ids = [...idSet];
  const idsKey = ids.join(",");
  const itemsKey = keyBits.join(";");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    for (const id of ids) {
      if (peekVisualRecord(id) || tried.current.has(id)) continue;
      tried.current.add(id);
      loadVisualRecord(id).then(
        () => { if (mounted.current) bump(); },
        () => {
          failed.current.add(id);
          if (mounted.current) bump();
        },
      );
    }
    // ids 由 idsKey 完整决定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // items 每次渲染都是新数组,按内容算的 key 记忆,控件拿到的 pages 引用才稳定
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => pagesOf(items, failed.current), [itemsKey, loadedCount]);
}

/** 耗时:一秒以内给毫秒,十秒以内一位小数,再长取整秒 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

// 标题只写一份,在 src/ai/progressReport.ts

/** 说明行左边那句 */
function pageCaption(p: DetailPage, item: DetailItem | undefined): string {
  if (p.kind === "inbound") return `对话 · 收到 ${item?.type === "inbound" ? item.messages.length : 0} 条消息`;
  // 小结的好坏只靠绿 ✓ / 黄 ! / 红 ! 的颜色和字形表达,不再写「有问题要看」这类字
  if (p.kind === "summary") return item?.type === "report" ? reportTitle(item.report) : "小结";
  if (p.kind === "ops") {
    const tools = item?.type === "run" ? item.tools : [];
    const names = [...new Set(tools.map((t) => bareToolName(t.name)))].join("、") || bareToolName(p.tool);
    const label = tools.some((t) => t.ok === false) ? "失败" : KIND_LABEL[toolKind(p.tool)];
    return `${label} · ${names}${tools.length > 1 ? ` ×${tools.length}` : ""}`;
  }
  const kind = KIND_LABEL[toolKind(p.tool)];
  const what =
    p.kind === "image"
      ? p.label || p.tool
      : p.kind === "change"
        ? p.before && p.after
          ? `${p.beforeLabel} → ${p.afterLabel}`
          : p.after
            ? p.afterLabel
            : p.beforeLabel
        : `参数变化 ${p.diff.length} 项`;
  return `${kind} · ${what}`;
}

/** 「点击跟踪最新」上的图标:双箭头指向最后 */
function IconFollowLatest(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4l4 4-4 4M8.5 4l4 4-4 4" />
    </svg>
  );
}

export function OpDetailPreview(props: {
  pages: DetailPage[];
  /** 页面所属的项:操作卡、小结、收到的消息按它现取内容 */
  items: DetailItem[];
  /** 点图标跳页:seq 每点一次加一,跳到 key 所属的第一页;点的是最新那一项就跟踪最新 */
  jump?: { key: string; seq: number } | null;
  /** 当前页换了(自动跟踪或用户翻的):报上这一页所属项的 key,byUser = 用户翻的 / 点的 */
  onPage?: (itemKey: string, byUser: boolean) => void;
  /** 消息还在跑:跟踪最新时一页页往后翻 */
  live?: boolean;
}): JSX.Element | null {
  const { pages, items, jump, onPage, live } = props;
  const n = pages.length;
  // 当前页和「要去的页」都按页 id 记:可视化记录是异步取回的,新页可能插到当前页前面,按下标记会把正在看的页悄悄换掉。
  // 默认停在最新一项:还在跑的从头一页页翻过来,已经跑完的直接停在最后一页(还没有页时等页出来再按这条定)
  const [curId, setCurId] = useState<string | null>(() => (pages.length ? (live ? pages[0].id : pages[pages.length - 1].id) : null));
  /** 拖动中跟手的偏移(px) */
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** 鼠标停在哪一侧的翻页区,那一侧的箭头才露出来 */
  const [hover, setHover] = useState<"prev" | "next" | null>(null);
  /** 渲染好的页(图片 / 动图加载完,或确定失败) */
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  /** 用户要去、但还没渲染好的页(按页 id):渲染好就切过去 */
  const [wantedId, setWantedId] = useState<string | null>(null);
  /** 跟踪最新 */
  const [follow, setFollow] = useState(true);
  const frameRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; t: number; moved: boolean } | null>(null);
  /**
   * 翻到过的页。「修改」页里的动图只在这些页(和正在预先渲染的那一页)里挂载:服务端现渲一段动图要几秒到几十秒,
   * 一打开消息就把所有动图全触发,预渲染进程会被压垮。
   */
  const seen = useRef(new Set<string>());
  /** 上一次切页的时刻:自动翻页按它卡最短间隔 */
  const lastSwitchAt = useRef(0);
  /** 下一次换页是不是用户弄的(报给 onPage) */
  const byUserRef = useRef(false);
  const base = usePrerenderBase();
  /** 上一次渲染时当前页的下标:当前页那一页没了(比如可视化记录取失败换成了操作卡)时,留在原来的位置附近 */
  const lastIndex = useRef(0);
  const found = curId ? pages.findIndex((p) => p.id === curId) : -1;
  const cur = found >= 0 ? found : n === 0 ? 0 : curId === null ? (live ? 0 : n - 1) : Math.min(lastIndex.current, n - 1);
  lastIndex.current = cur;
  const itemByKey = useMemo(() => new Map(items.map((it) => [it.key, it])), [items]);

  const isReady = (i: number): boolean => {
    const p = pages[i];
    return !!p && (!isVisualPage(p) || p.kind === "diff" || ready.has(p.id));
  };
  const markReady = useCallback((id: string) => {
    setReady((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const show = (i: number) => {
    lastSwitchAt.current = performance.now();
    setCurId(pages[i].id);
  };

  const go = (i: number, byUser: boolean) => {
    if (!n) return;
    const next = Math.max(0, Math.min(n - 1, i));
    if (byUser) {
      setFollow(next >= n - 1);
      byUserRef.current = true;
    }
    if (next === cur) {
      setWantedId(null);
      return;
    }
    if (isReady(next)) {
      setWantedId(null);
      show(next);
    } else {
      // 还没渲染好:不切,先让它开始渲染,好了由下面的 effect 切过去
      setWantedId(pages[next].id);
    }
  };
  // 原生滚轮监听只挂一次,通过 ref 拿到最新的页码和翻页函数
  const goRef = useRef(go);
  goRef.current = go;
  const curRef = useRef(cur);
  curRef.current = cur;

  const followLatest = () => {
    byUserRef.current = true;
    setFollow(true);
    go(n - 1, false);
  };

  const wantedIdx = wantedId ? pages.findIndex((p) => p.id === wantedId) : -1;
  const wantedPage = wantedIdx >= 0 ? wantedIdx : null;
  // 下一步要切到哪一页:用户点过的优先;跟踪最新时,还在跑的往后翻一页,跑完的直接去最后一页
  const target = wantedPage ?? (follow && cur < n - 1 ? (live ? cur + 1 : n - 1) : null);
  // 要去的页还没好,就先把它挂上开始渲染(一次只预先渲染这一页)
  const preloadId = target !== null && target !== cur && !isReady(target) ? pages[target].id : null;

  // 第一页第一次显示出来也算一次切换:第二页不会紧跟着第一页闪过去
  const curReady = n > 0 && isReady(cur);
  const shownOnce = useRef(false);
  useEffect(() => {
    if (curReady && !shownOnce.current) {
      shownOnce.current = true;
      lastSwitchAt.current = performance.now();
    }
  }, [curReady]);

  // 要去的页渲染好了才切:用户点的、跑完的消息立刻切;还在跑的自动翻页离上次切换不足 AUTO_STEP_MS 就等到够了再切。
  // 拖动中不自动翻
  useEffect(() => {
    if (target === null || target === cur || dragging || !isReady(target)) return;
    const auto = wantedPage === null;
    const wait = auto && live ? Math.max(0, lastSwitchAt.current + AUTO_STEP_MS - performance.now()) : 0;
    const timer = window.setTimeout(() => {
      show(target);
      if (!auto) setWantedId(null);
    }, wait);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, cur, dragging, ready, wantedPage, live]);

  // 当前页换了就报给气泡:它据此给对应的图标上描边 / 发光
  const pageId = n > 0 ? pages[cur].id : null;
  useEffect(() => {
    if (!pageId) return;
    onPage?.(pages[cur].itemKey, byUserRef.current);
    byUserRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // 图标那边点过来:点的是最新那一项就跟踪最新,否则跳到它的第一页(没渲染好就等它好了再跳)
  useEffect(() => {
    if (!jump || !n) return;
    byUserRef.current = true;
    if (jump.key === pages[n - 1].itemKey) {
      setFollow(true);
      go(n - 1, false);
      return;
    }
    const i = pages.findIndex((p) => p.itemKey === jump.key);
    if (i >= 0) go(i, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq]);

  // 触控板 / 鼠标的横向滚动(或 Shift + 滚轮)翻页。
  // React 的 onWheel 是被动监听,拦不住浏览器自己的横向手势(前进后退),所以挂原生的非被动监听
  const hasPages = n > 0;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    let acc = 0;
    let lockUntil = 0;
    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!dx) return; // 竖着滚的归消息列表(或操作卡自己的滚动)
      e.preventDefault();
      const now = performance.now();
      if (now < lockUntil) {
        // 惯性还在滚:把锁往后顺延一点,等这串事件停了再接受下一次
        lockUntil = Math.max(lockUntil, now + 120);
        acc = 0;
        return;
      }
      acc += dx * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
      if (Math.abs(acc) >= WHEEL_PX) {
        goRef.current(curRef.current + (acc > 0 ? 1 : -1), true);
        acc = 0;
        lockUntil = now + WHEEL_LOCK_MS;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasPages]);

  /** 指针落在左右哪一侧的翻页区;到头了那一侧不算 */
  const sideOf = (clientX: number): "prev" | "next" | null => {
    const el = frameRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = (clientX - r.left) / Math.max(1, r.width);
    if (f < EDGE && cur > 0) return "prev";
    if (f > 1 - EDGE && cur < n - 1) return "next";
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !n) return;
    // 动图的「重试」、操作卡里的文字这类自己处理点击 / 选字的,不当成拖动或翻页
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, summary, pre, .ai-odp-text")) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) {
      if (e.pointerType === "mouse" && !e.buttons) setHover(sideOf(e.clientX));
      return;
    }
    const dx = e.clientX - g.x;
    if (!g.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      // 竖着拖多半是想滚消息列表(触屏),让给浏览器
      if (Math.abs(e.clientY - g.y) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      g.moved = true;
      setDragging(true);
      setHover(null);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 指针已经抬起,捕获不了也无妨 */
      }
    }
    // 两头拖不动、邻页还没渲染好也拖不过去:只给三分之一的位移,手感上是「到头了」
    const blocked = dx > 0 ? cur === 0 || !isReady(cur - 1) : cur === n - 1 || !isReady(cur + 1);
    setDrag(blocked ? dx / 3 : dx);
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    const dx = e.clientX - g.x;
    if (g.moved) {
      const speed = Math.abs(dx) / Math.max(1, performance.now() - g.t);
      setDragging(false);
      setDrag(0);
      if (!cancelled && (Math.abs(dx) > SWIPE_PX || (Math.abs(dx) > DRAG_SLOP * 2 && speed > FLING_SPEED))) {
        go(cur + (dx < 0 ? 1 : -1), true);
      }
      return;
    }
    if (cancelled) return;
    // 没拖动 = 点了一下:左右两侧是翻页区,中间不做事
    const side = sideOf(e.clientX);
    if (side === "prev") go(cur - 1, true);
    else if (side === "next") go(cur + 1, true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // 编辑台全局也认方向键(挪播放头),画框有焦点时归控件
    e.preventDefault();
    e.stopPropagation();
    go(cur + (e.key === "ArrowRight" ? 1 : -1), true);
  };

  if (!n) return null;
  const page = pages[cur];
  seen.current.add(page.id);
  const loading = (id: string) => seen.current.has(id) || id === preloadId;
  const toolsOf = (key: string) => {
    const it = itemByKey.get(key);
    return it?.type === "run" ? it.tools : [];
  };
  const caption = pageCaption(page, itemByKey.get(page.itemKey));
  // 圆点窗口:当前页尽量居中,两头贴边时整体往里收
  const dotStart = Math.max(0, Math.min(cur - Math.floor(MAX_DOTS / 2), n - MAX_DOTS));
  const dotEnd = Math.min(n, dotStart + MAX_DOTS);

  const body = (p: DetailPage): ReactNode => {
    const it = itemByKey.get(p.itemKey);
    if (p.kind === "ops") return <OpCards tools={toolsOf(p.itemKey)} />;
    if (p.kind === "summary") return it?.type === "report" ? <SummaryCard report={it.report} tone={it.tone} /> : null;
    if (p.kind === "inbound") return it?.type === "inbound" ? <InboundCards messages={it.messages} /> : null;
    // 画面页:画面上方叠这次操作的头一行,下方叠结果里的 note(有才叠);两层都不吃鼠标,拖动翻页照旧
    const call = it?.type === "run" && p.call !== undefined ? it.tools[p.call] : undefined;
    const note = call ? noteOf(call) : "";
    return (
      <>
        {/* D5:同源退回已经删掉,拿不到预渲染的源就没有地址可拼 */}
        {base === null ? <div className="ai-visual-note">预渲染进程还没就绪,画面取不回来</div> : <PageBody p={p} base={base} loadGif={loading(p.id)} onReady={markReady} />}
        {call ? (
          <div className="ai-odp-over-head" data-pc="odp-over-head">
            <OpHead t={call} />
          </div>
        ) : null}
        {/* 改了项目的那一步在画面页上也能「撤销这步」:原来 AI 栏底部的「Agent 操作记录」每行都有,那块换成「Agent 操作」之后撤销只在这个控件里(2026-10-20) */}
        {call && call.ok === true && (p.kind === "change" || p.kind === "diff") ? (
          <div className="ai-odp-over-undo" data-pc="odp-over-undo">
            <AgentUndoButton callId={call.callId} />
          </div>
        ) : null}
        {note ? (
          <div className="ai-odp-over-note" data-pc="odp-over-note">
            {note}
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div className="ai-carousel ai-odp" data-pc="op-detail-preview">
      <div className="ai-odp-head">
        <span className="ai-carousel-label" title={caption}>{caption}</span>
        {!follow ? (
          <button type="button" className="ai-odp-follow" data-pc="odp-follow" onClick={followLatest}>
            <IconFollowLatest />
            点击跟踪最新
          </button>
        ) : null}
      </div>
      <div
        ref={frameRef}
        className={`ai-carousel-frame${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        role="group"
        aria-roledescription="操作详细预览"
        aria-label={`操作详细预览,第 ${cur + 1} 页,共 ${n} 页`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <div className="ai-carousel-track" style={{ transform: `translateX(calc(${-cur * 100}% + ${drag}px))` }}>
          {pages.map((p, i) => (
            <div key={p.id} className={`ai-carousel-page is-${p.kind}`} aria-hidden={i !== cur} data-ready={isReady(i) ? "" : undefined}>
              {/* 只挂当前页、左右邻居(拖动时看得见邻居,图片顺便先加载)和正在预先渲染的那一页;翻远了就卸掉,
                  不让整条消息里的图和动图一直挂着。翻到过的页记在 seen 里,回来时动图可以直接加载(浏览器有缓存) */}
              {Math.abs(i - cur) <= 1 || p.id === preloadId ? body(p) : null}
            </div>
          ))}
        </div>
        {/* 当前页还没渲染好:盖一层提示,不露出半截图 */}
        {!curReady ? <div className="ai-carousel-wait" role="status">画面渲染中…</div> : null}
        {cur > 0 ? <span className={`ai-carousel-arrow is-prev${hover === "prev" ? " is-on" : ""}`} aria-hidden>‹</span> : null}
        {cur < n - 1 ? <span className={`ai-carousel-arrow is-next${hover === "next" ? " is-on" : ""}`} aria-hidden>›</span> : null}
      </div>
      {n > 1 ? (
        <div className="ai-odp-foot">
          <div className="ai-carousel-dots" data-pc="ai-carousel-dots">
            {pages.slice(dotStart, dotEnd).map((p, k) => {
              const i = dotStart + k;
              const pending = i !== cur && !isReady(i);
              // 窗口外还有页:最外侧的点缩小
              const edge = (k === 0 && dotStart > 0) || (i === dotEnd - 1 && dotEnd < n);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`ai-carousel-dot${i === cur ? " is-on" : ""}${pending ? " is-pending" : ""}${wantedPage === i ? " is-wanted" : ""}${edge ? " is-edge" : ""}`}
                  aria-label={pending ? `第 ${i + 1} 页(还在渲染,好了自动切过去)` : `第 ${i + 1} 页`}
                  aria-current={i === cur ? "true" : undefined}
                  title={pending ? "还在渲染,好了自动切过去" : undefined}
                  onClick={() => go(i, true)}
                />
              );
            })}
          </div>
          <span className="ai-carousel-count">
            {wantedPage !== null ? "渲染中… " : ""}
            {cur + 1} / {n}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ── 文字页:操作卡、小结、收到的消息 ─────────────────────────────── */

/** 结果摘要是 JSON 就解析成对象,不是就原样当文字 */
function parseResult(summary?: string): unknown {
  if (!summary) return null;
  try {
    return JSON.parse(summary);
  } catch {
    return summary;
  }
}

/** 这些字段是给界面 / 模型认的,不是给人读的内容 */
const HIDDEN_KEYS = new Set(["ok", "visualId"]);

/** 一个值压成一行字 */
function short(v: unknown, max = 80): string {
  let s: string;
  if (v === null || v === undefined) s = "—";
  else if (typeof v === "string") s = v;
  else if (typeof v === "number" || typeof v === "boolean") s = String(v);
  else if (Array.isArray(v)) s = `${v.length} 项`;
  else {
    s = Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !HIDDEN_KEYS.has(k))
      .map(([k, x]) => `${k}: ${x !== null && typeof x === "object" ? (Array.isArray(x) ? `${x.length} 项` : "{…}") : String(x)}`)
      .join(",");
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function ShortList({ list, max }: { list: unknown[]; max: number }): JSX.Element {
  return (
    <ul className="ai-opcard-list">
      {list.slice(0, max).map((x, i) => (
        <li key={i}>{short(x)}</li>
      ))}
      {list.length > max ? <li className="more">还有 {list.length - max} 项</li> : null}
    </ul>
  );
}

/** 结果内容:对象按字段一行一个,数组给条数和前几条,文字原样 */
function ResultFields({ value }: { value: unknown }): JSX.Element | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "object") return <div className="ai-opcard-text">{short(value, 600)}</div>;
  if (Array.isArray(value)) return value.length ? <ShortList list={value} max={8} /> : <div className="ai-opcard-text is-faint">没有结果</div>;
  const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => !HIDDEN_KEYS.has(k));
  if (!entries.length) return <div className="ai-opcard-text is-faint">完成</div>;
  return (
    <dl className="ai-opcard-fields">
      {entries.slice(0, 12).map(([k, v]) => (
        <div key={k} className="row">
          <dt>{k}</dt>
          <dd>
            {Array.isArray(v) ? (
              <>
                {v.length} 项
                {v.length ? <ShortList list={v} max={5} /> : null}
              </>
            ) : (
              short(v, 160)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 参数压成一行:参数 · a: 1 · b: x */
function paramsLine(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return "参数 · " + entries.map(([k, v]) => `${k}: ${short(v, 40)}`).join(" · ");
}

/** 对话 ID 换成页签名;找不到就给个短 ID */
function agentName(conversationId: unknown): string {
  const id = String(conversationId ?? "");
  if (!id || id === "未知") return "未知 Agent";
  return findTabByConversation(id)?.title ?? `Agent ${id.slice(0, 8)}`;
}

function errorText(t: ToolCallInfo, res: unknown): string {
  if (res && typeof res === "object" && typeof (res as { error?: unknown }).error === "string") return (res as { error: string }).error;
  return typeof res === "string" && res ? res : t.summary || "失败了,没有返回原因";
}

/** 对话类操作(多 Agent 之间):只给内容 */
function agentContent(t: ToolCallInfo, res: unknown): ReactNode {
  const name = bareToolName(t.name);
  const input = (t.input && typeof t.input === "object" ? t.input : {}) as Record<string, unknown>;
  if (name === "send_message") {
    const to = String(input.to ?? "");
    return (
      <>
        <div className="ai-opcard-to">发给 {to === "all" ? "所有 Agent" : agentName(to)}</div>
        <div className="ai-opcard-text">{String(input.text ?? "")}</div>
      </>
    );
  }
  if (name === "declare_scope") {
    return (
      <div className="ai-opcard-text">
        声明范围:{String(input.scope ?? "")}
        {input.note ? `\n${String(input.note)}` : ""}
      </div>
    );
  }
  const r = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
  if (name === "check_messages") {
    const msgs = Array.isArray(r.messages) ? (r.messages as { from?: unknown; text?: unknown }[]) : [];
    return msgs.length ? (
      msgs.map((m, i) => (
        <div key={i} className="ai-opcard-msg">
          <div className="ai-opcard-to">来自 {agentName(m.from)}</div>
          <div className="ai-opcard-text">{String(m.text ?? "")}</div>
        </div>
      ))
    ) : (
      <div className="ai-opcard-text is-faint">没有新消息</div>
    );
  }
  if (name === "list_agents") {
    const agents = Array.isArray(r.agents) ? (r.agents as { title?: unknown; scope?: unknown; you?: unknown; busy?: unknown }[]) : [];
    return agents.length ? (
      <ul className="ai-opcard-list">
        {agents.map((a, i) => (
          <li key={i}>
            {String(a.title ?? "")}
            {a.scope ? ` · ${String(a.scope)}` : ""}
            {a.you ? "(自己)" : ""}
            {a.busy ? " · 正在跑" : ""}
          </li>
        ))}
      </ul>
    ) : (
      <div className="ai-opcard-text is-faint">没有别的 Agent</div>
    );
  }
  return <ResultFields value={res} />;
}

/** 操作的头一行:类别小方块 + 类别(失败时写「失败」)+ 工具名 + 耗时。操作卡用,画面页也叠在画面上方 */
function OpHead({ t }: { t: ToolCallInfo }): JSX.Element {
  const kind = toolKind(t.name);
  return (
    <div className="ai-opcard-head">
      <span className={`ai-op ai-op--${kind}${t.ok === false ? " is-err" : ""} ai-opcard-chip`} aria-hidden />
      <span className="ai-opcard-kind">{t.ok === false ? "失败" : KIND_LABEL[kind]}</span>
      <span className="ai-opcard-name">{bareToolName(t.name)}</span>
      {typeof t.durationMs === "number" ? <span className="ai-opcard-dur">{fmtDuration(t.durationMs)}</span> : null}
    </div>
  );
}

/** 结果里给人看的那句说明(note 字段);没有就不叠 */
function noteOf(t: ToolCallInfo): string {
  if (t.ok !== true) return "";
  const res = parseResult(t.summary);
  const note = res && typeof res === "object" ? (res as { note?: unknown }).note : undefined;
  return typeof note === "string" ? note.trim() : "";
}

/** 一次操作的卡片:头一行(OpHead),下面是内容 */
function OpCard({ t }: { t: ToolCallInfo }): JSX.Element {
  const kind = toolKind(t.name);
  const res = t.ok === undefined ? null : parseResult(t.summary);
  let content: ReactNode;
  if (t.ok === undefined) content = <div className="ai-opcard-text is-faint">进行中…</div>;
  else if (t.ok === false) content = <div className="ai-opcard-error">{errorText(t, res)}</div>;
  else if (kind === "agent") content = agentContent(t, res);
  else {
    const params = paramsLine(t.input);
    content = (
      <>
        {params ? <div className="ai-opcard-params">{params}</div> : null}
        <ResultFields value={res} />
      </>
    );
  }
  return (
    <div className={`ai-opcard${t.ok === false ? " is-err" : ""}`} data-pc="op-card">
      <OpHead t={t} />
      {content}
      {t.ok === true ? <AgentUndoButton callId={t.callId} /> : null}
    </div>
  );
}

function OpCards({ tools }: { tools: ToolCallInfo[] }): JSX.Element {
  if (!tools.length) return <div className="ai-carousel-note">没有操作记录</div>;
  return (
    <div className="ai-odp-text">
      {tools.map((t, i) => (
        <OpCard key={i} t={t} />
      ))}
    </div>
  );
}

const REPORT_GROUPS = [
  { field: "done", label: "已完成", mark: "✓", cls: "is-done" },
  { field: "todo", label: "待办", mark: "○", cls: "is-todo" },
  { field: "problems", label: "问题", mark: "!", cls: "is-problem" },
] as const;

/** 小结页:头一行是绿 ✓ / 黄 ! / 红 ! 的小方块 + 标题(好坏只看颜色和字形,不写字),下面三组条目(空组不显示) */
function SummaryCard({ report, tone }: { report: ProgressReport; tone: SummaryTone }): JSX.Element {
  const groups = REPORT_GROUPS.filter((g) => report[g.field].length > 0);
  return (
    <div className={`ai-odp-text ai-odp-summary tone-${tone}`} data-pc="op-summary">
      <div className="ai-opcard-head">
        <span className={`ai-op ai-op--summary tone-${tone} ai-opcard-chip`} role="img" aria-label={SUMMARY_TONE_TEXT[tone]} />
        <span className="ai-opcard-kind">{reportTitle(report)}</span>
      </div>
      {groups.length ? (
        groups.map((g) => (
          <div key={g.field} className={`ai-report-group ${g.cls}`}>
            <div className="ai-report-label">
              <span className="ai-report-mark" aria-hidden>{g.mark}</span>
              {g.label}
            </div>
            <ul className="ai-report-list">
              {report[g.field].map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div className="ai-report-empty">(没有可汇报的内容)</div>
      )}
    </div>
  );
}

/** 收到的 Agent 消息:只给内容 */
function InboundCards({ messages }: { messages: InboundAgentMessage[] }): JSX.Element {
  return (
    <div className="ai-odp-text">
      {messages.map((m, i) => (
        <div key={i} className="ai-opcard" data-pc="op-inbound">
          <div className="ai-opcard-head">
            <span className="ai-op ai-op--agent ai-opcard-chip" aria-hidden />
            <span className="ai-opcard-kind">收到消息</span>
            <span className="ai-opcard-name is-plain">来自 {agentName(m.from)}</span>
          </div>
          <div className="ai-opcard-text">{m.text}</div>
        </div>
      ))}
    </div>
  );
}

/* ── 画面页 ─────────────────────────────────────────────────────── */

function PageBody({ p, base, loadGif, onReady }: { p: DetailPage; base: string; loadGif: boolean; onReady: (id: string) => void }): JSX.Element | null {
  if (p.kind === "image") {
    return <PageImage key={p.src} src={p.viaPrerender ? withBase(base, p.src) : p.src} label={p.label} onSettled={() => onReady(p.id)} />;
  }
  if (p.kind === "diff") {
    return (
      <div className="ai-carousel-diff">
        <DiffList diff={p.diff} />
      </div>
    );
  }
  if (p.kind === "change") return <ChangeBody p={p} base={base} loadGif={loadGif} onReady={onReady} />;
  return null;
}

/** 修改页:前后动图都出来(或确定失败)才算渲染好 */
function ChangeBody({ p, base, loadGif, onReady }: { p: Extract<DetailPage, { kind: "change" }>; base: string; loadGif: boolean; onReady: (id: string) => void }): JSX.Element {
  const settled = useRef(new Set<"before" | "after">());
  const need = (p.before ? 1 : 0) + (p.after ? 1 : 0);
  const settle = (which: "before" | "after") => {
    settled.current.add(which);
    if (settled.current.size >= need) onReady(p.id);
  };
  return (
    <div className="ai-carousel-change">
      <div className="ai-visual-gifs">
        {p.before ? (loadGif ? <Gif src={withBase(base, p.before)} label={p.beforeLabel} onSettled={() => settle("before")} /> : <GifSlot label={p.beforeLabel} />) : null}
        {p.before && p.after ? <div className="ai-visual-arrow" aria-hidden>→</div> : null}
        {p.after ? (loadGif ? <Gif src={withBase(base, p.after)} label={p.afterLabel} onSettled={() => settle("after")} /> : <GifSlot label={p.afterLabel} />) : null}
      </div>
      {p.diff.length ? <DiffList diff={p.diff} /> : null}
    </div>
  );
}

/** 看过的一张图;取不回来就写一句,不留一块空白。按原尺寸显示(只缩不放),在画框里居中 */
function PageImage({ src, label, onSettled }: { src: string; label?: string; onSettled: () => void }): JSX.Element {
  const [bad, setBad] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // 缓存里的图可能在挂上 onLoad 之前就已经解码好了,补报一次
  useEffect(() => {
    const el = ref.current;
    if (el?.complete && el.naturalWidth > 0) onSettled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (bad) return <div className="ai-carousel-note">这张图取不回来了</div>;
  return (
    <img
      ref={ref}
      className="ai-carousel-img"
      src={src}
      alt={label || "画面"}
      draggable={false}
      onLoad={onSettled}
      onError={() => {
        setBad(true);
        onSettled();
      }}
    />
  );
}

/** 还没翻到的「修改」页:先占好动图的位置,翻到了再换成真的动图 */
function GifSlot({ label }: { label: string }): JSX.Element {
  return (
    <figure className="ai-visual-gif">
      <div className="box" />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function DiffList({ diff }: { diff: DiffRow[] }): JSX.Element {
  return (
    <ul className="ai-visual-diff">
      {diff.map((d) => (
        <li key={d.key}>
          <span className="k">{d.key}</span>
          <span className="from">{d.from}</span>
          <span className="arrow" aria-hidden>→</span>
          <span className="to">{d.to}</span>
        </li>
      ))}
    </ul>
  );
}
