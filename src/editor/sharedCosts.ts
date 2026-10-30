/**
 * 页面侧的共享成本记录(语义 `mechanism/document-service.md`「成本记录」、`mechanism/rendering.md`「界限搜索与成本记录」;
 * 契约 `docs/plan/c10-contract.md` 第 3 节、第 18 节第 7 条)。经页面已有的文档服务连接(共享项目那一条,
 * `assetTiers.ts` 的 `docRequest`)说话,协议见 `server/docservice/modules/costs.mjs`:
 *
 * - **写**(`publishSharedCosts`):桌面版与所有在线浏览器测完卡,都把活渲单帧耗时写进文档服务(2026-10-07 用户定)。
 *   后台舞台测的(`probeRunner.ts`)由本文件的 `SharedCostRelay` 补传、`Preview` 每测完一张当场转写;只有一个舞台时
 *   界限搜索测的由 `costSearch.ts` 测完直接写。
 * - **读**(`listSharedCosts`):只有一个舞台的在线页面打开项目时读本项目的全部记录,做界限搜索(`costSearch.ts`)。
 *
 * 环境只报原始值(`pageEnvironment.mjs`),指纹由文档服务按预渲染结果键同一套规则算,页面不另算。
 * 本文件不引有状态的模块(连接、store 都由调用方注入),Node 单测直接载入。
 */
import type { CardCostRecord } from "../render/cardCostKey.mjs";

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

/** 页面报给文档服务的原始环境(`pageEnvironment.mjs` 的 `readPageEnvironment`) */
export interface PageEnvironment {
  platform: string;
  userAgent: string;
  renderer: string;
  vendor: string;
}

/** 文档服务里的一条成本记录 */
export interface SharedCostRecord {
  identityKey: string;
  envFingerprint: string;
  stepMs: number;
  samples: number;
  measuredAt: number;
  mode: "dev" | "build";
}

/** 写入时的一条(环境整批给,不在每条里) */
export type SharedCostInput = Omit<SharedCostRecord, "envFingerprint">;

