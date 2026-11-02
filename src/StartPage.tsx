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

/** Write a byte count in a human-readable form. Export outputs and the prerender cache easily reach tens of GB, so it stops at G */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** Seconds → mm:ss */
function humanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Today's items show only the time; the rest show the date */
function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : tr("{0}/{1}", d.getMonth() + 1, d.getDate());
}

/** In addition to humanDate, include hours and minutes: when something is exported several times on the same day, the date alone cannot tell them apart */
function humanDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = humanDate(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return date === hm ? date : `${date} ${hm}`;
}

/**
 * The start page. This is the first thing you see on entering the software, and the editor is entered
 * only after you choose something.
 *
 * Five blocks: start creating, join someone else's project, extension features, local drafts, storage.
 * There is no left sidebar and no row of round entry points.
 * "Storage" (`workflow/project.md` "Start") shows the space used by the prerender cache and export
 * outputs, changes the cache limit, clears the cache, and manages export outputs one by one;
 * the title bar menu item "Storage…" goes straight here (`open-storage` in `WindowTitleBar.tsx`).
 *
 * Online browser mode (C10a contract section 2 "First screen"): only "Join someone else's project": in
 * the online page, creating projects, local drafts and extension features all need the editor process
 * (`/api/*`), which C10a does not provide (creation and drafts come with the rest of C10). In the online
 * build only `OnlineStartPage` remains, and the desktop page, together with the calls behind drafts and
 * extension features, is cut away (M8 leftover L24; for the technique see "Online build pruning" in
 * `src/online/pageFlag.ts`).
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

/** Explicitly request the old account form in the address (`?ui=classic`): kept only for troubleshooting and for probes that still recognize the old page; there is no entry in the UI */
function wantsClassic(): boolean {
  try {
    return new URLSearchParams(location.search).get("ui") === "classic";
  } catch {
    return false;
  }
}

/**
 * The desktop app explicitly asks for the Vibe-mode screen (`?ui=vibe`). The desktop app's default is still
 * this page (the Classic start page): changing the desktop app's default UI is a level-1 change and is
 * not decided by a session; online, the default is Vibe mode and this parameter is not consulted.
 *
 * It is carried in the address so that **it stays in place after a refresh**: pressing F5 in Vibe mode, or
 * returning home from the editor, should land on the screen you were just on.
 * The "Vibe mode" switch in the editor's top bar (`src/editor/ModeSwitch.tsx`) also changes this parameter
 * and then dispatches `pc-go-home`.
 */
function wantsVibe(): boolean {
  try {
    return new URLSearchParams(location.search).get("ui") === "vibe";
  } catch {
    return false;
  }
}

/**
 * Write `?ui=` as some value (null removes it). If the address cannot be changed (rare), this switch is
 * not affected, and only after a refresh does it return to the default screen.
 *
 * The editor side (`goVibe` in `src/editor/TopBar.tsx`) writes the same parameter, but it writes it
 * itself and does not import from here: this file imports `src/editor/`, and importing the other way
 * round would create a cycle.
 */
function setUiParam(value: string | null): void {
  try {
    const url = new URL(location.href);
    if (value === null) url.searchParams.delete("ui");
    else url.searchParams.set("ui", value);
    history.replaceState(history.state, "", url);
  } catch { /* Do not block the switch when the address bar cannot be changed */ }
}

