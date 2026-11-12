/**
 * Load the page's tool implementations in the Agent server (editor vite process) (Section 5 of
 * C6.5 design draft: "use vite's ssrLoadModule to load src/mcp/handlers/* and store").
 *
 * `load(id)` is `server.ssrLoadModule` (in tests, the same-named method on a self-started vite
 * server). Called before executing each tool: if the module was not modified, vite returns cache
 * directly; if files under src changed (including newly created custom cards), vite invalidates
 * it and modules importing it, so the next load gets new code.
 *
 * Server-side store is a singleton in this process: executor (`agent-exec.mjs`) first puts the
 * project replica into it under a serial lock, and retrieves it after running to compute diff.
 * Page-exclusive states (playhead, selection, panels) are only default values in this store and do
 * not represent the page; tools reading them remain executed on the page.
 */

/**
 * Registry must be in place before tool implementations: cards and parts both rely on side
 * effects during import to register.
 */
const REGISTRIES = ['/src/cards/index.ts', '/src/parts/index.ts'];

export { diffScopes, overlappingScopes, splitScopes, scopeOverlaps, parkedCutsIndex, cutLookView } from '../../src/kernel/agentScopes.mjs';
export {
  CREATIVITY_HINT,
  CREATIVITY_LABEL,
  creativityAllows,
  creativityRank,
  effectiveCreativity,
  normalizeCreativity,
  projectCreativity,
} from '../../src/kernel/creativity.mjs';
export const ROLES_DIR = new URL('../../src/ai/roles/', import.meta.url);

/** Card translation, review, and syntax check: pure functions in `server/vite-plugin-cards.ts` (the same copy used by the desktop app when creating cards) */
let cardLibPromise = null;
export function loadCardLib(loadModule = null) {
  cardLibPromise ??= import(new URL('../vite-plugin-cards.ts', import.meta.url).href).catch(async (err) => {
    if (typeof loadModule !== 'function') throw err;
    return loadModule('/server/vite-plugin-cards.ts');
  });
  return cardLibPromise;
}

/** store module → the empty project from when it was first loaded (this is what `clearProject` puts back) */
const EMPTY_PROJECT = new WeakMap();

/**
 * @param {(id: string) => Promise<any>} load
 * @param {{ apiBase?: string }} [options] URL used by tool implementations to call editor APIs (`src/mcp/apiUrl.ts`)
 */
