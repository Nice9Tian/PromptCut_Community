// mcp-tools.mjs is pure data with no node dependency, so the frontend can import it directly; it
// has no .d.ts, so the little shape that is used is declared here in place.
// @ts-expect-error .mjs without type declarations
import { tools as RAW_TOOL_SPECS } from "../../server/mcp-tools.mjs";
import { modelToolName, pageToolName } from "../../server/tools/ui-names.mjs";
import { webOpen, webView, webClick, webType, webScroll, webRead, webHandoff, webClose } from "./web";
import { requestAgentBrowser, closeAgentBrowser } from "./agentBrowserStore";
import * as agentBus from "./agentBus";
import { applyDesktopSessions } from "./desktopSessions";
import { TOOL_ROUTES } from "../mcp/routes.mjs";
import { getState } from "../store/project";
import { prerenderUrl } from "../render/prerender";
import { flushDataMirror, startDataMirror } from "../render/dataMirror";
import { beginAgentTool, endAgentTool } from "../editor/userEditing";
import { issueAgentTicket, pageOpIdsSince, pageOpMark } from "../editor/sync/syncManager";
import { trackJobs, trackResults } from "../mcp/common";
import { tr as trText } from "../i18n/index.ts";

/**
 * Internal tool name the Agent server uses to ask the page for read-only page state (PAGE_STATE_TOOL
 * in server/agent/agent-side.mjs). It is not in the tool table and the Agent cannot see it, so it is
 * not written as a literal dispatch branch (the reconcile in tool-schema.test.mjs only recognizes
 * declared tools).
 */
const PAGE_STATE_TOOL = "__page_state";
const TOOL_SPECS = RAW_TOOL_SPECS as { name: string; inputSchema?: { required?: string[] } }[];

/**
 * Validates required parameters against the tool's own inputSchema.
 *
 * Why intercept at this layer: inputSchema declares required, but **no layer actually enforces it**.
 * The MCP protocol relies on the client to be diligent, and CLI drivers (claude / codex / agy) do
 * not guarantee validation. So a missing parameter goes all the way into the implementation:
 * `seek({})` sets t to null and `set_theme({})` sets themeId to undefined, and both still return
 * `{ok:true}`: the Agent thinks it succeeded while the project is already broken. Silently
 * corrupting state is much harder to track down than an error.
 *
 * The direct API path already has the same validation in harness/agent.mjs; this fills in the path
 * that goes through MCP.
 * It only checks "is the required parameter present" and does no type inference: over-validation
 * would also block legitimate calls.
 */
function missingRequired(tool: string, args: unknown): string[] {
  const spec = TOOL_SPECS.find((t) => t.name === tool);
  const required = spec?.inputSchema?.required ?? [];
  if (required.length === 0) return [];
  const bag = (args ?? {}) as Record<string, unknown>;
  return required.filter((k) => bag[k] === undefined || bag[k] === null);
}

