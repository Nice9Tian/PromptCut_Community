/**
 * 在 Agent 服务端(编辑器 vite 进程)里载入页面那一套工具实现(C6.5 设计稿第 5 节:「用 vite 的 ssrLoadModule
 * 载入 src/mcp/handlers/* 和 store」)。
 *
 * `load(id)` 是 `server.ssrLoadModule`(测试里是自己起的 vite 服务器的同名方法)。每次执行工具前都调一遍:
 * 模块没被改过时 vite 直接回缓存;src 下的文件改了(含新建的定制卡),vite 把它和引用它的模块作废,下次载入即是新代码。
 *
 * 服务端的 store 是这个进程里的一份单例:执行器(`agent-exec.mjs`)在串行锁里先把项目副本放进去,跑完再取出来算差异。
 * 页面独有的状态(播放头、选区、面板)在这份 store 里只是缺省值,不代表页面;读它们的工具留在页面执行。
 */

/** 注册表要先于工具实现就位:卡片、部件都靠 import 时的副作用登记 */
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

/** 卡片的翻译、审查、语法检查:纯函数,在 `server/vite-plugin-cards.ts` 里(桌面版建卡用的同一份) */
let cardLibPromise = null;
export function loadCardLib(loadModule = null) {
  cardLibPromise ??= import(new URL('../vite-plugin-cards.ts', import.meta.url).href).catch(async (err) => {
    if (typeof loadModule !== 'function') throw err;
    return loadModule('/server/vite-plugin-cards.ts');
  });
  return cardLibPromise;
}

/** store 模块 → 它刚载入时的那份空项目(`clearProject` 放回去的就是它) */
const EMPTY_PROJECT = new WeakMap();

