/**
 * 云端分组的同步引擎(裁定 V22-05～09,设计见 `docs/archive/agent-reports/AGENT-claude-groups-local-cloud.md`「方案」)。
 *
 * 云端存的是整份 `OrgState`(`realm: "cloud"`),按账号一份,接口是 `POST /hosted/shared/account/start-org` 的 `get` / `put`。
 * 本文件只管同步的逻辑,**不碰 React、不碰网络、不碰存储、不碰计时器**:这四样都由调用方注入,所以可以不起服务就单测
 * (`orgSync.test.mjs`)。React 一侧的薄壳在 `useCloudOrg.ts`,网络一侧是 `src/account/client.ts` 的 `getStartOrg` / `putStartOrg`。
 *
 * 流程:
 *   - **本机缓存优先**:界面一开就用 `loadOrg` 读到的那一份(它也是云端那份在这台浏览器里的缓存),不等网络。
 *   - **拉**(`refresh`:打开页面、登录、页面重新可见、网络恢复时):取云端当前那份。没有本机未传的改动就直接采用云端的;
 *     有就三方合并(`orgMerge.ts`)再传。云端什么都没存过(版本 0)而本机已经有内容(分组做在云端存储接上之前)就整份传上去。
 *   - **改动**(`changed`):先记「有没有传上去的改动」(`dirty`,存在本机),防抖约 1 秒后传。
 *   - **传**:带着上次拿到的版本号。成功:版本号更新。冲突(409,云端那份比我拿到的新):用带回来的那份三方合并,
 *     按它的版本号重传,最多重试几次。传的过程中又有新改动,传完仍标「有没传的」并再排一次。
 *   - **失败不弹窗**:服务端还没有这条路由(老服务端,404)→ `unsupported`:改动只留在本机,不报错、不重试,下次打开页面再探一次;
 *     连不上、5xx、令牌过期等 → `pending`:改动留着,隔一会儿再试,间隔逐次加倍到一分钟封顶,页面重新可见、网络恢复时也立刻试。
 *   - 同一时刻只跑一件事(串成一条链),不会两个请求互相抢着改本机的记录。
 *
 * 本机的同步记录(`SyncMeta`)和整理信息本身分两个键存:`{ version: 上次拿到的云端版本, base: 当时那一份, dirty: 有没有没传上去的 }`。
 * `base` 就是三方合并的「共同出发点」;读不到(第一次、记录丢了)就是 null,合并时两边的内容都算新增,不丢东西。
 */
import { mergeOrg } from "./orgMerge.ts";
import { emptyOrg, parseOrg, type OrgState } from "./vibeOrg.ts";

/** 云端回的一份:版本 0、org null 是没存过 */
export interface RemoteOrg {
  version: number;
  org: unknown | null;
}

/** `put` 的结果:成功回写入后的版本与那一份;冲突带回云端当前的 */
export type PutResult =
  | { conflict: false; version: number; org: unknown }
  | { conflict: true; version: number; org: unknown | null };

/**
 * 网络一侧。要求:连不上、服务出错抛任意错误(引擎当 `pending`);服务端没有这条路由(老服务端)抛 `OrgUnsupportedError`。
 */
export interface OrgTransport {
  get(): Promise<RemoteOrg>;
  put(baseVersion: number, org: OrgState): Promise<PutResult>;
}

/** 服务端还没有云端分组这条路由(404 等):引擎标 `unsupported`,不报错 */
export class OrgUnsupportedError extends Error {
  constructor(message = "这台云端服务还不支持云端分组") {
    super(message);
    this.name = "OrgUnsupportedError";
  }
}

export interface SyncMeta {
  /** 上次拿到(或写入)的云端版本;0 是云端什么都没存过 */
  version: number;
  /** 上次拿到(或写入)的那一份:三方合并的共同出发点 */
  base: OrgState | null;
  /** 本机有没有还没传上去的改动 */
  dirty: boolean;
}

/**
 * - `idle`        还没问过云端(刚打开)
 * - `syncing`     正在跟云端对
 * - `synced`      本机和云端一致
 * - `pending`     有改动没传上去(连不上等),隔一会儿会再试
 * - `unsupported` 云端服务还没有这条路由:只记在这台浏览器里,界面不报错
 */
export type SyncStatus = "idle" | "syncing" | "synced" | "pending" | "unsupported";

