/**
 * 在线双舞台的两个舞台(C10 契约 `docs/plan/c10-contract.md` 第 2 节;语义 `mechanism/rendering.md`「舞台」:舞台有两个)。
 *
 * - **舞台源**:两个舞台 A、B 各用一个源,与编辑器页同站跨源,三方的响应都带 `Origin-Agent-Cluster: ?1`(nginx 或本机代理加)。
 *   页面从运行配置 `/editor/runtime-config.json` 取舞台源(`cloud/scripts/remote/docservice.mjs deploy-hosted --stage-origins` 写进去):
 *
 *       { "v": 1, "stageOrigins": ["https://s1.<主机>", "https://s2.<主机>"] }
 *
 *   同一份配置里另有托管方的总开关 `"onlineCardExec": false`(契约 `online-card-exec-contract.md`;缺省开):关掉就不在线执行用户卡与素材效果卡,
 *   整体退回原来的做法(`parseCardExecSwitch`)。
 *
 * - **跨源隔离**:所有舞台一律跨源隔离，撤掉退回同源单舞台的路（2026-10-14 用户定）。读不到配置、配置不对时不挂载舞台；
 *   握手失败退回跨源单舞台 A（只管当次，不留崩溃记录）。
 * - **舞台闸门停在第一级**（精简模式、低配模式，`onlineTier.ts`）:只开单舞台 A,不开后台舞台 B,单舞台 A 同样必须是跨源隔离舞台。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor;不读 `import.meta.env`(调用方把 `base` 传进来)。
 */

export type StageLetter = "A" | "B";
export type StageOrigins = Record<StageLetter, string>;
/**
 * 首次握手的进度。`interim` 过渡期已撤销（所有舞台一律跨源隔离，不再退回同源单舞台；2026-10-14 用户定）。
 */
export type Handshake = "pending" | "interim" | "ok" | "failed";
export type StageLayout = "dual" | "single";

/** 运行配置的文件名(相对在线构建的 base,即 `/editor/`) */
export const RUNTIME_CONFIG_FILE = "runtime-config.json";
/** 取运行配置的时限 */
export const RUNTIME_CONFIG_TIMEOUT_MS = 5000;
/** 每个舞台从自己 iframe 的 `load` 起等握手的时限;过了算握手失败,退回跨源单舞台 A(计时与总上限见 `stageHandshake.ts`) */
export const STAGE_HANDSHAKE_TIMEOUT_MS = 20_000;

/** 一个源:`http(s)://host[:port]`,不带路径、查询与片段 */
function originOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v.trim().replace(/\/+$/, "");
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
    return u.origin === text ? text : null;
  } catch {
    return null;
  }
}

/**
 * 运行配置 → 两个舞台源。收解析后的对象或 JSON 文本;`stageOrigins` 要是两个不同的合法源(数组,或 `{ A, B }`)。
 * 读不到或不合法回 null,不抛。
 */
export function parseStageOrigins(config: unknown): StageOrigins | null {
  let c: unknown = config;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { return null; }
  }
  if (!c || typeof c !== "object") return null;
  const raw = (c as { stageOrigins?: unknown }).stageOrigins;
  let a: unknown, b: unknown;
  if (Array.isArray(raw)) {
    if (raw.length !== 2) return null;
    [a, b] = raw;
  } else if (raw && typeof raw === "object") {
    a = (raw as { A?: unknown }).A;
    b = (raw as { B?: unknown }).B;
  } else {
    return null;
  }
  const A = originOf(a), B = originOf(b);
  if (!A || !B || A === B) return null;
  return { A, B };
}

/**
 * 运行配置里的总开关「在线执行用户卡与素材效果卡」(托管方可关):只有明写 `"onlineCardExec": false` 才是关,没写、写别的值、
 * 配置不是对象都按缺省(开)。读不到配置时没有舞台源,本来就是同源单舞台、不执行,所以「读不到」不用另判。
 */
export function parseCardExecSwitch(config: unknown): boolean {
  let c: unknown = config;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { return true; }
  }
  if (!c || typeof c !== "object") return true;
  return (c as { onlineCardExec?: unknown }).onlineCardExec !== false;
}