/**
 * @param {(id: string) => Promise<any>} load
 * @param {{ apiBase?: string }} [options] 工具实现里打编辑器接口用的地址(`src/mcp/apiUrl.ts`)
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
    /** 把项目放进服务端 store(不进撤销栈、不经同步挂钩) */
    setProject(project) {
      core.set({ project });
    },
    getProject() {
      return core.getState().project;
    },
    /**
     * 多个实例共用这一份 store 时(托管档,`agent-exec.mjs` 的 `isolateStore`)进锁先调:项目以外的页面状态
     * (播放头、选区、手动时长等)回到缺省值,撤销栈清空 —— 上一个实例的工具实现留下的东西不带给下一个。
     */
    resetStore() {
      core.set({ t: 0, playing: false, selection: [], filePath: null, dirty: false, durationManual: null, lastCamera3dFov: null });
      dropUndo();
    },
    /** 出锁时调:把项目换回刚载入时的空项目,store 里不留任何实例的内容 */
    clearProject() {
      core.set({ project: EMPTY_PROJECT.get(core), selection: [] });
      dropUndo();
    },
    /** 路由表里的工具 → EditorApi 方法;不在表里回 undefined */
    routeOf(tool) {
      return Object.hasOwn(routeTable, tool) ? routeTable[tool] : undefined;
    },
    async callRoute(tool, args) {
      const route = routeTable[tool];
      const fn = editorApi[route.method];
      if (typeof fn !== 'function') throw new Error(`服务端没有 ${tool} 的实现(${route.method})`);
      return route.passArgs ? fn(args) : fn();
    },
    /**
     * 把向页面要来的只读页面状态放进服务端 store(c65-integ2 裁定:既读页面状态又写项目的 5 个工具,
     * 写入在这里执行,页面状态向页面要一次):`t` 是页面播放头(切剪辑时存回被停放的那条);
     * `track` 是页面内存里 `track_points` 跑出来的轨迹(`attach_clip_motion` 读)。
     * 回一个收拾函数:跑完 handler 就把放进去的轨迹拿掉,不让它留在服务端(服务端没有作业表)。
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
    /** 项目总时长的规则(`src/kernel/duration.ts`):执行器按它在同一次写入里把总时长跟着内容更新(`settleDuration`) */
    durationRules: {
      contentEndOf: duration.contentEndOf,
      effectiveDuration: duration.effectiveDuration,
      manualDurationFor: duration.manualDurationFor,
    },
    frameLayoutOf: common.frameLayoutOf,
    stageSize: common.stageSize,

    /* ---------------- 托管档:项目自己的用户卡与素材登记(契约 cloud-agent-contract.md 第 9.3、9.4 节) ---------------- */

    /** 服务端卡片表里现有的卡片 id(检出里带的内置卡与随仓库的用户卡) */
    cardIds() {
      return registry.allCards().map((c) => c.id);
    },
    /**
     * 静态解析一份用户卡源码(`src/kernel/cardSourceParse.mjs`):取 id、名字、说明、参数默认值与控件,只认字面量,**不执行源码**。
     * `files(key)` 给它引到的同目录文件的源码。回 `[{ id, name, description?, defaults, controls, controlsIncomplete }]`。
     */
    parseCard(source, { key, files } = {}) {
      return cardParse.parseCardSource(source, { key, ...(typeof files === 'function' ? { files } : {}) });
    },
    /** 一份卡片源码经相对导入引到的文件(仓库相对路径) */
    cardImports(source, key) {
      return cardParse.cardSourceImports(source, key);
    },
    /**
     * 把一组静态解析出的用户卡临时登记进卡片表(只有数据:组件是个空壳,从不渲染),回撤掉它们的函数。
     * 与表里已有的 id 撞车的不登记(内置卡优先,和 `src/cards/index.ts` 的兜底一致)。只在进程级的锁里用。
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
    /** 登记一条已经入库的素材(不进撤销栈);回登记好的那一条 */
    addMedia(asset) {
      return store.actions.addMedia(asset);
    },
    /** 把一条素材放上时间轴(与桌面版导入视频后自动放一段相同);回片段或 null */
    addMediaClip(mediaId, start, opts = {}) {
      return store.actions.addMediaClip(mediaId, start, opts);
    },
    /**
     * 音效合成(契约第 9.4a 节):与桌面版同一份纯函数。`plan` 把 sound_generate 的参数变成配方与落点(只读传进来的项目);
     * `renderWav` 按块合成 PCM16 WAV;`commit` 在放好项目的 store 上原子登记素材与片段(只在进程级的锁里用)。
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
     * 卡片声音(契约第 9.4c 节):WAV 已经由渲染服务的工作进程算好、入了库,这里只在放好项目的 store 上原子登记
     * (与桌面版同一份 `commitCardAudio`;只在进程级的锁里用)。**这里不执行卡片代码。**
     */
    cardAudio: {
      commit: (args) => cardAudioActions.commitCardAudio({ ...args, loadToken: core.getState().projectLoadToken }),
    },
    /**
     * 测响度(契约第 9.4b 节):与桌面版同一份。`measureRequest` 按放好项目的 store 算出「测谁」(只在进程级的锁里用),
     * `measureFinish` 给量出来的数标上谁在出声。
     */
    audio: {
      measureRequest: (args) => common.measureAudioRequest(args),
      measureFinish: (req, data) => common.measureAudioFinish(req, data),
    },
    /**
     * 感知与一键流程的工具包(镜头、主体、一键流程;`server/agent/service/perception/`、`hosted-workflow.mjs`)要用的内核函数。
     * 那些文件不引用 `src/`:宿主从这里取来,经工厂参数 `kernel` 注入(契约第 2.1 节「载入缝」)。都是只读项目数据的纯函数。
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
     * 感知结果写回素材(与桌面版同一份 store 动作:换新对象,不原地改)。只在放好项目的 store 上、进程级的锁里用。
     */
    media: {
      setTranscript: (mediaId, transcript) => store.actions.setMediaTranscript(mediaId, transcript),
      setShots: (mediaId, shots) => store.actions.setMediaShots(mediaId, shots),
      setSubjects: (mediaId, subjects) => store.actions.setMediaSubjects(mediaId, subjects),
    },
    /** 一键流程落卡用的三个 store 动作(与桌面版 `src/mcp/tools/autoWorkflow.ts` 用的是同一份);只在进程级的锁里用 */
    workflow: {
      addCardClip: (cardId, start, opts = {}) => store.actions.addCardClip(cardId, start, opts),
      ensureCaptionTrack: () => store.actions.ensureCaptionTrack(),
      setProjectMeta: (meta) => store.actions.setProjectMeta(meta),
    },
    /** 此刻 store 里项目内容的末尾(秒):新导入的视频接在后面放 */
    contentEnd() {
      return duration.contentEndOf(core.getState().project.tracks ?? []);
    },
  };
}
