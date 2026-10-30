/**
 * 页面触发预渲染(`preload`)的调度:编辑推送成功、系统空闲时防抖发一次,没就绪就接着问。
 *
 * 为什么要页面来发:预渲染进程只有收到 `POST /api/frames/preload` 才为这一版项目开后台预渲染
 * (锚帧、控件快照、本地档、轨道流)。以前只有 legacy 预览(`UnifiedPreview`)发它,双舞台模式下没人发 ——
 * 重卡在真实使用里拿不到预渲染结果,兜底顺序常常一路退到占位符。
 *
 * 「编辑推送成功」由 `frameRequest` 保证:它先 `alignMirror()`(把没推的改动推上去并等它落地)再带
 * `{ session, localRev }` 发请求;镜像缺键(409)时整份重推一次。「空闲」= 不在播放、不在拖动(由调用方给):
 * 后台 lane 本来就给播放让路,播放中被打断的那一版会停在 `partial`,空闲之后再发一次就接着做。
 *
 * 调度本身是纯逻辑(计时器可注入),单测在 `prerenderPreload.test.mjs`;React 那一层在 `usePrerenderPreload.ts`。
 */

/** 编辑之后等这么久没有新的改动才发(防抖) */
export const PRELOAD_DEBOUNCE_MS = 800;
/** 还没就绪时隔多久再问一次 */
export const PRELOAD_POLL_MS = 2000;
/** 请求失败(预渲染进程重启等)之后隔多久重试 */
export const PRELOAD_RETRY_MS = 4000;
/** 一次后台请求不结算时释放单飞位；正常整段预渲染可能花数分钟 */
export const PRELOAD_REQUEST_TIMEOUT_MS = 6 * 60_000;

export interface PreloadStatus {
  status?: string;
  sampled?: number;
}

export interface PreloadDeps {
  /** 发一次 preload(调用方用 `frameRequest("preload", …, { target: "prerender", lane: "background" })`) */
  request(signal: AbortSignal): Promise<PreloadStatus>;
  /** 每次回包之后通知(legacy 预览拿它归档采样帧) */
  onStatus?(status: PreloadStatus): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface PreloadScheduler {
  /** 项目改了(新的一版要推给预渲染进程) */
  edited(): void;
  /** 空闲与否(不在播放、不在拖动) */
  setIdle(idle: boolean): void;
  dispose(): void;
}

export function createPreloadScheduler(deps: PreloadDeps): PreloadScheduler {
  let idle = false;
  /** 有还没发出去的一版(编辑过,或空闲之后要复查一次) */
  let dirty = true;
  let done = false;
  let inFlight = false;
  let disposed = false;
  let timer: unknown = null;
  let requestGeneration = 0;
  let activeAbort: AbortController | null = null;
  let activeWatchdog: unknown = null;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const arm = (ms: number) => {
    clear();
    timer = deps.setTimer(() => { timer = null; void run(); }, ms);
  };

  const run = async (): Promise<void> => {
    if (disposed || !idle || inFlight) return;
    inFlight = true;
    dirty = false;
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeAbort = controller;
    const watchdog = deps.setTimer(() => {
      activeWatchdog = null;
      if (disposed || generation !== requestGeneration) return;
      requestGeneration++;
      controller.abort();
      activeAbort = null;
      inFlight = false;
      if (idle) arm(PRELOAD_RETRY_MS);
    }, PRELOAD_REQUEST_TIMEOUT_MS);
    activeWatchdog = watchdog;
    let status: PreloadStatus | null = null;
    try {
      status = await deps.request(controller.signal);
    } catch {
      deps.clearTimer(watchdog);
      if (activeWatchdog === watchdog) activeWatchdog = null;
      if (generation !== requestGeneration) return;
      inFlight = false;
      activeAbort = null;
      if (!disposed && idle) arm(PRELOAD_RETRY_MS);
      return;
    }
    deps.clearTimer(watchdog);
    if (activeWatchdog === watchdog) activeWatchdog = null;
    if (generation !== requestGeneration) return;
    inFlight = false;
    activeAbort = null;
    if (disposed) return;
    try { deps.onStatus?.(status); } catch { /* 通知方出错不影响调度 */ }
    done = status?.status === "ready";
    if (!idle) return;
    // 请求在飞的时候又编辑了:按防抖再发一次;否则没就绪就接着问
    if (dirty) arm(PRELOAD_DEBOUNCE_MS);
    else if (!done) arm(PRELOAD_POLL_MS);
  };

  return {
    edited() {
      if (disposed) return;
      dirty = true;
      done = false;
      if (idle && !inFlight) arm(PRELOAD_DEBOUNCE_MS);
    },
    setIdle(next) {
      if (disposed || next === idle) return;
      idle = next;
      if (!idle) { clear(); return; }
      // 空闲了:播放中后台那一版可能停在 `partial`,复查一次(同样按防抖,拖动刚松手不马上抢)
      if (!done) dirty = true;
      if (dirty && !inFlight) arm(PRELOAD_DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      requestGeneration++;
      activeAbort?.abort();
      activeAbort = null;
      if (activeWatchdog !== null) deps.clearTimer(activeWatchdog);
      activeWatchdog = null;
      clear();
    },
  };
}
