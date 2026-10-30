import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getActiveCollectDelegationUrl, subscribeActiveCollectDelegation } from "../ai/collectDelegationStore";
import { actions, getState, useStore } from "../store/project";
import { cancelExport, exportVideo, streamExportFile, revealExport, importProjectFile, getMediaFile } from "./io";
import { newProject, pickSaveTarget, serializeProc, writeProcToDisk, loadProc, forgetSaveTarget, PROC_EXT, PROC_FORMAT } from "./io/proc";
import { PROCP_EXT, isProcpFile, loadProcpFile, packMissingMessage, packProcp } from "./io/procp";
import { exportSkippedMessage } from "./io/exportSkipped";
import { ExportDialog, type ExportState } from "./ExportDialog";
import type { ExportMode } from "../export/cardLayers";
import { exportGateNow } from "./media/assetTiers";
import { awaitingUploaderMessage } from "../render/mediaTier";
import { ensureActiveDraftId, saveDraft, setActiveDraftId } from "./io/drafts";
import { saveProcFile, savePackedFile } from "./io/saveFlow";
import { agentToolProbe, mediaImportProbe } from "./io/localWrites";
import { showSaveNotice } from "./saveLock";
import { SaveStatusLayer } from "./SaveStatusLayer";
import { Logo } from "../ui/Logo";
import {
  IconExport,
  IconHome,
  IconNew,
  IconMore,
  IconPalette,
  IconOpen,
  IconRedo,
  IconSave,
  IconSettings,
  IconUndo,
  IconVoice,
} from "../ui/icons";
import { openVoiceSettings } from "../ai/voiceSettingsStore";
import { ModeSwitch } from "./ModeSwitch";
import { LanOpenDialog } from "./LanOpenDialog";
import { AgentBrowserTab } from "./AgentBrowserTab";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { SkinDialog } from "./SkinDialog";
import { SkillDialog } from "./SkillDialog";
import { isViewOnly, viewOnlyReason, viewOnlyText } from "./io/viewOnly";
import { useReadOnly } from "./readOnly";
import { ReadOnlyMarker } from "./ReadOnlyFence";
import { SyncChips } from "./sync/SyncChips";
import { BackupsDialog } from "./sync/BackupsDialog";
import { useSync, whenSaved } from "./sync/syncManager";
import { unsentAtRisk, UNSENT_LEAVE_TEXT } from "./sync/onlineStatus";
import { onlineUnsupported } from "../online/pageFlag";
import "../ui/toolbar.css";

