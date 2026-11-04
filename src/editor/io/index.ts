import type { Project, TranscriptSegment } from "../../kernel/project";
import { actions, getState } from "../../store/project";
import { createEmptyProject } from "../../kernel/project";
import { resetProjectAi } from "../../ai/projectAi";
import { getCard } from "../../kernel/registry";
import { mediaUrlFromPath, restoreMediaUrls } from "./mediaUrls";
import { dropPythonNodes, publishPythonDrop } from "./pythonDrop";
import { applyUploadedMedia, uploadMediaFile, type UploadedMedia } from "./mediaUpload";
import { prerenderBase } from "../../render/prerender";
import { exportGate } from "../media/assetTiers";
import { awaitingUploaderMessage } from "../../render/mediaTier";
import { parseExportSkipped, type ExportSkipped } from "./exportSkipped";
import { holdOnlineQueueOriginals } from "../../online/mediaUploadQueue";
import { blockedByReadOnly } from "../readOnlyCore";
import { viewOnlyText } from "./viewOnly";

// Module-level variable holding the File, for use by stage 2 export
const mediaFiles = new Map<string, File>();

export function getMediaFile(id: string): File | undefined {
  const own = mediaFiles.get(id);
  if (own) return own;
  // The copy derived by "Create as sound" has no File of its own (it is the same file as the source video), so it
  // borrows the source media's. Transcription and export both go through here; without this step the derived sound
  // would end up as "file not in memory"
  const src = getState().project.media.find((m) => m.id === id)?.soundOf;
  return src ? mediaFiles.get(src) : undefined;
}

/**
 * For media registered outside io, hand the original File back to this table.
 *
 * This table is the only source of getMediaFile, and getMediaFile backs two things: speech-to-text needs the
 * original file to upload (stt.ts), and on export, media with a blob: url must be re-uploaded to the render process.
 * Media registered by bypassing it silently breaks on both: transcription reports "Media file not in memory", and
 * export clears the url of that media, and neither place says it was caused by "missed registration on import".
 */
export function registerMediaFile(id: string, file: File): void {
  mediaFiles.set(id, file);
}

/**
 * Pick one or more video files, register them as MediaAsset (probing duration/width/height), and place them at the
 * playhead on the video track. Returns the registered asset ids.
 *
 * The address is always /@media/<content hash> (A1): blob: is used only to probe metadata and is revoked right after;
 * if kept, neither the render process nor the export process can open it. During ingest (upload + computing sha256
 * while writing to disk) the asset stays pending, the clip is already on the timeline, and the media layer first draws
 * an "Uploading" placeholder, then shows the picture automatically once the upload finishes.
 */
