/**
 * 在线页面的逐帧导出(`docs/plan/c10a-contract.md` 第 11.1 节)——`src/editor/io/index.ts` 的 `exportVideo` 在线分支的本体。
 * 流水在 `browserExport.ts`;这里接编辑器那一侧:项目、素材服务与文档服务(`assetTiers.ts`)、提示(`pushToast`)、落点。
 * 由 `io/index.ts` 按需载入(这一串在 Node 单测里载不进来)。
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
   * 「另存为」拿到的落点:给了就边编边按位置写进去(`showSaveFilePicker` 的流式写),回包带 `written: true`,
   * 调用方**不要**再 `streamExportFile`(那会把刚写好的文件换成空的)。不给就攒在内存里,由 `streamExportFile` /
   * `fetchExportFile` 取走;这个浏览器连「另存为」都没有(iOS)时攒成 Blob 直接下载。
   */
  target?: FileSystemFileHandle | null;
  /** 导出方式:`fast` 快速导出、`full` 完整导出(用户点导出时选的);不给 = 完整导出 */
  mode?: ExportMode;
  /** 导出前核对没过(素材原尺寸没传完、在等渲染节点把本页不执行的卡逐帧渲好)时给用户看的话;null = 过了 */
  onWaiting?: (message: string | null) => void;
  /** 探针:只导前 n 帧 */
  maxFrames?: number;
}

export interface OnlineJob {
  controller: AbortController;
  blob: Blob | null;
}

let seq = 0;

/** 这个浏览器有没有「另存为」(没有的是 iOS 这类,只能攒成 Blob 下载) */
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
export { isCardRunnable, nonRunnableClips };

/** 卡片画面的现成来源从哪取:文档服务(层表、清单、任务队列)与素材服务;页面没连着项目时为 null(全部由导出页活渲) */
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
  // 导出开始时先把未生成、缺失或过期的声音生成好,再出画面(`product/rendering.md`「有声动效卡」;在线页面只合成判轻的内置声音)。
  // 项目快照在这之后才取;这一步失败或取消时落点文件还没打开,不留东西
  try {
    await prepareExportSounds({ signal: job.controller.signal, onProgress: (done, total) => opts.onProgress?.(done, total, "sound") });
  } catch (e) {
    const err = e as Error & { cancelled?: boolean };
    pushToast(err.cancelled ? ONLINE_EXPORT_TEXT.cancelled : ONLINE_EXPORT_TEXT.failed(err.message), err.cancelled ? "info" : "warn");
    throw err.cancelled ? Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true }) : err;
  }
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  // 导出期间暂停预览,并释放小尺寸缓存(契约第 11.1 节)
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
  // C10 契约第 12 节:导出可能比只读票据的时限还长,途中按时限提前续签(取票复用 assetTicketSource)
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
      // 导出只用素材原尺寸:它的地址换成远程素材服务的取回地址(只读票据走查询串,`<video>` 带不了头)
      mediaUrl: remote ? (url) => remoteMediaUrl(url, { base: remote.base, ticket: renewer?.ticket() ?? remote.ticket }) : undefined,
      freshTicket: renewer ? () => renewer.ticket() : undefined,
    });
    renewer?.stop();
    if (writable) await writable.close();
    else {
      job.blob = memory!.blob();
      if (!canPickFile()) downloadBlob(job.blob, name);
    }
    pushToast(`${ONLINE_EXPORT_TEXT.done}(${result.frames} 帧,${(result.bytes / 1024 / 1024).toFixed(1)} MB)`, "info");
    return { outDir: "", id, written: !!writable };
  } catch (e) {
    renewer?.stop();
    try { await writable?.abort?.(); } catch { /* 已经关了 */ }
    const err = e as Error & { cancelled?: boolean };
    pushToast(err.cancelled ? ONLINE_EXPORT_TEXT.cancelled : ONLINE_EXPORT_TEXT.failed(err.message), err.cancelled ? "info" : "warn");
    throw err.cancelled ? Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true }) : err;
  }
}

/** 逐帧导出的票据续签(C10 契约第 12 节);取不到票据来源(本地素材服务)回 null,照旧用固定的那一张 */
async function startRenewer(): Promise<TicketRenewer | null> {
  if (!(await remoteAssetTicketInfo(false))) return null;
  const renewer = createTicketRenewer({ fetchTicket: () => remoteAssetTicketInfo(true) });
  await renewer.start();
  lastRenewer = renewer;
  return renewer;
}
/** 探针看:最近一次导出的续签次数 */
let lastRenewer: TicketRenewer | null = null;
export function exportRenewalStats() {
  return lastRenewer?.stats() ?? null;
}

/**
 * 探针入口(`window.__pcIo.exportVideoBrowser`,`scripts/probes/lowmem-export-compare.mjs`、`online-export-modes-probe.mjs`):在当前页面上跑一次
 * 浏览器逐帧导出,回产物字节(base64)与统计。不经「另存为」、不下载。
 *   - `originals: false`:卡片一律由导出页活渲,不取任何现成的画面(桌面运行环境没有文档服务;本页不执行的卡这时没有画面);
 *   - `originals: true`:照正式导出,按 `mode`(`fast` / `full`,缺省 `full`)取卡片画面的来源;
 *   - `capture`:这些帧(项目帧号)合成完当场拷一张 PNG 回来(`captures`:帧号 → `data:` 地址),逐像素核对用;
 *   - `waitLimit`:导出前的等待提示最多看到几条就取消(缺省 3;等渲染节点现渲时给大一点)。
 *   - `stallMs`:等渲染节点时多久没有进展就报失败(缺省是 `exportFrames.ts` 的 `EXPORT_STALL_MS`;探针注成几秒)。
 */
export async function exportVideoBrowserProbe(o: { maxFrames?: number; originals?: boolean; sounds?: boolean; mode?: ExportMode; capture?: number[]; waitLimit?: number; stallMs?: number } = {}) {
  // `sounds: true`:同正式导出,先把声音生成好(探针 `sound-ab-probe.mjs`)
  if (o.sounds) await prepareExportSounds({ signal: new AbortController().signal });
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  const sink = new MemorySink();
  const controller = new AbortController();
  const waits: string[] = [];
  // 在线页面上(c10a-demo-probe):素材原尺寸同 exportVideoOnline 一样换成远程素材服务的取回地址;桌面运行环境没有远程时照旧
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
    // 导出前核对一直没过(等待上传方等)时,把看到的提示交回去,探针要核对文案
    const err = e as Error & { cancelled?: boolean };
    return { result: null, waits, base64: "", error: String(err?.message ?? err), cancelled: !!err?.cancelled };
  }
  renewer?.stop();
  const bytes = sink.bytes();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { result, waits, base64: btoa(bin), renewal: renewer?.stats() ?? null, captures };
}