export interface EditorApi {
  soundPresets(): any;
  soundGenerate(args: import("../editor/io/soundGeneration").GenerateSoundOptions): Promise<any>;
  soundStatus(args?: { jobId?: string }): any;
  soundCancel(args: { jobId: string }): any;
  backgroundJobStatus(args: { jobId: string }): any;
  listCards(args?: { cardId?: string; detail?: string }): any;
  getProject(): any;
  listMedia(): any;
  getSelection(): any;
  addClip(args: { cardId: string; start: number; duration?: number; trackId?: string; params?: any }): any;
  updateClip(args: { clipId: string; start?: number; end?: number; cardId?: string; params?: any; opacity?: number; fadeIn?: number; fadeOut?: number; label?: string; trackId?: string }): any;
  /**
   * Card-level addressing (the root node of the scene graph). When part-level is added, add a node
   * parameter; the signature does not need to change
   */
  setPosition(args: { clipId: string; space?: "world" | "local"; x?: number | string; y?: number | string; w?: number | string; h?: number | string; anchor?: [number, number]; scale?: number | string; rotate?: number | string; rotateX?: number | string; rotateY?: number | string; translateZ?: number | string; frameExpr?: Record<string, string | null>; clearFrameExpr?: boolean; clear?: boolean; clamp?: boolean }): any;
  setRect(args: { clipId: string; x1: number; y1: number; x2: number; y2: number; mode?: "fit" | "canvas"; align?: [number, number]; frameExpr?: Record<string, string | null>; clearFrameExpr?: boolean }): any;
  align(args: { clipId: string; h?: "left" | "center" | "right"; v?: "top" | "center" | "bottom"; margin?: number }): any;
  nudge(args: { clipId: string; dx?: number; dy?: number; scaleBy?: number; rotateBy?: number; clamp?: boolean }): any;
  /** Async: contentBox needs a round trip to the stage (D4, page side). Write tools are still synchronous */
  getLayout(args?: { clipId?: string }): Promise<any>;
  getClip(args: { clipId: string }): any;
  listParts(args?: { partId?: string; detail?: string }): any;
  addComposite(args: { start: number; duration?: number; trackId?: string; parts?: unknown[] }): any;
  addPart(args: { clipId: string; partId: string; params?: Record<string, unknown>; frame?: unknown; enterMs?: number; label?: string; parentId?: string; index?: number }): any;
  setPart(args: { clipId: string; partInstanceId: string; params?: Record<string, unknown>; frame?: unknown; enterMs?: number; label?: string }): any;
  removePart(args: { clipId: string; partInstanceId: string }): any;
  movePart(args: { clipId: string; partInstanceId: string; parentId?: string | null; index?: number }): any;
  setClip(args: { clipId: string; envelope: unknown }): any;
  removeClip(args: { clipId: string }): any;
  duplicateClip(args: { clipId: string }): any;
  splitClip(args: { clipId: string; t: number }): any;
  setClipVolume(args: { clipId: string; volume: number }): any;
  setClipMuted(args: { clipId: string; muted: boolean }): any;
  renderCardAudio(args: { clipId: string; force?: boolean }): Promise<any>;
  cancelCardAudio(args: { clipId: string }): any;
  separateAudio(args: { clipId?: string; clipIds?: string[] }): any;
  createAudio(args: { mediaId?: string; clipId?: string }): any;
  setEmphasis(args: { clipId: string; kind: string; color?: string; size?: number; opacity?: number; dx?: number; dy?: number }): any;
  listTransitions(): any;
  addTransition(args: { kind: string; clipId: string; otherClipId?: string; dur?: number }): any;
  removeTransition(args: { transitionId: string }): any;
  // Tracks. Validation and gates are in mcp/tools/trackTools.ts
  addTrack(args: { name?: string; index?: number }): any;
  listTracks(): any;
  removeTrack(args: { trackId?: string; trackIds?: string[]; force?: boolean; reason?: string }): any;
  updateTrack(args: { trackId: string; name?: string; hidden?: boolean; muted?: boolean; locked?: boolean }): any;
  moveTrack(args: { trackId: string; index: number }): any;
  // Filter library. Validation and gates are in editor/right/filterTools.ts; the values and their
  // translation for the three pipelines are in kernel/filters.mjs
  listFilters(): any;
  createFilter(args: any): any;
  updateFilter(args: any): any;
  removeFilter(args: { filterId: string; force?: boolean; reason?: string }): any;
  applyFilter(args: { clipId: string; filterId: string; params?: Record<string, number> }): any;
  listPixelMaps(): any;
  createPixelMap(args: any): any;
  updatePixelMap(args: any): any;
  removePixelMap(args: { pixelMapId: string; force?: boolean; reason?: string }): any;
  applyPixelMap(args: { clipId: string; pixelMapId?: string }): any;
  listMediaEffects(args?: { mediaId?: string }): any;
  // Audio effects library. Validation and gates are in editor/right/audioFxTools.ts, the values in
  // kernel/audioFx.mjs, the node graph in src/audio/fxChain.ts
  listAudioFx(): any;
  createAudioFx(args: any): any;
  updateAudioFx(args: any): any;
  removeAudioFx(args: { fxId: string; force?: boolean; reason?: string }): any;
  applyAudioFx(args: { clipId: string; fxId: string; params?: Record<string, number> }): any;
  /** Measure loudness: server-side ffmpeg ebur128 (server/vite-plugin-audio.ts) */
  measureAudio(args: { clipId?: string; mediaId?: string; scope?: string; series?: boolean }): Promise<any>;
  /**
   * Custom measurement (plan A6): the PCM goes to a dedicated Chrome's sandbox, which runs JS written
   * by the Agent (server/audio-measure-js.mjs)
   */
  measureAudioJs(args: { code: string; clipId?: string; mediaId?: string; scope?: string; start?: number; duration?: number; sampleRate?: number; mono?: boolean; timeoutMs?: number }): Promise<any>;
  // Multiple cuts (timelines). All other clip / track tools act only on the currently active one
  listCuts(args?: { cutId?: string }): any;
  switchCut(args: { cutId?: string; name?: string }): any;
  addCut(args?: { name?: string; kind?: "2d" | "3d"; spaceWidth?: number; spaceHeight?: number; camera3dFov?: number }): any;
  setCutKind(args: { cutId?: string; kind: "2d" | "3d"; spaceWidth?: number; spaceHeight?: number; camera3dFov?: number }): any;
  prerenderCutTo2D(args?: { cutId?: string; name?: string }): Promise<any>;
  renameCut(args: { cutId: string; name: string }): any;
  removeCut(args: { cutId: string; force?: boolean; reason?: string }): any;
  listCameras(args?: { cutId?: string }): any;
  addCamera(args: { cutId?: string; name?: string; row?: number; start: number; end: number; enabled?: boolean; params?: Record<string, number | string>; x?: number | string; y?: number | string; z?: number | string; rx?: number | string; ry?: number | string; rz?: number | string; fovDeg?: number | string; zoom?: number | string; rotate?: number | string }): any;
  updateCamera(args: { cameraId: string; cutId?: string; name?: string; row?: number; start?: number; end?: number; enabled?: boolean; params?: Record<string, number | string | null>; x?: number | string; y?: number | string; z?: number | string; rx?: number | string; ry?: number | string; rz?: number | string; fovDeg?: number | string; zoom?: number | string; rotate?: number | string }): any;
  removeCamera(args: { cameraId: string; cutId?: string }): any;
  /**
   * Place a cut segment referencing another cut in the active cut (either cutId or name); throws
   * with an explanation when it would be placed into itself or form a circular reference
   */
  addCutSegment(args: { cutId?: string; name?: string; start: number; duration?: number; cutOffset?: number; trackId?: string }): any;
  /**
   * Change which cut a cut segment references (cutId or name) and at which second of the referenced
   * cut it starts (cutOffset)
   */
  setCutSegment(args: { clipId: string; cutOffset?: number }): any;
  seek(args: { t: number }): any;
  play(): any;
  pause(): any;
  setTheme(args: { themeId: string }): any;
  setProjectMeta(args: any): any;
  setCamera3d(args: { enabled?: boolean; fovDeg?: number }): any;
  bakeCard(args: { clipId: string; t?: number; size?: number; bg?: string }): Promise<any>;
  // STT tools
  sttStatus(): Promise<any>;
  sttInstall(args: { engine: string }): Promise<any>;
  transcribeMedia(args: { mediaId: string; engine?: string; model?: string; language?: string }): Promise<any>;
  getTranscript(args: { mediaId: string }): any;
  detectShots(args: { mediaId: string; force?: boolean }): Promise<any>;
  listShots(args: { mediaId: string }): any;
  trackPoints(args: { mediaId: string; points: number[][] }): Promise<any>;
  getTrack(args: { mediaId: string; full?: boolean }): any;
  trackStatus(): Promise<any>;
  trackInstall(): Promise<any>;
  // Subject detection: where the people in the frame are, which side is empty
  detectSubjects(args: { mediaId: string; times?: number[]; prompt?: string; force?: boolean }): Promise<any>;
  listSubjects(args: { mediaId: string }): any;
  subjectStatus(): Promise<any>;
  subjectInstall(): Promise<any>;
  attachClipMotion(args: {
    clipId: string; mediaId: string; pointIndex?: number; whenHidden?: string;
  }): any;
  detachClipMotion(args: { clipId: string }): any;
  autoWorkflow(args: { mediaId: string; style?: string; maxCards?: number }): Promise<any>;
  autoWorkflowStatus(args: { jobId: string }): any;
  fillCaptions(args: { clipId?: string; mediaId?: string; showEn?: boolean }): any;
  listCaptions(args: { clipId?: string }): any;
  editCaption(args: { clipId?: string; op?: string; index?: number; text?: string; en?: string; start?: number; end?: number }): any;
  importMedia(args: { url?: string; name?: string }): Promise<any>;
  // Voiceover: cloud TTS generates an mp3 into the media library, and with start given it is put
  // on the timeline
  voiceList(): Promise<any>;
  voiceGenerate(args: { text: string; start?: number; trackId?: string; provider?: string; voiceId?: string; speed?: number; emotion?: string; name?: string }): Promise<any>;
  collectStatus(): Promise<any>;
  collectSearch(args: { query: string; site?: string; limit?: number }): Promise<any>;
  collectInstall(): Promise<any>;
  collectProbe(args: { url: string; site?: string; quality?: number }): Promise<any>;
  collectDownload(args: { url: string; quality?: number; site?: string; audioOnly?: boolean; allParts?: boolean; cookies?: string }): Promise<any>;
  collectJob(args: { jobId: string }): Promise<any>;
  collectLogin(args: { site?: string; method?: "qr" | "browser"; force?: boolean }): Promise<any>;
  collectLoginCheck(args: { site?: string; hide?: boolean }): Promise<any>;
  collectLogout(args: { site?: string }): Promise<any>;
  createCard(args: { id: string; source: string; overwrite?: boolean }): Promise<any>;
  applyCard(args: any): any;
  getCardSource(args: { cardId: string; file?: string }): Promise<any>;
  editCard(args: { cardId: string; file?: string; find: string; replace: string; replaceAll?: boolean }): Promise<any>;
  /**
   * Read-only DOM tree (inspect_card_dom): each node is tagged with its source location, and all
   * changes go through editCard
   */
  inspectCardDom(args: { clipId: string; t?: number; ref?: number | string; depth?: number }): Promise<any>;
  seePreview(args: { t?: number; clipId?: string; times?: number[]; cutId?: string; view?: "camera" | "space" }): Promise<any>;
  seeSequences(args: { mediaId: string; page?: number; perPage?: number; grid?: number; scene?: number; from?: number; to?: number }): Promise<any>;
  cardAuthoringGuide(): Promise<any>;
}