/** `place: false` only adds to the media library, not to the timeline (used when a cloud chat attachment is sent and put into the media library, user decision, 2026-10-18) */
export async function importVideoFiles(files: FileList | File[], { place = true }: { place?: boolean } = {}): Promise<string[]> {
  // Read-only project (guest): importing media is a write. The button is already greyed out; reaching here means a
  // path not covered, such as drag and drop
  if (blockedByReadOnly()) throw new Error(viewOnlyText());
  const releaseHold = holdOnlineQueueOriginals();
  try {
    const fileArray = Array.from(files);
    const mediaIds: string[] = [];
    let cursor = getState().t;

    for (const file of fileArray) {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.style.display = "none";
      document.body.appendChild(video);

      const { duration, videoWidth, videoHeight } = await new Promise<{ duration: number; videoWidth: number; videoHeight: number }>((resolve) => {
        video.onloadedmetadata = () => {
          resolve({ duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
        };
        video.onerror = () => {
          console.warn(`[io] video probe failed: ${file.name}`);
          resolve({ duration: 5, videoWidth: 1920, videoHeight: 1080 });
        };
        video.src = url;
      });

      document.body.removeChild(video);
      URL.revokeObjectURL(url);

      const media = actions.addMedia({
        kind: "video",
        name: file.name,
        url: "",
        pending: true,
        duration,
        width: videoWidth,
        height: videoHeight,
      });

      mediaFiles.set(media.id, file);
      mediaIds.push(media.id);

      if (place) {
        const clip = actions.addMediaClip(media.id, cursor);
        if (clip) {
          cursor = clip.end;
        } else {
          console.warn(`[io] addMediaClip returned null, mediaId: ${media.id}`);
        }
      }

      applyUploadedMedia(media.id, await uploadMediaFile(file));
    }

    return mediaIds;
  } finally {
    releaseHold();
  }
}

/**
 * Register a video that the **server has already ingested** (the kind downloaded by media collection).
 *
 * It takes the same registration path as importVideoFiles: probe duration/width/height, addMedia, register the File,
 * place on the video track. The only difference is that the page no longer POSTs an upload: the server has already
 * sent it into the content store through the asset service's ingest endpoint (the same path as a user import),
 * `uploaded` is the ingest response, and the address is /@media/<hash>.
 */
export async function importVideoFromServer(opts: { url: string; name?: string; uploaded?: UploadedMedia | null }): Promise<string> {
  const res = await fetch(opts.url);
  if (!res.ok) throw new Error(tr("Failed to fetch file (HTTP {0}): {1}", res.status, opts.url));
  const blob = await res.blob();
  const name = opts.name || decodeURIComponent(opts.url.split("/").pop() || "video.mp4");
  const file = new File([blob], name, { type: blob.type || "video/mp4" });
  const url = URL.createObjectURL(file);

  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.style.display = "none";
  document.body.appendChild(video);
  const meta = await new Promise<{ duration: number; videoWidth: number; videoHeight: number }>((resolve) => {
    video.onloadedmetadata = () => resolve({ duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
    video.onerror = () => {
      console.warn(`[io] video probe failed: ${name}`);
      resolve({ duration: 5, videoWidth: 1920, videoHeight: 1080 });
    };
    video.src = url;
  });
  document.body.removeChild(video);

  URL.revokeObjectURL(url);

  const media = actions.addMedia({
    kind: "video",
    name,
    // The /@media/<hash> after ingest; the hash, extension and two tiers are written back by applyUploadedMedia below from the ingest response
    url: opts.url,
    duration: meta.duration,
    width: meta.videoWidth,
    height: meta.videoHeight,
  });
  mediaFiles.set(media.id, file);
  applyUploadedMedia(media.id, opts.uploaded ?? null);
  const clip = actions.addMediaClip(media.id, getState().t);
  if (!clip) console.warn(`[io] addMediaClip returned null, mediaId: ${media.id}`);
  return media.id;
}

/**
 * Register an **audio** that the server has already ingested (the kind generated by voiceover). It only goes into the
 * media library, not onto the timeline.
 *
 * The server sent it into the content store through the asset service's ingest endpoint (the same path as a user
 * import), `uploaded` is the ingest response: the address is /@media/<hash>, and the hash, extension and byte count
 * are written back per applyUploadedMedia (the same way as imported media).
 * The File is still recorded in mediaFiles, so it can be found when transcription and export need the original file.
 */
export async function importAudioFromServer(opts: { url: string; name?: string; uploaded?: UploadedMedia | null }): Promise<string> {
  const res = await fetch(opts.url);
  if (!res.ok) throw new Error(tr("Failed to fetch file (HTTP {0}): {1}", res.status, opts.url));
  const blob = await res.blob();
  const name = opts.name || decodeURIComponent(opts.url.split("/").pop() || "voice.mp3");
  const file = new File([blob], name, { type: blob.type || "audio/mpeg" });
  const duration = await new Promise<number | undefined>((resolve) => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    const timer = window.setTimeout(() => resolve(undefined), 8000);
    el.onloadedmetadata = () => { window.clearTimeout(timer); resolve(Number.isFinite(el.duration) ? el.duration : undefined); };
    el.onerror = () => { window.clearTimeout(timer); console.warn(`[io] Failed to probe audio: ${name}`); resolve(undefined); };
    el.src = opts.url;
  });
  const media = actions.addMedia({ kind: "audio", name, url: opts.url, duration });
  mediaFiles.set(media.id, file);
  if (opts.uploaded) applyUploadedMedia(media.id, opts.uploaded);
  return media.id;
}

/** Read .promptcut.json (or a compatible overlay arrangement JSON) and load it into the store. Returns the Project. */
export async function importProjectFile(file: File): Promise<Project> {
  const text = await file.text();
  const json = JSON.parse(text);
  // Same rule as opening a .proc: Python cards are archived, so drop the definitions and nodes before converting to a Project.
  publishPythonDrop(dropPythonNodes(json));

  if (json.version === 1 && Array.isArray(json.tracks)) {
    const empty = createEmptyProject();
    const project: Project = {
      ...empty,
      ...json,
      media: json.media || empty.media,
      tracks: json.tracks || empty.tracks,
    };
    delete (project as unknown as Record<string, unknown>)._note;

    // Same conversion as opening a .proc (parseProc calls it too), so there is only one copy of the rules
    const restored = restoreMediaUrls(project.media || [], { externalPathUrl: true });
    for (const m of restored.missing) console.warn(`[io] Missing asset: ${m.name} (${m.url})`);
    project.media = restored.media;

    actions.loadProject(project, file.name);
    // Switching projects must clear the AI state. Opening a .proc goes through applyProjectAi and creating a new one
    // goes through resetProjectAi, but the "import old format" path used to go through neither: the backend kept that
    // session id, reproducing 81f255b.
    // The difference is that it didn't even clear the visible chat, so the symptom is visible and the harm one tier
    // lower, but it must be cleared all the same.
    resetProjectAi();
    return project;
  } else if (json.cards && Array.isArray(json.cards)) {
    const p = createEmptyProject(file.name.replace(/\.[^/.]+$/, ""));
    actions.loadProject(p, file.name);
    resetProjectAi();
    
    let maxEnd = 0;
    for (const c of json.cards) {
      const cardId = c.cardId || c.id || c.card;
      if (!getCard(cardId)) {
        console.warn(`[io] Unknown card ${cardId}, skipped`);
        continue;
      }
      const dur = c.end !== undefined ? c.end - c.start : c.duration;
      const clip = actions.addCardClip(cardId, c.start, { duration: dur, params: c.params });
      if (clip) {
        maxEnd = Math.max(maxEnd, clip.end);
      }
    }
    
    actions.setProjectMeta({ duration: Math.max(maxEnd, 10) });
    return getState().project;
  } else {
    throw new Error(tr("Unrecognized project file: expected .promptcut.json or a {cards:[...]} arrangement"));
  }
}

/** Timecode to seconds: 00:01:02,500 / 00:01:02.500 / 01:02,500 (hours optional) */
function parseTimecode(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, "0")) / 1000;
}

/**
 * Parse SRT (WebVTT is also supported). Lenient handling: BOM, CRLF, optional index lines, the WEBVTT header,
 * cue settings after the end time, and markup such as <i> and {\\an8} are all swallowed. Blocks that can't be
 * parsed are skipped without throwing.
 */
export function parseSrt(text: string): TranscriptSegment[] {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const segments: TranscriptSegment[] = [];

  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0])) lines.shift();

    // The index line is optional
    let i = 0;
    if (/^\d+$/.test(lines[i] ?? "") && (lines[i + 1] ?? "").includes("-->")) i += 1;

    const timeLine = lines[i];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const [rawStart, rawEnd] = timeLine.split("-->");
    const start = parseTimecode(rawStart ?? "");
    // In WebVTT the end time may be followed by settings such as align / position; take only the first part
    const end = parseTimecode((rawEnd ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;

    const body = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{[^}]*\}/g, "")
      .trim();
    if (!body) continue;

    segments.push({ start, end, text: body });
  }

  return segments.sort((a, b) => a.start - b.start);
}

