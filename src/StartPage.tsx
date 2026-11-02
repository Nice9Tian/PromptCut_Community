import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";
import "./StartPage.css";
import { Logo } from "./ui/Logo";
import { LanguageMenu } from "./ui/LanguageMenu";
import { listDrafts, openDraft, deleteDraft, newDraftId, setActiveDraftId } from "./editor/io/drafts";
import type { DraftInfo } from "./editor/io/drafts";
import { newProject, loadProc, PROC_EXT } from "./editor/io/proc";
import { PROCP_EXT, isProcpFile, loadProcpFile } from "./editor/io/procp";
import { actions } from "./store/project";
import { sttStatus } from "./editor/io/stt";
import type { SttStatus, SttEngineStatus } from "./editor/io/stt";
import { shotsStatus, installShots } from "./ai/shots";
import { trackStatus, installTrack } from "./ai/track";
import { subjectStatus, installSubject } from "./ai/subject";
import { collectStatus, installCollect, type CollectStatus } from "./ai/collect";
import { openCollectLogin, useCollectLoginState } from "./ai/collectLoginStore";
import { CollectLoginDialog } from "./editor/right/CollectLoginDialog";
import { runSttInstall } from "./editor/io/runSttInstall";
import { useInstallJobs } from "./ai/sttInstallStore";
import { SttInstallProgress } from "./editor/right/SttInstallProgress";
import { VoiceSettingsDialog } from "./voice/VoiceSettingsDialog";
import { openVoiceSettings, useVoiceSettingsState } from "./ai/voiceSettingsStore";
import { getVoiceConfig } from "./ai/voice";
import { JoinForm } from "./editor/sync/JoinForm";
import { STORAGE_EVENT, takeStorageRequest } from "./ui/WindowTitleBar";
import { getAccountExtensions, subscribeAccountExtensions } from "./editor/sync/accountExtensions";

function AccountProjectsSlot(props: { online: boolean; onEnterEditor: () => void }): JSX.Element | null {
  const ext = useSyncExternalStore(subscribeAccountExtensions, getAccountExtensions, getAccountExtensions);
  const AccountProjects = ext.AccountProjects;
  if (AccountProjects) return <AccountProjects online={props.online} onEnterEditor={props.onEnterEditor} />;
  if (props.online) return <JoinSection onEnterEditor={props.onEnterEditor} />;
  return null;
}
import { OnlineStart } from "./start/OnlineStart";
import { DesktopStart } from "./start/DesktopStart";
import { tr } from "./i18n/index.ts";

/** 字节数写成人看的样子。导出产物、预渲染缓存动辄几十 GB,所以到 G 为止 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** 秒 → mm:ss */
function humanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 今天的只显示时间,其余显示日期 */
function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : tr("{0}/{1}", d.getMonth() + 1, d.getDate());
}

/** humanDate 之外再带上时分:同一天导出好几次,只有日期分不出来 */
function humanDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = humanDate(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return date === hm ? date : `${date} ${hm}`;
}

/**
 * 开始页面。进软件先看到这里,选了才进编辑器。
 *
 * 五块:开始创作、加入别人的项目、拓展功能、本地草稿、存储。没有左侧栏,也没有那排圆形入口。
 * 「存储」(`workflow/project.md`「开始」)显示预渲染缓存与导出产物的占用、改缓存上限、清理缓存、逐份管理导出产物;
 * 标题栏菜单「存储…」直达这里(`WindowTitleBar.tsx` 的 `open-storage`)。
 *
 * 在线浏览器模式(C10a 契约第 2 节「首屏」):只有「加入别人的项目」—— 在线页面里新建项目、本机草稿、拓展功能
 * 都要编辑器进程(`/api/*`),C10a 不提供(新建与草稿随 C10 其余)。在线构建里只留 `OnlineStartPage`,桌面那一页
 * 连同草稿、拓展功能背后的调用一起剪掉(M8 遗留 L24;写法见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

function JoinSection(props: { onEnterEditor: () => void }): JSX.Element {
  return (
    <section className="sp-section" data-pc="start-join">
      <h2 className="sp-section-title">{tr("Join someone else's project")}</h2>
      <JoinForm onJoined={props.onEnterEditor} />
    </section>
  );
}

/** 地址里点名要原来那一块账号表单(`?ui=classic`):只留给排障和还认老页面的探针,界面上没有入口 */
function wantsClassic(): boolean {
  try {
    return new URLSearchParams(location.search).get("ui") === "classic";
  } catch {
    return false;
  }
}

/**
 * 桌面版点名要氛围式那一屏(`?ui=vibe`)。桌面版的缺省仍是这一页(传统开始页) —— 改桌面版的缺省界面是一级改动,
 * 不由会话定;在线那边缺省就是氛围式,不看这个参数。
 *
 * 用地址带着是为了**刷新后还在原地**:氛围式里按 F5、从编辑界面回首页,落回的都该是刚才那一屏。
 * 编辑界面顶栏的「氛围式」(`src/editor/ModeSwitch.tsx`)也是改这个参数再派 `pc-go-home`。
 */
function wantsVibe(): boolean {
  try {
    return new URLSearchParams(location.search).get("ui") === "vibe";
  } catch {
    return false;
  }
}

/**
 * 把 `?ui=` 写成某个值(null 是去掉)。地址改不了(少见)不影响这一次切换,只是刷新后回到缺省那一屏。
 *
 * 编辑界面那边(`src/editor/TopBar.tsx` 的 `goVibe`)写的是同一个参数,但它自己写,不从这里引 ——
 * 这个文件要引 `src/editor/`,反过来引会绕成一圈。
 */
function setUiParam(value: string | null): void {
  try {
    const url = new URL(location.href);
    if (value === null) url.searchParams.delete("ui");
    else url.searchParams.set("ui", value);
    history.replaceState(history.state, "", url);
  } catch { /* 改不了地址栏不拦着切 */ }
}