/**
 * These tools change the timeline: each time one succeeds, it is worth refreshing the preview
 * image below the SKILL floating window once
 */
const TIMELINE_TOOLS = new Set([
  "add_clip", "update_clip", "remove_clip", "duplicate_clip", "split_clip",
  "add_transition", "remove_transition", "set_clip_volume", "set_clip_muted", "render_card_audio", "separate_audio", "create_audio", "set_emphasis",
  "set_position", "set_rect", "align", "nudge", "fill_captions", "edit_caption", "attach_clip_motion", "detach_clip_motion",
  "add_track", "remove_track", "update_track", "move_track",
  "create_filter", "update_filter", "remove_filter", "apply_filter",
  "create_pixel_map", "update_pixel_map", "remove_pixel_map", "apply_pixel_map",
  "create_audio_fx", "update_audio_fx", "remove_audio_fx", "apply_audio_fx",
  "user_interface_switch_cut", "add_cut", "set_cut_kind", "prerender_cut_to_2d",
  "add_camera", "update_camera", "remove_camera",
  "set_theme", "voice_generate", "sound_generate",
]);

/**
 * The "visible results" of the chat panel.
 *
 * When a user opens a tool in the concise view, what they used to see was the JSON of the input
 * arguments and the result, which is meant for debugging. A tool that looks at an image should show
 * the image it returned at the time; adding / deleting a card should show that card; editing a card
 * should show which parameters changed and the two animated images before and after. Only this page,
 * which executes the tool, can get these things (the project from before the change, the returned
 * bitmap), so here a "visualization record" is handed to the server to store, and its id is put at
 * the very front of the result: all four vendors' tool result summaries keep the opening part, and
 * the chat panel uses this id to fetch the record.
 *
 * The animated images are not rendered here: only "how to render" is stored (what the card looked
 * like at the time), and the server renders when the user opens it. So an Agent tool call costs just
 * one extra local file write; handing over the record waits at most 3 seconds, and on timeout it is
 * left out and the tool result returns as usual.
 */