/**
 * Import .srt / .vtt and attach it to a media item as its caption transcript (the structure is the same as a
 * speech-to-text result, so the "Media → Captions" tab and the caption card of autoWorkflow can use it directly).
 * Without mediaId it attaches to the first media item; with no media at all it reports an error: the caption
 * timeline is relative to the media.
 */
export async function importSrtFile(
  file: File,
  opts: { mediaId?: string } = {},
): Promise<{ mediaId: string; count: number }> {
  if (blockedByReadOnly()) throw new Error(viewOnlyText());
  const segments = parseSrt(await file.text());
  if (segments.length === 0) {
    throw new Error(tr("No caption segments were parsed from {0}, check whether it is in SRT / VTT format", file.name));
  }
  const p = getState().project;
  const mediaId = opts.mediaId && p.media.some((m) => m.id === opts.mediaId) ? opts.mediaId : p.media[0]?.id;
  if (!mediaId) {
    throw new Error(tr("No media yet: first import a video in the \"Video\" tab, then import its captions"));
  }
  actions.setMediaTranscript(mediaId, {
    engine: "srt",
    model: file.name,
    createdAt: new Date().toISOString(),
    segments,
  });
  return { mediaId, count: segments.length };
}

/** Serialize the current project into a JSON string (blob URLs become relative paths) */
export function exportProjectJson(): string {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project & { _note?: string };
  p._note = tr("This file only records the arrangement. Media is recovered from the local content store by media[].hash (the sha256 of the file content) (/@media/<hash>). To take the media along, use \"Save as package…\" to save a .procp. For old files whose media has no hash, media is looked up by the file name in media[].path (/@media/<file name>). For files with no path either, after reopening you need to re-import the media with \"Import video\".");

  for (const m of p.media) {
    if (m.url.startsWith("blob:")) {
      // blob: lives only in this page. If there is a path, write it as a server address, so reopening, export and
      // screenshots can fetch it directly
      const served = mediaUrlFromPath(m.path);
      if (served) {
        m.url = served;
        continue;
      }
      // A derived "sound" media item points to the same file as the source video, but it was never registered with a File
      // itself: go back and look up the source media's
      const file = mediaFiles.get(m.id) ?? (m.soundOf ? mediaFiles.get(m.soundOf) : undefined);
      m.url = file ? file.name : m.name;
    }
  }

  return JSON.stringify(p, null, 2);
}