/** 一次 `cost.put` 最多几条(与服务端 `COSTS_LIMITS.MAX_PUT` 相同) */
export const SHARED_COST_PUT_MAX = 500;
/** 请求等回包的上限 */
export const SHARED_COST_TIMEOUT_MS = 15_000;
/** 转写的核对间隔:连接、项目、本机记录任一变了,下一拍补传 */
export const SHARED_COST_RELAY_MS = 5_000;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** 采样帧数:记录里有就用;没有(桌面的 K1 记录不存它)就取 `device` 串里的最少样本数 `stepN=`,再没有按 1 */
export function samplesOf(record: Partial<CardCostRecord> & { samples?: unknown }): number {
  if (Number.isSafeInteger(record.samples) && (record.samples as number) > 0) return record.samples as number;
  const m = /(?:^| \| )stepN=(\d+)(?: \||$)/.exec(String(record.device ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/** K1 的一条本机记录 → 文档服务的形状;不合格(没有 identityKey / stepMs)回 null */
export function toSharedInput(record: Partial<CardCostRecord> & { samples?: unknown }, now: () => number = Date.now): SharedCostInput | null {
  if (!record || typeof record.identityKey !== "string" || !IDENTITY_RE.test(record.identityKey)) return null;
  if (!finite(record.stepMs) || record.stepMs < 0) return null;
  const measuredAt = finite(record.measuredAt) && record.measuredAt > 0 ? record.measuredAt : now();
  return {
    identityKey: record.identityKey,
    stepMs: record.stepMs,
    samples: samplesOf(record),
    measuredAt,
    mode: record.mode === "build" ? "build" : "dev",
  };
}

/**
 * 这条 K1 记录是不是这台浏览器测的:`device` 串以「本页 UA | 本页 GPU 渲染器」开头(`costDevice.mjs` 的拼法)。
 * 别的机器、离线探针在别的浏览器里测的记录环境对不上,不转写(指纹要按测量环境算)。
 * 单舞台、双舞台测的都转写(2026-10-07 用户定所有在线浏览器测完都写)。
 */
export function measuredHere(record: Partial<CardCostRecord>, env: PageEnvironment): boolean {
  const device = String(record?.device ?? "");
  if (!device || !env?.userAgent) return false;
  const renderer = env.renderer || "unknown";
  return device.startsWith(`${env.userAgent} | ${renderer} | `);
}

/**
 * 写进文档服务。超过一批的分批发。连不上、被拒都不抛,回 `{ ok: false, error }`。
 */
export async function publishSharedCosts({ request, projectId, environment, records, timeoutMs = SHARED_COST_TIMEOUT_MS }: {
  request: Request;
  projectId: string;
  environment: PageEnvironment;
  records: readonly SharedCostInput[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; added: number; updated: number; ignored: number; envFingerprint?: string; error?: string }> {
  const out = { ok: true, added: 0, updated: 0, ignored: 0 } as { ok: boolean; added: number; updated: number; ignored: number; envFingerprint?: string; error?: string };
  if (!records.length) return out;
  try {
    for (let i = 0; i < records.length; i += SHARED_COST_PUT_MAX) {
      const batch = records.slice(i, i + SHARED_COST_PUT_MAX);
      const r = await request({ type: "cost.put", projectId, environment, records: batch }, timeoutMs);
      if (r?.type !== "cost.stored") throw new Error(`cost.put:${String(r?.reason ?? r?.type ?? "no-reply")}`);
      out.added += Number(r.added) || 0;
      out.updated += Number(r.updated) || 0;
      out.ignored += Number(r.ignored) || 0;
      if (typeof r.envFingerprint === "string") out.envFingerprint = r.envFingerprint;
    }
    return out;
  } catch (e) {
    return { ...out, ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** 读本项目的全部记录,顺带取本机环境的指纹。失败抛错(调用方决定怎么兜底) */
export async function listSharedCosts({ request, projectId, environment, timeoutMs = SHARED_COST_TIMEOUT_MS }: {
  request: Request;
  projectId: string;
  environment: PageEnvironment;
  timeoutMs?: number;
}): Promise<{ records: SharedCostRecord[]; envFingerprint: string; truncated: boolean }> {
  const r = await request({ type: "cost.list", projectId, environment }, timeoutMs);
  if (r?.type !== "cost.listing") throw new Error(`cost.list:${String(r?.reason ?? r?.type ?? "no-reply")}`);
  const records = (Array.isArray(r.records) ? r.records : []).filter((x): x is SharedCostRecord =>
    !!x && typeof (x as SharedCostRecord).identityKey === "string" && finite((x as SharedCostRecord).stepMs));
  return { records, envFingerprint: typeof r.envFingerprint === "string" ? r.envFingerprint : "", truncated: r.truncated === true };
}

/**
 * 桌面版与在线浏览器(连着共享项目的页面)把本机测完的成本记录转写进文档服务。
 *
 * - 只在连着共享项目时写(`projectId()` 与 `linkKey()` 都给出值);没连就不写、不报错;
 * - 只转写这台浏览器测的记录(`measuredHere`),只转写当前项目用到的卡(`identityKeys()`);
 * - 按「连接 + 项目」记下传过的「identityKey @ measuredAt」,换了连接或项目从头补传一遍(服务端按测量时刻留最新,重复无害);
 * - 同时只跑一次;失败的下一拍再试。
 */
export class SharedCostRelay {
  private readonly deps: {
    request: Request;
    linkKey: () => unknown;
    projectId: () => string | null;
    environment: () => PageEnvironment;
    costs: () => readonly CardCostRecord[];
    identityKeys: () => ReadonlySet<string>;
    now?: () => number;
  };
  private scope: { link: unknown; projectId: string } | null = null;
  private sent = new Set<string>();
  private busy = false;
  /** 诊断:最近几次写入 */
  readonly log: { at: number; projectId: string; count: number; ok: boolean; error?: string }[] = [];

  constructor(deps: SharedCostRelay["deps"]) {
    this.deps = deps;
  }

  /** 现在就核一次;回这一次写了几条(没写回 0) */
  async sync(): Promise<number> {
    if (this.busy) return 0;
    const link = this.deps.linkKey();
    const projectId = this.deps.projectId();
    if (!link || !projectId) return 0;
    if (!this.scope || this.scope.link !== link || this.scope.projectId !== projectId) {
      this.scope = { link, projectId };
      this.sent = new Set();
    }
    const env = this.deps.environment();
    const keys = this.deps.identityKeys();
    const now = this.deps.now ?? Date.now;
    const pending: { mark: string; input: SharedCostInput }[] = [];
    const latest = new Map<string, CardCostRecord>();
    for (const r of this.deps.costs()) {
      if (!keys.has(r.identityKey) || !measuredHere(r, env)) continue;
      const prev = latest.get(r.identityKey);
      if (!prev || (Number(r.measuredAt) || 0) >= (Number(prev.measuredAt) || 0)) latest.set(r.identityKey, r);
    }
    for (const r of latest.values()) {
      const input = toSharedInput(r, now);
      if (!input) continue;
      const mark = `${input.identityKey}@${input.measuredAt}`;
      if (!this.sent.has(mark)) pending.push({ mark, input });
    }
    if (!pending.length) return 0;
    this.busy = true;
    try {
      const res = await publishSharedCosts({ request: this.deps.request, projectId, environment: env, records: pending.map((p) => p.input) });
      this.note({ at: now(), projectId, count: pending.length, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
      // 写的时候连接或项目又换了:这一批算在旧的那一份上,新的一份下一拍从头补传
      if (res.ok && this.scope?.link === link && this.scope?.projectId === projectId) for (const p of pending) this.sent.add(p.mark);
      return res.ok ? pending.length : 0;
    } finally {
      this.busy = false;
    }
  }

  private note(entry: SharedCostRelay["log"][number]) {
    this.log.push(entry);
    if (this.log.length > 20) this.log.splice(0, this.log.length - 20);
  }

  debug() {
    return { scope: this.scope ? { projectId: this.scope.projectId } : null, sent: this.sent.size, log: this.log.slice() };
  }
}
