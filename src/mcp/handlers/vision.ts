import { startShotDetection, waitForShots } from "../../ai/shots";
import { scenesOf, planSequences, frameTimes, transcriptFor } from "../../ai/sequences";
import { EditorApi } from "../../ai/mcpExecutor";
import { prerenderUrl } from "../../render/prerender";
import { getState, actions } from "../../store/project";
import { subjectForRange } from "../../kernel/project";
import { cutLookView } from "../../kernel/agentScopes.mjs";
import { mediaCardUrl, isImageMedia } from "../../ai/mediaRef";
import { mediaReadyForServer, perceptionMediaRef } from "../../ai/perceptionMedia";

import { shotJobs, subjectDigest } from "../common";
import { apiUrl } from "../apiUrl";

export const visionHandlers = {
  seePreview: async (args) => {
    const state = getState();
    /*
     * cutId (user decision, 2026-10-21): no need to switch to view an inactive cut. What is passed to
     * render is a project view with "that cut treated as active", used only for generating the image
     * this time: does not enter the store or document sync, and leaves the playhead and active cut
     * untouched. When t is omitted, takes the playhead from when that cut was last left.
     */
    if (args?.cutId !== undefined && args?.cutId !== null && typeof args.cutId !== "string") throw new Error("cutId must be a string (the cut id from list_cuts); if omitted, the currently active cut is used.");
    if (args?.view !== undefined && args?.view !== null && args.view !== "camera" && args.view !== "space") {
      throw new Error(`view must be "camera" or "space", received ${JSON.stringify(args.view)}`);
    }
    const view = args?.view === "space" ? "space" : args?.view === "camera" ? "camera" : undefined;
    const look = cutLookView(state.project, args?.cutId);
    const project = look.project;
    const playheadT = look.active ? state.t : (look.parkedT ?? 0);
    /*
     * This is a fallback: when a data mirror exists, see_frames is queried directly by the server from
     * prerender (server tool in vite-plugin-ai), without going through this page at all. When reaching
     * here, it is also sent to the prerender origin, and released after 180s like the tool limit: after
     * releasing, the connection closes, and prerender drops still-queued jobs without wasting a Chrome.
     */
    const snap = async (t: number | undefined) => {
      const res = await fetch(await prerenderUrl("/api/vision/snapshot"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          t: t ?? (args?.clipId ? undefined : playheadT),
          clipId: args?.clipId,
          ...(view ? { view } : {}),
        }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Failed to render frame (HTTP ${res.status})`);
      return { ...data, cut: look.cut };
    };
    /*
     * times: view multiple timestamps at once. A reviewer needs to compare multiple timestamps to
     * judge shot pacing; calling one by one is too slow and prone to oversights. **One request,
     * rendered in a single pass on the server** (advancing from frame 0, capturing these frames along
     * the way), with each labeled with its timestamp. Previously, each timestamp was requested
     * separately, re-advancing from frame 0 every time, multiplying the advance cost by the number of
     * timestamps. Capped at 10 images, aligned with screenshots kept in the harness: with more, earlier
     * ones get pushed out.
     */
    const times = Array.isArray(args?.times) ? args.times.filter((x: unknown) => typeof x === "number").slice(0, 10) : [];
    if (times.length) {
      const res = await fetch(await prerenderUrl("/api/vision/snapshot"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, times, clipId: args?.clipId, ...(view ? { view } : {}) }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Failed to render frame (HTTP ${res.status})`);
      return { ok: true, frames: data.frames, note: data.note, ...(data.view ? { view: data.view } : {}), __images: data.__images, cut: look.cut };
    }
    return snap(typeof args?.t === "number" ? args.t : undefined);
  },
  /**
   * Render the visuals into an image for the model to inspect.
   *
   * project is passed from here rather than letting the server read it itself: the true timeline
   * lives in the browser store, and the copy held by the server (from the last save) may already be
   * stale: letting the model see an outdated image is worse than not showing it one at all.
   */
  /**
   * Inspect media: provide paginated contact sheets by shot to the model (planned in
   * src/ai/sequences.ts; sheets are made by /api/vision/sheet using ffmpeg). If shot detection has
   * not been run, run it here and wait for it: the model needs to see the visuals, don't make it
   * learn a "start job, poll" workflow first; if detection fails, fall back to fixed 10-second
   * segments, marking fallback in the response so it knows the boundaries are not real shots.
   */
  seeSequences: async (args) => {
    let media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    /*
     * For images, return the image itself directly. Previously, only video was recognized: images were
     * either rejected, or (for legacy jpgs incorrectly registered as video) ran shot detection to get a
     * 0.04-second "shot": the model decided that "cannot extract visuals" and turned to Read disk paths
     * instead. Fetching in the editor page can get both blob: and /@media; the long edge is scaled down
     * to 1280, clear enough to see without blowing up context.
     */
    if (isImageMedia(media)) {
      const src = media.url || mediaCardUrl(media);
      if (!src) throw new Error(`${media.name} has no fetchable address (upload not finished?), try again later`);
      const r = await fetch(src);
      if (!r.ok) throw new Error(`Failed to fetch image (HTTP ${r.status}): ${media.name}`);
      const bmp = await createImageBitmap(await r.blob());
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
      return {
        ok: true,
        mediaId: media.id,
        name: media.name,
        kind: "image",
        width: bmp.width,
        height: bmp.height,
        cardUrl: mediaCardUrl(media),
        note: "This is an image, shown below as is (long edge scaled down to within 1280). To use it in card parameters, fill in cardUrl.",
        __images: [{ sceneIndex: 1, label: "Original image", mime: "image/jpeg", base64 }],
      };
    }
    if (media.kind !== "video") throw new Error(`${media.name} is not a video, there are no frames to view`);
    // Newly imported media must wait until stored (the model may call here right after import_media
    // returns): wait up to 15 seconds. Shot detection fetches bytes via asset service, looking at
    // pending / hash / address, not disk paths (see ai/perceptionMedia.ts)
    for (let i = 0; i < 30 && !mediaReadyForServer(media); i++) {
      await new Promise((r) => setTimeout(r, 500));
      media = getState().project.media.find((m) => m.id === args.mediaId) ?? media;
    }
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`);
    const notes: string[] = [];
    let shots = media.shots ?? null;
    if (!shots) {
      const pending = shotJobs.get(args.mediaId);
      try {
        let jobId = pending && !pending.error ? pending.jobId : "";
        if (!jobId) {
          jobId = await startShotDetection(perceptionMediaRef(media));
          shotJobs.set(args.mediaId, { jobId, percent: 0, engine: "scdet" });
        }
        const result = await waitForShots(jobId, (percent, engine) => shotJobs.set(args.mediaId, { jobId, percent, engine }));
        actions.setMediaShots(args.mediaId, result);
        shotJobs.delete(args.mediaId);
        shots = result;
        notes.push(`Shot detection just finished (${result.engine}), ${result.shots.length} shots in total.`);
      } catch (e) {
        notes.push(`Shot detection failed (${e instanceof Error ? e.message : String(e)}), below it is split into 10-second segments, the boundaries are not real shots.`);
      }
    }
    const { scenes: all, fallback } = scenesOf(shots, media.duration ?? 0);
    if (!all.length) throw new Error(`${media.name} has no picture to view (duration is 0?)`);
    const plan = planSequences(all, args);
    // Request sheets one by one, at most 3 in parallel: each is an ffmpeg invocation, opening all at
    // once would crush the machine
    const results: any[] = new Array(plan.scenes.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= plan.scenes.length) return;
        const sc = plan.scenes[i];
        try {
          const r = await fetch(await prerenderUrl("/api/vision/sheet"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ media: { id: media.id, name: media.name, kind: media.kind, url: media.url, path: media.path }, start: sc.start, end: sc.end, grid: plan.grid }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
          results[i] = d;
        } catch (e) {
          results[i] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const images: { sceneIndex: number; mime: string; base64: string }[] = [];
    const scenesOut = plan.scenes.map((sc, i) => {
      const r = results[i];
      if (r?.__image?.base64) images.push({ sceneIndex: sc.index, mime: r.__image.mime || "image/jpeg", base64: r.__image.base64 });
      const text = transcriptFor(media.transcript, sc.start, sc.end);
      return {
        index: sc.index,
        start: sc.start,
        end: sc.end,
        duration: Math.round((sc.end - sc.start) * 100) / 100,
        in: sc.inTransition,
        out: sc.outTransition,
        frames: r?.frames ?? frameTimes(sc.start, sc.end, plan.grid),
        ...(text ? { transcript: text } : {}),
        subject: subjectDigest(subjectForRange(media.subjects, sc.start, sc.end)),
        ...(r?.error ? { imageError: r.error } : {}),
      };
    });
    return {
      ok: true,
      mediaId: media.id,
      name: media.name,
      engine: shots?.engine ?? null,
      ...(fallback ? { fallback } : {}),
      page: plan.page, pages: plan.pages, perPage: plan.perPage, grid: plan.grid,
      nextPage: plan.nextPage, prevPage: plan.prevPage,
      matched: plan.matched, totalScenes: plan.totalScenes,
      scenes: scenesOut,
      note: [
        ...notes,
        `Each contact sheet corresponds to the shot with the same index in scenes; cells, row by row from left to right, correspond to the seconds in frames.`,
        plan.nextPage ? `${plan.pages - plan.page} more pages: see_frames({ source: "media", mediaId, page: ${plan.nextPage} }).` : "This is the last page.",
        "If a shot is hard to see: see_frames({ source: 'media', mediaId, scene: index, grid: 9 }).",
        !media.transcript ? "This media has not been transcribed yet; to check what is said, run transcribe_media first." : "",
      ].filter(Boolean).join(" "),
      __images: images,
    };
  },
  bakeCard: async (args) => {
    // Fallback path: when a data mirror exists, bake_card is queried directly by the server from
    // prerender. Here it is also sent to the prerender origin, released at 150 seconds (tool limit)
    const res = await fetch(await prerenderUrl("/api/vision/bake"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: getState().project,
        clipId: args.clipId,
        t: args.t,
        size: args.size,
        bg: args.bg,
      }),
      signal: AbortSignal.timeout(150000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Render failed (HTTP ${res.status})`);
    return data;
  },
  /**
   * Read-only view of a card's DOM tree at a specific moment (each node labeled with its source code
   * location). project is passed from here for the same reason as see_frames: the true timeline lives
   * in the browser store, and the copy held by the server (from the last save) may already be stale.
   */
  inspectCardDom: async (args) => {
    const ref = typeof args.ref === "string" ? Number(String(args.ref).replace(/^ref_/, "")) : args.ref;
    // Fallback path: when a data mirror exists, the server queries prerender directly. Here it is also
    // sent to the prerender origin, released at 60 seconds (tool limit)
    const res = await fetch(await prerenderUrl("/api/cards/dom"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: getState().project, clipId: args.clipId, t: args.t, ref, depth: args.depth }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Cannot read the DOM tree (HTTP ${res.status})`);
    return data;
  },
  cardAuthoringGuide: async () => {
    const res = await fetch(apiUrl("/api/cards/guide"));
    if (!res.ok) throw new Error(`Cannot get the card authoring guide (HTTP ${res.status})`);
    return { guide: await res.text() };
  },
} satisfies Partial<EditorApi>;