/**
 * Export video: hand the current project to the render core (server/bakery/) to render frame by frame.
 * A browser can't start puppeteer directly, so it goes through the dev server's /api/export endpoint (a vite plugin,
 * implemented by this task) and returns a job whose progress callback can be subscribed to.
 */
export async function exportVideo(
  opts: {
    /**
     * stage: sound = at export start, generate the sounds first (done/total is the segment count, done may be fractional);
     * render = render cards frame by frame, compose = ffmpeg composes the media and encodes
     * (done/total is the frame count of this step)
     */
    onProgress?: (done: number, total: number, stage?: ExportStage) => void;
    /**
     * The task can be cancelled once its id is known, so it is returned to the caller the moment it starts. When sounds
     * must be generated first it is returned twice: first the id of the sound generation step, then, after handing over
     * to the prerender process, the id of the export task (cancel, fetch output and open directory all recognize the
     * latter; the former can still be used to cancel)
     */
    onStart?: (id: string) => void;
  } & OnlineExportOptions = {},
): Promise<{ outDir: string; id: string; written?: boolean; skippedMedia?: ExportSkipped[] }> {
  // c10a section 11.1: the online page has no prerender process and exports frame by frame in the browser.
  // Fetch `ONLINE` on demand: `mode.ts` reads `import.meta.env`, which doesn't exist when this module is loaded in a Node unit test
  if ((await import("../../online/mode")).ONLINE) return exportVideoOnline(opts);
  // At export start, first generate the sounds that are not generated, missing or stale, then produce the picture
  // (`product/rendering.md`, "Sound motion-graphics card"). The project snapshot is taken only after this
  const prep = await prepareSoundsBeforeExport(opts);
  try {
    return await exportVideoDesktop(opts, prep);
  } finally {
    if (prep.id) soundPrepJobs.delete(prep.id);
  }
}

