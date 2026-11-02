/**
 * Frame-by-frame export on the online page (`docs/plan/c10a-contract.md` Section 11.1): the core
 * implementation of the online branch of `exportVideo` in `src/editor/io/index.ts`.
 * The pipeline is in `browserExport.ts`; this connects to the editor side: project, asset service,
 * document service (`assetTiers.ts`), notifications (`pushToast`), drop target.
 * Loaded on demand by `io/index.ts` (this entire chain cannot be loaded in Node unit tests).
 */
import type { Project } from "../kernel/project";
import { actions, getState } from "../store/project";
import { assetAuthHeaders, docRequest, exportGate, hasDocLink, remoteAssetBase, remoteAssetTicketInfo } from "../editor/media/assetTiers";
import { currentDocProjectId, currentSharedLink, pageSession, subscribeQueueEvents } from "../editor/sync/syncManager";
import { CODE_VERSION } from "../online/boot";
import type { ExportMode } from "./cardLayers";
import { createTicketRenewer, type TicketRenewer } from "./ticketRenewal";
import { remoteMediaUrl, mediaTierPolicy } from "../render/mediaTier";
import { activeOnlineSource } from "../render/snapshotSource";
import { pushToast } from "../editor/sync/syncManager";
import { MemorySink, type MuxSink } from "./mp4Mux";
import { runBrowserExport } from "./browserExport";
import { cardRunState, getCard, isUserCardId } from "../kernel/registry";
import { ONLINE_EXPORT_TEXT } from "./text";
import { prepareExportSounds } from "../editor/io/exportSounds";

export interface OnlineExportOptions {
  /**
   * Drop target obtained from "Save as": if provided, writes positionally while encoding (streaming
   * writes via `showSaveFilePicker`), response includes `written: true`; caller must **not** call
   * `streamExportFile` again (which would replace the newly written file with an empty one).
   * If omitted, accumulates in memory to be retrieved by `streamExportFile` / `fetchExportFile`;
   * when the browser lacks "Save as" altogether (iOS), accumulates into a Blob for direct download.
   */
  target?: FileSystemFileHandle | null;
  /** Export mode: `fast` for fast export, `full` for full export (selected by user when clicking export); omitted = full export */
  mode?: ExportMode;
  /** Message shown to the user when pre-export check fails (original-size assets not fully uploaded, waiting for render nodes to render cards not executed on this page frame-by-frame); null = passed */
  onWaiting?: (message: string | null) => void;
  /** Probe: export first n frames only */
  maxFrames?: number;
}

export interface OnlineJob {
  controller: AbortController;
  blob: Blob | null;
}

let seq = 0;

/** Whether this browser supports "Save as" (those without it like iOS can only accumulate into a Blob for download) */
const canPickFile = () => typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

import { isCardRunnable, nonRunnableClips } from "./cardLayers";
import { tr } from "../i18n/index.ts";
export { isCardRunnable, nonRunnableClips };

/** Where ready-made sources for card frames are fetched from: document service (layer table, manifest, task queue) and asset service; null when page is not connected to a project (all live rendered by the export page) */
const cardLayerDeps = (over: { stallMs?: number } = {}) => (hasDocLink() ? {
  projectId: () => currentDocProjectId() || null,
  projectRev: () => currentSharedLink()?.ds.rev ?? null,
  stream: { request: docRequest, assetBase: remoteAssetBase, authHeaders: assetAuthHeaders },
  frames: { request: docRequest, subscribeQueue: subscribeQueueEvents, assetBase: remoteAssetBase, authHeaders: assetAuthHeaders,
    publisherId: `page-${pageSession()}`, codeVersion: CODE_VERSION, ...(over.stallMs ? { stallMs: over.stallMs } : {}) },
} : null);

