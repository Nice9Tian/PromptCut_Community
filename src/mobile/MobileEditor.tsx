/**
 * 手机版编辑界面(语义 `workflow/editing.md`「手机版界面」;交互以 `prototypes/mobile-ui-demo/` 为准)。
 *
 * 底部导航栏三个分页:缩略预览(默认)、时间轴、Agent。返回层级:分页 → 缩略预览 → 项目列表,浏览器后退同一规则
 * (进分页推一层历史记录,分页之间切换只替换当前这层)。
 * 编辑器的基础设施(文档服务同步、舞台与预览、测量遮罩、同步浮层)和桌面 `Editor.tsx` 挂的是同一套,只换了摆法。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "../cards";
import { actions, getState, onLocalCommit, useStore, withMerge } from "../store/project";
import { findClip, type TrackClip } from "../kernel/project";
import { transitionsOf, type Transition } from "../kernel/transitions";
import { getCard } from "../kernel/registry";
import { listCuts } from "../kernel/cuts";
import { Preview } from "../editor/Preview";
import { ProbeGate } from "../editor/ProbeGate";
import { MediaMigrationDialog } from "../editor/MediaMigrationDialog";
import { MissingMaterialsDialog } from "../editor/MissingMaterialsDialog";
import { CloudGoneDialog } from "../editor/sync/CloudGoneDialog";
import { SyncOverlays } from "../editor/sync/SyncOverlays";
import { DependencyPrompt } from "../editor/DependencyPrompt";
import { resumeShared, startSync, useSync } from "../editor/sync/syncManager";
import { unsentAtRisk, UNSENT_LEAVE_BODY } from "../editor/sync/onlineStatus";
import { useCloudRunning } from "../editor/sync/presence";
import { useReadOnly } from "../editor/readOnly";
import { ReadOnlyMarker } from "../editor/ReadOnlyFence";
import { AgentPage } from "./AgentPage";
import { overlayQuoteId } from "../editor/timeline/overlayActions";
import type { OverlayItem } from "../editor/timeline/overlays";
import { clipKind, clipName, mainClipsOf, mainTrackOf, planReorder } from "./mainContent";
import { ThumbStrip } from "./ThumbStrip";
import { FullTimeline, type FullTimelineHandle } from "./FullTimeline";
import { Icon } from "./icons";
import { StageButton, SubNav, fmtTc, useConfirm, useToast, type SubItem } from "./ui";
import {
  AssetsSheet, CardsSheet, ClipsSheet, ConflictSheet, ExportSheet, MembersSheet, ParamsSheet, SpeedSheet,
  conflictBarText, useConflicts, type AssetTab, type CardTab, type ParamsTarget, type TransitionTarget,
} from "./sheets";
import { useMembers } from "./useMembers";
import { useUploadRejectedNotice } from "../editor/left/uploadRejectedNotice";

// 探针与测试读写 store 的口子(桌面的时间轴模块装同一个;手机版不挂时间轴模块,这里自己装)
(window as unknown as { __pcStore?: unknown }).__pcStore = { getState, actions };

type Page = "preview" | "timeline" | "agent";
type SheetState =
  | { kind: "assets"; tab: AssetTab }
  | { kind: "cards"; tab: CardTab; transition: TransitionTarget | null }
  | { kind: "clips" }
  | { kind: "params"; target: ParamsTarget }
  | { kind: "speed"; clipId: string }
  | { kind: "conflict" }
  | { kind: "members" }
  | { kind: "export" }
  | null;

const TRANSITION_NAME: Record<Transition["kind"], string> = { crossfade: "交叉溶解", fadeIn: "淡入", fadeOut: "淡出" };
const cardName = (id: string) => getCard(id)?.name;

/** 历史记录里本界面的那一层:1 缩略预览,2 时间轴 / Agent 分页 */
interface NavState { pcm: 1; lvl: 1 | 2; page?: Page }
const navState = (): NavState | null => {
  const s = history.state as NavState | null;
  return s && s.pcm === 1 ? s : null;
};