export type ExportStage = "sound" | "render" | "compose";
const exportCancelled = () => Object.assign(new Error(tr("Export canceled")), { cancelled: true });

/**
 * The task table for the "generate sounds first" step. This step runs in the page and has no prerender process task id
 * yet, so it first issues an id of its own to the caller for cancelling;
 * once the export task is created its id is recorded, and cancelling with the old id still works.
 */
const soundPrepJobs = new Map<string, { controller: AbortController; jobId?: string }>();
let soundPrepSeq = 0;

async function prepareSoundsBeforeExport(opts: Parameters<typeof exportVideo>[0]): Promise<{ id: string | null; controller: AbortController }> {
  const sounds = await import("./exportSounds");
  const controller = new AbortController();
  const needs = await sounds.listExportSoundNeeds(controller.signal);
  if (!needs.length) return { id: null, controller };
  const id = `sound-prep-${Date.now().toString(36)}-${++soundPrepSeq}`;
  soundPrepJobs.set(id, { controller });
  opts?.onStart?.(id);
  try {
    await sounds.prepareExportSounds({ signal: controller.signal, needs, onProgress: (done, total) => opts?.onProgress?.(done, total, "sound") });
  } catch (error) {
    soundPrepJobs.delete(id);
    throw error;
  }
  if (controller.signal.aborted) { soundPrepJobs.delete(id); throw exportCancelled(); }
  return { id, controller };
}

async function exportVideoDesktop(
  opts: Parameters<typeof exportVideo>[0] = {},
  prep: { id: string | null; controller: AbortController },
): Promise<{ outDir: string; id: string; written?: boolean; skippedMedia?: ExportSkipped[] }> {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  (await import("../../audio/cardAudio")).assertProjectCardAudio(p);
  // C6.6 "Export uses only original media size": if the original media size is not yet complete on the current asset
  // service, block before export and tell the user to wait for the uploader, instead of substituting the small media size
  const missing = await exportGate(p);
  if (missing.length) throw Object.assign(new Error(awaitingUploaderMessage(missing)), { code: "awaiting-uploader", missing });
  /*
   * Export runs on the **prerender process** (it shares slot accounting with the render pool, and idle prerendering is
   * paused during export, see render-pool-state.mjs). Uploads, submission and progress push all go straight to its
   * origin: the progress stream is attached for the whole export, and putting it on the editor's own origin would tie
   * up a connection.
   */
  const base = await prerenderBase();

  for (const m of p.media) {
    if (m.url.startsWith("blob:")) {
      // Same as above: a derived "sound" media item has no File of its own, so borrow the source video's (the two are the same file anyway)
      const file = mediaFiles.get(m.id) ?? (m.soundOf ? mediaFiles.get(m.soundOf) : undefined);
      if (file) {
        const res = await fetch(`${base}/api/export/media/${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        if (res.ok) {
          const data = await res.json();
          m.url = data.url;
        } else {
          console.warn(`[io] Failed to upload asset: ${file.name}`);
          m.url = "";
        }
      } else {
        console.warn(`[io] Could not find the File for the blob: ${m.name}`);
        m.url = "";
      }
    }
  }

  const frames = (opts as { frames?: string }).frames;
  const res = await fetch(`${base}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: p, frames, workers: (opts as { workers?: number | string }).workers })
  });
  if (!res.ok) {
    const text = await res.text();
    // The interception in the prerender process (the asset service changed after the page checked): likewise prompt
    // with "wait for the uploader"
    if (res.status === 409) {
      try {
        const body = JSON.parse(text) as { code?: string; message?: string; missing?: unknown };
        if (body.code === "awaiting-uploader") throw Object.assign(new Error(body.message || tr("Waiting for the uploader")), { code: "awaiting-uploader", missing: body.missing });
      } catch (err) {
        if ((err as { code?: string })?.code === "awaiting-uploader") throw err;
      }
    }
    throw new Error(text);
  }

  const started = await res.json();
  const { id, outDir } = started;
  // Old media marked "(missing)" whose file can't be fetched on this machine: the clips holding them are not part of
  // this export (dropSkippedMediaClips in the prerender process); tell the user on completion
  const skippedMedia = parseExportSkipped(started.skippedMedia);
  if (skippedMedia.length) console.warn("[io] Export skipped clips whose media is missing:", skippedMedia.map((m) => m.name || m.id));
  jobBase.set(id, base);
  if (prep.id) {
    const job = soundPrepJobs.get(prep.id);
    if (job) job.jobId = id;
    // Cancel clicked in the short gap after the sounds are generated but before the export task is created: end the task as soon as it is created
    if (prep.controller.signal.aborted) { await fetch(exportJobUrl(id), { method: "DELETE" }).catch(() => {}); throw exportCancelled(); }
  }
  opts.onStart?.(id);

  return new Promise((resolve, reject) => {
    const es = new EventSource(`${base}/api/export/${id}?sse=1`);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      es.close();
      fn();
    };
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.status === "running") {
        opts.onProgress?.(data.done, data.total, data.stage);
      } else if (data.status === "done") {
        finish(() => {
          opts.onProgress?.(data.total, data.total);
          resolve(skippedMedia.length ? { outDir, id, skippedMedia } : { outDir, id });
        });
      } else if (data.status === "cancelled") {
        finish(() => reject(Object.assign(new Error(tr("Export canceled")), { cancelled: true })));
      } else if (data.status === "error") {
        finish(() => reject(new Error(data.message || tr("Export error"))));
      }
    };
    es.onerror = () => {
      finish(() => reject(new Error(tr("The connection to the export process was lost, the export may still be running in the background"))));
    };
  });
}

