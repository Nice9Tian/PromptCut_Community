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
import { LanguageMenu } from "../ui/LanguageMenu";
import { tr } from "../i18n/index.ts";
import { SkillDialog } from "./SkillDialog";
import { isViewOnly, viewOnlyReason, viewOnlyText } from "./io/viewOnly";
import { useReadOnly } from "./readOnly";
import { ReadOnlyMarker } from "./ReadOnlyFence";
import { SyncChips } from "./sync/SyncChips";
import { BackupsDialog } from "./sync/BackupsDialog";
import { hasSharedResume, useSync, whenSaved } from "./sync/syncManager";
import { unsentAtRisk, UNSENT_LEAVE_TEXT } from "./sync/onlineStatus";
import { onlineUnsupported } from "../online/onlineUnsupported";
import "../ui/toolbar.css";

/** Project menu items greyed out in online browser mode: all need the editor process (draft, save as, local backup), which C10a does not provide (contract section 2) */
const ONLINE_OFF = (entry: string): string => onlineUnsupported(entry);

/**
 * Compile-time constant of the online build (see "online build pruning" in `src/online/pageFlag.ts`
 * for how to write it and why), same value as `ONLINE` in `mode.ts`.
 * The functions behind the items greyed out on the online page (New, Open, Save, Save as package,
 * SKILL) are replaced with empty functions in the online build, and are pruned together with the
 * /api calls behind the draft, package and Skill dialogs (M8 leftover L24).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * Description text for "Shortcuts" and "About PromptCut". In the desktop app they are opened from the
 * title bar menu "Help" (`WindowTitleBar.tsx`, handed to `onCommand` below via `pc-titlebar-command`);
 * the online build does not draw a title bar (user decision, 2026-10-22), so these two items live in
 * the "⋯" menu instead, and clicking them shows the same description.
 */
const SHORTCUTS_TEXT = tr("Space Play/pause\nCtrl/Cmd + Z Undo\nCtrl/Cmd + Shift + Z Redo\nCtrl/Cmd + Y Redo\nDelete Delete selected clips");
const ABOUT_TEXT = tr("PromptCut\nAI video editor");

/** Placeholder for the items in the "⋯" menu that have no icon: icons are 18px by default, take up the same width so the text lines up with the "Skin…" row */
const MoreMenuNoIcon = () => <span aria-hidden="true" style={{ flex: "0 0 18px", width: 18 }} />;

/** Top bar width tiers: wide (all expanded), medium (icons collapsed), narrow (more menu folded) */
type BarTier = "wide" | "icon" | "narrow";

const THRESHOLD_ICON = 880;
const THRESHOLD_WIDE = 1180;
const HYSTERESIS = 40;

/** Tier conversion with hysteresis, to avoid flickering back and forth at the threshold width */
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
 * Top bar button: label is always rendered as span.pc-btn-label, and CSS smoothly collapses and
 * expands it.
 * title always equals label, so the hint is still visible on mouse hover after collapsing to the
 * square icon state.
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
  /** Overrides the hover hint. When disabled, use it to explain why it cannot be clicked */
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
 * Top bar: downgrades dynamically through three tiers by bar width, containing editing actions,
 * appearance and layout, and file export.
 */