export interface OrgSyncOptions {
  transport: OrgTransport;
  /** 此刻界面上的整理信息(含没传上去的改动) */
  getOrg: () => OrgState;
  /** 合并出新的整理信息:界面换成它并写本机缓存。**不要**再把它当成一次用户改动(不要再调 `changed`) */
  applyOrg: (org: OrgState) => void;
  loadMeta: () => SyncMeta | null;
  saveMeta: (meta: SyncMeta) => void;
  onStatus?: (status: SyncStatus) => void;
  /** 排一个定时任务,回一个取消函数。缺省用 setTimeout */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** 改动之后等多久再传 */
  debounceMs?: number;
  /** 失败重试的间隔:第一次这么久,之后逐次加倍,到 maxRetryMs 封顶 */
  retryMs?: number;
  maxRetryMs?: number;
  /** 一次同步里遇到冲突最多重合并几次 */
  maxConflicts?: number;
}

export const SYNC_DEFAULTS = Object.freeze({ debounceMs: 1000, retryMs: 2000, maxRetryMs: 60_000, maxConflicts: 5 });

const keyOf = (org: OrgState): string => JSON.stringify([org.groups, org.projects, org.chats]);
const hasContent = (org: OrgState): boolean => org.groups.length + org.projects.length + org.chats.length > 0;

/** 云端回的东西不可信(服务端检查过,这里再认一遍):认不出来当没有 */
function readRemote(org: unknown): OrgState | null {
  if (org === null || org === undefined) return null;
  return parseOrg(JSON.stringify(org), "cloud");
}

export interface OrgSync {
  /** 打开、登录、页面重新可见、网络恢复时调:跟云端对一次 */
  refresh(): Promise<void>;
  /** 用户改了整理信息之后调(界面已经换成新的、本机缓存已经写了) */
  changed(): void;
  status(): SyncStatus;
  /** 不再排任何任务(换账号、卸载时调);正在跑的那一次跑完但不再回调 */
  stop(): void;
}