const CLIP_EDIT_TOOLS = new Set([
  "update_clip", "set_clip", "set_position", "set_rect", "align", "nudge", "set_emphasis",
  "add_part", "set_part", "remove_part", "move_part",
]);
const CLIP_CREATE_TOOLS = new Set(["add_clip", "duplicate_clip", "add_composite"]);

function cloneProject<T>(p: T): T {
  try { return structuredClone(p); } catch { return JSON.parse(JSON.stringify(p)); }
}

function visualRequest(tool: string, args: any, result: any, before: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || result.ok === false) return null;
  if (tool === "see_frames") {
    const images: { mime?: string; base64: string; label: string }[] = [];
    if (result.__image?.base64) images.push({ mime: result.__image.mime, base64: result.__image.base64, label: typeof result.t === "number" ? `t=${result.t}s` : "" });
    for (const im of Array.isArray(result.__images) ? result.__images : []) {
      if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? (im.sceneIndex != null ? trText("Shot {0}", im.sceneIndex) : "") });
    }
    return images.length ? { tool, images } : null;
  }
  if (CLIP_CREATE_TOOLS.has(tool)) {
    const id = result.id || result.clipId;
    return id ? { tool, clipId: id, after: getState().project } : null;
  }
  if (tool === "remove_clip") return before && args?.clipId ? { tool, clipId: args.clipId, before } : null;
  if (CLIP_EDIT_TOOLS.has(tool)) return before && args?.clipId ? { tool, clipId: args.clipId, before, after: getState().project } : null;
  return null;
}

