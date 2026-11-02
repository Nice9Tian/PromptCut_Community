import { tr } from "../i18n/index.ts";
/**
 * Copy for frame-by-frame export on online pages (`docs/plan/c10a-contract.md` Section 14, Table C,
 * copied verbatim).
 * The "Waiting for uploader" entry follows C6.6 (`awaitingUploaderMessage` in
 * `src/render/mediaTier.ts`, with the missing asset name).
 */
/**
 * Reason reported by render node why it cannot render (`exportStreamSpecs` in
 * `server/frame-pipeline.mjs`) → user-facing message
 */
const NODE_REASON: Record<string, string> = {
  "no-card": tr("The render node does not have the code for this card"),
  "no-stream": tr("This card cannot be rendered on its own for now"),
  "publish-failed": tr("A record of the previous failed render is still there; clicking export again will render it again"),
};

export const ONLINE_EXPORT_TEXT = {
  /**
   * Export: heavy card missing original-size prerender (message for the legacy "take HTML snapshots of
   * each card frame by frame" path; neither new export path uses it anymore, will be removed together
   * when snapshots are removed)
   */
  missingOriginals: (n: number) => tr("{0} heavy card clips have no prerender original size yet. Wait for the render node to finish, then export.", n),
  /** Export method (name is user decision, 2026-10-13; the two descriptions are drafts, user will revise later) */
  modeTitle: tr("Choose export method"),
  fast: tr("Fast export"),
  fastHint: tr("Heavy cards use the prerendered track stream frames directly. Fast, slightly lower quality."),
  full: tr("Full export"),
  fullHint: tr("Every frame is rendered again. Same quality as the desktop app, slow."),
  /** Export: cards that cannot run on this device need render node to render frame by frame, no node has accepted yet */
  waitingNode: (n: number) => tr("This device cannot run the cards of {0} clips, so they must be rendered frame by frame by a render node before export. No render node is online now: open the desktop app on a computer and enter this project, or wait for the host's render service to take over.", n),
  /** Export: render node accepted, preparing */
  planningNode: (n: number) => tr("A render node has taken over and is preparing to render {0} clips.", n),
  /** Export: render node is rendering frame by frame */
  renderingNode: (done: number, total: number) => tr("A render node is rendering frame by frame for this export: {0} / {1} frames done. Export starts once all of them arrive.", done, total),
  /** Export: render node reported that some clips cannot be rendered */
  nodeCannot: (n: number, reason: string) => tr("The render node cannot render {0} clips ({1}), so this export is not possible.", n, NODE_REASON[reason] ?? tr("The render node is temporarily unavailable")),
  /** Export: render node did not finish rendering */
  nodeFailed: (reason: string) => tr("The render node could not finish rendering the frames this export needs ({0}). Please export again.", reason),
  /** Export: render node has made no progress (node exited or has been busy) */
  nodeStalled: (ms: number) => tr("The render node has made no progress for {0} (it may be offline), so this export did not complete. Make sure the render node is online, then export again.", ms >= 60_000 ? tr("{0} min", Math.round(ms / 60_000)) : tr("{0} s", Math.round(ms / 1000))),
  /** Export: project was modified while waiting for the render node */
  projectChanged: tr("The project was changed during export. Please export again."),
  /** Export: render node is needed, but this page is not connected to a project */
  noLink: tr("This page is not linked to a project, so it cannot reach a render node and cannot export."),
  /** Export: browser does not support encoding at this size */
  unsupportedSize: tr("This browser cannot export video at this size. Please export in the desktop app on a computer, or in a browser."),
  /** Export: no audio encoding */
  noAudio: tr("This device cannot encode audio, so the exported video will have no sound. Continue exporting?"),
  /** Export: start */
  start: tr("Keep the page in the foreground and do not lock the screen during export."),
  progress: (x: number, y: number) => tr("Exported {0}/{1} frames", x, y),
  done: tr("Export complete"),
  cancelled: tr("Export cancelled"),
  failed: (reason: string) => tr("Export failed: {0}", reason),
} as const;