/**
 * The first screen of the online browser (computer identity): **the default is Vibe mode**
 * (`user-workflow.md` "Working mode": the default UI after logging in on the online browser). The whole
 * set lives in `src/start/` and is wired to real accounts, real cloud projects and real Cloud Agents (the
 * header of `src/start/OnlineStart.tsx` records, block by block, what it is wired to).
 *
 * There used to be a gate here ([ruling V21-12]: while the new UI ran only as UI with fake data, it was
 * entered only with `?ui=vibe`, and the default was still the old account form). During the user's
 * acceptance check on 2026-10-23 they pointed out that this was a wrong call: what was wanted was to wire
 * the new UI to the business layer and make it the default. The gate has been removed (rework branch
 * `claude/vibe-wire`).
 * `?ui=vibe` / `?ui=home` / `?ui=login` no longer mean anything special (they all enter the default page,
 * and `?ui=home` no longer skips login).
 * The old account form (`AccountProjects`) can only still be opened under `?ui=classic`, and there is no
 * entry in the UI.
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
 * The desktop app's first screen: a choice between the Classic start page (the large block below) and the
 * **Vibe mode** screen (`src/start/DesktopStart.tsx`).
 *
 * The default is the Classic start page; clicking the "Vibe mode" button at its top, or the first segment
 * of the working-mode switch in the editor's top bar, enters Vibe mode, recorded in the address as
 * `?ui=vibe` (so it is still Vibe mode after a refresh). The "Extensions and storage" button on the right
 * of the Vibe-mode top bar returns to this page: opening a project file, joining someone else's project,
 * extension features and storage exist only on this page.
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
    // The new project has not been written to disk yet; after entering the editor, "Save project" writes it as a draft
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
      // A .procp (a zip package of arrangement + assets, A1) is first unpacked and stored in the library, then
      // loaded; do not call .text() on it, that would read the whole package, possibly several GB, into the page.
      const packed = await isProcpFile(file);
      const project = packed ? await loadProcpFile(file) : loadProc(await file.text());
      actions.loadProject(project, packed ? file.name.replace(/\.procp$/i, PROC_EXT) : file.name);
      // A project opened from a file does not belong to any draft; a new one is created when saving
      setActiveDraftId(null);
      onEnterEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("This file can't be opened"));
    }
  };

  return (
    <div className="sp">
      <header className="sp-bar">
        {/* The Logo already carries its wordmark, do not add it again */}
        <Logo size={22} />
        <span className="sp-bar-spacer" />
        {/* Vibe mode (`user-workflow.md` "Working mode", first row): without opening the editor, talk to the Agent and get the video made */}
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
 * ── Storage ───────────────────────────────────────────────
 * For the interface contract see section 4 of `docs/plan/storage-plan.md`: `/api/storage*` (frame store
 * usage, limit, clearing the cache; the editor process forwards to the prerender process) and
 * `/api/exports*` (export outputs, `server/vite-plugin-exports-list.ts`). When `/api/storage` cannot be
 * reached (for example that half is not installed yet, or the prerender process did not start) this
 * block still shows the export outputs as usual, and the cache row says "Temporarily unavailable", with
 * no error.
 * Only in the desktop start page; the online build cuts these calls away together with it (`StartPage`
 * is `OnlineStartPage` in the online build).
 */

/*
 * Sizes in this block are converted by 1024, the same as in the draft list (`humanSize`), with GB = 1024³
 * bytes: consistent with the "GB" shown by Windows Explorer; the server's cache limit, the default of
 * 50 GB and the lower bound of 5 GB also use this GB (`GB` in `server/frame-library-storage.mjs`).
 * Entering 20 sends 20 × 1024³.
 */
const GB = 1024 ** 3;
const storageSize = humanSize;
/** Lower bound of the cache limit (`mechanism/platforms.md` "Frame store": the user can change it between 5 GB and the total disk capacity) */
const CAP_MIN_BYTES = 5 * GB;
/** How long to wait before fetching again, and at most how many more times, when the server returns `scanning: true` */
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
    /** The server is rescanning or measuring (the numbers will still change) */
    scanning?: boolean;
    /** `reason`: `cap` means it was cleared automatically for exceeding the limit, `clear` means the user cleared it by clicking "Clear cache" (`evictTo` in `frame-library-storage.mjs`) */
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
 * Read a JSON endpoint. When the endpoint does not exist the dev server may return the home page's HTML
 * (200) or a 404; both are treated as unavailable; `{ ok: false, error }` throws the error so the UI
 * can show it.
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
      // Change the input box only when the limit changed (an automatic re-fetch must not wipe out the number the user is typing)
      if (shownCap.current !== s.frameLibrary.capBytes) {
        shownCap.current = s.frameLibrary.capBytes;
        setCapGb(String(Math.round(s.frameLibrary.capBytes / GB)));
      }
    } catch {
      setStorage(null);
      setStorageState("unavailable");
    }
  }, []);

  // The server is measuring (`scanning: true`; `GET /api/storage` measures once in the background when
  // it finds the last check out of date): fetch again after a few seconds until the measurement is
  // done; at most STORAGE_RESCAN_TRIES re-fetches, no endless polling
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

  // Title bar "Storage…": when coming back from the editor the start page has just mounted, and when
  // clicked from the start page the event is received directly.
  // The blocks above (drafts, extensions) are read asynchronously and push this block down when they
  // finish, so within the first second or two scroll once more along with them
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
 * How an extension looks in the UI.
 *
 * `offerInstall` is split out instead of simply negating "installed or not": there are two not-installed
 * cases that should not get an install button: the status cannot be read at all, and there is not even
 * Python. Clicking in either case is bound to fail again, and showing a plain "Not installed" amounts
 * to tricking the user into hitting a wall.
 */