/**
 * 在线浏览器(电脑身份)的首屏:**缺省是 Vibe 模式**(`user-workflow.md`「工作方式」:在线浏览器登录后的默认界面),
 * 整套在 `src/start/`,已接上真账号、真云端项目、真云端 Agent(`src/start/OnlineStart.tsx` 文件头逐块写了接到哪)。
 *
 * 原先这里有一道门(〔裁 V21-12〕:新界面只跑界面、用假数据时,只有带 `?ui=vibe` 才进,缺省仍是老的账号表单),
 * 用户 2026-10-23 验收时指出判错了:要的是把新界面接上业务层并成为缺省。门已去掉(返工分支 `claude/vibe-wire`)。
 * `?ui=vibe` / `?ui=home` / `?ui=login` 不再有特别的意思(进的都是缺省这一页,`?ui=home` 不再跳过登录)。
 * 老的那一块账号表单(`AccountProjects`)只在 `?ui=classic` 下还能打开,界面上没有入口。
 */
function OnlineStartPage(props: { onEnterEditor: () => void }): JSX.Element {
  if (wantsClassic()) {
    return (
      <div className="sp">
        <header className="sp-bar">
          <Logo size={22} />
          <span className="sp-bar-spacer" />
        <LanguageMenu className="sp-ghost-btn" />
        </header>
        <main className="sp-main"><AccountProjectsSlot online onEnterEditor={props.onEnterEditor} /></main>
      </div>
    );
  }
  return <OnlineStart onEnterEditor={props.onEnterEditor} />;
}

export const StartPage: (props: { onEnterEditor: () => void }) => JSX.Element = ONLINE_BUILD ? OnlineStartPage : DesktopStartPage;

/**
 * 桌面版的首屏:在传统开始页(下面那一大段)和**氛围式**那一屏(`src/start/DesktopStart.tsx`)之间二选一。
 *
 * 缺省是传统开始页;点它顶上那颗「氛围式」或编辑界面顶栏工作方式开关的第一格进氛围式,地址上记成 `?ui=vibe`
 * (所以刷新后还在氛围式)。氛围式顶栏右边的「拓展与存储」回这一页 —— 打开项目文件、加入别人的项目、拓展功能、
 * 存储这几块只有这一页有。
 */
function DesktopStartPage(props: { onEnterEditor: () => void }): JSX.Element {
  const [vibe, setVibe] = useState(wantsVibe);
  if (vibe) {
    return (
      <DesktopStart
        onEnterEditor={props.onEnterEditor}
        onClassic={() => { setUiParam(null); setVibe(false); }}
      />
    );
  }
  return <DesktopClassicPage onEnterEditor={props.onEnterEditor} onVibe={() => { setUiParam("vibe"); setVibe(true); }} />;
}

function DesktopClassicPage(props: { onEnterEditor: () => void; onVibe: () => void }): JSX.Element {
  const { onEnterEditor } = props;
  const [drafts, setDrafts] = useState<DraftInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDrafts(await listDrafts());
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("Failed to read drafts"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startNew = () => {
    newProject(tr("Untitled"));
    // 新项目还没落盘,进编辑器后由「保存项目」写成草稿
    setActiveDraftId(newDraftId());
    onEnterEditor();
  };

  const open = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await openDraft(id);
      setActiveDraftId(id);
      onEnterEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("Failed to open"));
    } finally {
      setBusy("");
    }
  };

  const remove = async (draft: DraftInfo) => {
    if (!confirm(tr("Delete draft \"{0}\"? This deletes the .proc file on disk and cannot be undone.", draft.name))) return;
    try {
      await deleteDraft(draft.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("Failed to delete"));
    }
  };

  const openFile = async (file: File) => {
    setError("");
    try {
      // .procp(编排 + 素材的 zip 包,A1)先拆包落库再载入;别对它 .text(),
      // 那是把一个可能几 GB 的包整份读进页面。
      const packed = await isProcpFile(file);
      const project = packed ? await loadProcpFile(file) : loadProc(await file.text());
      actions.loadProject(project, packed ? file.name.replace(/\.procp$/i, PROC_EXT) : file.name);
      // 从文件打开的不属于任何草稿,保存时再新建一份
      setActiveDraftId(null);
      onEnterEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("This file can't be opened"));
    }
  };

  return (
    <div className="sp">
      <header className="sp-bar">
        {/* Logo 自带文字标,别再补一遍 */}
        <Logo size={22} />
        <span className="sp-bar-spacer" />
        {/* 氛围式(`user-workflow.md`「工作方式」第一行):不打开编辑界面,对着 Agent 说话把片子做出来 */}
        <button className="sp-ghost-btn" data-pc="start-go-vibe" title={tr("Make the video by talking to the Agent, without opening the editor")} onClick={props.onVibe}>
          {tr("Vibe mode")}
        </button>
        <button className="sp-ghost-btn" onClick={() => fileInput.current?.click()}>
          {tr("Open project file")}
        </button>
      </header>

      <main className="sp-main">
        <button className="sp-hero" onClick={startNew}>
          <span className="sp-hero-plus" aria-hidden="true">{tr("+")}</span>
          <span className="sp-hero-text">{tr("Start creating")}</span>
          <span className="sp-hero-sub">{tr("Create an empty project")}</span>
        </button>

        <AccountProjectsSlot online={false} onEnterEditor={onEnterEditor} />
        <JoinSection onEnterEditor={onEnterEditor} />

        <section className="sp-section">
          <h2 className="sp-section-title">{tr("Extras")}</h2>
          <ExtensionCards />
        </section>

        <section className="sp-section">
          <div className="sp-section-head">
            <h2 className="sp-section-title">{tr("Local drafts")}</h2>
            <div className="sp-section-actions">
              <span className="sp-muted">{loading ? tr("Loading…") : tr("{0}", drafts.length)}</span>
              <button className="sp-ghost-btn" onClick={() => void refresh()}>{tr("Refresh")}</button>
            </div>
          </div>

          {error && <div className="sp-error">{error}</div>}

          {!loading && drafts.length === 0 && !error && (
            <div className="sp-empty">
              {tr("No drafts yet. Click \"Start creating\" above to make one; once you save in the editor it will show up here.")}
            </div>
          )}

          <div className="sp-grid">
            {drafts.map((d) => (
              <div key={d.id} className={`sp-draft${d.broken ? " is-broken" : ""}`}>
                <button
                  className="sp-draft-thumb"
                  disabled={d.broken || busy === d.id}
                  onClick={() => void open(d.id)}
                  title={d.broken ? tr("This file can't be parsed") : tr("Open \"{0}\"", d.name)}
                >
                  {d.thumbnail
                    ? <img src={d.thumbnail} alt="" />
                    : <span className="sp-draft-placeholder">{d.broken ? tr("!") : tr("{0} cards", d.clips)}</span>}
                  {busy === d.id && <span className="sp-draft-busy">{tr("Opening…")}</span>}
                </button>
                <div className="sp-draft-meta">
                  <div className="sp-draft-name" title={d.name}>{d.name}</div>
                  <div className="sp-draft-sub">
                    {humanDate(d.updatedAt)} · {humanSize(d.size)} · {humanDuration(d.duration)}
                  </div>
                </div>
                <button className="sp-draft-del" title={tr("Delete this draft")} onClick={() => void remove(d)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>

        <StorageSection />
      </main>

      <input
        ref={fileInput}
        type="file"
        accept={`${PROC_EXT},${PROCP_EXT},.json`}
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); }}
      />
    </div>
  );
}

