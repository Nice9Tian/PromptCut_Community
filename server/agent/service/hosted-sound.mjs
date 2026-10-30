/**
 * 云端 Agent 的音效合成(`sound_generate`、`sound_status`、`sound_cancel`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4a 节)。
 *
 * 提示音与键盘声的合成是确定性的纯计算(`src/kernel/soundEffects.ts`),不执行任何项目带来的代码,所以就在 Agent 服务进程里按块合成:
 *
 *   参数 →(`src/audio/soundRequest.ts`,与桌面版同一份)配方 →(`src/audio/soundGeneration.ts`,与桌面版同一份)PCM16 WAV
 *     → 凭成员本人的素材票据写进素材服务(`media`)→ 在项目副本上原子登记(`commitSoundEffect`,与桌面版同一份:配方、内容哈希、片段)。
 *
 * 所以同一份配方在云端与桌面版合成出的 WAV 逐样本相同(单测 CA-SND-01 比对)。
 *
 * 作业表按实例(项目 × 成员)分:一个项目的对话看不到、取消不了别的项目或别的成员的作业;作业号带随机数。
 * 合成在整个进程里同时只跑一个(`slot`),每块让出一次事件循环;一位成员在一个项目里最多排 4 个(与桌面版同一个数)。
 * 前端代码只经 `ssr-host.mjs`(`host.sound`)。
 */
import { randomBytes } from 'node:crypto';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'stale']);
const finished = (job) => TERMINAL.has(job.state);
const REDO = new Set(['failed', 'cancelled', 'stale']);

/** 进程级:同时只让一个作业占着(合成是 CPU 活,不让几个项目的合成把服务进程占满) */
export function createSlot() {
  let tail = Promise.resolve();
  return {
    /** 等到轮到自己;回放手的函数。`signal` 取消时不再等(已经排上的那一格照样让给后面) */
    acquire(signal) {
      let release;
      const mine = new Promise((resolve) => { release = resolve; });
      const before = tail;
      tail = before.then(() => mine);
      return new Promise((resolve, reject) => {
        const onAbort = () => { release(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        before.then(() => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) return;
          resolve(release);
        });
      });
    },
  };
}

/** 一个实例(项目 × 成员)的作业表 */
export const newSoundState = () => ({ jobs: new Map(), byRequest: new Map(), latest: new Map() });

const viewOf = (job) => ({
  id: job.id, jobId: job.id, requestId: job.requestId, state: job.state, progress: job.progress,
  ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: job.result } : {}),
});

/**
 * 一个对话的三个工具。
 * @param {object} d
 * @param {ReturnType<typeof newSoundState>} d.state 这个实例的作业表
 * @param {ReturnType<typeof createSlot>} d.slot 进程级的合成名额
 * @param {() => Promise<object>} d.host `ssr-host.mjs`
 * @param {() => Promise<{ project: object }>} d.snapshot 此刻的项目副本
 * @param {(track: object, apply: (host: object) => any) => Promise<any>} d.mutate 在项目副本上改并提交(`track` 是这次调用的事件上下文)
 * @param {() => Promise<void>} d.ensureCanWrite 只读成员在这里被拒
 * @param {(wav: Uint8Array) => Promise<{ hash: string, size: number }>} d.put 写进素材服务
 * @param {(row: object) => void} d.record 记一行用量
 * @param {new (message: string, extra?: object) => Error} d.ToolError
 * @param {{ pendingJobs?: number, historyJobs?: number }} [d.limits]
 */