export async function loadSsrHost(load, { apiBase } = {}) {
  for (const id of REGISTRIES) await load(id);
  const [core, api, routes, diff, common, apiUrl, duration, registry, cardParse, store, soundRequest, soundGeneration, soundEffects, cardAudioActions, kernelProject, kernelLayout] = await Promise.all([
    load('/src/store/core.ts'),
    load('/src/mcp/api.ts'),
    load('/src/mcp/routes.mjs'),
    load('/src/kernel/diffProject.ts'),
    load('/src/mcp/common.ts'),
    load('/src/mcp/apiUrl.ts'),
    load('/src/kernel/duration.ts'),
    load('/src/kernel/registry.ts'),
    load('/src/kernel/cardSourceParse.mjs'),
    load('/src/store/project.ts'),
    load('/src/audio/soundRequest.ts'),
    load('/src/audio/soundGeneration.ts'),
    load('/src/kernel/soundEffects.ts'),
    load('/src/store/actions/cardAudio.ts'),
    load('/src/kernel/project.ts'),
    load('/src/kernel/layout.ts'),
  ]);
  if (apiBase) apiUrl.setApiBase(apiBase);
  if (!EMPTY_PROJECT.has(core)) EMPTY_PROJECT.set(core, core.getState().project);
  const dropUndo = () => {
    if (Array.isArray(core.history)) core.history.length = 0;
    if (Array.isArray(core.future)) core.future.length = 0;
  };
  const editorApi = api.editorApi;
  const routeTable = routes.TOOL_ROUTES;
  return {
    /** Put the project into the server store (does not enter the undo stack, does not go through sync hooks) */
    setProject(project) {
      core.set({ project });
    },
    getProject() {
      return core.getState().project;
    },
    /**
     * Called first upon entering the lock when multiple instances share this store (hosted tier,
     * `isolateStore` in `agent-exec.mjs`): page state outside the project (playhead, selection,
     * manual duration, etc.) resets to defaults, and the undo stack is cleared: nothing left by
     * the previous instance's tool implementation is carried over to the next.
     */
    resetStore() {
      core.set({ t: 0, playing: false, selection: [], filePath: null, dirty: false, durationManual: null, lastCamera3dFov: null });
      dropUndo();
    },
    /** Called when exiting the lock: swaps the project back to the empty project from initial load, leaving no instance content in the store */
    clearProject() {
      core.set({ project: EMPTY_PROJECT.get(core), selection: [] });
      dropUndo();
    },
    /** Tools in the routing table → EditorApi methods; returns undefined if not in the table */
    routeOf(tool) {
      return Object.hasOwn(routeTable, tool) ? routeTable[tool] : undefined;
    },
    async callRoute(tool, args) {
      const route = routeTable[tool];
      const fn = editorApi[route.method];
      if (typeof fn !== 'function') throw new Error(`The server has no implementation of ${tool} (${route.method})`);
      return route.passArgs ? fn(args) : fn();
    },
    /**
     * Puts read-only page state requested from the page into the server store (c65-integ2 ruling:
     * for the 5 tools that both read page state and write to the project, writes are performed here,
     * and page state is requested once from the page): `t` is the page playhead (saved back to the
     * parked cut when switching cuts); `track` is the trajectory produced by `track_points` in page
     * memory (read by `attach_clip_motion`). Returns a cleanup function: removes the inserted
     * trajectory once the handler finishes, preventing it from lingering on the server (the server
     * has no jobs table).
     */
    setPageState(ps = {}) {
      core.set({ t: typeof ps.t === 'number' && Number.isFinite(ps.t) ? ps.t : 0, playing: false, selection: [], durationManual: null });
      const mediaId = ps.track && typeof ps.track.mediaId === 'string' ? ps.track.mediaId : null;
      if (mediaId) {
        if (ps.track.result) common.trackResults.set(mediaId, ps.track.result);
        else common.trackResults.delete(mediaId);
        if (ps.track.running) common.trackJobs.set(mediaId, { jobId: 'page', percent: 0 });
        else common.trackJobs.delete(mediaId);
      }
      return () => {
        if (!mediaId) return;
        common.trackResults.delete(mediaId);
        common.trackJobs.delete(mediaId);
      };
    },
    diffProject: diff.diffProject,
    /** Rules for project total duration (`src/kernel/duration.ts`): the executor follows them to update total duration alongside content in the same write (`settleDuration`) */
    durationRules: {
      contentEndOf: duration.contentEndOf,
      effectiveDuration: duration.effectiveDuration,
      manualDurationFor: duration.manualDurationFor,
    },
    frameLayoutOf: common.frameLayoutOf,
    stageSize: common.stageSize,

    /* ---------------- Hosted tier: project user cards and asset registration (contract cloud-agent-contract.md, sections 9.3 and 9.4) ---------------- */

    /** Existing card IDs in the server card table (built-in cards from checkout and user cards shipped with the repo) */
    cardIds() {
      return registry.allCards().map((c) => c.id);
    },
    /**
     * Statically parses user card source code (`src/kernel/cardSourceParse.mjs`): extracts id, name,
     * description, parameter defaults, and controls; recognizes only literals;
     * **does not execute source code**. `files(key)` provides source code for files in the same
     * directory referenced by it. Returns `[{ id, name, description?, defaults, controls, controlsIncomplete }]`.
     */
    parseCard(source, { key, files } = {}) {
      return cardParse.parseCardSource(source, { key, ...(typeof files === 'function' ? { files } : {}) });
    },
    /** Files referenced via relative imports by card source code (repository-relative paths) */
    cardImports(source, key) {
      return cardParse.cardSourceImports(source, key);
    },
    /**
     * Temporarily registers a set of statically parsed user cards into the card table (data only:
     * the component is an empty shell and never renders); returns a function to unregister them.
     * Cards that collide with existing IDs in the table are not registered (built-in cards take
     * priority, consistent with the fallback in `src/cards/index.ts`). Used only within process-level locks.
     */
    registerProjectCards(parsed) {
      const taken = new Set(registry.allCards().map((c) => c.id));
      const defs = [];
      for (const p of Array.isArray(parsed) ? parsed : []) {
        if (!p || typeof p.id !== 'string' || taken.has(p.id)) continue;
        taken.add(p.id);
        defs.push({
          id: p.id, name: p.name, description: typeof p.description === 'string' ? p.description : '', source: 'user',
          defaults: p.defaults && typeof p.defaults === 'object' ? p.defaults : {},
          controls: Array.isArray(p.controls) ? p.controls : [],
          Component: () => null,
        });
      }
      if (!defs.length) return () => {};
      registry.registerCards(defs);
      return () => registry.unregisterCards(defs.map((d) => d.id));
    },
    /** Registers an asset already stored in the library (does not enter the undo stack); returns the registered item */
    addMedia(asset) {
      return store.actions.addMedia(asset);
    },
    /** Places an asset onto the timeline (same as the desktop app automatically placing a clip after importing video); returns a clip or null */
    addMediaClip(mediaId, start, opts = {}) {
      return store.actions.addMediaClip(mediaId, start, opts);
    },
    /**
     * Sound effect synthesis (contract section 9.4a): same pure functions as the desktop app.
     * `plan` turns sound_generate parameters into recipes and drop targets (read-only on the passed-in
     * project); `renderWav` synthesizes PCM16 WAV in chunks; `commit` atomically registers assets
     * and clips on the store with the project loaded (used only within process-level locks).
     */
    sound: {
      plan: (project, options) => soundRequest.planSoundGeneration(project, options),
      renderWav: (recipe, options) => soundGeneration.renderSoundEffectWav(recipe, options),
      reuseDigest: (recipe) => soundGeneration.soundEffectReuseDigest(recipe),
      reuseKey: (recipe) => soundEffects.soundEffectReuseKey(recipe),
      assertSize: (recipe) => soundGeneration.assertSoundRecipeSize(recipe),
      commit: (spec) => store.actions.commitSoundEffect(spec),
    },
    /**
     * Card audio (contract section 9.4c): WAV has already been computed and stored in the library
     * by render service worker processes; here it only atomically registers on the store with the
     * project loaded (same `commitCardAudio` as the desktop app; used only within process-level locks).
     * **Card code is not executed here.**
     */
    cardAudio: {
      commit: (args) => cardAudioActions.commitCardAudio({ ...args, loadToken: core.getState().projectLoadToken }),
    },
    /**
     * Loudness measurement (contract section 9.4b): same as the desktop app. `measureRequest` calculates
     * "who to measure" from the store with the project loaded (used only within process-level locks);
     * `measureFinish` tags the measured values with who is outputting sound.
     */
    audio: {
      measureRequest: (args) => common.measureAudioRequest(args),
      measureFinish: (req, data) => common.measureAudioFinish(req, data),
    },
    /**
     * Kernel functions needed by perception and one-click workflow toolkits (shots, subjects, one-click
     * workflow; `server/agent/service/perception/`, `hosted-workflow.mjs`). Those files do not import
     * `src/`: the host retrieves them from here and injects them via factory parameter `kernel` (contract
     * section 2.1 "loading seam"). All are pure functions that only read project data.
     */
    kernel: Object.freeze({
      subjectForRange: kernelProject.subjectForRange,
      suggestPosition: kernelProject.suggestPosition,
      MAX_SUBJECT_TIMES: kernelProject.MAX_SUBJECT_TIMES,
      subjectSampleTimes: kernelProject.subjectSampleTimes,
      rectForSafeSide: kernelLayout.rectForSafeSide,
      getCard: registry.getCard,
    }),
    /**
     * Writes perception results back to assets (same store action as the desktop app: replaces with
     * a new object, does not mutate in place). Used only on the store with the project loaded,
     * within process-level locks.
     */
    media: {
      setTranscript: (mediaId, transcript) => store.actions.setMediaTranscript(mediaId, transcript),
      setShots: (mediaId, shots) => store.actions.setMediaShots(mediaId, shots),
      setSubjects: (mediaId, subjects) => store.actions.setMediaSubjects(mediaId, subjects),
    },
    /** Three store actions used by one-click workflows to place cards (the same copy used by desktop app `src/mcp/tools/autoWorkflow.ts`); used only within process-level locks */
    workflow: {
      addCardClip: (cardId, start, opts = {}) => store.actions.addCardClip(cardId, start, opts),
      ensureCaptionTrack: () => store.actions.ensureCaptionTrack(),
      setProjectMeta: (meta) => store.actions.setProjectMeta(meta),
    },
    /** End of project content in the store at this moment (seconds): newly imported videos are placed after it */
    contentEnd() {
      return duration.contentEndOf(core.getState().project.tracks ?? []);
    },
    /** Commit a pre-rendered 3D cut `.mp4` asset into a new 2D cut on the loaded project replica */
    commitPrerenderedCutTo2D(cutId, data, opts = {}) {
      const sourceId = cutId || core.getState().project.activeCutId;
      const sourceCut = (core.getState().project.cuts ?? []).find((c) => c.id === sourceId);
      const { cut, media, clip } = store.actions.applyPrerenderedCutTo2D(cutId, data, { switchTo: false, ...opts });
      common.clipGuard.noteMutation();
      const listed = editorApi.listCuts();
      const p = core.getState().project;
      return {
        ok: true,
        sourceCutId: sourceCut?.id ?? sourceId,
        cut: { id: cut.id, name: cut.name, kind: '2d' },
        media: { id: media.id, name: media.name, cardUrl: media.url, duration: media.duration, width: media.width, height: media.height },
        clipId: clip.id,
        activeCutId: p.activeCutId,
        cuts: listed.cuts,
        note: `Pre-rendered 3D cut "${sourceCut?.name ?? sourceId}" into video asset "${media.name}" and placed it on Track 1 of new 2D cut "${cut.name}" (${cut.id}). The original 3D cut was kept untouched.`,
      };
    },
  };
}