/**
 * Local writes to wait for before saving (`io/localWrites.ts`): media this device is importing, and
 * tools the Agent is running.
 * Pending operations (confirmed by the document service) and background writes are awaited
 * separately in `waitForLocalWrites`.
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
  // "Open on phone" (`workflow/editing.md`, "the second screen on the LAN"): only the desktop side gets this entry
  const [lanOpen, setLanOpen] = useState(false);
  /**
   * "Local backup…". The two C6.5 items "New shared project" and "Open shared project" are removed
   * (C10a contract section 6, "old entries"): to work with others, tick "Multi-user collaboration" in
   * the project settings; to join someone else's project, use the start page.
   */
  const [backupsOpen, setBackupsOpen] = useState(false);
  // Clicking an entity such as "Project settings" in the undo toast dispatches this event: open the project settings dialog
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener("pc-open-project-settings", open);
    return () => window.removeEventListener("pc-open-project-settings", open);
  }, []);
  /**
   * Disabled state of the undo / redo buttons: greyed out when the stack is empty. Most undo stack
   * changes come with a project change (the store notifies);
   * when nothing could be undone, the project stays the same and only a toast appears, so this also
   * subscribes to the toast in the sync state.
   */
  const canUndo = useStore(() => actions.canUndo());
  const canRedo = useStore(() => actions.canRedo());
  useSync((v) => v.notice);
  const [moreBtnRect, setMoreBtnRect] = useState<DOMRect | null>(null);

  /**
   * "Project" dropdown: New / Open / Save / Project settings are gathered in one button, and the
   * submenu only appears when opened.
   * All four actions are "clicked once in a while"; laid flat on the bar they would take four slots
   * and crowd out frequently used ones like export.
   * The menu is mounted on body (portal) and, like "⋯", closes on click outside / Esc.
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
  // Read-only has two sources: ?observe in the address (fixed as soon as the page opens), and this project granting only read-only permission (changes on entering / leaving a project, needs a re-render); subscribe to the sync state for both
  const viewOnly = useSync(() => isViewOnly());
  const reason = useSync(() => viewOnlyReason());
  // Read-only permission (a guest in someone else's project): controls that modify the project are greyed out, and the hover hint uses viewOnlyText(). The ?observe path is not handled here, it stays as before
  const ro = useReadOnly();

  const name = useStore((s) => s.project.name);
  // Do not subscribe to the whole project: the top bar needs the project only at export, so fetch it on the spot with getState(); if subscribed, every clip move re-renders the whole top bar (tiers-probe T4)
  // Online pages are all cloud projects (changes sync to the cloud in real time, "Save project" is greyed out), and read-only mode cannot save either: neither shows the unsaved "*" and blue dot, and going back to the home page / switching to Vibe mode does not show the unsaved confirmation
  const dirty = useStore((s) => !ONLINE_BUILD && s.dirty) && !viewOnly;
  /**
   * The kind of case where the online page must ask before leaving the editor: offline (or an offline
   * batch waiting for the user's decision), holding changes not yet committed,
   * and the changes exist only in this page: a guest's project is not persisted (in `syncManager.ts`
   * the browser local cache is written only for account projects),
   * or the browser local cache write failed this time (quota, private mode). It is the same check
   * that `SyncOverlays.tsx` uses to hook the browser leave confirmation.
   */
  const unsentRisk = useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore));
  const projectInput = useRef<HTMLInputElement>(null);

  /** Rename the top bar project name in place: click the label and it becomes an input */
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  /**
   * Use a ref rather than the renaming state as the gate: when Esc closes the editing state, the
   * input being unmounted
   * still fires one more blur, and that blur handler captured the renaming from the previous render
   * (still true) -- looking only at state, the cancel would be committed again by the blur.
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
   * Finish renaming. Enter and blur both go through here, and the gate makes sure it takes effect
   * only once.
   * An empty name falls back to "Untitled", consistent with the rule in the project settings dialog.
   */
  const commitRename = () => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    setRenaming(false);
    const next = draftName.trim() || tr("Untitled");
    if (next !== name) actions.setProjectMeta({ name: next });
  };

  // On entering the editing state, put the cursor in and select all, so the user does not have to click again and delete
  useEffect(() => {
    if (!renaming) return;
    const el = renameInputRef.current;
    el?.focus();
    el?.select();
  }, [renaming]);

  /**
   * Finish when clicking elsewhere.
   *
   * onBlur alone is not enough: the preview and timeline call preventDefault in mousedown (to block
   * text selection),
   * which also blocks the focus transfer, so the input stays open. So, following the "⋯" menu's
   * approach, additionally listen to mousedown on window, and commit when the click is outside the
   * input. Both paths go into commitRename,
   * and renamingRef makes sure it takes effect only once.
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
   * Clicking "Appearance → Skin…" in the desktop app's native menu bar dispatches pc-open-skin; catch it
   * here and open
   * the same dialog: both entries share one UI, no second copy.
   *
   * It goes through window.__TAURI__ (withGlobalTauri is enabled in tauri.conf.json), so the frontend
   * does not need to install an extra @tauri-apps/api for this one listener; there is no such global
   * in a browser, so the whole block is naturally skipped.
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
        // The component may unmount before listen lands, in which case unsubscribe immediately
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ResizeObserver watches the top bar root element's own clientWidth and converts to a tier with hysteresis
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

  // The more menu closes on click outside or Escape
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

  // While the menu is open, listen to window resize and scroll (capture phase), and close the menu as soon as either fires to prevent drift
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

  // There used to be a rule here, "close the menu when the tier switches back to wide/icon": that was
  // because "⋯" existed only in the narrow tier back then,
  // and after widening the button was gone and the menu would be left alone on the screen. Now "⋯" is
  // present at any width, and this rule would
  // close the menu immediately on opening in the wide tier, so it was removed. Menu drift is handled
  // by the resize listener below.

  const run = (fn: () => Promise<unknown>) => () => fn().catch((e) => alert(String(e?.message ?? e)));

  const [exportState, setExportState] = useState<ExportState | null>(null);
  /** ID of the running export task, needed for cancelling */
  const exportIdRef = useRef<string | null>(null);

  /**
   * Save: pop up "Save as" for the user to pick a location, and update the local draft at the same
   * time. The flow is in `io/saveFlow.ts`.
   *
   * The order matters -- showSaveFilePicker needs a user gesture, so it must be the first
   * await here; if the draft is saved first and the dialog shown after, the gesture expires and the
   * browser throws SecurityError right away.
   * If the user cancels, the whole thing does not count as saved: the draft is not written and the
   * dirty flag is not cleared, consistent with "I did not save".
   */
  /** Tell the user the save result (the card at the top, `SaveStatusLayer`): a failed save is an error, a successful save with something to say is info */
  const notifySave = (message: string, tone: "error" | "info" = "error") => {
    showSaveNotice({ tone, title: tone === "error" ? tr("Not saved this time") : tr("Saved"), message });
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
   * Save as package: .procp = arrangement + the media the project uses (A1). The flow is in
   * `io/saveFlow.ts`.
   *
   * Same rule as saving a project -- pickSaveTarget needs a user gesture, so it must be the first
   * await, and packing (fetching media by hash from the local content store) can only come after the
   * destination is picked. Media in the package is deduplicated by content hash,
   * so even if several clips reference the same media, there is only one copy of the bytes.
   */
  const savePackedProject = ONLINE_BUILD ? async () => {} : async () => {
    await savePackedFile(`${name}${PROCP_EXT}`, {
      pick: (fileName) => pickSaveTarget(fileName, tr("PromptCut packaged project"), { "application/zip": [PROCP_EXT] }),
      settle: (ms) => whenSaved(ms),
      probes: LOCAL_WRITE_PROBES,
      pack: () => packProcp(),
      download: (blob, fileName) => {
        // This WebView has no file system access API, fall back to a browser download
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
   * Export video.
   *
   * Same approach as saving a project: showSaveFilePicker needs a user gesture, so first pop up "Save as"
   * to get the
   * destination, then start rendering -- rendering takes tens of seconds, and by then the gesture has
   * long expired. If the user cancels picking a location, nothing is exported.
   *
   * Even if no location can be picked (the WebView lacks this API), export still works:
   * the file stays in the server's output directory, and at the end an "Open output directory" is
   * offered.
   *
   * The online browser first picks the export method (`docs/semantics/workflow/project.md`, "Export video": "Quick export" or "Full export"):
   * when entered without `mode`, it only switches the dialog to the selection step, and after the
   * choice it enters again with `mode` -- that click is the user gesture "Save as" needs. The desktop
   * app has no such step.
   */
  const exportProject = async (mode?: ExportMode) => {
    const project = getState().project;
    // C6.6: judge once first from the polled set (no request sent, so the user gesture needed by "Save as" below is not wasted);
    // if the original media size has not finished uploading, do not pop up Save as, and tell the user to wait for the uploader instead. exportVideo asks the asset service once more
    const pending = exportGateNow(project);
    if (pending && pending.length) {
      setExportState({ phase: "error", done: 0, total: 1, target: "", message: awaitingUploaderMessage(pending) });
      return;
    }
    if (ONLINE_BUILD && !mode) {
      setExportState({ phase: "asking", done: 0, total: 1, target: "" });
      return;
    }
    // Collapse the selection dialog while the save location is being picked (if the user cancels picking, nothing is exported)
    if (ONLINE_BUILD) setExportState(null);
    const suggested = `${name}.mp4`;
    let target: FileSystemFileHandle | null = null;
    try {
      target = await pickSaveTarget(suggested, tr("MP4 video"), { "video/mp4": [".mp4"] });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // The user cancelled, not an error
      throw e;
    }

    setExportState({
      phase: "running",
      done: 0,
      // Seed a visible total immediately; the server also seeds this before
      // spawning Chrome, so the dialog never presents a misleading 0/0.
      total: Math.max(1, Math.floor(project.duration * (project.fps || 30))),
      target: target ? target.name : tr("Output folder (this machine does not support choosing a location)"),
      startedAt: Date.now(),
      ...(mode ? { mode } : {}),
    });

    try {
      const { outDir, id, written, skippedMedia } = await exportVideo({
        // Online browser mode (c10a section 11.1) writes to this destination while editing, and returns written: true; the desktop path ignores it
        target,
        // Online browser: the chosen export method; what is still being waited on before export (original media size, render node) is shown in the progress window. The desktop path ignores these two
        ...(mode ? { mode, onWaiting: (message: string | null) => setExportState((st) => (st ? { ...st, waiting: message ?? undefined } : st)) } : {}),
        onStart: (jobId) => {
          exportIdRef.current = jobId;
          setExportState((st) => (st ? { ...st, id: jobId } : st));
        },
        onProgress: (done, total, stage) =>
          setExportState((s) => (s && s.phase === "running" ? { ...s, done, total, stage } : s)),
      });

      // Only after rendering finishes is the output moved to the location the user picked; if none was picked it stays in the output directory.
      // What has already been written to the destination while editing (online export, written) is not moved again: another createWritable would replace the written file with an empty one
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
      // Clips skipped because of missing media: listed in the completion dialog (not silent)
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

  /** New project: clear the current arrangement and detach the draft binding (saving will start a new one) */
  const createProject = ONLINE_BUILD ? () => {} : () => {
    if (dirty && !confirm(tr("The current project has unsaved changes, and creating a new one will discard them. Continue?"))) return;
    newProject();
    setActiveDraftId(null);
  };

  /**
   * Top bar "Open project…". .proc has a {format, project, ai} shell around it, and importProjectFile
   * only recognizes a bare Project and a {cards} arrangement, so opening a .proc with it would
   * report "unrecognized" right away -- so .proc goes through
   * loadProc (which restores the script and chat together), and only the other old JSON goes to
   * importProjectFile.
   */
  const openProjectFile = ONLINE_BUILD ? async (_file: File) => {} : async (file: File) => {
    if (dirty && !confirm(tr("The current project has unsaved changes, and opening another project will discard them. Continue?"))) return;
    // .procp is a zip package of "arrangement + media" (A1): first split the media by hash into the local content store,
    // then take the project.proc inside and send it down exactly the same path as .proc. Must not call
    // file.text() first -- that would read a zip of possibly several GB into the page whole.
    if (await isProcpFile(file)) {
      actions.loadProject(await loadProcpFile(file), file.name.replace(/\.procp$/i, PROC_EXT));
      setActiveDraftId(null);
      forgetSaveTarget();
      return;
    }
    const text = await file.text();
    let isProc = false;
    try { isProc = JSON.parse(text)?.format === PROC_FORMAT; } catch { /* Leave it to the error reporting below */ }
    if (isProc) actions.loadProject(loadProc(text), file.name);
    else await importProjectFile(file);
    // A file opened from disk belongs to no draft; ask for the destination again when saving, so as not to overwrite the previous project's file
    setActiveDraftId(null);
    forgetSaveTarget();
  };

  /**
   * The prompt when the online page leaves the editor: it does not ask "the project is unsaved" (cloud projects have no such thing, issue #16),
   * it asks "changes accumulated while offline exist only in this page and will be lost on leaving". If allowed, just leave.
   */
  const okToLeaveOnline = () => !ONLINE_BUILD || !unsentRisk || confirm(UNSENT_LEAVE_TEXT);

  /** Back to the start page. The Shell listens to this event */
  const goHome = () => {
    if (!okToLeaveOnline()) return;
    if (dirty && !confirm(tr("The current project has unsaved changes, and going back to the home page will discard them. Continue?"))) return;
    window.dispatchEvent(new Event("pc-go-home"));
  };

  /**
   * Go to the Vibe mode screen (the first slot of the top bar's working mode switch).
   *
   * It takes the same path as "back to the start page": leave the editor and land on the start page,
   * which decides which screen to show from `?ui=` in the address
   * (`wantsVibe` / `wantsClassic` in `StartPage.tsx`). So write `?ui=vibe` into the address first and
   * then dispatch the event:
   *   - Online browser: the default is Vibe mode anyway, and this step also covers the `?ui=classic`
   *     troubleshooting backdoor,
   *     otherwise going back with it would land on the old account form page;
   *   - Desktop app: the default is the Classic start page, and without this parameter going back
   *     would land on that page and never reach Vibe mode.
   *
   * With unsaved changes, this button is handled differently from "back to home": the desktop app
   * **saves the local draft first and then leaves**, not just a warning.
   * In the Vibe mode screen the Agent does the work, and the user has no "Save project" button at
   * hand (that screen saves on a timer by itself,
   * see `AUTOSAVE_MS` in `src/start/DesktopStart.tsx`), so what was just made must not be left in
   * memory before switching over.
   * What is saved is only the local draft, not the `.proc` the user saved as, so **the dirty flag is
   * not cleared**: the "*" on the top bar keeps reminding that the file has not been written.
   * Online pages are all cloud projects, with changes synced straight to the cloud, no "Save project"
   * and no local draft, and no unsaved confirmation;
   * only changes accumulated offline that exist only in this page (guest projects, local cache write
   * failed) get one question, see `okToLeaveOnline` for the criterion.
   */
  const goVibe = () => {
    const go = () => {
      try {
        const url = new URL(location.href);
        url.searchParams.set("ui", "vibe");
        history.replaceState(history.state, "", url);
      } catch {
        // If the address cannot be changed (rare), do not block leaving either, at worst it lands on the default screen
      }
      window.dispatchEvent(new Event("pc-go-home"));
    };
    if (ONLINE_BUILD) { if (okToLeaveOnline()) go(); return; }
    if (!dirty) { go(); return; }
    void saveDraft(ensureActiveDraftId()).then(go, (e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      if (confirm(tr("Could not save the changes to the local project ({0}). Switching to Vibe mode will discard them. Continue?", why))) go();
    });
  };

  /** Switching language reloads the page: save to the local draft and come back to it in the editor */
  const prepareLanguageSwitch = async (url: URL): Promise<boolean> => {
    if (ONLINE_BUILD) return okToLeaveOnline();
    if (hasSharedResume()) return true; // a shared project reopens by itself after a reload
    const id = ensureActiveDraftId();
    try {
      await saveDraft(id);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return confirm(tr("Your changes could not be saved to the local project ({0}). Switching language will lose them. Continue?", why));
    }
    url.searchParams.set("draft", id);
    return true;
  };

  // The title bar menu and the top bar buttons share the same set of actions, to avoid maintaining two copies of file/export logic.
  // WindowTitleBar only presents the menu, and hands the selection back to the editor through this event.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      switch (command) {
        // Online page: these items are all greyed out in the menu (C10 contract section 10), and same-named commands sent from the title bar menu are likewise ignored
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
    // unsentRisk is in there too ("Back to home" has to ask based on it); if it is not listed,
    // this handler holds on to a stale copy
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
          placeholder={tr("Untitled")}
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
          title={ro.title(tr("Click to rename project"))}
          aria-disabled={ro.locked || undefined}
          onClick={startRename}
        >
          {name}
          {dirty && <span className="pc-dirty"> *</span>}
        </button>
      )}
      <span className="pc-bar-sep" />

      {/* A · Editor controls: undo and redo are always icon-only */}
      <div className="pc-bar-group">
        {/* A disabled button gets no hover, so the tooltip hangs on the wrapper outside it
   (draft: hover tooltip includes the not-clickable case) */}
        <span title={ro.title(tr("Undo (Ctrl+Z): only undoes your own actions on this page"))} data-pc="undo-btn">
          <Btn onClick={() => actions.undo()} label={tr("Revoke")} title={ro.title(tr("Undo (Ctrl+Z): only undoes your own actions on this page"))} icon={<IconUndo />} collapsed disabled={!canUndo || ro.locked} />
        </span>
        <span title={ro.title(tr("Redo (Ctrl+Shift+Z / Ctrl+Y): restores the action you just undid (no longer available after a new action)"))} data-pc="redo-btn">
          <Btn onClick={() => actions.redo()} label={tr("Redo")} title={ro.title(tr("Redo (Ctrl+Shift+Z / Ctrl+Y): restores the action you just undid (no longer available after a new action)"))} icon={<IconRedo />} collapsed disabled={!canRedo || ro.locked} />
        </span>
      </div>
      <span className="pc-bar-sep" />

      {/*
        A' · AI's browser tab (only appears in the desktop shell). When the agent hits login / CAPTCHA,
        it does not pop up a dialog; this tab flashes and shows a bubble, and only switches to the
        browser panel when the user clicks over. Present at any width: it is the touchpoint between the
        agent and humans; if collapsed into "...", no one would see it flash.
      */}
      <AgentBrowserTab />

      {/*
        B · Mode and project settings.

        "Classic mode / SKILL" is a unified two-option control (ModeSwitch), not a dropdown: the two
        working modes are mutually exclusive, and whichever slot the slider is in is active; a collapsed
        dropdown only shows the current value.

        Skin still lives only inside "...".
      */}
      {tier !== "narrow" && (
        <div className="pc-bar-group">
          <ModeSwitch onOpenSkill={() => setSkillOpen(true)} onEnterVibe={goVibe} />
        </div>
      )}
      {/* "⋯" is shown at any width: skins live only inside it, so collapsing it would remove the entry point */}
      <div className="pc-bar-group">
        <button
          ref={moreBtnRef}
          type="button"
          className="pc-btn pc-btn--icon"
          title={tr("More settings")}
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={toggleMoreMenu}
        >
          <IconMore />
        </button>
      </div>

      {/* ⋯ popup floating menu */}
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="pc-more-menu"
          style={{
            top: (moreBtnRect?.bottom ?? 36) + 4,
            // The menu is anchored to the right end of the button and expands leftward, so it does not
            // overflow the screen in narrow windows
            left: Math.max(8, Math.min((moreBtnRect?.right ?? 0) - 200, window.innerWidth - 208)),
          }}
        >
          <button
            type="button"
            className="pc-btn"
            style={{ width: "100%", justifyContent: "flex-start" }}
            title={tr("Skin")}
            onClick={() => {
              setMenuOpen(false);
              setSkinOpen(true);
            }}
          >
            <IconPalette />
            <span className="pc-btn-label">{tr("Skin…")}</span>
          </button>
          <LanguageMenu className="pc-btn" prepare={prepareLanguageSwitch} />
          {/* The online build has no title bar menu (user decision, 2026-10-22), so these two items from its
   "Help" move here; the desktop app keeps them in the title bar menu, so they are not repeated here */}
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
                <span className="pc-btn-label">{tr("Shortcuts")}</span>
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
                <span className="pc-btn-label">{tr("About PromptCut")}</span>
              </button>
            </>
          )}
          {/* Open on phone (`workflow/editing.md` "Second screen on LAN"): phones on the same LAN scan the QR
              code to enter the same local project. Online pages do not have this item: projects there are in the
              cloud, so phones can simply open the direct project URL. */}
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
              <span className="pc-btn-label">{tr("Open on your phone")}</span>
            </button>
          )}
          {/* The mode switch is only folded in at the narrow tier; at the wide tier it stays on the bar;
   project settings already live in the "Project" menu */}
          {tier === "narrow" && (
            <div className="pc-more-menu-row">
              <ModeSwitch onOpenSkill={() => { setMenuOpen(false); setSkillOpen(true); }} onEnterVibe={() => { setMenuOpen(false); goVibe(); }} />
            </div>
          )}
        </div>,
        document.body,
      )}

      {/* "Project" dropdown menu: anchored below the button, goes through a portal like ⋯ */}
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
          <button type="button" role="menuitem" className="pc-proj-item" disabled={ONLINE_BUILD} title={ONLINE_BUILD ? ONLINE_OFF(tr("New project")) : undefined} onClick={() => { setProjOpen(false); createProject(); }}>
            <IconNew />
            <span className="pc-proj-text"><b>{tr("New project")}</b><small>{tr("Start an empty project")}</small></span>
          </button>
          <button type="button" role="menuitem" className="pc-proj-item" disabled={ONLINE_BUILD} title={ONLINE_BUILD ? ONLINE_OFF(tr("Open project")) : undefined} onClick={() => { setProjOpen(false); projectInput.current?.click(); }}>
            <IconOpen />
            <span className="pc-proj-text"><b>{tr("Open project…")}</b><small>{tr("{0} project file", PROC_EXT)}</small></span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pc-proj-item"
            disabled={viewOnly || ONLINE_BUILD}
            title={ONLINE_BUILD ? ONLINE_OFF(tr("Save project")) : viewOnly ? viewOnlyText() : undefined}
            onClick={() => { setProjOpen(false); void saveProject(); }}
          >
            <IconSave />
            <span className="pc-proj-text"><b>{tr("Save project")}</b><small>{dirty ? tr("Has unsaved changes") : tr("Up to date")}</small></span>
            {dirty && <span className="pc-proj-dirty" />}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pc-proj-item"
            data-pc="menu-pack"
            disabled={viewOnly || ONLINE_BUILD}
            title={ONLINE_BUILD ? ONLINE_OFF(tr("Save as package")) : viewOnly ? viewOnlyText() : tr("Bundle the arrangement and media into one package, then open it directly on another machine")}
            onClick={() => { setProjOpen(false); void savePackedProject(); }}
          >
            <IconSave />
            <span className="pc-proj-text"><b>{tr("Save as package…")}</b><small>{tr("{0} with media included", PROCP_EXT)}</small></span>
          </button>
          <div className="pc-proj-sep" role="separator" />
          <button type="button" role="menuitem" className="pc-proj-item" data-pc="menu-backups" onClick={() => { setProjOpen(false); setBackupsOpen(true); }}>
            <IconSave />
            <span className="pc-proj-text"><b>{tr("Local backup…")}</b><small>{ONLINE_BUILD ? tr("Changes that were overwritten or discarded offline (kept only on this page)") : tr("Changes that were overwritten or discarded offline")}</small></span>
          </button>
          <div className="pc-proj-sep" role="separator" />
          <button type="button" role="menuitem" className="pc-proj-item" onClick={() => { setProjOpen(false); setSettingsOpen(true); }}>
            <IconSettings />
            <span className="pc-proj-text"><b>{tr("Project settings…")}</b><small>{tr("Size, frame rate, multi-user collaboration")}</small></span>
          </button>
        </div>,
        document.body,
      )}

      <span className="ml-auto" />

      {/* C6.5: member button for sync paused / offline / shared project */}
      <div className="pc-bar-group">
        <SyncChips />
      </div>

      {/* Prominent banner shown while the desktop app is downloading on the user's behalf */}
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
          title={tr("Cloud Agent is downloading with the login on this computer: {0}", collectUrl)}
        >
          {tr("Cloud Agent is downloading with the login on this computer: {0}", collectUrl)}
        </div>
      )}

      {/* Read-only (?observe=1, or this project was only granted read-only access): tell people this copy
   is for viewing, not editing, so they do not click in vain and only then find out */}
      {viewOnly && (
        <span
          className="pc-viewonly-badge"
          data-pc="viewonly-badge"
          data-pc-reason={reason ?? undefined}
          title={reason === "read-only-member" ? viewOnlyText() : tr("This page was opened in read-only mode (?observe=1): you can view but not edit.")}
        >
          {reason === "read-only-member" ? tr("View only") : tr("Read-only view")}
        </span>
      )}

      {/* C · File operations bar: Open/Save participate in mid-tier collapse; Export is the primary
          button and never collapses. Import video has moved to the + button under "Media → Video" on the left
          rail; the top bar no longer duplicates it. */}
      <div className="pc-bar-group">
        <Btn onClick={goHome} label={tr("Home")} icon={<IconHome />} collapsed={tier !== "wide"} />
        {/* New / Open / Save / Project settings are gathered in this one button, and the submenu only
   appears when it is opened (see toggleProjMenu) */}
        <button
          ref={projBtnRef}
          type="button"
          className={`pc-btn pc-proj-btn${projOpen ? " is-open" : ""}`}
          title={tr("Project: new, open, save, settings")}
          aria-haspopup="menu"
          aria-expanded={projOpen}
          onClick={toggleProjMenu}
        >
          <IconOpen />
          <span className="pc-btn-label">{tr("Project")}</span>
          <svg className="pc-proj-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {dirty && <span className="pc-proj-dirty" title={tr("Has unsaved changes")} />}
        </button>
        {/* Voiceover settings: opens a child window, the same one as "Settings" on the start page's
   voiceover card */}
        <Btn onClick={openVoiceSettings} label={tr("Voiceover settings")} icon={<IconVoice />} collapsed={tier !== "wide"} disabled={ONLINE_BUILD} title={ONLINE_BUILD ? ONLINE_OFF(tr("Voiceover")) : undefined} />
        <Btn
          onClick={run(() => exportProject())}
          label={tr("Export video")}
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

      {/* Project settings dialog */}
      <SkinDialog open={skinOpen} onClose={() => setSkinOpen(false)} />
      {/* On the online page SKILL is grayed out (ModeSwitch), so the dialog cannot be opened */}
      {ONLINE_BUILD ? null : <SkillDialog open={skillOpen} onClose={() => setSkillOpen(false)} />}
      {/* Like the menu item at line 754, this needs !ONLINE_BUILD: if it is missed, LanOpenDialog goes
   into the online output together with its /api/lan-open */}
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
          // First switch the UI to the look of "cancelling"; killing the process on the server takes a
          // while; the real cancelled state is written by the path that comes back via SSE
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