/**
 * Which origin each export task was created on. The task table lives only in the memory of the process that created
 * it, so cancel / open directory / fetch output must go back to the same origin: these three used to hardcode the
 * same origin, and after export moved to the prerender process the editor side always replied
 * "Unknown export job". Do not ask prerenderBase() again here: a restart of prerender midway changes the port, and
 * what you get is the new process.
 */
const jobBase = new Map<string, string>();

function exportJobUrl(id: string, suffix = ""): string {
  return `${jobBase.get(id) ?? ""}/api/export/${id}${suffix}`;
}

/** Abort an export. The render process and the Chrome / ffmpeg it spawned are all terminated. */
export async function cancelExport(id: string): Promise<void> {
  const online = onlineJobs.get(id);
  if (online) { online.controller.abort(); return; }
  // Still in the "generate sounds first" step: stop the generation (the segment not yet committed leaves nothing
  // behind); if it has already been handed to the prerender process, cancel that task instead
  const prep = soundPrepJobs.get(id);
  if (prep) {
    prep.controller.abort();
    if (prep.jobId) await fetch(exportJobUrl(prep.jobId), { method: "DELETE" }).catch(() => {});
    return;
  }
  await fetch(exportJobUrl(id), { method: "DELETE" }).catch(() => {});
}

/** Open the output directory of this export in the file manager */
export async function revealExport(id: string): Promise<void> {
  await fetch(exportJobUrl(id, "/reveal"), { method: "POST" });
}

/** Fetch a given output (preview.mp4 / overlay.mov), to write it to the location the user chose */
export async function fetchExportFile(id: string, name: string): Promise<Blob> {
  const online = onlineJobs.get(id);
  if (online) {
    if (!online.blob) throw new Error(tr("This export was already written directly to the selected file"));
    return online.blob;
  }
  const r = await fetch(exportJobUrl(id, `/file/${encodeURIComponent(name)}`));
  if (!r.ok) throw new Error(tr("Could not fetch {0}: {1}", name, await r.text()));
  return r.blob();
}