export function createSoundTools({ state, slot, host, snapshot, mutate, ensureCanWrite, put, record = () => {}, ToolError = Error, limits = {} }) {
  const pendingMax = limits.pendingJobs ?? 4;
  const historyMax = limits.historyJobs ?? 8;

  function trim() {
    const done = [...state.jobs.values()].filter(finished);
    for (const old of done.slice(0, Math.max(0, done.length - historyMax))) {
      state.jobs.delete(old.id);
      if (state.byRequest.get(old.requestKey) === old.id) state.byRequest.delete(old.requestKey);
      if (state.latest.get(old.targetKey) === old.id) state.latest.delete(old.targetKey);
    }
  }

  async function run(job, plan, spec, h, track) {
    const signal = job.abort.signal;
    const t0 = Date.now();
    let bytes = 0;
    let release = null;
    const stale = () => state.latest.get(job.targetKey) !== job.id;
    try {
      release = await slot.acquire(signal);
      if (stale()) throw Object.assign(new Error('已有新的生成请求,旧结果未应用'), { stale: true });
      job.state = 'rendering';
      const wav = await h.sound.renderWav(plan.recipe, {
        signal,
        progress: (fraction) => { if (!signal.aborted) job.progress = fraction * 0.8; },
        yield: () => new Promise((resolve) => setImmediate(resolve)),
      });
      release(); release = null;
      signal.throwIfAborted();
      job.state = 'uploading'; job.progress = 0.8;
      bytes = wav.byteLength;
      const asset = await put(wav);
      signal.throwIfAborted();
      if (!/^[a-f0-9]{64}$/.test(asset.hash)) throw new Error('素材服务未返回有效内容哈希');
      const reuseKey = await h.sound.reuseDigest(plan.recipe);
      let result = null;
      await mutate(track, (hh) => {
        // 进锁之后再看一次:取消了、或有了更新的请求,这一份不落地
        signal.throwIfAborted();
        if (stale()) throw Object.assign(new Error('已有新的生成请求,旧结果未应用'), { stale: true });
        result = hh.sound.commit({
          ...spec,
          asset: {
            kind: 'audio', name: plan.name, hash: asset.hash, url: `/@media/${asset.hash}`, ext: 'wav', size: wav.byteLength,
            duration: plan.recipe.frames / plan.recipe.sampleRate, soundEffect: { recipe: plan.recipe, reuseKey },
          },
          link: { recipe: plan.recipe, reuseKey, requestId: job.requestId, ...(plan.sourceClipId ? { sourceClipId: plan.sourceClipId } : {}) },
        });
        return { ok: true };
      });
      job.state = 'succeeded'; job.progress = 1; job.result = result;
    } catch (err) {
      const message = String(err?.message ?? err);
      if (signal.aborted && job.state !== 'stale') { job.state = 'cancelled'; job.error = '已取消,原音效保持不变'; }
      else if (job.state === 'stale') { /* 被更新的请求顶掉时已经写好了原因 */ }
      else if (err?.stale || /已改变|已切换/.test(message)) { job.state = 'stale'; job.error = err?.stale ? message : `项目或片段已改变,旧生成结果未应用(${message})`; }
      else { job.state = 'failed'; job.error = message.slice(0, 300); }
    } finally {
      release?.();
      try {
        record({ service: 'sound', vendor: 'builtin', model: plan.recipe.preset, units: bytes, unit: 'bytes', ok: job.state === 'succeeded', ms: Date.now() - t0 });
      } catch { /* 记用量失败不影响结果 */ }
      trim();
    }
    return job;
  }

  async function generate(args, track) {
    const requestId = args?.requestId;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new ToolError('requestId 必须是 1 到 200 个字符');
    await ensureCanWrite();
    const h = await host();
    const { project: p } = await snapshot();
    let plan;
    try {
      plan = h.sound.plan(p, { ...args, requestId });
      h.sound.assertSize(plan.recipe);
    } catch (err) {
      throw new ToolError(String(err?.message ?? err).slice(0, 300));
    }
    const signature = h.sound.reuseKey(plan.recipe);
    const targetKey = `${p.activeCutId ?? ''}:${plan.target?.clip.id ?? requestId}`;
    const requestKey = `${targetKey}\0${requestId}`;
    const old = state.jobs.get(state.byRequest.get(requestKey) ?? '');
    if (old && !REDO.has(old.state)) {
      if (old.signature !== signature) throw new ToolError('requestId 已用于不同配方,修改后请使用新的 requestId');
      const resultCurrent = () => !!p.media?.some((m) => m.id === old.result?.mediaId)
        && (!old.result?.clipId || p.tracks?.some((t) => t.clips.some((c) => c.id === old.result.clipId && c.mediaId === old.result.mediaId)));
      if (old.state !== 'succeeded' || resultCurrent()) return viewOf(await old.done);
    }
    const pending = [...state.jobs.values()].filter((j) => !finished(j) && j.targetKey !== targetKey);
    if (pending.length >= pendingMax) throw new ToolError(`音效任务队列已满(最多 ${pendingMax} 个),请等待或取消`);
    for (const prior of state.jobs.values()) {
      if (prior.targetKey !== targetKey || finished(prior)) continue;
      prior.state = 'stale'; prior.error = '已有新的生成请求,旧结果未应用';
      prior.abort.abort();
    }
    const job = {
      id: `sound-${randomBytes(6).toString('hex')}`, requestId, targetKey, requestKey, signature,
      state: 'queued', progress: 0, error: undefined, result: undefined, abort: new AbortController(), done: null,
    };
    state.jobs.set(job.id, job); state.byRequest.set(requestKey, job.id); state.latest.set(targetKey, job.id);
    const spec = {
      projectId: p.id, cutId: p.activeCutId, expectedClip: plan.expectedClip, expectedSource: plan.expectedSource,
      replaceClipId: plan.target?.clip.id, start: plan.start, duration: plan.duration, mediaOffset: plan.mediaOffset,
      trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
    };
    job.done = run(job, plan, spec, h, track);
    return viewOf(await job.done);
  }

  const withOk = (view) => (view.state === 'succeeded' ? { ok: true, ...view } : finished(view) ? { ok: false, ...view, error: view.error ?? '音效没有生成' } : view);

  return {
    sound_generate: async (args, track) => withOk(await generate(args ?? {}, track ?? {})),
    sound_status: async (args) => {
      if (!args?.jobId) return { jobs: [...state.jobs.values()].map(viewOf) };
      const job = state.jobs.get(String(args.jobId));
      if (!job) throw new ToolError('找不到音效任务(服务重启后请从片段的配方重新生成)');
      return viewOf(job);
    },
    sound_cancel: async (args) => {
      const job = state.jobs.get(String(args?.jobId ?? ''));
      if (!job) throw new ToolError('找不到音效任务');
      if (!finished(job)) job.abort.abort();
      // 已经在提交的那一下不可分:等它落定再答,不回一个之后会变的状态
      const settled = await Promise.race([job.done, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
      return viewOf(settled ?? job);
    },
  };
}