/*
 * ── 存储 ───────────────────────────────────────────────
 * 接口约定见 `docs/plan/storage-plan.md` 第 4 节:`/api/storage*`(帧库占用、上限、清理缓存,编辑器进程转发给预渲染进程)
 * 与 `/api/exports*`(导出产物,`server/vite-plugin-exports-list.ts`)。`/api/storage` 取不到(比如那一半还没装上、
 * 预渲染进程没起来)时这一块照常显示导出产物,缓存那一行写「暂时取不到」,不报错。
 * 只在桌面开始页里;在线构建连同这些调用一起剪掉(`StartPage` 在线构建里是 `OnlineStartPage`)。
 */

/*
 * 这一块的大小与草稿列表一样按 1024 换算(`humanSize`),GB = 1024³ 字节 —— 与 Windows 资源管理器显示的「GB」一致;
 * 服务端的缓存上限、缺省 50 GB、下限 5 GB 也是这个 GB(`server/frame-library-storage.mjs` 的 `GB`)。填 20 发 20 × 1024³。
 */
const GB = 1024 ** 3;
const storageSize = humanSize;
/** 缓存上限的下限(`mechanism/platforms.md`「帧库」:用户可在 5 GB 到磁盘总容量之间改) */
const CAP_MIN_BYTES = 5 * GB;
/** 服务端回 `scanning: true` 时隔多久再取、最多再取几次 */
const STORAGE_RESCAN_MS = 3000;
const STORAGE_RESCAN_TRIES = 10;

interface StorageInfo {
  frameLibrary: {
    bytes: number;
    capBytes: number;
    capSource: "default" | "user";
    diskBytes: number;
    pinnedBytes?: number;
    scannedAt?: string | number | null;
    /** 服务端正在重扫或正在量(数字还会变) */
    scanning?: boolean;
    /** `reason`:`cap` 超上限自动清的,`clear` 用户点「清理缓存」清的(`frame-library-storage.mjs` 的 `evictTo`) */
    lastEvict?: { at: string | number; freedBytes: number; removed: number; skipped: number; reason?: "cap" | "clear" } | null;
  };
}

interface ExportItem {
  id: string;
  projectName: string | null;
  projectId: string | null;
  at: string | null;
  finished: boolean;
  running?: boolean;
  bytes: number;
  deliverables: Array<{ name: string; bytes: number }>;
  intermediateBytes: number;
}

const DELIVERABLE_LABEL: Record<string, string> = { "preview.mp4": tr("Final video"), "overlay.mov": tr("Transparent layers") };

/**
 * 读一个 JSON 接口。接口不存在时开发服务器可能回首页的 HTML(200)、也可能 404,两种都当取不到;
 * `{ ok: false, error }` 把 error 抛出来给界面显示。
 */