interface ExtStatusView {
  headline: string;
  /** The sentence that follows the headline: which tier is actually in use now, and what can still be done after the downgrade */
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

/** Translate the result of a settled query into UI state. The mapping itself may also throw (the backend omitted a field), so it is caught together */
function toView<T>(r: PromiseSettledResult<T>, map: (v: T) => ExtStatusView): ExtStatusView {
  if (r.status === "rejected") return failedView(r.reason);
  try { return map(r.value); } catch (e) { return failedView(e); }
}

function viewStt(s: SttStatus): ExtStatusView {
  // The status is in engines.<engine>.installed; the top level has no ready / installed / available fields;
  // it used to read the top level and always got undefined, so even after installation it kept showing
  // "Not installed".
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
    // ready:false does not mean unusable: this tier can run, and writing a bare "Not installed" would make
    // people think the feature is grayed out, so spell out both "what still works" and "when it will break".
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
    // light works, but it is a whole capability tier below full. Writing a bare "Installed" would make
    // people think text prompts work too, when every time it returns only people and faces.
    return {
      headline: tr("Installed"),
      note: tr("Light tier: recognizes faces and bodies, enough to avoid people; finding targets from text prompts requires installing the full tier extension pack"),
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.reason) {
    // An environment problem such as not even having Python: giving an install button would only make people hit the wall again
    return { headline: tr("Unavailable"), note: s.reason, tone: "danger", offerInstall: false };
  }
  return {
    headline: tr("Not installed"),
    note: tr("There is no fallback tier. Install AI to know which side of the frame a person is on and where to place cards without covering faces"),
    tone: "muted",
    offerInstall: true,
  };
}

/** The shell of an extension card. The four cards look the same, and differ only in the icon, the copy and the button on the right */
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

/** The extension features area: four cards for speech-to-text, shot detection, motion tracking and subject detection */
function ExtensionCards(): JSX.Element {
  const [stt, setStt] = useState<ExtStatusView | null>(null);
  const [shots, setShots] = useState<ExtStatusView | null>(null);
  const [track, setTrack] = useState<ExtStatusView | null>(null);
  const [subject, setSubject] = useState<ExtStatusView | null>(null);
  const [collect, setCollect] = useState<ExtStatusView | null>(null);
  /** The raw state of media collection: the login button looks at ready and at the login state of each site */
  const [collectRaw, setCollectRaw] = useState<CollectStatus | null>(null);

  const load = useCallback(async () => {
    // The five queries each make one HTTP request, and each has to wait for the Python side to answer. In
    // series the slowest would be last and the start page would just sit waiting, so they are sent together.
    // Use allSettled rather than all: one extension whose status cannot be fetched
    // must not nail the other cards to "Checking…" forever.
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

  // Refresh once after the login window closes: logging in / out both change the text on this card
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
    // Having no built-in Python or no ffmpeg is not something an online install can fix; giving a button would only make people hit the wall again
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
 * Voiceover: synthesized in the cloud, nothing to install, and the card only shows "whether the token is
 * configured, and which voice is used by default". There are many settings, so clicking "Settings" opens
 * a sub-window (the "Voiceover settings" in the editor's top bar opens the same one).
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

  // Refresh once after the settings window closes: the token and the default voice may both have changed
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

/** Media collection: the status is queried uniformly above, and installation goes through the SSE log stream of installCollect (pip installs yt-dlp) */
function CollectCard(props: { status: ExtStatusView | null; raw: CollectStatus | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, raw, onReload } = props;
  const [running, setRunning] = useState(false);
  // Login only matters once installed: the button text follows the saved login state, and an expired one also counts as "needs to log in again"
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

/** Speech-to-text: the status is queried uniformly above, and this card only handles in-place installation */
function SttCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [startError, setStartError] = useState<string | null>(null);
  const jobs = useInstallJobs();
  const job = jobs.at(-1);
  const running = !!job && job.phase !== "done" && job.phase !== "failed";

  // After installation the status is refreshed automatically, so the user does not have to click again
  useEffect(() => { if (job?.phase === "done") void onReload(); }, [job?.phase, onReload]);

  const install = () => {
    setStartError(null);
    // Take exactly the same path as the missing-dependency prompt in the editor: read the pip output as a
    // stream, parse the progress, and use mutual exclusion to prevent duplicates. This used to be
    // POST /api/stt/install with no body,
    // the server's JSON.parse("") threw straight away and returned 500, so the installation never started,
    // and this code looked at neither the status code nor that SSE stream, so the button flashed once and
    // went back to "Install".
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
        // The criterion is "is it running", not "is there a task": after one installation finishes, the store keeps
        // that completed record forever, and using it as the condition would make the card never show a button
        // again, a dead end.
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install}>{job?.phase === "failed" ? tr("Retry") : tr("Install")}</button>
          : null
      }
    >
      {/* The installation process must be visible: downloading hundreds of MB and running for minutes,
          having no progress feels like no response. Keep failures displayed as well, otherwise users only
          see the button change back to "Install", not knowing why installation failed. */}
      {(running || job?.phase === "failed") && (
        <div className="sp-ext-progress"><SttInstallProgress job={job!} compact /></div>
      )}
      {startError && <div className="sp-ext-error">{startError}</div>}
    </ExtCard>
  );
}

/** Shot detection: the status is queried uniformly above, and installation goes through the SSE log stream of installShots */
function ShotsCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The dependencies are installed and only the model files are missing: they have to come from the extension library package, which an online install cannot fix */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    // Keep only the last line, for the same reason as the motion tracking card
    void installShots((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // "Dependencies installed but the model is still missing" is not a failure: the model is weights that we
        // converted ourselves or downloaded from the official source, which are not in requirements and are only
        // distributed with the extension library package. Reporting it in red would make people think the
        // install was in vain, whereas what should really be said is "go run that .exe".
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

/** Motion tracking: the status is queried uniformly above, and installation goes through the SSE log stream of installTrack */
function TrackCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The dependencies are installed and only the model files are missing: they have to come from the extension library package, which an online install cannot fix */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    // 400 MB goes over the user's own network, so ask before starting: once clicked by mistake there is no backing out.
    if (!confirm(tr("The motion tracking extension needs to download torch and BootsTAPIR weights, about 400 MB, and takes several minutes. Install now?"))) return;
    setRunning(true);
    setError(null);
    setTail("");
    // Keep only the last line: pip prints hundreds of lines, and the start page has no place for an install
    // log panel, so one moving line is enough to show that it is "still running".
    void installTrack((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // "Dependencies installed but the model is still missing" is not a failure: the model is weights that we
        // converted ourselves or downloaded from the official source, which are not in requirements and are only
        // distributed with the extension library package. Reporting it in red would make people think the
        // install was in vain, whereas what should really be said is "go run that .exe".
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

/** Subject detection: the status is queried uniformly above, and installation goes through the SSE log stream of installSubject (only the light tier is installed) */
function SubjectCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The dependencies are installed and only the model files are missing: they have to come from the extension library package, which an online install cannot fix */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    // Keep only the last line, for the same reason as the other two cards: pip prints hundreds of lines, and there is no place for an install log panel here
    void installSubject((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // "Dependencies installed but the model is still missing" is not a failure: the weights of YuNet and
        // RT-DETR are not in requirements and are only distributed with the extension library package. Reporting
        // it in red would make people think the install was in vain, whereas what should really be said is "go
        // run that .exe".
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
        // A human figure plus a viewfinder frame: what this card does is exactly "frame the people in the picture"
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