export async function exportVideoOnline(
  opts: { onProgress?: (done: number, total: number, stage?: "sound" | "render" | "compose") => void; onStart?: (id: string) => void } & OnlineExportOptions,
  jobs: Map<string, OnlineJob>,
): Promise<{ outDir: string; id: string; written?: boolean }> {
  const id = `online-${Date.now().toString(36)}-${++seq}`;
  const job: OnlineJob = { controller: new AbortController(), blob: null };
  jobs.set(id, job);
  opts.onStart?.(id);
  // When export begins, generate ungenerated, missing, or expired sounds before producing frames
  // (`product/rendering.md` "Audio motion card"; the online page only synthesizes built-in sounds
  // classified as light).
  // The project snapshot is taken only after this; if this step fails or is canceled, the drop target
  // file has not been opened yet, leaving nothing behind
  try {
    await prepareExportSounds({ signal: job.controller.signal, onProgress: (done, total) => opts.onProgress?.(done, total, "sound") });
  } catch (e) {
    const err = e as Error & { cancelled?: boolean };
    pushToast(err.cancelled ? ONLINE_EXPORT_TEXT.cancelled : ONLINE_EXPORT_TEXT.failed(err.message), err.cancelled ? "info" : "warn");
    throw err.cancelled ? Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true }) : err;
  }
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  // Pause preview during export, and release small-size cache (Contract Section 11.1)
  if (getState().playing) actions.pause();
  activeOnlineSource()?.clearCache();

  const writable = opts.target ? await opts.target.createWritable() : null;
  const memory = writable ? null : new MemorySink();
  const sink: MuxSink = writable
    ? { write: (data, position) => writable.write({ type: "write", position, data: data as unknown as BufferSource }) }
    : memory!;
  const remote = mediaTierPolicy().remote ?? (remoteAssetBase() ? { base: remoteAssetBase()!, ticket: null } : null);
  const name = `${(p.name || "PromptCut").replace(/[\\/:*?"<>|]+/g, "_")}.mp4`;
  let waitingShown = "";
  // C10 Contract Section 12: export may take longer than read-only ticket validity; renew early along the way based on expiration limit (ticket retrieval reuses assetTicketSource)
  const renewer = remote ? await startRenewer() : null;
  try {
    const result = await runBrowserExport({
      project: p,
      sink,
      signal: job.controller.signal,
      maxFrames: opts.maxFrames,
      mode: opts.mode,
      onProgress: (done, total) => opts.onProgress?.(done, total, "render"),
      onWaiting: (message) => {
        opts.onWaiting?.(message);
        if (!opts.onWaiting && message && message !== waitingShown) pushToast(message, "warn", 8000);
        waitingShown = message ?? "";
      },
      confirm: (message) => window.confirm(message),
      notify: (message, tone) => pushToast(message, tone ?? "info"),
      checkMediaOriginals: () => exportGate(p),
      cardLayers: cardLayerDeps(),
      nonRunnable: () => nonRunnableClips(p),
      // Export uses only original-size assets: its URL is swapped for remote asset service retrieval URL (read-only ticket goes in query string, `<video>` cannot send headers)
      mediaUrl: remote ? (url) => remoteMediaUrl(url, { base: remote.base, ticket: renewer?.ticket() ?? remote.ticket }) : undefined,
      freshTicket: renewer ? () => renewer.ticket() : undefined,
    });
    renewer?.stop();
    if (writable) await writable.close();
    else {
      job.blob = memory!.blob();
      if (!canPickFile()) downloadBlob(job.blob, name);
    }
    pushToast(tr("{0} ({1} frames, {2} MB)", ONLINE_EXPORT_TEXT.done, result.frames, (result.bytes / 1024 / 1024).toFixed(1)), "info");
    return { outDir: "", id, written: !!writable };
  } catch (e) {
    renewer?.stop();
    try { await writable?.abort?.(); } catch { /* Already closed */ }
    const err = e as Error & { cancelled?: boolean };
    pushToast(err.cancelled ? ONLINE_EXPORT_TEXT.cancelled : ONLINE_EXPORT_TEXT.failed(err.message), err.cancelled ? "info" : "warn");
    throw err.cancelled ? Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true }) : err;
  }
}