export function MobileEditor() {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const selection = useStore((s) => s.selection);
  const toast = useToast();
  // 在线上传被限额拒掉的(游客第 4 条视频之类):弹一句说清楚(`uploadRejectedNotice.ts`)
  useUploadRejectedNotice(toast);
  // 这个项目只给了只读权限(游客):改项目的操作(换顺序、分割、复制、删除、静音、拖动、对齐、撤销重做、加素材 / 卡片、参数)
  // 一律不给,子导航栏整排置灰、悬停是 viewOnlyText();播放、预览、点选看缩略时间轴、读 Agent 对话、导出照常
  const ro = useReadOnly();
  const confirm = useConfirm();
  const [page, setPage] = useState<Page>("preview");
  const [sheet, setSheet] = useState<SheetState>(null);
  const [selTr, setSelTr] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ clipId: string; cardId?: string; label: string; kind?: string } | null>(null);
  const timeline = useRef<FullTimelineHandle>(null);
  const conflicts = useConflicts();
  const offlineOpen = useSync((v) => v.offlineOpen && v.status === "paused");
  /**
   * 离线时攒下的改动只在这个页面里(浏览器存不下,见 `onlineStatus.ts` 的 `unsentAtRisk`):离开编辑界面之前问一句。
   * 判据和顶栏、浏览器原生离开确认是同一个。手机版拦的是**应用内返回**:系统后退、顶栏的主页键都走这里。
   */
  const unsentRisk = useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore));
  const running = useCloudRunning();
  const members = useMembers(sheet?.kind === "members");

  const main = useMemo(() => mainClipsOf(project), [project]);
  const mainTrack = mainTrackOf(project);
  const selClip = selection[0] && findClip(project, selection[0]) ? selection[0] : null;
  const tr = selTr ? transitionsOf(project).find((x) => x.id === selTr) ?? null : null;
  const cutName = useMemo(() => listCuts(project).find((c) => c.active)?.name ?? "剪辑", [project]);

  /* ---------- 编辑器基础设施:同 Editor.tsx(不塞演示卡:手机版不放假数据) ---------- */
  useEffect(() => { void startSync().then(() => resumeShared()); }, []);
  // 重连时发现断网期间项目被改过:打开冲突合并面板(同桌面的离线对话框)
  useEffect(() => { if (offlineOpen) setSheet({ kind: "conflict" }); }, [offlineOpen]);

  /* ---------- 返回层级与浏览器后退 ---------- */
  const pushedBase = useRef(false);
  /** popstate 是在后退**发生之后**才到的,拿不到最新的 props,所以这一刻该不该拦记在 ref 里 */
  const riskRef = useRef(false);
  useEffect(() => { riskRef.current = unsentRisk; }, [unsentRisk]);
  /** 已经问过、用户选了「离开」:接下来那一次 popstate 不再拦 */
  const leaving = useRef(false);
  /** 自己发起的后退(分页 → 缩略预览):页面已经当场切好,对应的 popstate 到了就跳过,免得把这之后刚打开的面板关掉 */
  const ownBack = useRef(0);
  useEffect(() => {
    const s = navState();
    if (!s) { history.pushState({ pcm: 1, lvl: 1 } satisfies NavState, ""); pushedBase.current = true; }
    else if (s.lvl !== 1) history.replaceState({ pcm: 1, lvl: 1 } satisfies NavState, "");
    const onPop = () => {
      if (ownBack.current > 0) { ownBack.current--; return; }
      const st = navState();
      if (!st) {
        // 要离开编辑界面了。离线攒的改动只在这个页面里就先问一句 —— 后退已经发生,拦不住,
        // 所以把刚被弹掉的那一层压回去(人就留在原地),再用手机版自己的确认框问;选「离开」才真走
        if (riskRef.current && !leaving.current) {
          history.pushState({ pcm: 1, lvl: 1 } satisfies NavState, "");
          askLeave.current();
          return;
        }
        leaving.current = false;
        window.dispatchEvent(new Event("pc-go-home"));
        return;
      }
      setSheet(null);
      setPage(st.lvl === 2 && st.page ? st.page : "preview");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const goPage = (next: Page) => {
    setSheet(null);
    if (next === page) return;
    if (next === "preview") {
      if (navState()?.lvl === 2) { ownBack.current++; history.back(); }
      setPage("preview");
      return;
    }
    const st: NavState = { pcm: 1, lvl: 2, page: next };
    if (page === "preview") history.pushState(st, ""); else history.replaceState(st, "");
    setPage(next);
  };
  /** 真的走:从这里之后不再问第二遍(`history.back()` 还会再来一次 popstate) */
  const leaveNow = () => {
    leaving.current = true;
    if (navState()?.lvl === 1 && pushedBase.current) history.back();
    else { leaving.current = false; window.dispatchEvent(new Event("pc-go-home")); }
  };
  /** 问那一句。popstate 里也要用,所以放进 ref:那个处理器只挂一次,捏不到新的闭包 */
  const askLeave = useRef<() => void>(() => {});
  askLeave.current = () => confirm({ text: UNSENT_LEAVE_BODY, ok: "离开", danger: true, run: leaveNow });
  const goHome = () => {
    if (unsentRisk) { askLeave.current(); return; }
    leaveNow();
  };

  /* ---------- 时间轴分页的「✕ 放弃本次编辑」:记下进来之后本页面落地了几次修改 ---------- */
  const editCount = useRef(0);
  useEffect(() => {
    if (page !== "timeline") return;
    editCount.current = 0;
    return onLocalCommit(() => { editCount.current++; });
  }, [page]);
  const discardEdits = () => {
    const n = editCount.current;
    for (let i = 0; i < n && actions.canUndo(); i++) actions.undo();
    editCount.current = 0;
    if (n) toast("已放弃本次编辑");
  };

  /* ---------- 选中 ---------- */
  const selectClip = (id: string | null) => { setSelTr(null); actions.select(id ? [id] : []); };
  const selectTransition = (x: Transition | null) => { actions.select([]); setSelTr(x?.id ?? null); };
  // 缩略预览里点缩略时间轴以外的任何地方:取消选中
  useEffect(() => {
    if (page !== "preview") return;
    const off = (e: PointerEvent) => {
      if (!selClip && !selTr) return;
      if ((e.target as HTMLElement).closest(".mblock, .mark, .subnav, .pager, .topbar, .cfbar, .sheet, .scrim, .confirm, .transport, .stage-btns")) return;
      selectClip(null);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  });

  /* ---------- 引用:切到 Agent,把这一项带进输入框 ---------- */
  const refClip = (c: TrackClip) => {
    setQuote({ clipId: c.id, cardId: c.cardId || undefined, label: clipName(project, c, cardName) });
    goPage("agent");
  };
  /** 单张叠加卡:引用块比整段细一级(`@叠加卡 名字(片段id#种类:定义id)`,见 editor/quoteBus.ts) */
  const refOverlay = (c: TrackClip, item: OverlayItem) => {
    setQuote({ clipId: overlayQuoteId(c, item), label: item.name, kind: "叠加卡" });
    goPage("agent");
  };
  const refTransition = (x: Transition) => {
    setQuote({ clipId: x.id, label: `转场 ${TRANSITION_NAME[x.kind]}` });
    goPage("agent");
  };
  useEffect(() => {
    if (page !== "agent" || !quote) return;
    const q = quote;
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("pc-quote-clip", { detail: q }));
      toast(`已引用：${q.label}`);
      setQuote(null);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [page, quote, toast]);

  /* ---------- 操作 ---------- */
  const seek = (x: number) => { if (getState().playing) actions.pause(); actions.seek(Math.max(0, x)); };
  const reorder = (order: string[]) => {
    if (ro.locked) { toast(ro.why); return; }
    const p = getState().project;
    const plan = planReorder(p, order);
    if ("error" in plan) { toast(plan.error); return; }
    if (!plan.moves.length) return;
    const track = mainTrackOf(p)!;
    const far = Math.max(...track.clips.map((c) => c.end)) + 1000;
    withMerge({ key: `pcm-reorder-${Date.now()}`, windowMs: Infinity }, () => {
      // 先全部挪到远处腾位置,再按新起点从前往后放,中途不会互相顶住
      plan.moves.forEach((m, i) => {
        const c = findClip(getState().project, m.id)!.clip;
        const s = far + i * 1000;
        actions.moveClip(m.id, { start: s, end: s + (c.end - c.start) });
      });
      [...plan.moves].sort((a, b) => a.start - b.start).forEach((m) => {
        const c = findClip(getState().project, m.id)!.clip;
        actions.moveClip(m.id, { start: m.start, end: m.start + (c.end - c.start) });
      });
    });
    const done = plan.moves.every((m) => Math.abs((findClip(getState().project, m.id)?.clip.start ?? -1) - m.start) < 1e-6);
    toast(done ? "已调整顺序" : "换顺序没有完全成功，可以撤销");
  };
  const split = (c: TrackClip) => {
    if (ro.locked) { toast(ro.why); return; }
    if (t <= c.start + 0.05 || t >= c.end - 0.05) { toast("先把播放头移到片段中间"); return; }
    const r = actions.splitClip(c.id, t);
    toast(r ? "已在播放头处切分" : "切不开：这一段挂着转场，或所在序列锁着");
  };
  const dup = (c: TrackClip) => { if (ro.locked) { toast(ro.why); return; } const r = actions.duplicateClip(c.id); if (r) { selectClip(r.id); toast("已复制"); } };
  const del = (c: TrackClip) => ro.locked ? toast(ro.why) : confirm({ text: `删除“${clipName(project, c, cardName)}”？`, ok: "删除", danger: true, run: () => { actions.removeClip(c.id); toast("已删除，可撤销"); } });
  const mute = (c: TrackClip) => { if (ro.locked) { toast(ro.why); return; } actions.setClipMuted(c.id, !c.audioMuted); toast(c.audioMuted ? "已恢复声音" : "已静音"); };
  const align = (which: "start" | "end") => {
    if (ro.locked) { toast(ro.why); return; }
    const c = selClip ? findClip(project, selClip)?.clip : undefined;
    if (!c) { toast("先选中一个片段"); return; }
    if (main.some((m) => m.id === c.id)) { toast("主要内容的位置由顺序决定，在缩略时间轴上长按换顺序"); return; }
    const len = c.end - c.start;
    const start = which === "start" ? t : Math.max(0, t - len);
    const before = getState().project;
    actions.moveClip(c.id, { start, end: start + len });
    if (getState().project === before) toast("放不下：那里已经有别的片段");
  };
  const commitMove = (id: string, patch: { start: number; end: number }) => {
    if (ro.locked) { toast(ro.why); return; }
    const before = getState().project;
    actions.moveClip(id, patch);
    toast(getState().project === before ? "放不下：和别的片段重叠，或这一段挂着转场" : "已调整（一次拖动 = 一步撤销）");
  };
  const delTransition = (x: Transition) => ro.locked ? toast(ro.why) : confirm({ text: `删除转场「${TRANSITION_NAME[x.kind]}」？`, ok: "删除", danger: true, run: () => {
    const r = actions.removeTransition(x.id);
    setSelTr(null);
    toast(r.ok ? (r.note ?? "已删除转场，相关片段解锁了") : r.error);
  } });
  const boundaryOf = (x: Transition): TransitionTarget | null => {
    const i = main.findIndex((c) => c.id === x.aId || c.id === x.bId);
    if (i < 0) return null;
    const a = x.kind === "fadeIn" ? main[i - 1] : main[i];
    const b = x.kind === "fadeIn" ? main[i] : main[i + 1];
    return a && b ? { a, b, replace: x } : null;
  };

  const STD: SubItem[] = [
    { icon: "video", label: "视频", pcm: "sub-video", run: () => setSheet({ kind: "assets", tab: "video" }) },
    { icon: "image", label: "图片", pcm: "sub-image", run: () => setSheet({ kind: "assets", tab: "image" }) },
    { icon: "audio", label: "音频", pcm: "sub-audio", run: () => setSheet({ kind: "assets", tab: "audio" }) },
    { icon: "clip", label: "剪辑", pcm: "sub-cut", run: () => setSheet({ kind: "clips" }) },
    { icon: "card", label: "卡片", pcm: "sub-card", run: () => setSheet({ kind: "cards", tab: "anim", transition: null }) },
    { icon: "text", label: "文字", pcm: "sub-text", run: () => setSheet({ kind: "cards", tab: "text", transition: null }) },
  ];
  const selClipObj = selClip ? findClip(project, selClip)?.clip ?? null : null;
  const refItem = (run: () => void): SubItem => ({ icon: "ref", label: "引用", ref: true, pcm: "sub-ref", run });
  const transitionItems = (x: Transition): SubItem[] => [
    refItem(() => refTransition(x)),
    { icon: "time", label: "时长·强度", pcm: "sub-tr-time", run: () => setSheet({ kind: "params", target: { transitionId: x.id } }) },
    { icon: "swap", label: "换转场", pcm: "sub-tr-swap", run: () => setSheet({ kind: "cards", tab: "transition", transition: boundaryOf(x) }) },
    { icon: "trash", label: "删除", pcm: "sub-tr-del", run: () => delTransition(x) },
  ];
  const clipTools = (c: TrackClip): SubItem[] => {
    const kind = clipKind(project, c);
    const items: SubItem[] = [
      refItem(() => refClip(c)),
      { icon: "split", label: "分割", pcm: "sub-split", run: () => split(c) },
      { icon: "copy", label: "复制", pcm: "sub-dup", run: () => dup(c) },
    ];
    const params = () => setSheet({ kind: "params", target: { clipId: c.id } });
    const muteItem: SubItem = { icon: "mute", label: c.audioMuted ? "恢复声音" : "静音", pcm: "sub-mute", run: () => mute(c) };
    if (kind === "card") items.push({ icon: "style", label: "样式", pcm: "sub-style", run: params }, { icon: "opacity", label: "不透明度", pcm: "sub-opacity", run: params });
    else if (kind === "audio") items.push(muteItem, { icon: "volume", label: "音量", pcm: "sub-volume", run: params });
    // 视频段:静音、速度、调整(演示稿 toolsFor 的顺序);「速度」打开速度面板(store 的 setClipSpeed,〔裁〕变速段不出原声)
    else items.push(...(kind === "video" ? [muteItem, { icon: "speed", label: "速度", pcm: "sub-speed", run: () => setSheet({ kind: "speed", clipId: c.id }) } as SubItem] : []), { icon: "adjust", label: "调整", pcm: "sub-adjust", run: params });
    // 叠加层:最窄的片段上角标不吃点击,这里是唯一的入口(`mobile/overlayBadge.ts`)
    items.push({ icon: "layers", label: "叠加层", pcm: "sub-overlays", run: params });
    items.push({ icon: "trash", label: "删除", pcm: "sub-del", run: () => del(c) });
    return items;
  };
  // 只读时整排子导航栏置灰(都是加素材 / 改片段 / 要给 Agent 发话的入口),悬停写明原因
  const lockItems = (items: SubItem[]): SubItem[] => (ro.locked ? items.map((it) => ({ ...it, disabled: true, title: ro.why })) : items);
  const previewItems: SubItem[] = lockItems(tr ? transitionItems(tr) : selClipObj ? [refItem(() => refClip(selClipObj)), ...STD] : STD);
  const timelineItems: SubItem[] = lockItems(selClipObj ? clipTools(selClipObj) : STD);

  const timelineTitle = selClipObj
    ? `${({ card: "卡片", audio: "音频", image: "图片段", cut: "剪辑段", video: "视频段" } as const)[clipKind(project, selClipObj)]} · ${clipName(project, selClipObj, cardName)}`
    : `时间轴 · ${cutName}`;
  const aspect = `${project.width} / ${project.height}`;
  const memberLabel = members.unavailable ? "成员" : `${members.people} 人 · ${members.agents} Agent`;

  return (
    <div className={`editor${page === "timeline" ? " is-timeline" : ""}`} data-pcm="editor" data-page={page} data-readonly={ro.locked ? "1" : undefined}>
      <ReadOnlyMarker />
      <MediaMigrationDialog />
      <MissingMaterialsDialog />
      <CloudGoneDialog />
      <SyncOverlays offlineDialog={false} />
      <DependencyPrompt />

      {page === "timeline" ? (
        <div className="topbar edit-head" data-pcm="topbar">
          <button type="button" className="icon-btn" data-pcm="tl-discard" title="退出（放弃本次编辑）" aria-label="退出" onClick={() => { discardEdits(); goPage("preview"); }}><Icon name="close" /></button>
          <h1 data-pcm="edit-title">{timelineTitle}</h1>
          <button type="button" className="icon-btn ok" data-pcm="tl-done" title="完成" aria-label="完成" onClick={() => goPage("preview")}><Icon name="ok" /></button>
        </div>
      ) : (
        <div className="topbar" data-pcm="topbar">
          {page === "agent"
            ? <button type="button" className="icon-btn" data-pcm="top-back" title="返回缩略预览" aria-label="返回" onClick={() => goPage("preview")}><Icon name="back" /></button>
            : <button type="button" className="icon-btn" data-pcm="top-home" title="主页" aria-label="主页" onClick={goHome}><Icon name="home" /></button>}
          <h1 data-pcm="project-name">{project.name}</h1>
          <button type="button" className="btn primary" style={{ height: 30, padding: "0 12px" }} data-pcm="top-export" onClick={() => setSheet({ kind: "export" })}>导出</button>
        </div>
      )}

      {/* 只读项目(游客):手机上看不到悬停说明,置灰的按钮得有一句话讲清为什么(播放、预览、导出、读 Agent 对话照常) */}
      {ro.locked && <div className="robar" data-pcm="ro-bar">{ro.why}</div>}

      {conflicts.pending && (
        <div className="cfbar" data-pcm="cfbar">
          <Icon name="warn" />
          <span className="txt" data-pcm="cfbar-text">{conflictBarText(conflicts)}</span>
          <button type="button" data-pcm="cfbar-open" onClick={() => setSheet({ kind: "conflict" })}>处理</button>
        </div>
      )}

      {/*
        Agent 分页时预览只藏不卸:舞台 iframe 不能 display:none(里面的 <video> 与 rAF 会停、布局归零,同 Preview.tsx 后台舞台的注释),
        所以挪出排版、透明、不收指针
      */}
      <div className="preview-area" data-pcm="preview-area" inert={page === "agent"}
        style={page === "agent" ? { position: "absolute", left: 0, right: 0, top: 0, opacity: 0, pointerEvents: "none" } : undefined}>
        <div className="stage-wrap">
          <div className="stage" data-pcm="stage" style={{ aspectRatio: aspect }}>
            <Preview variant="mobile" />
            <ProbeGate />
            <div className="stage-btns">
              {/* 没有账号就没有成员,整个入口不画(`product/platforms.md`「局域网里的第二块屏」:手机上不显示成员) */}
              {!members.unavailable && (
                <StageButton className="sbtn" pcm="members-btn" title="成员" onTap={() => setSheet({ kind: "members" })}>
                  {page === "timeline" ? <><Icon name="members" />{`${members.people}·${members.agents}`}</> : memberLabel}
                  {/* 有新的申请加入时出数字角标(只有创建者看得到申请;2026-10-22 用户定) */}
                  {members.requests.length > 0 && <span className="badge-n" data-pcm="members-request-badge">{members.requests.length}</span>}
                </StageButton>
              )}
            </div>
            {running.size > 0 && <div className="agent-flag" data-pcm="agent-flag">Agent 正在改</div>}
          </div>
        </div>
      </div>

      {page !== "agent" && (
        <div className="transport" data-pcm="transport">
          <button type="button" className="play" data-pcm="play" aria-label={playing ? "暂停" : "播放"} onClick={() => actions.togglePlay()}><Icon name={playing ? "pause" : "play"} /></button>
          <div className="tc"><b data-pcm="tc-now">{fmtTc(t)}</b> / <span data-pcm="tc-total">{fmtTc(project.duration)}</span></div>
          <span className="spacer" />
          <button type="button" className="icon-btn" data-pcm="undo" aria-label="撤销" disabled={!actions.canUndo() || ro.locked} title={ro.title("撤销")} onClick={() => { actions.undo(); if (editCount.current > 0) editCount.current--; }}><Icon name="undo" /></button>
          <button type="button" className="icon-btn" data-pcm="redo" aria-label="重做" disabled={!actions.canRedo() || ro.locked} title={ro.title("重做")} onClick={() => actions.redo()}><Icon name="redo" /></button>
        </div>
      )}

      {page === "preview" && (
        <div className="pane-default" data-pcm="pane-preview">
          <ThumbStrip
            project={project}
            clips={main}
            t={t}
            playing={playing}
            selected={tr?.id ?? selClip}
            onSelect={(s) => {
              if (!s) { selectClip(null); return; }
              if ("clipId" in s) { selectClip(s.clipId); toast(`已选中第 ${main.findIndex((c) => c.id === s.clipId) + 1} 段 · 再长按这张卡拖动可换顺序`); }
              else { selectTransition(s.transition); toast(`已选中转场「${TRANSITION_NAME[s.transition.kind]}」`); }
            }}
            onReorder={reorder}
            onScrub={seek}
            onAddMedia={() => { if (!ro.locked) setSheet({ kind: "assets", tab: "video" }); }}
            onAddTransition={(a, b) => { if (!ro.locked) setSheet({ kind: "cards", tab: "transition", transition: { a, b } }); }}
            locked={ro.locked}
          />
          <SubNav items={previewItems} pcm="subnav-preview" />
        </div>
      )}

      {page === "timeline" && (
        <>
          <FullTimeline
            ref={timeline}
            project={project}
            t={t}
            playing={playing}
            selected={selClip}
            mainTrackId={mainTrack?.id}
            cardName={cardName}
            onSelect={selectClip}
            onScrub={seek}
            onCommitMove={commitMove}
            onAlign={align}
            onOverlays={(id) => { selectClip(id); setSheet({ kind: "params", target: { clipId: id } }); }}
            locked={ro.locked}
            lockedWhy={ro.why}
          />
          <SubNav items={timelineItems} pcm="subnav-timeline" />
        </>
      )}

      <div className="pane-agent" data-pcm="pane-agent" style={page === "agent" ? undefined : { display: "none" }}>
        <AgentPage active={page === "agent"} />
      </div>

      <div className="pager" data-pcm="pager">
        <button type="button" className={page === "preview" ? "on" : undefined} data-pcm="pg-preview" onClick={() => goPage("preview")}><span className="ico"><Icon name="pgPreview" /></span><span className="lbl">缩略预览</span></button>
        <button type="button" className={page === "timeline" ? "on" : undefined} data-pcm="pg-timeline" onClick={() => goPage("timeline")}><span className="ico"><Icon name="pgTimeline" /></span><span className="lbl">时间轴</span></button>
        <button type="button" className={page === "agent" ? "on" : undefined} data-pcm="pg-agent" onClick={() => goPage("agent")}><span className="ico"><span className="disc"><Icon name="sparkle" /></span></span><span className="lbl">Agent</span></button>
      </div>

      {sheet?.kind === "assets" && <AssetsSheet tab={sheet.tab} onTab={(tab) => setSheet({ kind: "assets", tab })} onClose={() => setSheet(null)}
        onSwitchCut={(id) => { actions.switchCut(id); toast("已换成另一条剪辑"); }}
        onPlaced={(clip, m) => { setSheet(null); if (m.kind !== "audio") selectClip(null); toast(m.kind === "audio" ? `已加到 ${fmtTc(clip.start)}` : `已加到主要内容末尾（第 ${mainClipsOf(getState().project).length} 段）`); }} />}
      {sheet?.kind === "cards" && <CardsSheet tab={sheet.tab} transition={sheet.transition} onTab={(tab) => setSheet({ ...sheet, tab })} onClose={() => setSheet(null)}
        onAdded={(clip) => { setSheet(null); selectClip(clip.id); if (page !== "timeline") goPage("timeline"); }} />}
      {sheet?.kind === "clips" && <ClipsSheet onClose={() => setSheet(null)} onSwitched={(name) => { selectClip(null); toast(`缩略时间轴已换成“${name}”`); if (page === "timeline") requestAnimationFrame(() => timeline.current?.fit()); }} />}
      {sheet?.kind === "params" && <ParamsSheet target={sheet.target} onClose={() => setSheet(null)}
        onAskAgent={(id) => { const c = findClip(getState().project, id)?.clip; if (c) refClip(c); }}
        onQuoteOverlay={(c, item) => { setSheet(null); refOverlay(c, item); }} />}
      {sheet?.kind === "speed" && <SpeedSheet clipId={sheet.clipId} onClose={() => setSheet(null)} />}
      {sheet?.kind === "conflict" && <ConflictSheet onClose={() => setSheet(null)} />}
      {sheet?.kind === "members" && !members.unavailable && <MembersSheet info={members} onClose={() => setSheet(null)} />}
      {sheet?.kind === "export" && <ExportSheet onClose={() => setSheet(null)} />}
    </div>
  );
}