async function storageJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error(res.ok ? tr("API unavailable") : `HTTP ${res.status}`);
  const body = await res.json() as { ok?: boolean; error?: string } & T;
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function StorageSection(): JSX.Element {
  const sectionRef = useRef<HTMLElement>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ok" | "unavailable">("loading");
  const [items, setItems] = useState<ExportItem[]>([]);
  const [exportsLoading, setExportsLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [capGb, setCapGb] = useState("");

  const shownCap = useRef<number | null>(null);
  const loadStorage = useCallback(async () => {
    try {
      const s = await storageJson<StorageInfo>("/api/storage");
      if (!s.frameLibrary || typeof s.frameLibrary.bytes !== "number") throw new Error(tr("Bad response"));
      setStorage(s);
      setStorageState("ok");
      // 只在上限变了时改输入框(自动重取时不冲掉用户正在填的数)
      if (shownCap.current !== s.frameLibrary.capBytes) {
        shownCap.current = s.frameLibrary.capBytes;
        setCapGb(String(Math.round(s.frameLibrary.capBytes / GB)));
      }
    } catch {
      setStorage(null);
      setStorageState("unavailable");
    }
  }, []);

  // 服务端在量(`scanning: true`,`GET /api/storage` 发现上次检查已过时会在后台量一次):
  // 隔几秒再取,直到量完;最多重取 STORAGE_RESCAN_TRIES 次,不无限轮询
  const scanTries = useRef(0);
  const scanning = !!storage?.frameLibrary.scanning;
  useEffect(() => {
    if (!scanning) { scanTries.current = 0; return; }
    if (scanTries.current >= STORAGE_RESCAN_TRIES) return;
    const timer = window.setTimeout(() => { scanTries.current++; void loadStorage(); }, STORAGE_RESCAN_MS);
    return () => window.clearTimeout(timer);
  }, [scanning, storage, loadStorage]);

  const loadExports = useCallback(async () => {
    setExportsLoading(true);
    try {
      const r = await storageJson<{ items: ExportItem[] }>("/api/exports");
      setItems(Array.isArray(r.items) ? r.items : []);
    } catch (e) {
      setError(tr("Failed to read export output: {0}", e instanceof Error ? e.message : String(e)));
    } finally {
      setExportsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    await Promise.all([loadStorage(), loadExports()]);
  }, [loadStorage, loadExports]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 标题栏「存储…」:从编辑器回来时开始页刚挂上,从开始页点时直接收到事件。
  // 上面几块(草稿、拓展)是异步读出来的,读完会把这一块往下推,所以头一两秒里跟着再滚一次
  useEffect(() => {
    const focus = () => {
      const el = sectionRef.current;
      if (!el) return;
      el.scrollIntoView({ block: "start" });
      const main = el.parentElement;
      if (!main || typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(() => el.scrollIntoView({ block: "start" }));
      for (const child of Array.from(main.children)) ro.observe(child);
      window.setTimeout(() => ro.disconnect(), 1500);
    };
    if (takeStorageRequest()) focus();
    window.addEventListener(STORAGE_EVENT, focus);
    return () => window.removeEventListener(STORAGE_EVENT, focus);
  }, []);

  const clearCache = async () => {
    if (!confirm(tr("Clearing the cache deletes prerender output (except what the currently open project uses). It will have to be prerendered again when needed. Continue?"))) return;
    setBusy("clear-cache");
    setError("");
    setNotice("");
    try {
      const r = await storageJson<{ freedBytes: number; removed?: number; skipped?: number }>("/api/storage/clear-cache", { method: "POST" });
      setNotice(tr("Cleanup done, freed {0}{1}.", storageSize(r.freedBytes || 0), r.skipped ? tr("; {0} items in use, not deleted", r.skipped) : ""));
      await loadStorage();
    } catch (e) {
      setError(tr("Failed to clear cache: {0}", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy("");
    }
  };

  const fl = storage?.frameLibrary;
  const capMaxGb = fl && fl.diskBytes > 0 ? Math.floor(fl.diskBytes / GB) : Infinity;
  const saveCap = async () => {
    const gb = Number(capGb);
    if (!Number.isFinite(gb) || gb < CAP_MIN_BYTES / GB || gb > capMaxGb) {
      setNotice("");
      setError(tr("The limit must be between {0} GB and {1}.", CAP_MIN_BYTES / GB, Number.isFinite(capMaxGb) ? tr("{0} GB (total disk capacity)", capMaxGb) : tr("total disk capacity")));
      return;
    }
    setBusy("cap");
    setError("");
    setNotice("");
    try {
      const r = await storageJson<{ capBytes: number }>("/api/storage/cap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bytes: Math.round(gb * GB) }),
      });
      setNotice(tr("Cache limit changed to {0}.", storageSize(r.capBytes)));
      await loadStorage();
    } catch (e) {
      setError(tr("Failed to change limit: {0}", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy("");
    }
  };

  const act = async (item: ExportItem, action: "delete" | "prune" | "reveal") => {
    const who = tr("{0} ({1})", item.projectName || tr("Unknown project"), item.at ? humanDateTime(item.at) : item.id);
    if (action === "delete" && !confirm(tr("Delete export \"{0}\"? This deletes the files on disk ({1}), including the final video and the transparency layer, and cannot be undone.", who, storageSize(item.bytes)))) return;
    if (action === "prune" && !confirm(tr("Delete only the intermediate files of \"{0}\" ({1})? The final video and transparency layer are kept. This deletes the files on disk and cannot be undone.", who, storageSize(item.intermediateBytes)))) return;
    setBusy(`${action}:${item.id}`);
    setError("");
    setNotice("");
    try {
      const r = await storageJson<{ freedBytes?: number }>(`/api/exports/${encodeURIComponent(item.id)}/${action}`, { method: "POST" });
      if (action !== "reveal") {
        setNotice(tr("{0}, freed {1}.", action === "delete" ? tr("Deleted") : tr("Deleted intermediate files"), storageSize(r.freedBytes || 0)));
        await loadExports();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (action !== "reveal") await loadExports();
    } finally {
      setBusy("");
    }
  };

  const exportBytes = items.reduce((s, it) => s + it.bytes, 0);
  const exportMid = items.reduce((s, it) => s + it.intermediateBytes, 0);
  const pct = fl && fl.capBytes > 0 ? Math.min(100, (fl.bytes / fl.capBytes) * 100) : 0;

  return (
    <section ref={sectionRef} className="sp-section" data-pc="start-storage" id="storage">
      <div className="sp-section-head">
        <h2 className="sp-section-title">{tr("Storage")}</h2>
        <div className="sp-section-actions">
          <button className="sp-ghost-btn" onClick={() => void refresh()} disabled={!!busy}>{tr("Refresh")}</button>
        </div>
      </div>

      {error && <div className="sp-error" data-pc="storage-error">{error}</div>}
      {notice && <div className="sp-storage-notice" data-pc="storage-notice">{notice}</div>}

      <div className="sp-storage-cards">
        <div className="sp-storage-card" data-pc="storage-cache">
          <div className="sp-storage-label">{tr("Prerender cache")}</div>
          {storageState === "loading" && <div className="sp-muted">{tr("Loading…")}</div>}
          {storageState === "unavailable" && (
            <div className="sp-muted" data-pc="storage-cache-unavailable">{tr("Not available right now. Once the prerender process is up, click \"Refresh\" and check again.")}</div>
          )}
          {storageState === "ok" && fl && (
            <>
              <div className="sp-storage-figure" data-pc="storage-cache-bytes">
                {storageSize(fl.bytes)} <span className="sp-muted">{tr("/ limit {0}{1}", storageSize(fl.capBytes), fl.capSource === "default" ? tr("(default)") : "")}</span>
              </div>
              <div className="sp-storage-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
              {fl.lastEvict && (
                <div className="sp-muted">
                  {tr("{0} {1}, freed {2}", fl.lastEvict.reason === "clear" ? tr("Last cache cleanup") : tr("Last automatic cleanup"), humanDateTime(new Date(fl.lastEvict.at).toISOString()), storageSize(fl.lastEvict.freedBytes))}
                </div>
              )}
              <div className="sp-storage-row">
                <label className="sp-muted" htmlFor="sp-cap-input">{tr("Limit")}</label>
                <input
                  id="sp-cap-input"
                  className="sp-storage-input"
                  data-pc="storage-cap-input"
                  type="number"
                  min={CAP_MIN_BYTES / GB}
                  max={Number.isFinite(capMaxGb) ? capMaxGb : undefined}
                  step={1}
                  value={capGb}
                  onChange={(e) => setCapGb(e.target.value)}
                />
                <span className="sp-muted">GB</span>
                <button className="sp-ghost-btn" data-pc="storage-cap-save" disabled={!!busy} onClick={() => void saveCap()}>{tr("Set")}</button>
              </div>
            </>
          )}
          <div className="sp-storage-row">
            <button
              className="sp-ghost-btn"
              data-pc="storage-clear-cache"
              disabled={storageState !== "ok" || !!busy}
              onClick={() => void clearCache()}
            >
              {busy === "clear-cache" ? tr("Clearing…") : tr("Clear cache")}
            </button>
          </div>
        </div>

        <div className="sp-storage-card" data-pc="storage-exports-total">
          <div className="sp-storage-label">{tr("Export output")}</div>
          {exportsLoading && items.length === 0
            ? <div className="sp-muted">{tr("Loading…")}</div>
            : (
              <>
                <div className="sp-storage-figure">{storageSize(exportBytes)} <span className="sp-muted">{tr("· {0} items", items.length)}</span></div>
                <div className="sp-muted">{exportMid > 0 ? tr("Of this, intermediate files take {0}; you can delete only those and keep the final video and transparency layer.", storageSize(exportMid)) : tr("No intermediate files.")}</div>
              </>
            )}
        </div>
      </div>

      {!exportsLoading && items.length === 0 && !error && (
        <div className="sp-empty">{tr("No exports yet. Each export will be listed here once it finishes.")}</div>
      )}

      {items.length > 0 && (
        <ul className="sp-export-list" data-pc="storage-exports">
          {items.map((it) => {
            const rowBusy = busy.endsWith(`:${it.id}`);
            return (
              <li key={it.id} className="sp-export-row" data-pc="storage-export" data-export-id={it.id}>
                <div className="sp-export-main">
                  <div className="sp-export-name" title={it.projectId ? tr("Project {0}", it.projectId) : it.id}>
                    {it.projectName || <span className="sp-muted">{tr("Unknown project")}</span>}
                    {it.running
                      ? <span className="sp-export-tag">{tr("In progress")}</span>
                      : !it.finished && <span className="sp-export-tag is-warn">{tr("Unfinished")}</span>}
                  </div>
                  <div className="sp-draft-sub">
                    <span title={it.id}>{it.at ? humanDateTime(it.at) : it.id}</span>
                    {" · "}<span data-pc="storage-export-bytes">{storageSize(it.bytes)}</span>
                    {it.deliverables.map((d) => (
                      <span key={d.name}> · {DELIVERABLE_LABEL[d.name] ?? d.name} {storageSize(d.bytes)}</span>
                    ))}
                    {it.intermediateBytes > 0 && <span data-pc="storage-export-mid"> {" "}{tr("· Intermediate files {0}", storageSize(it.intermediateBytes))}</span>}
                  </div>
                </div>
                <div className="sp-export-actions">
                  <button className="sp-ghost-btn" data-pc="storage-export-reveal" disabled={rowBusy} onClick={() => void act(it, "reveal")}>{tr("Open containing folder")}</button>
                  {it.intermediateBytes > 0 && !it.running && (
                    <button className="sp-ghost-btn" data-pc="storage-export-prune" disabled={!!busy} onClick={() => void act(it, "prune")}>
                      {busy === `prune:${it.id}` ? tr("Deleting…") : tr("Delete intermediate files only")}
                    </button>
                  )}
                  {!it.running && (
                    <button className="sp-ghost-btn sp-danger-btn" data-pc="storage-export-delete" disabled={!!busy} onClick={() => void act(it, "delete")}>
                      {busy === `delete:${it.id}` ? tr("Deleting…") : tr("Delete")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * 一个拓展在界面上的样子。
 *
 * 拆出 offerInstall 而不是直接用「装没装」取反:有两种没装的情况不该给安装按钮 ——
 * 状态压根读不到、以及连 Python 都没有。这两种点了必然再失败一次,
 * 显示成普通的「未安装」等于骗用户去撞墙。
 */
interface ExtStatusView {
  headline: string;
  /** 跟在 headline 后面那句:现在实际吃的是哪一档、降级之后还能干什么 */
  note: string;
  tone: "ok" | "muted" | "danger";
  offerInstall: boolean;
}

function toneClass(tone: ExtStatusView["tone"]): string {
  return tone === "ok" ? "sp-ok" : tone === "danger" ? "sp-ext-error" : "sp-muted";
}

function failedView(reason: unknown): ExtStatusView {
  return {
    headline: tr("Can't read status"),
    note: reason instanceof Error ? reason.message : String(reason),
    tone: "danger",
    offerInstall: false,
  };
}

/** 把一次 settled 的查询结果翻成界面状态。映射本身也可能抛(后端少给字段),一起兜住 */
function toView<T>(r: PromiseSettledResult<T>, map: (v: T) => ExtStatusView): ExtStatusView {
  if (r.status === "rejected") return failedView(r.reason);
  try { return map(r.value); } catch (e) { return failedView(e); }
}

function viewStt(s: SttStatus): ExtStatusView {
  // 状态在 engines.<引擎>.installed 里,顶层没有 ready / installed / available 这些字段;
  // 以前读顶层,取到的永远是 undefined,所以装好了也一直显示「未安装」。
  const engines: Record<string, SttEngineStatus> = s.engines;
  const hit = Object.entries(engines).find(([, e]) => e.installed);
  if (hit) {
    return {
      headline: tr("Installed"),
      note: tr("Currently using {0}{1}", hit[0], hit[1].version ? ` ${hit[1].version}` : ""),
      tone: "ok",
      offerInstall: false,
    };
  }
  return {
    headline: tr("Not installed"),
    note: tr("No fallback tier; install it to turn speech into captions"),
    tone: "muted",
    offerInstall: true,
  };
}

function viewShots(s: { ready: boolean; engine: string }): ExtStatusView {
  if (s.ready) {
    return {
      headline: tr("Installed"),
      note: tr("Currently using {0}; recognizes hard cuts, dissolves and fades", s.engine || "TransNetV2"),
      tone: "ok",
      offerInstall: false,
    };
  }
  return {
    headline: tr("Not installed"),
    note: tr("Currently using ffmpeg scdet; recognizes hard cuts only, not dissolves"),
    tone: "muted",
    offerInstall: true,
  };
}

function viewTrack(s: { ready: boolean; engine: "bootstapir" | "template" | null; reason?: string }): ExtStatusView {
  if (s.ready) {
    return {
      headline: tr("Installed"),
      note: tr("Currently using {0}; keeps tracking through turns, deformation and brief occlusion", s.engine ?? "bootstapir"),
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.engine === "template") {
    // ready:false 不等于用不了 —— 这一档是能跑的,写成光秃秃的「未安装」会让人
    // 以为功能是灰的,所以把「还能用」和「什么时候会翻车」一起说清楚。
    return {
      headline: tr("Not installed"),
      note: tr("Currently using numpy template matching as a fallback, which can still track: rigid, clearly textured targets are tracked very accurately;")
        + tr(" The target is lost if it turns, zooms, or stays blocked for long. Installing the extension is much more stable, but it downloads about 400 MB"),
      tone: "muted",
      offerInstall: true,
    };
  }
  return {
    headline: tr("Unavailable"),
    note: s.reason || tr("Neither tier would start, usually because Python was not found"),
    tone: "danger",
    offerInstall: false,
  };
}

function viewSubject(s: { ready: boolean; engine: "light" | "full" | null; reason?: string }): ExtStatusView {
  if (s.engine === "full") {
    return {
      headline: tr("Installed"),
      note: tr("Full tier: faces and bodies, and it can also find targets from any text prompt (cat, phone, red car)"),
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.engine === "light") {
    // light 能用,但和 full 差一整个能力档。写成光秃秃的「已安装」会让人以为
    // 文字提示也能用,结果每次都只回人和脸。
    return {
      headline: tr("Installed"),
      note: tr("Light tier: recognizes faces and bodies, enough to avoid people; finding targets from text prompts requires installing the full tier extension pack"),
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.reason) {
    // 连 Python 都没有这类环境问题,给安装按钮只会让人再撞一次墙
    return { headline: tr("Unavailable"), note: s.reason, tone: "danger", offerInstall: false };
  }
  return {
    headline: tr("Not installed"),
    note: tr("There is no fallback tier. Install AI to know which side of the frame a person is on and where to place cards without covering faces"),
    tone: "muted",
    offerInstall: true,
  };
}

/** 拓展卡的壳子。四张卡长得一样,差别只在图标、文案和右边那个按钮 */
function ExtCard(props: {
  icon: ReactNode;
  name: string;
  desc: string;
  status: ExtStatusView | null;
  action?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const { icon, name, desc, status, action, children } = props;
  return (
    <div className="sp-ext-card">
      <div className="sp-ext-icon" aria-hidden="true">{icon}</div>
      <div className="sp-ext-body">
        <div className="sp-ext-name">{name}</div>
        <div className="sp-ext-desc">{desc}</div>
        <div className="sp-ext-state">
          {status === null
            ? <span className="sp-muted">{tr("Checking…")}</span>
            : <span className={toneClass(status.tone)}>
                {status.headline}{status.note ? ` · ${status.note}` : ""}
              </span>}
        </div>
        {children}
      </div>
      {action}
    </div>
  );
}

/** 拓展功能区:听写、镜头识别、运动追踪、主体检测四张卡 */
function ExtensionCards(): JSX.Element {
  const [stt, setStt] = useState<ExtStatusView | null>(null);
  const [shots, setShots] = useState<ExtStatusView | null>(null);
  const [track, setTrack] = useState<ExtStatusView | null>(null);
  const [subject, setSubject] = useState<ExtStatusView | null>(null);
  const [collect, setCollect] = useState<ExtStatusView | null>(null);
  /** 素材收集的原始状态:登录按钮要看 ready 和各站登录态 */
  const [collectRaw, setCollectRaw] = useState<CollectStatus | null>(null);

  const load = useCallback(async () => {
    // 五个查询各打一个 HTTP,而且都要等 Python 那边应答。串行的话最慢的排在最后,
    // 开始页会干等着,所以一起发。用 allSettled 不用 all:一个拓展查不到状态
    // 不该把另外几张卡也永远钉在「检测中…」。
    const [a, b, c, d, e] = await Promise.allSettled([
      sttStatus(), shotsStatus(), trackStatus(), subjectStatus(), collectStatus(),
    ]);
    setStt(toView(a, viewStt));
    setShots(toView(b, viewShots));
    setTrack(toView(c, viewTrack));
    setSubject(toView(d, viewSubject));
    setCollect(toView(e, viewCollect));
    setCollectRaw(e.status === "fulfilled" ? e.value : null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 登录框关掉之后刷新一次:登录 / 退出都会改这张卡上的字
  const loginOpen = useCollectLoginState().open;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !loginOpen) void load();
    wasOpen.current = loginOpen;
  }, [loginOpen, load]);

  return (
    <div className="sp-ext-row">
      <SttCard status={stt} onReload={load} />
      <ShotsCard status={shots} onReload={load} />
      <TrackCard status={track} onReload={load} />
      <SubjectCard status={subject} onReload={load} />
      <CollectCard status={collect} raw={collectRaw} onReload={load} />
      <VoiceCard />
      <CollectLoginDialog />
      <VoiceSettingsDialog />
    </div>
  );
}

function viewCollect(s: CollectStatus): ExtStatusView {
  if (s.ready) {
    const bili = s.cookies?.bilibili;
    const login = bili?.loggedIn
      ? tr("Bilibili logged in (user {0})", bili.userId ?? "?")
      : bili?.expired ? tr("Bilibili login state expired") : tr("Bilibili not logged in, up to 1080p");
    return {
      headline: tr("Installed"),
      note: tr("yt-dlp {0}; {1}", s.ytdlp?.version ?? "", login),
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.python === false || (s.ytdlp?.installed && !s.ffmpeg)) {
    // 没有内置 Python 或没有 ffmpeg 不是在线装能解决的,给按钮只会让人再撞一次墙
    return {
      headline: tr("Unavailable"),
      note: s.reason || (s.ytdlp?.installed ? tr("ffmpeg not found, video and audio streams cannot be merged") : tr("Built-in Python not found")),
      tone: "danger",
      offerInstall: false,
    };
  }
  return {
    headline: tr("Not installed"),
    note: tr("Install it to grab videos from web links such as Bilibili straight into the media library (about 3 MB)"),
    tone: "muted",
    offerInstall: true,
  };
}

/**
 * 配音:云端合成,不用装东西,卡上只显示「令牌配没配、默认用谁」。
 * 设置项多,点「设置」开子窗口(编辑台顶栏的「配音设置」开的是同一个)。
 */
function VoiceCard(): JSX.Element {
  const [status, setStatus] = useState<ExtStatusView | null>(null);

  const load = useCallback(async () => {
    try {
      const { config, presets } = await getVoiceConfig();
      const p = config.provider;
      const id = config[p].voiceId;
      const voice = config.customVoices.find((v) => v.provider === p && v.voiceId === id)?.name
        ?? presets.systemVoices[p].find((v) => v.voiceId === id)?.name
        ?? id;
      setStatus(config.apiKey.set
        ? { headline: tr("Configured"), note: `${presets.labels[p]} · ${voice}`, tone: "ok", offerInstall: false }
        : { headline: tr("Not configured"), note: tr("Fill in the API Key so the agent can do voiceover"), tone: "muted", offerInstall: false });
    } catch (e) {
      setStatus(failedView(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 设置窗口关掉之后刷新一次:令牌、默认音色都可能改了
  const open = useVoiceSettingsState().open;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) void load();
    wasOpen.current = open;
  }, [open, load]);

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
        </svg>
      }
      name="Voiceover"
      desc={tr("Turn text into speech with cloud synthesis, MiniMax by default.")}
      status={status}
      action={<button className="sp-ghost-btn" onClick={openVoiceSettings}>{tr("Settings")}</button>}
    />
  );
}

/** 素材收集:状态由上面统一查,安装走 installCollect 的 SSE 日志流(pip 装 yt-dlp) */
function CollectCard(props: { status: ExtStatusView | null; raw: CollectStatus | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, raw, onReload } = props;
  const [running, setRunning] = useState(false);
  // 装好了才谈登录:按钮文案跟着存盘登录态走,过期也算「要重新登录」
  const canLogin = !!raw?.ready;
  const biliLoggedIn = !!raw?.cookies?.bilibili?.loggedIn;
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    void installCollect((line) => setTail(line))
      .then(({ ok, log }) => {
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? tr("Install failed"));
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      }
      name="Media collection"
      desc={tr("Give a web link such as Bilibili and the video is grabbed into the media library.")}
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title={tr("About 3 MB")}>
              {error ? tr("Retry") : tr("Install")}
            </button>
          : canLogin
            ? <button className="sp-ghost-btn" onClick={() => openCollectLogin("bilibili", "qr")}
                title={biliLoggedIn ? tr("View login state, switch account, or log out") : tr("Log in by QR code or account password to get the quality only available when logged in")}>
                {biliLoggedIn ? tr("Bilibili account") : tr("Log in to Bilibili")}
              </button>
            : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">{tr("Installing…{0}", tail ? ` ${tail}` : "")}</span>
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}

/** 听写识别:状态由上面统一查,这张卡只管就地安装 */
function SttCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [startError, setStartError] = useState<string | null>(null);
  const jobs = useInstallJobs();
  const job = jobs.at(-1);
  const running = !!job && job.phase !== "done" && job.phase !== "failed";

  // 装完自动把状态刷新到位,不用用户自己再点一次
  useEffect(() => { if (job?.phase === "done") void onReload(); }, [job?.phase, onReload]);

  const install = () => {
    setStartError(null);
    // 走和编辑器里那个缺依赖提示完全相同的路径:流式读 pip 输出、解析进度、
    // 互斥防重复。以前这里是 POST /api/stt/install 且不带 body,
    // 服务端 JSON.parse("") 直接抛错返回 500,安装根本没启动过,
    // 而这段代码既不看返回码也不读那条 SSE 流,所以按钮闪一下就回到「安装」。
    try { runSttInstall("faster-whisper"); }
    catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3M8.5 21h7" />
        </svg>
      }
      name="Speech recognition"
      desc={tr("Turn speech in the video into captions, runs locally, no upload.")}
      status={status}
      action={
        // 判断依据是「有没有在跑」,不是「有没有任务」—— 装完一次之后 store 里会一直留着
        // 那条已完成的记录,拿它当条件会让卡片再也出不来按钮,变成死胡同。
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install}>{job?.phase === "failed" ? tr("Retry") : tr("Install")}</button>
          : null
      }
    >
      {/* 装的过程要看得见:下几百 MB、跑几分钟,没有进度就和没反应一样。
          失败的也留着显示,否则用户只看到按钮变回「安装」,不知道为什么没装上。 */}
      {(running || job?.phase === "failed") && (
        <div className="sp-ext-progress"><SttInstallProgress job={job!} compact /></div>
      )}
      {startError && <div className="sp-ext-error">{startError}</div>}
    </ExtCard>
  );
}

/** 镜头识别:状态由上面统一查,安装走 installShots 的 SSE 日志流 */
function ShotsCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 依赖装好了,只差模型文件 —— 得靠拓展库包补,不是在线装能解决的 */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    // 只留最后一行,理由同运动追踪那张卡
    void installShots((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // 「依赖装好了但还缺模型」不是失败:模型是我们自己转/官方下的权重,
        // 不在 requirements 里,只随拓展库包发。报成红字会让人以为白装了,
        // 而真正该说的是「去跑那个 .exe」。
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? tr("Install failed"));
        else if (needsModel) setNeedsPack(true);
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 5v14M14 5v14" />
        </svg>
      }
      name="Shot detection"
      desc={tr("Find shot change points in the media and split it by shot.")}
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title={tr("About 30 MB")}>
              {error ? tr("Retry") : tr("Install")}
            </button>
          : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">{tr("Installing…{0}", tail ? ` ${tail}` : "")}</span>
        </div>
      )}
      {needsPack && !error && (
        <div className="sp-ext-error">
          {tr("Dependencies are installed, but the model file is still missing. It ships with the extension pack, so run PromptCut-ext-shots-&lt;version&gt;.exe")}
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}

/** 运动追踪:状态由上面统一查,安装走 installTrack 的 SSE 日志流 */
function TrackCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 依赖装好了,只差模型文件 —— 得靠拓展库包补,不是在线装能解决的 */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    // 400 MB 走的是用户自己的网,开始之前先问一声 —— 点错了退不掉。
    if (!confirm(tr("The motion tracking extension needs to download torch and BootsTAPIR weights, about 400 MB, and takes several minutes. Install now?"))) return;
    setRunning(true);
    setError(null);
    setTail("");
    // 只留最后一行:pip 会刷几百行,开始页没有装日志面板的地方,
    // 有一行在动就够说明「还在跑」了。
    void installTrack((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // 「依赖装好了但还缺模型」不是失败:模型是我们自己转/官方下的权重,
        // 不在 requirements 里,只随拓展库包发。报成红字会让人以为白装了,
        // 而真正该说的是「去跑那个 .exe」。
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? tr("Install failed"));
        else if (needsModel) setNeedsPack(true);
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2" />
        </svg>
      }
      name="Motion tracking"
      desc={tr("Make text and stickers follow a target in the frame.")}
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title={tr("About 400 MB, takes several minutes")}>
              {error ? tr("Retry") : tr("Install")}
            </button>
          : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">{tr("Installing…{0}", tail ? ` ${tail}` : "")}</span>
        </div>
      )}
      {needsPack && !error && (
        <div className="sp-ext-error">
          {tr("Dependencies are installed, but the 208 MB weights file is still missing. It ships with the extension pack, so run PromptCut-ext-track-&lt;version&gt;.exe")}
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}

/** 主体检测:状态由上面统一查,安装走 installSubject 的 SSE 日志流(只装 light 档) */
function SubjectCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 依赖装好了,只差模型文件 —— 得靠拓展库包补,不是在线装能解决的 */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    // 只留最后一行,理由同另外两张卡:pip 会刷几百行,这里没有装日志面板的地方
    void installSubject((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // 「依赖装好了但还缺模型」不是失败:YuNet 和 RT-DETR 的权重不在
        // requirements 里,只随拓展库包发。报成红字会让人以为白装了,
        // 而真正该说的是「去跑那个 .exe」。
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? tr("Install failed"));
        else if (needsModel) setNeedsPack(true);
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        // 一个人形加一个取景框:这张卡干的就是「框出画面里的人」
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
          <circle cx="12" cy="10" r="2.4" />
          <path d="M8.2 17c.5-2 1.9-3 3.8-3s3.3 1 3.8 3" />
        </svg>
      }
      name="Subject detection"
      desc={tr("See which side of the frame a person is on, and cards automatically avoid their face.")}
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title={tr("Light tier about 30 MB")}>
              {error ? tr("Retry") : tr("Install")}
            </button>
          : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">{tr("Installing…{0}", tail ? ` ${tail}` : "")}</span>
        </div>
      )}
      {needsPack && !error && (
        <div className="sp-ext-error">
          {tr("Dependencies are installed, but the model file is still missing. It ships with the extension pack, so run PromptCut-ext-light-&lt;version&gt;.exe")}
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}