async function withVisual(tool: string, args: any, result: unknown, before: unknown): Promise<unknown> {
  try {
    const body = visualRequest(tool, args, result, before);
    if (!body) return result;
    const res = await fetch(await prerenderUrl("/api/ai/visual"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok || !data.visualId) return result;
    return { visualId: data.visualId, ...(result as object) };
  } catch {
    return result; // The visualization is incidental; if it cannot be delivered, drop it
  }
}

/**
 * get_gif: samples 8 frames evenly across the whole card; the user sees the animated image and
 * the model sees a 4×2 montage
 */
async function getGif(args: { clipId: string }) {
  // Fallback path (when there is a data mirror the server does it directly, see the server-side tools
  // of vite-plugin-ai). Sent to the prerender source; gives up after 180 seconds.
  // Two steps (cloud-task.md resolution 12): first write only the spec, then `/render` renders the
  // pixels (`user` role)
  const post = async (path: string, body: unknown) => {
    const res = await fetch(await prerenderUrl(path), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || trText("Failed to make the animated image (HTTP {0})", res.status));
    return data;
  };
  const spec = await post("/api/ai/visual", { tool: "get_gif", clipId: args.clipId, after: getState().project });
  if (!spec.gifKey) throw new Error(trText("No clip with id {0} on the timeline.", args.clipId));
  const data = await post("/api/ai/visual/render", { key: spec.gifKey });
  return {
    visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
    note: trText("Collage 4×2: cell k corresponds to the k-th time in times (row by row, left to right). The user can open this step in the chat panel to see the animated image."),
    ...(data.grid ? { __image: { mime: "image/png", base64: data.grid } } : {}),
  };
}

/**
 * Render only one at a time: when the agent edits ten cards in a row, rendering the preview ten
 * times is pointless, so only the last one is kept
 */
let lastActionBusy = false;
let lastActionPending: (() => Promise<void>) | null = null;

/**
 * Under the SKILL mode floating window, shows the picture of "the last action the desktop app
 * session completed".
 *
 * When the editor process completes an operation in a desktop session and SKILL mode is on, it
 * sends `skill.preview` over SSE (requestSkillPreview in server/vite-plugin-ai.ts); here only
 * timeline operations are acted on: following the see_frames route, the whole screen at that moment
 * is rendered to a png and POSTed to the server, which writes it to skillRoot/last-action.{png,json};
 * the shell's watcher watches those two files and pushes any change to the floating window. Failure
 * is silent throughout: the preview is a nice-to-have and must not affect tool calls in return.
 * (It used to be done by the headless instance's page; after A4 archived the headless instance, it
 * is done by the user's own page.)
 */
function reportLastAction(api: EditorApi, tool: string, clipId: string | null, start: number | null): void {
  if (!TIMELINE_TOOLS.has(tool)) return;
  const run = async () => {
    // Time point: prefer the midpoint of the card this action involved; if there is none, let the
    // server use the current playhead
    let t: number | undefined;
    const clip = clipId ? getState().project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId) : undefined;
    if (clip && typeof clip.start === "number" && typeof clip.end === "number") t = (clip.start + clip.end) / 2;
    else if (typeof start === "number") t = start + 0.5;
    const shot = await api.seePreview(t == null ? {} : { t });
    const base64 = shot?.__image?.base64;
    if (!base64) return;
    await fetch("/api/skill-mode/last-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, clipId: clipId ?? null, t: shot?.t ?? t ?? null, base64 }),
    });
  };
  const kick = () => {
    if (lastActionBusy) { lastActionPending = run; return; }
    lastActionBusy = true;
    run().catch(() => {}).finally(() => {
      lastActionBusy = false;
      const next = lastActionPending;
      lastActionPending = null;
      if (next) { lastActionBusy = true; next().catch(() => {}).finally(() => { lastActionBusy = false; }); }
    });
  };
  kick();
}