/** Ticket renewal for frame-by-frame export (C10 Contract Section 12); returns null if ticket source (local asset service) is unavailable, keeping the fixed one as before */
async function startRenewer(): Promise<TicketRenewer | null> {
  if (!(await remoteAssetTicketInfo(false))) return null;
  const renewer = createTicketRenewer({ fetchTicket: () => remoteAssetTicketInfo(true) });
  await renewer.start();
  lastRenewer = renewer;
  return renewer;
}
/** For probe inspection: renewal count of the most recent export */
let lastRenewer: TicketRenewer | null = null;
export function exportRenewalStats() {
  return lastRenewer?.stats() ?? null;
}

/**
 * Probe entry point (`window.__pcIo.exportVideoBrowser`, `scripts/probes/lowmem-export-compare.mjs`,
 * `online-export-modes-probe.mjs`): runs browser frame-by-frame export on the current page,
 * returning artifact bytes (base64) and statistics. Bypasses "Save as", does not download.
 *   - `originals: false`: cards are all live rendered by the export page without fetching any
 *     ready-made frames (desktop runtime environment lacks document service; cards not executed on
 *     this page will have no visuals);
 *   - `originals: true`: matches formal export, fetching card frame sources according to `mode`
 *     (`fast` / `full`, defaults to `full`);
 *   - `capture`: after these frames (project frame numbers) are composited, immediately copies back
 *     a PNG (`captures`: frame number → `data:` URL), used for pixel-by-pixel verification;
 *   - `waitLimit`: maximum pre-export waiting notices observed before canceling (defaults to 3;
 *     increase when waiting for render nodes to render on demand);
 *   - `stallMs`: duration without progress before failing while waiting for render nodes (defaults to
 *     `EXPORT_STALL_MS` in `exportFrames.ts`; probes inject a few seconds).
 */
export async function exportVideoBrowserProbe(o: { maxFrames?: number; originals?: boolean; sounds?: boolean; mode?: ExportMode; capture?: number[]; waitLimit?: number; stallMs?: number } = {}) {
  // `sounds: true`: matches formal export, generating sounds first (probe `sound-ab-probe.mjs`)
  if (o.sounds) await prepareExportSounds({ signal: new AbortController().signal });
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  const sink = new MemorySink();
  const controller = new AbortController();
  const waits: string[] = [];
  // On the online page (c10a-demo-probe): original-size assets are swapped for remote asset service retrieval URLs, just like in exportVideoOnline; remains unchanged when desktop runtime environment has no remote service
  const remote = mediaTierPolicy().remote ?? (remoteAssetBase() ? { base: remoteAssetBase()!, ticket: null } : null);
  const renewer = remote ? await startRenewer() : null;
  let result: Awaited<ReturnType<typeof runBrowserExport>>;
  const wanted = new Set(o.capture ?? []);
  const captures: Record<number, string> = {};
  const waitLimit = Number.isFinite(o.waitLimit) ? (o.waitLimit as number) : 3;
  try {
    result = await runBrowserExport({
    project: p, sink, signal: controller.signal, maxFrames: o.maxFrames, mode: o.mode,
    onWaiting: (m) => { if (m) waits.push(m); if (waits.length > waitLimit) controller.abort(); },
    confirm: () => true, notify: () => {},
    checkMediaOriginals: () => exportGate(p),
    cardLayers: o.originals ? cardLayerDeps({ stallMs: o.stallMs }) : null,
    nonRunnable: () => nonRunnableClips(p),
    onFrame: wanted.size ? (frame, canvas) => { if (wanted.has(frame)) captures[frame] = canvas.toDataURL("image/png"); } : undefined,
    mediaUrl: remote ? (url) => remoteMediaUrl(url, { base: remote.base, ticket: renewer?.ticket() ?? remote.ticket }) : undefined,
    freshTicket: renewer ? () => renewer.ticket() : undefined,
    });
  } catch (e) {
    renewer?.stop();
    // When pre-export checks keep failing (waiting for uploader, etc.), pass back the observed notices; the probe needs to verify the copy
    const err = e as Error & { cancelled?: boolean };
    return { result: null, waits, base64: "", error: String(err?.message ?? err), cancelled: !!err?.cancelled };
  }
  renewer?.stop();
  const bytes = sink.bytes();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { result, waits, base64: btoa(bin), renewal: renewer?.stats() ?? null, captures };
}