/** 在线浏览器模式里置灰的项目菜单项:都要编辑器进程(草稿、另存、本地备份),C10a 不提供(契约第 2 节) */
const ONLINE_OFF = (entry: string): string => onlineUnsupported(entry);

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」),值同 `mode.ts` 的 `ONLINE`。
 * 在线页面上置灰的项(新建、打开、保存、打包保存、SKILL)背后的函数在在线构建里换成空函数,
 * 连同草稿、打包、Skill 对话框背后的 /api 调用一起剪掉(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * 「快捷键」「关于 PromptCut」的说明文字。桌面版在标题栏菜单「帮助」里点开(`WindowTitleBar.tsx`,经 `pc-titlebar-command` 交到下面的 `onCommand`);
 * 在线构建不画标题栏(2026-10-22 用户定),这两项改住在「⋯」菜单里,点了弹同一段说明。
 */
const SHORTCUTS_TEXT = "空格 播放/暂停\nCtrl/Cmd + Z 撤销\nCtrl/Cmd + Shift + Z 重做\nCtrl/Cmd + Y 重做\nDelete 删除选中片段";
const ABOUT_TEXT = "PromptCut\nAI 视频编辑器";

/** 「⋯」菜单里没有图标的那几项占位:图标默认 18px,占住同样宽度,文字才和「皮肤…」那一行对齐 */
const MoreMenuNoIcon = () => <span aria-hidden="true" style={{ flex: "0 0 18px", width: 18 }} />;

/** 顶栏宽度档位:宽档(全部展开)、中档(图标收缩)、窄档(折叠更多菜单) */
type BarTier = "wide" | "icon" | "narrow";

const THRESHOLD_ICON = 880;
const THRESHOLD_WIDE = 1180;
const HYSTERESIS = 40;

/** 带滞回的档位换算,避免在临界宽度时来回抖动 */
function computeNextTier(current: BarTier, width: number): BarTier {
  if (current === "wide") {
    if (width < THRESHOLD_ICON) return "narrow";
    if (width < THRESHOLD_WIDE) return "icon";
    return "wide";
  }
  if (current === "icon") {
    if (width >= THRESHOLD_WIDE + HYSTERESIS) return "wide";
    if (width < THRESHOLD_ICON) return "narrow";
    return "icon";
  }
  // current === "narrow"
  if (width >= THRESHOLD_WIDE + HYSTERESIS) return "wide";
  if (width >= THRESHOLD_ICON + HYSTERESIS) return "icon";
  return "narrow";
}

/**
 * 顶栏按钮:label 永远渲染为 span.pc-btn-label,通过 CSS 平滑收缩展开。
 * title 恒等于 label,收起为方形图标态后鼠标悬停仍能看到提示。
 */
function Btn({
  onClick,
  label,
  icon,
  primary,
  collapsed,
  disabled,
  title,
}: {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  primary?: boolean;
  collapsed?: boolean;
  disabled?: boolean;
  /** 覆盖悬停提示。禁用时用它说清为什么点不了 */
  title?: string;
}) {
  return (
    <button
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      className={`pc-btn${primary ? " pc-btn--primary" : ""}${collapsed ? " pc-btn--collapsed" : ""}`}
    >
      {icon}
      <span className="pc-btn-label">{label}</span>
    </button>
  );
}

/**
 * 顶栏:按条宽动态三档降级,包含编辑操作、外观与布局、文件导出。
 */
/**
 * 保存前要等的本机写入(`io/localWrites.ts`):这台设备正在导入的素材、Agent 正在跑的工具。
 * 待提交操作(文档服务确认)和后台写入在 `waitForLocalWrites` 里另外等。
 */
const LOCAL_WRITE_PROBES = [
  mediaImportProbe(() => getState().project.media, (id) => !!getMediaFile(id)),
  agentToolProbe,
];

export function TopBar() {
  const barRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const collectUrl = useSyncExternalStore(subscribeActiveCollectDelegation, getActiveCollectDelegationUrl, () => null);

  const [tier, setTier] = useState<BarTier>("wide");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skinOpen, setSkinOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  // 「在手机上打开」(`workflow/editing.md`「局域网里的第二块屏」):只有桌面那一侧给这个入口
  const [lanOpen, setLanOpen] = useState(false);
  /**
   * 「本地备份…」。C6.5 的「新建共享项目」「打开共享项目」两项已删(C10a 契约第 6 节「旧入口」):
   * 要和别人一起做,在项目设置里勾「多用户协作」;加入别人的项目在开始页。
   */
  const [backupsOpen, setBackupsOpen] = useState(false);
  // 撤销提示条里点「项目设置」那一类实体会派发这个事件:打开项目设置对话框
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener("pc-open-project-settings", open);
    return () => window.removeEventListener("pc-open-project-settings", open);
  }, []);
  /**
   * 撤销 / 重做按钮的禁用态:栈空时置灰。撤销栈的变化大多伴随项目变化(store 会通知);
   * 一处都没撤成时项目不变、只出提示条,所以顺带订阅同步状态里的提示条。
   */
  const canUndo = useStore(() => actions.canUndo());
  const canRedo = useStore(() => actions.canRedo());
  useSync((v) => v.notice);
  const [moreBtnRect, setMoreBtnRect] = useState<DOMRect | null>(null);

  /**
   * 「项目」下拉:新建 / 打开 / 保存 / 项目设置收在一个按钮里,点开才出子菜单。
   * 四个动作都是"偶尔点一次"的,平铺在条上占四个位置,还挤得导出这种常点的没地方。
   * 菜单挂在 body 上(portal),和「⋯」一样点外面 / 按 Esc 收起。
   */
  const [projOpen, setProjOpen] = useState(false);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  const projMenuRef = useRef<HTMLDivElement>(null);
  const [projRect, setProjRect] = useState<DOMRect | null>(null);
  const toggleProjMenu = () => {
    if (!projOpen && projBtnRef.current) setProjRect(projBtnRef.current.getBoundingClientRect());
    setProjOpen((v) => !v);
  };
  useEffect(() => {
    if (!projOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (projMenuRef.current?.contains(t) || projBtnRef.current?.contains(t)) return;
      setProjOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setProjOpen(false); } };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [projOpen]);
  // 只读有两个来源:地址里的 ?observe(页面一开就定了)、这个项目只给了只读权限(进 / 退项目时变,要重渲),都订阅同步状态
  const viewOnly = useSync(() => isViewOnly());
  const reason = useSync(() => viewOnlyReason());
  // 只读权限(游客进别人的项目):改项目的控件置灰,悬停说明用 viewOnlyText()。?observe 那条路不在这里,它照旧
  const ro = useReadOnly();

  const name = useStore((s) => s.project.name);
  // 不订阅整份项目:顶栏只在导出那一下要项目,当场 getState() 取;订阅了的话每挪一次片段顶栏整条重渲(tiers-probe T4)
  // 在线页面都是云端项目(改动实时同步上云端,「保存项目」置灰),只读模式也不能保存:都不标未保存的「*」与蓝点,回首页 / 切氛围式也不弹未保存确认
  const dirty = useStore((s) => !ONLINE_BUILD && s.dirty) && !viewOnly;
  /**
   * 在线页面离开编辑界面之前要问一句的那一种:离线(或离线批次等用户决定)、手里有还没提交上去的改动,
   * 而且改动只在这个页面里 —— 游客的项目不落盘(`syncManager.ts` 里浏览器本地缓存只给账号项目写),
   * 或者浏览器本地缓存这次写不成(配额、隐私模式)。和 `SyncOverlays.tsx` 挂浏览器离开确认用的是同一个判断。
   */
  const unsentRisk = useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore));
  const projectInput = useRef<HTMLInputElement>(null);

  /** 顶栏项目名就地改名:点一下标签变输入框 */
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  /**
   * 用 ref 而不是 renaming 这个 state 当闸门:按 Esc 关掉编辑态时,正在卸载的
   * input 还会再冒一次 blur,而那个 blur 处理函数捕获的是上一次渲染的
   * renaming(仍然是 true)——只看 state 的话,取消会被 blur 又提交回来。
   */
  const renamingRef = useRef(false);

  const startRename = () => {
    if (ro.locked) return;
    setDraftName(name);
    renamingRef.current = true;
    setRenaming(true);
  };

  const cancelRename = () => {
    renamingRef.current = false;
    setRenaming(false);
  };

  /**
   * 收尾改名。Enter 和失焦都走这里,闸门保证只生效一次。
   * 名字留空退回「未命名」,和项目设置对话框里那条规则保持一致。
   */
  const commitRename = () => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    setRenaming(false);
    const next = draftName.trim() || "未命名";
    if (next !== name) actions.setProjectMeta({ name: next });
  };

  // 进入编辑态就把光标放进去并全选,省得用户自己再点一次、删一遍
  useEffect(() => {
    if (!renaming) return;
    const el = renameInputRef.current;
    el?.focus();
    el?.select();
  }, [renaming]);

  /**
   * 点到别处就收尾。
   *
   * 光靠 onBlur 不够:预览和时间线在 mousedown 里 preventDefault(挡文字选中),
   * 那会连焦点转移一起挡掉,输入框就一直开着。所以照「⋯」菜单那套,额外在
   * window 上听 mousedown,点在输入框外面就提交。两条路都进 commitRename,
   * 由 renamingRef 保证只生效一次。
   */
  useEffect(() => {
    if (!renaming) return;
    const onDown = (e: MouseEvent) => {
      if (!renameInputRef.current?.contains(e.target as Node)) commitRename();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  });

  /**
   * 桌面版原生菜单栏的「外观 → 皮肤…」点了会派发 pc-open-skin,这里接住它打开
   * 同一个对话框 —— 两个入口共用一份界面,不做第二套。
   *
   * 走 window.__TAURI__(tauri.conf.json 里开了 withGlobalTauri),省得前端为这
   * 一个监听多装 @tauri-apps/api;浏览器里没有这个全局,整段自然跳过。
   */
  useEffect(() => {
    const api = (window as unknown as {
      __TAURI__?: { event?: { listen?: (e: string, cb: () => void) => Promise<() => void> } };
    }).__TAURI__;
    if (!api?.event?.listen) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    api.event
      .listen("pc-open-skin", () => setSkinOpen(true))
      .then((off) => {
        // 组件可能在 listen 落地之前就卸载了,那就立刻退订
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ResizeObserver 监听顶栏根元素自身 clientWidth 并带滞回换算档位
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const update = () => {
      setTier((curr) => computeNextTier(curr, el.clientWidth));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 更多菜单点击外部或按 Escape 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !moreBtnRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  // 菜单打开期间监听窗口 resize 和 scroll(捕获阶段),一触发就关掉菜单防漂移
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuOpen]);

  // 原来这里有条「档位切回 wide/icon 就收起菜单」——那是因为当时「⋯」只在窄档存在,
  // 变宽后按钮没了、菜单会孤零零留在屏幕上。现在「⋯」任何宽度都在,这条规则会
  // 在宽档一打开就立刻把菜单关掉,所以去掉了。菜单漂移由下面的 resize 监听负责。

  const run = (fn: () => Promise<unknown>) => () => fn().catch((e) => alert(String(e?.message ?? e)));

  const [exportState, setExportState] = useState<ExportState | null>(null);
  /** 正在跑的导出任务 id,取消要用 */
  const exportIdRef = useRef<string | null>(null);

  /**
   * 保存:弹「另存为」让用户选位置,同时把本地草稿更新掉。流程在 `io/saveFlow.ts`。
   *
   * 顺序有讲究 —— showSaveFilePicker 要用户手势,所以它必须是这里的第一个
   * await;先去存草稿再弹窗,手势就过期了,浏览器会直接抛 SecurityError。
   * 用户点取消就整个不算保存:草稿不写、脏标记不清,和「我没保存」一致。
   */
  /** 保存的结果说给用户(顶部那张卡片,`SaveStatusLayer`):没保存成的是 error,保存成了但有话要说的是 info */
  const notifySave = (message: string, tone: "error" | "info" = "error") => {
    showSaveNotice({ tone, title: tone === "error" ? "这次没有保存" : "已保存", message });
  };

  const saveProject = ONLINE_BUILD ? async () => {} : async () => {
    await saveProcFile(`${name}${PROC_EXT}`, {
      writeProc: (produce, fileName) => writeProcToDisk(produce, fileName),
      settle: (ms) => whenSaved(ms),
      probes: LOCAL_WRITE_PROBES,
      currentProject: () => getState().project,
      serialize: () => serializeProc(),
      saveDraft: async () => { await saveDraft(ensureActiveDraftId()); },
      markSaved: (fileName) => actions.markSaved(fileName),
      notify: notifySave,
    });
  };

  /**
   * 打包保存:.procp = 编排 + 项目用到的素材(A1)。流程在 `io/saveFlow.ts`。
   *
   * 和保存项目同一条规矩 —— pickSaveTarget 要用户手势,所以它必须是第一个 await,
   * 装包(从本地内容库按哈希取素材)只能排在挑好落点之后。包里素材按内容哈希去重,
   * 同一份素材被几条片段引用也只有一份字节。
   */
  const savePackedProject = ONLINE_BUILD ? async () => {} : async () => {
    await savePackedFile(`${name}${PROCP_EXT}`, {
      pick: (fileName) => pickSaveTarget(fileName, "PromptCut 打包项目", { "application/zip": [PROCP_EXT] }),
      settle: (ms) => whenSaved(ms),
      probes: LOCAL_WRITE_PROBES,
      pack: () => packProcp(),
      download: (blob, fileName) => {
        // 这个 WebView 没有文件系统访问 API,退回浏览器下载
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      missingMessage: (missing) => packMissingMessage(missing as Parameters<typeof packMissingMessage>[0]),
      notify: notifySave,
    });
  };

  /**
   * 导出视频。
   *
   * 和保存项目同一套路子:showSaveFilePicker 要用户手势,所以先弹「另存为」拿到
   * 落点,再开始渲染——渲染要几十秒,那之后手势早过期了。用户取消选位置就整个不导出。
   *
   * 挑不出位置(WebView 没这个 API)也照样能导:文件留在服务端的产物目录,
   * 结束时给一个「打开产物目录」。
   *
   * 在线浏览器先选导出方式(`docs/semantics/workflow/project.md`「导出视频」:「快速导出」或「完整导出」):不带 `mode` 进来时只把
   * 对话框切到选择那一步,选了以后带着 `mode` 再进来 —— 那一次点击就是「另存为」要的用户手势。桌面版没有这一步。
   */
  const exportProject = async (mode?: ExportMode) => {
    const project = getState().project;
    // C6.6:按轮询到的集合先判一次(不发请求,不耽误下面「另存为」要的用户手势);
    // 素材原尺寸还没传完就不弹另存为,直接提示等待上传方。exportVideo 里还会再问一遍素材服务
    const pending = exportGateNow(project);
    if (pending && pending.length) {
      setExportState({ phase: "error", done: 0, total: 1, target: "", message: awaitingUploaderMessage(pending) });
      return;
    }
    if (ONLINE_BUILD && !mode) {
      setExportState({ phase: "asking", done: 0, total: 1, target: "" });
      return;
    }
    // 选保存位置期间选择的对话框先收起来(用户取消选位置就整个不导出)
    if (ONLINE_BUILD) setExportState(null);
    const suggested = `${name}.mp4`;
    let target: FileSystemFileHandle | null = null;
    try {
      target = await pickSaveTarget(suggested, "MP4 视频", { "video/mp4": [".mp4"] });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // 用户取消,不是错误
      throw e;
    }

    setExportState({
      phase: "running",
      done: 0,
      // Seed a visible total immediately; the server also seeds this before
      // spawning Chrome, so the dialog never presents a misleading 0/0.
      total: Math.max(1, Math.floor(project.duration * (project.fps || 30))),
      target: target ? target.name : "产物目录（本机不支持选择位置）",
      startedAt: Date.now(),
      ...(mode ? { mode } : {}),
    });

    try {
      const { outDir, id, written, skippedMedia } = await exportVideo({
        // 在线浏览器模式(c10a 第 11.1 节)边编边写进这个落点,回 written: true;桌面那一路不看它
        target,
        // 在线浏览器:选的导出方式;导出前还在等什么(素材原尺寸、渲染节点)显示在进度窗口里。桌面那一路不看这两项
        ...(mode ? { mode, onWaiting: (message: string | null) => setExportState((st) => (st ? { ...st, waiting: message ?? undefined } : st)) } : {}),
        onStart: (jobId) => {
          exportIdRef.current = jobId;
          setExportState((st) => (st ? { ...st, id: jobId } : st));
        },
        onProgress: (done, total, stage) =>
          setExportState((s) => (s && s.phase === "running" ? { ...s, done, total, stage } : s)),
      });

      // 渲染完了才把成品搬到用户选的位置;没选就留在产物目录里。
      // 已经边编边写进落点的(在线导出,written)不再搬:再 createWritable 会把写好的文件换成空的
      if (target && !written) {
        const w = await target.createWritable();
        try {
          await streamExportFile(id, "preview.mp4", w);
          await w.close();
        } catch (error) {
          await w.abort?.();
          throw error;
        }
      }
      // 因素材缺失跳过的片段:完成的对话框里列出来(不静默)
      const skippedNote = skippedMedia?.length ? exportSkippedMessage(skippedMedia) : "";
      setExportState((s) => (s ? { ...s, phase: "done", outDir, done: s.total || 1, total: s.total || 1, ...(skippedNote ? { message: skippedNote } : {}) } : s));
    } catch (e) {
      const err = e as Error & { cancelled?: boolean };
      setExportState((s) =>
        s ? { ...s, phase: err.cancelled ? "cancelled" : "error", message: err.message } : s,
      );
    } finally {
      exportIdRef.current = null;
    }
  };

  /** 新建项目:清空当前编排,并断开草稿绑定(保存时会新开一份) */
  const createProject = ONLINE_BUILD ? () => {} : () => {
    if (dirty && !confirm("当前项目还有未保存的改动，新建会丢掉它们。继续？")) return;
    newProject();
    setActiveDraftId(null);
  };

  /**
   * 顶栏「打开项目…」。.proc 外面有一层 {format, project, ai} 的壳,importProjectFile
   * 只认裸 Project 和 {cards} 编排,拿它开 .proc 会直接报「无法识别」—— 所以 .proc 走
   * loadProc(连剧本和对话一起灌回去),其余的旧 JSON 才交给 importProjectFile。
   */
  const openProjectFile = ONLINE_BUILD ? async (_file: File) => {} : async (file: File) => {
    if (dirty && !confirm("当前项目还有未保存的改动，打开别的项目会丢掉它们。继续？")) return;
    // .procp 是「编排 + 素材」的 zip 包(A1):先把素材按哈希拆进本地内容库,
    // 再拿里面那条 project.proc 走和 .proc 完全一样的路。不能先 file.text() ——
    // 那会把一个可能几 GB 的 zip 整份读进页面。
    if (await isProcpFile(file)) {
      actions.loadProject(await loadProcpFile(file), file.name.replace(/\.procp$/i, PROC_EXT));
      setActiveDraftId(null);
      forgetSaveTarget();
      return;
    }
    const text = await file.text();
    let isProc = false;
    try { isProc = JSON.parse(text)?.format === PROC_FORMAT; } catch { /* 交给下面报错 */ }
    if (isProc) actions.loadProject(loadProc(text), file.name);
    else await importProjectFile(file);
    // 从文件打开的不属于任何草稿;保存时重新问落点,别覆盖上一个项目的文件
    setActiveDraftId(null);
    forgetSaveTarget();
  };

  /**
   * 在线页面离开编辑界面之前的那一句：问的不是「项目没保存」（云端项目没有这回事，issue #16），
   * 是「离线时攒的改动只在这个页面里，离开就没了」。放行就走。
   */
  const okToLeaveOnline = () => !ONLINE_BUILD || !unsentRisk || confirm(UNSENT_LEAVE_TEXT);

  /** 回到开始页。Shell 在监听这个事件 */
  const goHome = () => {
    if (!okToLeaveOnline()) return;
    if (dirty && !confirm("当前项目还有未保存的改动，回首页会丢掉它们。继续？")) return;
    window.dispatchEvent(new Event("pc-go-home"));
  };

  /**
   * 去氛围式那一屏（顶栏工作方式开关的第一格）。
   *
   * 走的就是「回开始页」那条路：离开编辑界面，落到开始页，开始页按地址上的 `?ui=` 决定显示哪一屏
   * （`StartPage.tsx` 的 `wantsVibe` / `wantsClassic`）。所以这里先把 `?ui=vibe` 写进地址再派事件：
   *   - 在线浏览器：缺省本来就是氛围式，这一步顺带把 `?ui=classic` 这个排障后门盖掉，
   *     否则带着它回去会落到老的账号表单那一页；
   *   - 桌面版：缺省是传统开始页，不写这个参数回去就落在那一页，到不了氛围式。
   *
   * 有未保存的改动时，这一颗和「回首页」处理得不一样：桌面版**先把本机草稿存了再走**，不只是警告一句。
   * 氛围式那一屏里动手的是 Agent，用户手边没有「保存项目」这颗键（那一屏自己定时存，
   * 见 `src/start/DesktopStart.tsx` 的 `AUTOSAVE_MS`），所以切过去之前不能把刚做的东西留在内存里。
   * 存的只是本机草稿，不是用户另存过的那个 `.proc`，所以**不清脏标记**——顶栏那颗「*」照旧提醒文件还没写。
   * 在线页面都是云端项目，改动直接同步上云端，没有「保存项目」和本机草稿，不弹未保存确认；
   * 只有离线时攒的改动只在这个页面里（游客项目、本地缓存写不成）才问一句，判据见 `okToLeaveOnline`。
   */
  const goVibe = () => {
    const go = () => {
      try {
        const url = new URL(location.href);
        url.searchParams.set("ui", "vibe");
        history.replaceState(history.state, "", url);
      } catch {
        // 地址改不了(少见)也不拦着走,顶多是落到缺省那一屏
      }
      window.dispatchEvent(new Event("pc-go-home"));
    };
    if (ONLINE_BUILD) { if (okToLeaveOnline()) go(); return; }
    if (!dirty) { go(); return; }
    void saveDraft(ensureActiveDraftId()).then(go, (e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      if (confirm(`这次没能把改动存进本机项目（${why}）。切到氛围式会丢掉它们，继续？`)) go();
    });
  };

  // 标题栏菜单和顶栏里的按钮共用同一套动作，避免维护两份文件/导出逻辑。
  // WindowTitleBar 只负责呈现菜单，通过这个事件把选择交回编辑器。
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      switch (command) {
        // 在线页面:这几项在菜单里都置灰(C10 契约第 10 节),标题栏菜单发来的同名命令同样不做
        case "new-project": if (!ONLINE_BUILD) createProject(); break;
        case "open-project": if (!ONLINE_BUILD) projectInput.current?.click(); break;
        case "save-project": if (!viewOnly && !ONLINE_BUILD) void saveProject(); break;
        case "export-video": void run(() => exportProject())(); break;
        case "go-home": goHome(); break;
        case "undo": if (!ro.locked) actions.undo(); break;
        case "redo": if (!ro.locked) actions.redo(); break;
        case "open-skin": setSkinOpen(true); break;
        case "open-voice": if (!ONLINE_BUILD) openVoiceSettings(); break;
        case "shortcuts": alert(SHORTCUTS_TEXT); break;
        case "about": alert(ABOUT_TEXT); break;
      }
    };
    window.addEventListener("pc-titlebar-command", onCommand);
    return () => window.removeEventListener("pc-titlebar-command", onCommand);
    // unsentRisk 也在里头(「回首页」要照它问一句):不列进来的话这个处理器会捏着旧的那一份
  }, [viewOnly, ro.locked, dirty, name, unsentRisk]);

  const toggleMoreMenu = () => {
    if (!menuOpen && moreBtnRef.current) {
      setMoreBtnRect(moreBtnRef.current.getBoundingClientRect());
    }
    setMenuOpen((prev) => !prev);
  };

  return (
    <div ref={barRef} className="pc-bar pc-bar--main">
      <ReadOnlyMarker />
      <Logo size={22} />
      {renaming ? (
        <input
          ref={renameInputRef}
          className="pc-projname pc-projname--editing"
          value={draftName}
          maxLength={80}
          placeholder="未命名"
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") cancelRename();
          }}
        />
      ) : (
        <button
          type="button"
          className="pc-projname pc-projname--btn"
          title={ro.title("点击重命名项目")}
          aria-disabled={ro.locked || undefined}
          onClick={startRename}
        >
          {name}
          {dirty && <span className="pc-dirty"> *</span>}
        </button>
      )}
      <span className="pc-bar-sep" />

      {/* A · 编辑控制:撤销与重做恒为纯图标态 */}
      <div className="pc-bar-group">
        {/* 禁用的按钮收不到悬停,提示挂在外面那层上(稿件:悬停提示含不可点时) */}
        <span title={ro.title("撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的")} data-pc="undo-btn">
          <Btn onClick={() => actions.undo()} label="撤销" title={ro.title("撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的")} icon={<IconUndo />} collapsed disabled={!canUndo || ro.locked} />
        </span>
        <span title={ro.title("重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）")} data-pc="redo-btn">
          <Btn onClick={() => actions.redo()} label="重做" title={ro.title("重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）")} icon={<IconRedo />} collapsed disabled={!canRedo || ro.locked} />
        </span>
      </div>
      <span className="pc-bar-sep" />

      {/*
        A' · AI 的浏览器页签(只在桌面壳里出现)。agent 撞上登录 / 验证码时不弹窗,
        这个页签闪并冒气泡,用户点过去才切到浏览器面板。任何宽度都在:它是 agent 和人之间的
        交接口,收进「⋯」里就没人看见闪了。
      */}
      <AgentBrowserTab />

      {/*
        B · 模式与项目设置。
        「传统式 / SKILL」是一个整体的二选一控件(ModeSwitch),不是下拉框 ——
        两种工作方式互斥,滑块在哪一格就是哪一格;下拉框收起来只看得见当前值。
        皮肤仍然只住在「⋯」里。
      */}
      {tier !== "narrow" && (
        <div className="pc-bar-group">
          <ModeSwitch onOpenSkill={() => setSkillOpen(true)} onEnterVibe={goVibe} />
        </div>
      )}
      {/* 「⋯」任何宽度都在:皮肤只住在这里面,收起来就没入口了 */}
      <div className="pc-bar-group">
        <button
          ref={moreBtnRef}
          type="button"
          className="pc-btn pc-btn--icon"
          title="更多设置"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={toggleMoreMenu}
        >
          <IconMore />
        </button>
      </div>

      {/* ⋯ 弹出浮层菜单 */}
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="pc-more-menu"
          style={{
            top: (moreBtnRect?.bottom ?? 36) + 4,
            // 菜单挂在按钮右端往左展开,窄窗口下不会顶出屏幕
            left: Math.max(8, Math.min((moreBtnRect?.right ?? 0) - 200, window.innerWidth - 208)),
          }}
        >
          <button
            type="button"
            className="pc-btn"
            style={{ width: "100%", justifyContent: "flex-start" }}
            title="皮肤"
            onClick={() => {
              setMenuOpen(false);
              setSkinOpen(true);
            }}
          >
            <IconPalette />
            <span className="pc-btn-label">皮肤…</span>
          </button>
          {/* 在线构建没有标题栏菜单(2026-10-22 用户定),它「帮助」里的这两项挪到这里;桌面版仍在标题栏菜单里,这里不重复 */}
          {ONLINE_BUILD && (
            <>
              <button
                type="button"
                className="pc-btn"
                style={{ width: "100%", justifyContent: "flex-start" }}
                data-pc="more-shortcuts"
                onClick={() => {
                  setMenuOpen(false);
                  alert(SHORTCUTS_TEXT);
                }}
              >
                <MoreMenuNoIcon />
                <span className="pc-btn-label">快捷键</span>
              </button>
              <button
                type="button"
                className="pc-btn"
                style={{ width: "100%", justifyContent: "flex-start" }}
                data-pc="more-about"
                onClick={() => {
                  setMenuOpen(false);
                  alert(ABOUT_TEXT);
                }}
              >
                <MoreMenuNoIcon />
                <span className="pc-btn-label">关于 PromptCut</span>
              </button>
            </>
          )}
          {/* 在手机上打开(`workflow/editing.md`「局域网里的第二块屏」):同一局域网里的手机扫码进同一个本机项目。
              在线页面没有这一项 —— 那边的项目在云端,手机直接开项目直达地址就行 */}
          {!ONLINE_BUILD && (
            <button
              type="button"
              className="pc-btn"
              style={{ width: "100%", justifyContent: "flex-start" }}
              data-pc="more-lan-open"
              onClick={() => {
                setMenuOpen(false);
                setLanOpen(true);
              }}
            >
              <MoreMenuNoIcon />
              <span className="pc-btn-label">在手机上打开</span>
            </button>
          )}
          {/* 模式开关只在窄档收进来,宽档它还在条上;项目设置已经住进「项目」菜单 */}
          {tier === "narrow" && (
            <div className="pc-more-menu-row">
              <ModeSwitch onOpenSkill={() => { setMenuOpen(false); setSkillOpen(true); }} onEnterVibe={() => { setMenuOpen(false); goVibe(); }} />
            </div>
          )}
        </div>,
        document.body,
      )}

      {/* 「项目」下拉菜单:挂在按钮下方,和 ⋯ 一样走 portal */}
      {projOpen && createPortal(
        <div
          ref={projMenuRef}
          className="pc-proj-menu"
          role="menu"
          style={{
            top: (projRect?.bottom ?? 36) + 6,
            left: Math.max(8, Math.min(projRect?.left ?? 0, window.innerWidth - 248)),
          }}
        >
          <button type="button" role="menuitem" className="pc-proj-item" disabled={ONLINE_BUILD} title={ONLINE_BUILD ? ONLINE_OFF("新建项目") : undefined} onClick={() => { setProjOpen(false); createProject(); }}>
            <IconNew />
            <span className="pc-proj-text"><b>新建项目</b><small>开一个空项目</small></span>
          </button>
          <button type="button" role="menuitem" className="pc-proj-item" disabled={ONLINE_BUILD} title={ONLINE_BUILD ? ONLINE_OFF("打开项目") : undefined} onClick={() => { setProjOpen(false); projectInput.current?.click(); }}>
            <IconOpen />
            <span className="pc-proj-text"><b>打开项目…</b><small>{PROC_EXT} 项目文件</small></span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pc-proj-item"
            disabled={viewOnly || ONLINE_BUILD}
            title={ONLINE_BUILD ? ONLINE_OFF("保存项目") : viewOnly ? viewOnlyText() : undefined}
            onClick={() => { setProjOpen(false); void saveProject(); }}
          >
            <IconSave />
            <span className="pc-proj-text"><b>保存项目</b><small>{dirty ? "有没保存的改动" : "已是最新"}</small></span>
            {dirty && <span className="pc-proj-dirty" />}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pc-proj-item"
            data-pc="menu-pack"
            disabled={viewOnly || ONLINE_BUILD}
            title={ONLINE_BUILD ? ONLINE_OFF("打包保存") : viewOnly ? viewOnlyText() : "编排和素材打成一个包,换台机器直接打开"}
            onClick={() => { setProjOpen(false); void savePackedProject(); }}
          >
            <IconSave />
            <span className="pc-proj-text"><b>打包保存…</b><small>{PROCP_EXT} 连素材一起</small></span>
          </button>
          <div className="pc-proj-sep" role="separator" />
          <button type="button" role="menuitem" className="pc-proj-item" data-pc="menu-backups" onClick={() => { setProjOpen(false); setBackupsOpen(true); }}>
            <IconSave />
            <span className="pc-proj-text"><b>本地备份…</b><small>{ONLINE_BUILD ? "被覆盖、离线丢弃的修改(只留在本页)" : "被覆盖、离线丢弃的修改"}</small></span>
          </button>
          <div className="pc-proj-sep" role="separator" />
          <button type="button" role="menuitem" className="pc-proj-item" onClick={() => { setProjOpen(false); setSettingsOpen(true); }}>
            <IconSettings />
            <span className="pc-proj-text"><b>项目设置…</b><small>尺寸、帧率、多用户协作</small></span>
          </button>
        </div>,
        document.body,
      )}

      <span className="ml-auto" />

      {/* C6.5:同步已暂停 / 离线 / 共享项目的成员按钮 */}
      <div className="pc-bar-group">
        <SyncChips />
      </div>

      {/* 桌面版代下时的醒目提示条 */}
      {collectUrl && (
        <div
          className="pc-bar-group"
          role="status"
          aria-live="polite"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "2px 10px",
            borderRadius: "999px",
            fontSize: "12px",
            color: "var(--ui-accent, #3b82f6)",
            background: "var(--ui-accent-subtle, rgba(59, 130, 246, 0.12))",
            border: "1px solid var(--ui-accent, rgba(59, 130, 246, 0.3))",
            maxWidth: "420px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: 500,
          }}
          title={`云端 Agent 正在用这台电脑上的登录下载：${collectUrl}`}
        >
          {`云端 Agent 正在用这台电脑上的登录下载：${collectUrl}`}
        </div>
      )}

      {/* 只读(?observe=1,或这个项目只给了只读权限):告诉人这份是看的不是改的,别让人白点一下才发现 */}
      {viewOnly && (
        <span
          className="pc-viewonly-badge"
          data-pc="viewonly-badge"
          data-pc-reason={reason ?? undefined}
          title={reason === "read-only-member" ? viewOnlyText() : "这个页面是用只读方式打开的(?observe=1):能看,不能改。"}
        >
          {reason === "read-only-member" ? "只能查看" : "只读查看"}
        </span>
      )}

      {/* C · 文件操作条:打开/保存参与中档收起,导出为主按钮永远不收起。
          导入视频已迁到左栏「素材 → 视频」的 + 按钮,顶栏不再重复 */}
      <div className="pc-bar-group">
        <Btn onClick={goHome} label="首页" icon={<IconHome />} collapsed={tier !== "wide"} />
        {/* 新建 / 打开 / 保存 / 项目设置收在这一个按钮里,点开才出子菜单(见 toggleProjMenu) */}
        <button
          ref={projBtnRef}
          type="button"
          className={`pc-btn pc-proj-btn${projOpen ? " is-open" : ""}`}
          title="项目:新建、打开、保存、设置"
          aria-haspopup="menu"
          aria-expanded={projOpen}
          onClick={toggleProjMenu}
        >
          <IconOpen />
          <span className="pc-btn-label">项目</span>
          <svg className="pc-proj-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {dirty && <span className="pc-proj-dirty" title="有没保存的改动" />}
        </button>
        {/* 配音设置:开子窗口,和开始页配音卡的「设置」是同一个 */}
        <Btn onClick={openVoiceSettings} label="配音设置" icon={<IconVoice />} collapsed={tier !== "wide"} disabled={ONLINE_BUILD} title={ONLINE_BUILD ? ONLINE_OFF("配音") : undefined} />
        <Btn
          onClick={run(() => exportProject())}
          label="导出视频"
          icon={<IconExport />}
          primary
          collapsed={false}
        />
      </div>

      <input
        ref={projectInput}
        type="file"
        accept={`${PROC_EXT},${PROCP_EXT},.json`}
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) run(() => openProjectFile(f))(); }}
      />

      {/* 项目设置对话框 */}
      <SkinDialog open={skinOpen} onClose={() => setSkinOpen(false)} />
      {/* 在线页面 SKILL 置灰(ModeSwitch),对话框打不开 */}
      {ONLINE_BUILD ? null : <SkillDialog open={skillOpen} onClose={() => setSkillOpen(false)} />}
      {/* 和第 754 行那个菜单项一样要带 !ONLINE_BUILD：漏了的话 LanOpenDialog 连它的 /api/lan-open 一起进在线产物 */}
      {!ONLINE_BUILD && lanOpen && <LanOpenDialog onClose={() => setLanOpen(false)} />}
      <BackupsDialog open={backupsOpen} onClose={() => setBackupsOpen(false)} />
      <ProjectSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <SaveStatusLayer />
      <ExportDialog
        state={exportState}
        onCancel={() => {
          // 先把界面切成「取消中」的观感,服务端杀进程要一会儿;真正的
          // cancelled 状态由 SSE 回来时那一路负责写
          if (exportIdRef.current) void cancelExport(exportIdRef.current);
        }}
        onClose={() => setExportState(null)}
        onReveal={() => {
          if (exportState?.id) void revealExport(exportState.id);
        }}
        onPick={(picked) => { void run(() => exportProject(picked))(); }}
      />
    </div>
  );
}