/**
 * Dispatch for web_*. The __image in the response body is passed up unchanged, so the harness can
 * pull it out as an image block
 */
async function runWebTool(tool: string, args: any): Promise<any> {
  switch (tool) {
    case "web_open": return webOpen(args);
    case "web_view": return webView();
    case "web_click": return webClick(args);
    case "web_type": return webType(args);
    case "web_scroll": return webScroll(args);
    case "web_read": return webRead(args);
    case "web_handoff": {
      const r = await webHandoff(args);
      // Desktop shell mode: the agent's browser is a child webview in the main window, which the Node
      // side cannot move, so it only returns a shell marker. This side **does not pop up a window to
      // interrupt the user**: it lights up the "Browser" tab in the top bar (blinking + a "pending
      // action" bubble), and the panel shows the webview only when the user clicks over there themselves.
      if (r && (r as { shell?: boolean }).shell) {
        if (args?.hide) closeAgentBrowser();
        else requestAgentBrowser(typeof args?.reason === "string" ? args.reason : "");
      }
      return r;
    }
    case "web_close": return webClose();
    default: throw new Error(trText("Unknown web tool: {0}", tool));
  }
}

export function connectMcpExecutor(getApi: () => EditorApi, onStatus?: (s: { connected: boolean }) => void): () => void {
  let source: EventSource | null = null;
  let active = true;

  /*
   * `?observe=1`: read-only viewing. The page renders the project as usual but **does not connect the
   * bridge** (so it never pushes the editor off the tool channel).
   * Without it = the editor (first come, first served; a refresh can take over).
   */
  const params = (() => {
    try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
  })();
  const observeOnly = params.has("observe");

  if (observeOnly) {
    // Tell the UI explicitly that "the bridge is not connected", so that the status dot does not show
    // green and make people think the tools are usable
    onStatus?.({ connected: false });
    return () => {};
  }

  /*
   * This page is the "editor", and it mirrors the project to the server (the read-only mirror used by
   * data management, see src/render/dataMirror.ts).
   * The read-only viewing page (observe) already returned above and never gets here: two pages
   * pushing at once would overwrite each other.
   *
   * **No longer waits for the bridge to connect** (A7): the body of a frame request holds only
   * `{session, localRev}`, and the server takes the project from the mirror. The editor page's own
   * preview must be drawable even when no Agent is connected. The criterion changed from "connected
   * to the MCP bridge" to "the page's role is the editor page".
   */
  startDataMirror();
  // Multi-Agent: when the tabs change, report to the editor process's bulletin board (A3)
  const stopTabReports = agentBus.startTabReports();

  const connect = () => {
    if (!active) return;
    source = new EventSource("/api/mcp/events");

    source.onopen = () => {
      onStatus?.({ connected: true });
      // The editor process may have just restarted: report the tabs once more, so that the bulletin
      // board's list is complete (A3)
      agentBus.resendTabs();
    };

    source.onmessage = async (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }

      if (ev.type === "hello") {
        // hello
      } else if (ev.type === "replaced") {
        if (source) source.close();
        source = null;
        onStatus?.({ connected: false });
        window.dispatchEvent(new CustomEvent("ai-chat-error", { detail: trText("Another editor page took over the AI connection") }));
        active = false;
      } else if (ev.type === "agent.board") {
        // The multi-Agent bulletin board (the one inside the editor process) changed: tab names change with
        // the scope, and tabs are marked unread (A3)
        agentBus.applyBoard(ev.agents);
      } else if (ev.type === "agent.desktop") {
        // Desktop app session groups (A4): vendor, operation in progress, progress report; replaced wholesale
        applyDesktopSessions(ev.sessions);
      } else if (ev.type === "skill.preview") {
        // A desktop session completed an operation while SKILL mode is on: refresh a preview for the
        // floating window (silent on failure)
        try { reportLastAction(getApi(), String(ev.tool), typeof ev.clipId === "string" ? ev.clipId : null, typeof ev.start === "number" ? ev.start : null); } catch { /* The preview is incidental */ }
      } else if (ev.type === "agent.spawn") {
        // spawn_agent starts a subagent: open a new tab with a role name (A3)
        void agentBus.handleSpawn(ev);
      } else if (ev.type === "agent.ticket") {
        // The Agent server asks for a connection ticket with the agent role (shared project; requestTicket
        // in server/vite-plugin-ai.ts)
        void issueAgentTicket(ev);
      } else if (ev.type === "call" && ev.tool === PAGE_STATE_TOOL) {
        /*
         * The Agent server asks the page for a read-only snapshot of page state (ruling in c65-integ2:
         * tools that both read page state and write the project are executed on the server instead, see
         * PAGE_STATE_TOOLS in server/agent/agent-exec.mjs): the playhead, and the trajectories that
         * track_points produced in page memory.
         * Read-only, changes no state, does not go through EditorApi.
         */
        const q = (ev.args ?? {}) as { keys?: string[]; args?: { mediaId?: unknown } };
        const keys = Array.isArray(q.keys) ? q.keys : [];
        const result: Record<string, unknown> = {};
        if (keys.includes("t")) result.t = getState().t;
        if (keys.includes("track")) {
          const mediaId = typeof q.args?.mediaId === "string" ? q.args.mediaId : null;
          result.track = mediaId ? { mediaId, result: trackResults.get(mediaId) ?? null, running: trackJobs.has(mediaId) } : null;
        }
        fetch("/api/mcp/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ev.id, ok: true, result }),
        }).catch(() => {});
      } else if (ev.type === "call") {
        const id = ev.id;
        /*
         * Tools that move the user interface were renamed (`user_interface_` prefix,
         * server/tools/ui-names.mjs): the internal operation names sent by the server keep the old names
         * (the 0.7.18 desktop app still recognizes them as usual when it is the initiating page), so both
         * are accepted here, and on entry they are all converted to the new name before the routing table
         * is consulted
         */
        const tool = modelToolName(ev.tool);
        const args = ev.args as any;
        // Multi-Agent: the server passes along the chat ID of the Agent that initiated this call (those
        // going through agy or an external command line do not have one)
        const agent: string | null = typeof ev.agent === "string" && ev.agent ? ev.agent : null;
        // Look at the project once before and once after a timeline operation, work out which "cut->track"
        // entries this one changed, and carry them in the response to the server's bulletin board (used
        // when the document service is not connected)
        const before = TIMELINE_TOOLS.has(tool) ? getState().project : null;
        // The chat panel needs to draw the card as it was "before the change": only tools that edit /
        // delete a card take this copy
        const visualBefore = CLIP_EDIT_TOOLS.has(tool) || tool === "remove_clip" ? cloneProject(getState().project) : null;
        const api = getApi();
        // Tools forwarded one-to-one are in the routing table; those outside the table (bulletin board,
        // see_frames, get_gif, web_*) each have their own branch.
        // Look up with Object.hasOwn: with direct indexing, a tool named "toString" / "constructor" would
        // hit things on Object.prototype, and what should have returned "unknown tool" becomes some other
        // error.
        const route = Object.hasOwn(TOOL_ROUTES, tool) ? TOOL_ROUTES[tool] : undefined;
        let ok = true;
        let result: unknown;
        let error: string | undefined;
        // Commits issued by this page during this call (write tools that stay in the page): the response
        // carries opIds, from which the Agent server advances the version this chat has read
        const opMark = pageOpMark();
        // Changes made by this page during this call were requested by the Agent and do not count as "the
        // user touched it" (src/editor/userEditing.ts, A2)
        beginAgentTool();

        try {
          const missing = missingRequired(tool, args);
          if (missing.length > 0) {
            throw new Error(trText("Missing required parameters: {0}. Add them and try again.", missing.join(trText(", "))));
          }
          // The hundred or so tools that forward one-to-one to EditorApi go through the routing table
          // (src/mcp/routes.mjs).
          // Whether to await copies the original dispatch chain: await only when the table says awaited, no
          // unification.
          // (The multi-Agent bulletin board tools are answered inside the editor process and no longer reach
          // the page, plan agent-workflow-plan.md A3)
          if (route) {
            result = route.passArgs ? api[route.method](args) : api[route.method]();
            if (route.awaited) result = await result;
          }
          else if (tool === "see_frames") {
            // One tool, two kinds of picture: the final video (timeline) goes through seePreview, the media
            // shot montage (media) goes through seeSequences
            const { source, ...rest } = (args ?? {}) as any;
            if (source === "media") {
              result = rest.mediaId
                ? await api.seeSequences(rest)
                : { ok: false, error: trText("When source is \"media\", mediaId is required (the media id from list_media)") };
            } else if (source === "timeline" || source === undefined) {
              result = await api.seePreview(rest);
            } else {
              result = { ok: false, error: trText("source can only be \"timeline\" (final video frames) or \"media\" (shot mosaic of the media), received {0}", JSON.stringify(source)) };
            }
          }
          else if (tool === "get_gif") result = await getGif(args);
          // Web operations do not go through EditorApi: the browser lives entirely on the server, and these
          // tools touch no state of the editor. Hooking them into EditorApi would only force the editor side
          // to implement 8 pure-forwarding methods.
          else if (tool.startsWith("web_") || tool === "user_interface_web_handoff") result = await runWebTool(pageToolName(tool), args);
          else throw new Error(trText("Unknown tool: {0}", tool));
        } catch (err: unknown) {
          ok = false;
          if (err instanceof Error) {
            error = err.message;
          } else {
            error = String(err);
          }
        } finally {
          endAgentTool();
        }

        if (ok && tool !== "get_gif") result = await withVisual(tool, args, result, visualBefore);

        /*
         * Push this change to the data mirror before returning the result: when the Agent calls see_frames
         * right after an edit, the server renders from the mirror, and that must already be the edited copy
         * (read-after-write consistency). When nothing changed, this step sends nothing.
         */
        try { await flushDataMirror(); } catch { /*
 * A failed push does not affect this result; when the server has no fresh mirror, it falls back to
 * executing through the page
 */ }

        const opIds = pageOpIdsSince(opMark);
        // Which "cut->track" entries this call changed are carried back in the response: when the document
        // service is not connected, the server's bulletin board relies on it to record changes (A3; once
        // connected, the commit stream records them)
        let scopes: string[] = [];
        if (ok && before) {
          try { scopes = agentBus.diffScopes(before, getState().project); } catch { scopes = []; }
        }
        fetch("/api/mcp/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ok, result, error, ...(opIds.length ? { opIds } : {}), ...(scopes.length ? { scopes } : {}) })
        }).catch(() => {});

      }
    };

    source.onerror = () => {
      onStatus?.({ connected: false });
      if (source) source.close();
      if (active) {
        setTimeout(connect, 3000);
      }
    };
  };

  connect();

  return () => {
    active = false;
    stopTabReports();
    if (source) {
      source.close();
      source = null;
    }
  };
}