/**
 * 开几个舞台:舞台闸门停在第一级(`single`)只开跨源 A,不开后台 B;握手失败退回跨源 A;没有舞台源(读不到配置)或与编辑器页同源
 * 也回 single(调用方据 `origins` 判出不挂载,不挂同源单舞台);其余双舞台(握手进行中也按双舞台挂 iframe)。
 * `pageOrigin` 给了时,舞台源不能与编辑器页同源(那就不是跨源隔离,按读不到处理)。
 */
export function stageLayout({ single, origins, handshake, pageOrigin }: { single: boolean; origins: StageOrigins | null; handshake?: Handshake; pageOrigin?: string }): StageLayout {
  if (single) return "single";
  if (!origins) return "single";
  if (pageOrigin && (origins.A === pageOrigin || origins.B === pageOrigin)) return "single";
  if (handshake === "failed" || handshake === "interim") return "single";
  return "dual";
}

/**
 * 素材服务的基址交给跨源舞台时换成相对地址:舞台一律读**自己源上**反代的 `/media`(C10 契约第 2 节「舞台读素材」:
 * 同源读、不靠 CORS,媒体画进 canvas 不污染)。基址与编辑器页同源时回路径部分;不同源(素材服务在别的主机上)原样。
 */
export function stageAssetBase(base: string, pageOrigin: string): string {
  try {
    const u = new URL(base);
    if (u.origin !== pageOrigin) return base;
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ 本页的状态 */

interface State {
  /** 运行配置:还没取 / 在取 / 取完(可能没有舞台源) */
  config: "idle" | "loading" | "done";
  origins: StageOrigins | null;
  handshake: Handshake;
  /** 握手失败时的原因(诊断) */
  reason: string | null;
  /** 托管方的总开关:在线执行用户卡与素材效果卡(缺省开;运行配置里 `onlineCardExec: false` 才关) */
  cardExec: boolean;
  /** 什么时候进的 `interim`(`Date.now()`);没进过为 null。换回双舞台之后仍留着(Preview 据此做换回那一下的画面衔接) */
  interimAt: number | null;
}

let state: State = { config: "idle", origins: null, handshake: "pending", reason: null, cardExec: true, interimAt: null };
const listeners = new Set<() => void>();
let loading: Promise<StageOrigins | null> | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
}

export function onlineStageState(): Readonly<State> {
  return state;
}

export function subscribeOnlineStages(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 取运行配置(页面载入时调一次;`base` 是在线构建的 base,缺省 `/editor/`)。取不到、超时、不合法都当没有舞台源。
 */
export function loadStageConfig({ base = "/editor/", fetchImpl, timeoutMs = RUNTIME_CONFIG_TIMEOUT_MS }: { base?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<StageOrigins | null> {
  if (loading) return loading;
  set({ config: "loading" });
  let cardExec = true;
  const f = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  loading = (async () => {
    if (!f) return null;
    const url = `${base.replace(/\/?$/, "/")}${RUNTIME_CONFIG_FILE}`;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
      const res = await f(url, { cache: "no-store", signal: ctrl?.signal });
      if (!res.ok) return null;
      const text = await res.text();
      cardExec = parseCardExecSwitch(text);
      return parseStageOrigins(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().then((origins) => {
    set({ config: "done", origins, cardExec });
    return origins;
  });
  return loading;
}

/**
 * 舞台握手的结果(Preview 报):失败本页会话内不再试,不退回同源单舞台。
 * `interim` 只能从 `pending` 进(换回双舞台之后再出问题不回 `interim`,照看守走 `failed`,不来回切)。
 */
export function markStageHandshake(result: Exclude<Handshake, "pending">, reason: string | null = null): void {
  if (state.handshake === result) return;
  if (state.handshake === "failed") return;
  if (result === "interim") {
    if (state.handshake !== "pending") return;
    set({ handshake: result, reason, interimAt: Date.now() });
    return;
  }
  set({ handshake: result, reason: result === "ok" ? null : reason });
}

/** 测试用 */
export function resetOnlineStagesForTest(next: Partial<State> = {}): void {
  loading = null;
  state = { config: "idle", origins: null, handshake: "pending", reason: null, cardExec: true, interimAt: null, ...next };
  listeners.clear();
}
