/**
 * 编辑页面这一侧:把后台舞台的声音这一半(舞台 RPC 那头的 `stageSound.ts`)接成 `cardAudio.ts` 的隔离宿主
 * (`docs/plan/online-card-exec-contract.md` 3.5、第 6 节)。只有形状转换,不执行任何卡片代码。
 *
 *   const link = createIsolatedSoundLink({ render: (request) => 后台舞台的 RPC.synthCardAudio(request) });
 *   link.setState(舞台报来的状态);     // 载入结果变了就再叫;null = 这条线程没了(舞台换了、页面不能执行了)
 *   link.dispose();
 *
 * 接上之后同步来的用户卡与素材效果卡的声音照 B 的规则走:判轻的经这里在声音线程里合成,判重的用已有产物。
 *
 * 舞台报来的东西当不可信输入:状态按形状校验、截短;采样块的形状在 `cardAudio.ts` 里再核一遍。
 * 项目每个版本只随请求发一次(结构化克隆一份),之后只带键;舞台说没有这一版(它重起过)就带上项目重发一次。
 */
import { setIsolatedCardAudioHost, type CardAudioRequest, type IsolatedCardAudioHost } from "../../audio/cardAudio";

/** 舞台报来的声音状态(形状同 `src/online/cardRuntime/stageSound.ts` 的 `StageSoundState`) */
export interface IsolatedSoundState {
  ready: Record<string, string>;
  blocked: Record<string, string>;
}

export interface IsolatedSoundRpcRequest {
  projectKey: string;
  project?: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

export interface IsolatedSoundLink {
  setState(state: unknown): void;
  host(): IsolatedCardAudioHost;
  dispose(): void;
}

const NO_PROJECT = /没有这一版项目/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 舞台报来的状态 → 干净的一份(键是卡片 id,值是短字符串);形状不对回 null */
export function sanitizeSoundState(state: unknown): IsolatedSoundState | null {
  if (!isRecord(state)) return null;
  const pick = (v: unknown, max: number) => {
    const out: Record<string, string> = {};
    if (!isRecord(v)) return out;
    for (const [id, text] of Object.entries(v).slice(0, 500)) if (id && id.length <= 200 && typeof text === "string" && text) out[id] = text.slice(0, max);
    return out;
  };
  return { ready: pick(state.ready, 64), blocked: pick(state.blocked, 240) };
}

export function createIsolatedSoundLink(opts: { render: (request: IsolatedSoundRpcRequest, signal?: AbortSignal) => Promise<Float32Array> }): IsolatedSoundLink {
  let state: IsolatedSoundState | null = null;
  /** 项目对象 → 键(编辑页面的项目是不可变更新,一个对象就是一个版本) */
  const keys = new WeakMap<object, string>();
  const sent = new Set<string>();
  let seq = 0;
  const keyOf = (project: unknown): string => {
    const owner = project as object;
    let key = keys.get(owner);
    if (!key) { key = `p${++seq}`; keys.set(owner, key); }
    return key;
  };
  const host: IsolatedCardAudioHost = {
    runnable: (cardId) => !!state && Object.hasOwn(state.ready, cardId),
    blocker: (cardId) => (state && Object.hasOwn(state.blocked, cardId) ? state.blocked[cardId] : null),
    versionOf: (cardId) => (state && Object.hasOwn(state.ready, cardId) ? state.ready[cardId] : ""),
    async render(request: CardAudioRequest, signal) {
      const projectKey = keyOf(request.project);
      const base = { projectKey, nodeId: request.nodeId, start: request.start, count: request.count, sampleRate: request.sampleRate };
      const first = !sent.has(projectKey);
      sent.add(projectKey);
      if (sent.size > 64) { sent.clear(); sent.add(projectKey); }
      try {
        return await opts.render(first ? { ...base, project: request.project } : base, signal);
      } catch (err) {
        // 舞台那头重起过、手里没有这一版了:带上项目重发一次
        if (first || !NO_PROJECT.test(String((err as Error)?.message ?? err))) throw err;
        return opts.render({ ...base, project: request.project }, signal);
      }
    },
  };
  return {
    setState(next) {
      const clean = next === null ? null : sanitizeSoundState(next);
      // 没变就不惊动声音那一侧(换宿主会让所有在用的声音重新取一遍;舞台每载入一次包都会报一次状态)
      const same = (clean === null && state === null) || (!!clean && !!state && JSON.stringify(clean) === JSON.stringify(state));
      state = clean;
      // 舞台那头换了一批卡(或线程没了):之前发过的项目它不一定还留着,下一次带上项目
      sent.clear();
      if (!same) setIsolatedCardAudioHost(clean ? host : null);
    },
    host: () => host,
    dispose() {
      state = null;
      sent.clear();
      setIsolatedCardAudioHost(null);
    },
  };
}