export function createOrgSync(options: OrgSyncOptions): OrgSync {
  const { transport, getOrg, applyOrg, loadMeta, saveMeta, onStatus } = options;
  const opt = {
    debounceMs: options.debounceMs ?? SYNC_DEFAULTS.debounceMs,
    retryMs: options.retryMs ?? SYNC_DEFAULTS.retryMs,
    maxRetryMs: options.maxRetryMs ?? SYNC_DEFAULTS.maxRetryMs,
    maxConflicts: options.maxConflicts ?? SYNC_DEFAULTS.maxConflicts,
  };
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });

  const loaded = loadMeta();
  let meta: SyncMeta = loaded ?? { version: 0, base: null, dirty: false };
  /**
   * 这台设备从没跟云端对过(没有同步记录):它本机已有的整理信息(云端存储接上之前做的)是「没传上去的」,
   * 不能因为云端已经有别的设备传的一份,就被直接顶掉;当成有未传改动、没有共同出发点,和云端的那份取并集。
   */
  let firstContact = loaded === null;
  let status: SyncStatus = "idle";
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let failures = 0;
  /** 串成一条链:同一时刻只跑一件事 */
  let chain: Promise<void> = Promise.resolve();

  const setStatus = (s: SyncStatus) => {
    if (status === s) return;
    status = s;
    if (!stopped) onStatus?.(s);
  };
  const setMeta = (next: SyncMeta) => { meta = next; saveMeta(next); };
  const clearTimer = () => { cancelTimer?.(); cancelTimer = null; };
  const later = (ms: number) => {
    clearTimer();
    if (stopped) return;
    cancelTimer = schedule(() => { cancelTimer = null; void enqueue(); }, ms);
  };

  /** 把没传上去的改动传上去(必要时先合并)。成功回 true;失败已经安排好重试、回 false */
  async function push(): Promise<boolean> {
    for (let conflicts = 0; ; ) {
      const mine = getOrg();
      const sent = keyOf(mine);
      const res = await transport.put(meta.version, mine);
      if (!res.conflict) {
        const stored = readRemote(res.org) ?? mine;
        // 传的过程中用户又改了:这一份还没传完,版本号记新的,标记仍是「有没传的」
        const moved = keyOf(getOrg()) !== sent;
        setMeta({ version: res.version, base: stored, dirty: moved });
        if (moved) later(opt.debounceMs);
        return true;
      }
      if (++conflicts > opt.maxConflicts) throw new Error("云端分组一直在变,这次没合并上");
      const theirs = readRemote(res.org) ?? emptyOrg("cloud");
      const merged = mergeOrg(meta.base, mine, theirs);
      // 先落本机再重传:合并结果不能只在内存里
      applyOrg(merged);
      setMeta({ version: res.version, base: theirs, dirty: true });
    }
  }

  async function pullAndPush(): Promise<void> {
    const remote = await transport.get();
    const theirs = readRemote(remote.org);
    const mine = getOrg();
    if (firstContact && hasContent(mine) && !meta.dirty) setMeta({ ...meta, dirty: true });
    if (remote.version < meta.version) {
      // 云端比我记的还旧(云端数据被重置过):以云端为出发点,把本机的整份再传上去
      setMeta({ version: remote.version, base: theirs, dirty: hasContent(mine) || meta.dirty });
    } else if (remote.version > meta.version) {
      if (!meta.dirty) {
        // 本机没有没传的改动:直接采用云端的
        const adopted = theirs ?? emptyOrg("cloud");
        if (theirs && keyOf(adopted) !== keyOf(mine)) applyOrg(adopted);
        setMeta({ version: remote.version, base: theirs, dirty: false });
        return;
      }
      const merged = mergeOrg(meta.base, mine, theirs ?? emptyOrg("cloud"));
      applyOrg(merged);
      setMeta({ version: remote.version, base: theirs, dirty: true });
    } else if (remote.version === 0 && !meta.dirty && hasContent(mine)) {
      // 云端什么都没存过、本机已经有内容(云端存储接上之前做的分组):整份传上去
      setMeta({ ...meta, dirty: true });
    }
    if (meta.dirty) await push();
  }

  async function run(): Promise<void> {
    if (stopped) return;
    setStatus("syncing");
    try {
      await pullAndPush();
      firstContact = false;
      failures = 0;
      setStatus(meta.dirty ? "pending" : "synced");
    } catch (e) {
      if (e instanceof OrgUnsupportedError) {
        // 老服务端:不报错、不重试(下次打开页面再探);改动留在本机
        failures = 0;
        setStatus("unsupported");
        return;
      }
      failures += 1;
      setStatus("pending");
      // 服务端说了多久以后再来(429 的 Retry-After,云端分组写入限流):不早于它;不丢改动,dirty 还在
      const hint = (e as { retryAfterSec?: unknown } | null)?.retryAfterSec;
      const asked = typeof hint === "number" && hint > 0 ? hint * 1000 : 0;
      later(Math.max(asked, Math.min(opt.maxRetryMs, opt.retryMs * 2 ** (failures - 1))));
    }
  }

  const enqueue = (): Promise<void> => {
    chain = chain.then(run, run);
    return chain;
  };

  return {
    refresh() {
      clearTimer();
      return enqueue();
    },
    changed() {
      if (stopped) return;
      if (!meta.dirty) setMeta({ ...meta, dirty: true });
      // 已经确认云端不支持:不再排传输(下次 refresh 会再探一次)
      if (status === "unsupported") return;
      setStatus(status === "synced" || status === "idle" ? "pending" : status);
      later(opt.debounceMs);
    },
    status: () => status,
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}

/* ---------------- 同步记录存在本机 ---------------- */

/** 同步记录的键:和整理信息本身(`orgKey("cloud", scope)`)分开存,一个是内容、一个是「内容和云端的关系」 */
export const syncMetaKey = (scope: string): string => `pc.start.orgsync.cloud.${scope}`;

/** 读回来的东西不可信:认不出就当没记过(第一次、记录丢了、被改坏) */
export function parseSyncMeta(raw: string | null): SyncMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !Number.isSafeInteger(v.version) || (v.version as number) < 0) return null;
    const base = v.base === null || v.base === undefined ? null : readRemote(v.base);
    return { version: v.version as number, base, dirty: v.dirty === true };
  } catch {
    return null;
  }
}

export function loadSyncMeta(scope: string): SyncMeta | null {
  try { return parseSyncMeta(localStorage.getItem(syncMetaKey(scope))); } catch { return null; }
}

export function saveSyncMeta(scope: string, meta: SyncMeta): void {
  try { localStorage.setItem(syncMetaKey(scope), JSON.stringify(meta)); } catch { /* 存不了就只在这次打开期间有效 */ }
}