/** Stream a finished export directly into a File System Access writable. */
export async function streamExportFile(id: string, name: string, writable: FileSystemWritableFileStream): Promise<void> {
  const online = onlineJobs.get(id);
  if (online) {
    // Online export: if it was already written directly into the chosen file, nothing to do here; if it was buffered in
    // memory, write it over in one piece
    if (online.blob) await writable.write(online.blob);
    return;
  }
  const r = await fetch(exportJobUrl(id, `/file/${encodeURIComponent(name)}`));
  if (!r.ok) throw new Error(tr("Could not fetch {0}: {1}", name, await r.text()));
  if (!r.body) throw new Error(tr("Could not fetch {0}: the response has no data stream", name));
  const reader = r.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value) await writable.write(part.value);
    }
  } finally { reader.releaseLock(); }
}

/* ------------------------------------------------------------------ *
 * Frame-by-frame export of the online page (`docs/plan/c10a-contract.md`, section 11.1): implemented in
 * `src/export/onlineExport.ts`, loaded on demand here
 * (the browser export chain can't be loaded in Node unit tests; `mode.ts` reads `import.meta.env`, which also doesn't
 * exist in unit tests). The task table is here; cancel and fetch output look it up by id.
 * ------------------------------------------------------------------ */

export type { OnlineExportOptions } from "../../export/onlineExport";
import type { OnlineExportOptions, OnlineJob } from "../../export/onlineExport";
import { tr } from "../../i18n/index.ts";
const onlineJobs = new Map<string, OnlineJob>();
async function exportVideoOnline(opts: Parameters<typeof exportVideo>[0] & OnlineExportOptions): Promise<{ outDir: string; id: string; written?: boolean }> {
  return (await import("../../export/onlineExport")).exportVideoOnline(opts ?? {}, onlineJobs);
}

declare global {
  interface Window {
    __pcIo?: Record<string, unknown>;
  }
}

if (typeof window !== "undefined") {
  // Temporary verification hook: during puppeteer headless verification, call these four functions directly (no need to simulate <input type=file>).
  window.__pcIo = { importVideoFiles, importProjectFile, importSrtFile, parseSrt, exportProjectJson, exportVideo, setMediaTranscript: (mediaId: string, transcript: any) => actions.setMediaTranscript(mediaId, transcript) };
  // Probes (`scripts/probes/lowmem-export-compare.mjs`, `online-export-modes-probe.mjs`): run one
  // frame-by-frame browser export on the current page and return the output bytes (base64) and stats.
  // No "Save as", no download. With `originals: false`, cards are always live-rendered by the export
  // page (the desktop runtime has no document service). For parameters see `exportVideoBrowserProbe`
  window.__pcIo.exportVideoBrowser = async (o: { maxFrames?: number; originals?: boolean; sounds?: boolean; mode?: "fast" | "full"; capture?: number[]; waitLimit?: number; stallMs?: number } = {}) => (await import("../../export/onlineExport")).exportVideoBrowserProbe(o);
  // Sound probe (`scripts/probes/sound-ab-probe.mjs`): the online build has no `/src/…` to import, so
  // generation, judging and the sound top-up before export get it from here
  Object.assign(window.__pcIo, { cancelExport, fetchExportFile });
  window.__pcIo.sound = async () => {
    const [effects, cards, exportSounds, judge, upload] = await Promise.all([import("./soundGeneration"), import("./cardAudioGeneration"), import("./exportSounds"), import("./onlineSoundJudge"), import("./generatedAudioUpload")]);
    return {
      startSoundGeneration: effects.startSoundGeneration, waitSoundGeneration: effects.waitSoundGeneration,
      generateCardAudio: cards.generateCardAudio, listExportSoundNeeds: exportSounds.listExportSoundNeeds,
      decideClipSound: judge.decideClipSound, hasGeneratedAudio: upload.hasGeneratedAudio,
    };
  };
}
