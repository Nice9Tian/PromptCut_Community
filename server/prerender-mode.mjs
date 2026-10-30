/**
 * 预渲染进程的三种模式(`docs/semantics/mechanism/rendering.md`「查询渲染与预渲染进程」;计划 `docs/plan/cloud-task.md` I1、I4(a))。
 *
 *   - `user`  :本机只有用户在编辑。只做预渲染(后台那一趟、队列任务、轨道流、AI 栏操作预览、3D 视图贴图),
 *              **不建 Agent lane**,Agent 的查询回 `503 NO_AGENT_LANE`。
 *   - `agent` :本机只有 Agent(或 Agent 云端环境)。只接 Agent 的查询,**不预渲染**:只建 Agent lane;
 *              `/preload` 回 `{ ok: true, skipped: 'agent' }`,其余预渲染的请求回 `503 NO_PRERENDER`;不起渲染节点、不产流。
 *   - `full`  :两者都在本机。三种都建,Agent 优先只是插队(现在的行为,缺省)。
 *
 * 模式名和 lane 名(`user` / `agent` / `background` …)同字不同物:这里的常量叫 `PRERENDER_MODE`,别和 lane 混。
 *
 * 由编辑器进程拉起预渲染进程时经环境变量 `PROMPTCUT_PRERENDER_MODE` 传进去(`vite-plugin-prerender.ts`);
 * Agent 云端环境不经编辑器进程,自己带 `PROMPTCUT_ROLE=prerender PROMPTCUT_PRERENDER_MODE=agent` 起。
 */

export const PRERENDER_MODE = Object.freeze({ USER: 'user', AGENT: 'agent', FULL: 'full' });
const MODES = new Set(Object.values(PRERENDER_MODE));

/** 规整一个模式值:认得的回小写模式名,认不得(含空)回 null */
export function parsePrerenderMode(value) {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase();
  return MODES.has(mode) ? mode : null;
}

/** 预渲染进程这一侧:按环境变量定自己的模式。没设或认不得都按 `full`(和加模式之前的行为相同) */
export function prerenderModeOf(env = process.env) {
  return parsePrerenderMode(env?.PROMPTCUT_PRERENDER_MODE) ?? PRERENDER_MODE.FULL;
}

/**
 * 编辑器进程拉起本机预渲染进程时选哪种模式(I4(a):用户机缺省一个进程,本机有 Agent 时 `full`,没有时 `user`)。
 *
 * 〔裁〕「本机有 Agent」按代码现状判:编辑器进程总是挂着 `vite-plugin-ai`(本机 Agent 的服务端工具就在编辑器进程里,
 * `vite.config.ts` 的插件表),桌面版与 dev server 都一样,所以缺省 `full`,现有用户看不出区别。
 * 编辑器进程的环境里显式给了合法的 `PROMPTCUT_PRERENDER_MODE` 时照它(排障、验收用;例如 `user` 表示不给本机 Agent 开查询)。
 */
export function localPrerenderMode(env = process.env) {
  return parsePrerenderMode(env?.PROMPTCUT_PRERENDER_MODE) ?? PRERENDER_MODE.FULL;
}

/** 这种模式接不接 Agent 的查询(建不建 Agent lane) */
export function modeServesAgent(mode) {
  return mode === PRERENDER_MODE.AGENT || mode === PRERENDER_MODE.FULL;
}

/** 这种模式做不做预渲染(后台那一趟、队列、流、用户的交互帧与播放、操作预览) */
export function modeServesPrerender(mode) {
  return mode === PRERENDER_MODE.USER || mode === PRERENDER_MODE.FULL;
}

/** 这种模式建哪些 lane(`FramePipeline.laneChains` 的键,外加 `'queue'` 与轨道流;只给诊断和单测看) */
export function lanesOfMode(mode) {
  const lanes = [];
  if (modeServesPrerender(mode)) lanes.push('user', 'background', 'queue', 'stream');
  if (modeServesAgent(mode)) lanes.push('agent');
  return lanes;
}

/**
 * 某条 lane 的请求在这种模式下被拒时的错误(`status` / `code` / `retryable`,路由原样回);不拒回 null。
 *
 * - Agent 的请求(`lane === 'agent'`)到了 `user` 模式:`503 NO_AGENT_LANE`(与编辑器进程没有 Agent lane 同一个码,
 *   调用方已经认它);不可重试 —— 模式在进程启动时定下,重试也还是这个进程。
 * - 预渲染的请求(其余 lane)到了 `agent` 模式:`503 NO_PRERENDER`,同样不可重试。
 */
export function modeRefusal(mode, lane) {
  if (lane === 'agent') {
    if (modeServesAgent(mode)) return null;
    return Object.assign(new Error(`这个预渲染进程是 ${mode} 模式,没有 Agent lane:不接 Agent 的查询。`),
      { status: 503, code: 'NO_AGENT_LANE', retryable: false, mode });
  }
  if (modeServesPrerender(mode)) return null;
  return Object.assign(new Error(`这个预渲染进程是 ${mode} 模式,只接 Agent 的查询,不做预渲染(请求的 lane:${lane})。`),
    { status: 503, code: 'NO_PRERENDER', retryable: false, mode });
}
