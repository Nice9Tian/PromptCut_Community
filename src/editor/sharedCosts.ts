/**
 * Page-side shared cost records (semantics `mechanism/document-service.md` "Cost records",
 * `mechanism/rendering.md` "Bound search and cost records"; contract `docs/plan/c10-contract.md`
 * section 3, section 18 item 7). It talks through the document service connection the page already
 * has (the shared project one, `docRequest` in `assetTiers.ts`); for the protocol see
 * `server/docservice/modules/costs.mjs`:
 *
 * - **Write** (`publishSharedCosts`): the desktop app and all online browsers, after measuring a
 *   card, write the live render single-frame time to the document service (user decision,
 *   2026-10-07). Those measured on the background stage (`probeRunner.ts`) are relayed by
 *   `SharedCostRelay` in this file, and `Preview` transcribes them on the spot as each one is
 *   measured; when there is only one stage, those measured by the bound search are written
 *   directly by `costSearch.ts` once measured.
 * - **Read** (`listSharedCosts`): an online page with only one stage reads all records of this
 *   project when opening the project, to do the bound search (`costSearch.ts`).
 *
 * The environment reports only raw values (`pageEnvironment.mjs`); the fingerprint is computed by
 * the document service using the same rules as the prerender output key, and the page does not
 * compute it separately.
 * This file imports no stateful modules (connection and store are injected by the caller), so Node
 * unit tests load it directly.
 */
import type { CardCostRecord } from "../render/cardCostKey.mjs";

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

/** Raw environment the page reports to the document service (`readPageEnvironment` in `pageEnvironment.mjs`) */
export interface PageEnvironment {
  platform: string;
  userAgent: string;
  renderer: string;
  vendor: string;
}

/** One cost record in the document service */
export interface SharedCostRecord {
  identityKey: string;
  envFingerprint: string;
  stepMs: number;
  samples: number;
  measuredAt: number;
  mode: "dev" | "build";
}

/** One entry on write (the environment is given once per batch, not in every entry) */
export type SharedCostInput = Omit<SharedCostRecord, "envFingerprint">;

/** Max entries per `cost.put` (same as the server's `COSTS_LIMITS.MAX_PUT`) */
export const SHARED_COST_PUT_MAX = 500;
/** Upper limit for a request waiting for its reply */
export const SHARED_COST_TIMEOUT_MS = 15_000;
/** Re-check interval for mirroring: if the connection, project or local records change, the next tick re-uploads */
export const SHARED_COST_RELAY_MS = 5_000;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Sampled frame count: use the record's value if present; otherwise (desktop K1 records don't store it) take the minimum sample count `stepN=` from the `device` string, and failing that use 1 */
export function samplesOf(record: Partial<CardCostRecord> & { samples?: unknown }): number {
  if (Number.isSafeInteger(record.samples) && (record.samples as number) > 0) return record.samples as number;
  const m = /(?:^| \| )stepN=(\d+)(?: \||$)/.exec(String(record.device ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/** One local K1 record → the document service's shape; returns null if invalid (no identityKey / stepMs) */
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
 * Whether this K1 record was measured in this browser: the `device` string starts with
 * "this page's UA | this page's GPU renderer" (as built by `costDevice.mjs`).
 * Records measured on other machines, or by offline probes in other browsers, have a mismatched
 * environment and are not mirrored (the fingerprint is computed from the measurement environment).
 * Records from both single-stage and dual-stage measurements are mirrored (user decision, 2026-10-07:
 * write everything measured in any online browser).
 */
export function measuredHere(record: Partial<CardCostRecord>, env: PageEnvironment): boolean {
  const device = String(record?.device ?? "");
  if (!device || !env?.userAgent) return false;
  const renderer = env.renderer || "unknown";
  return device.startsWith(`${env.userAgent} | ${renderer} | `);
}

/**
 * Write to the document service. Sends in batches if there is more than one batch. Never throws on
 * connection failure or rejection; returns `{ ok: false, error }`.
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

/** Read all records of this project and also fetch the local environment fingerprint. Throws on failure (the caller decides the fallback) */
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
 * The desktop app and the online browser (a page connected to a shared project) mirror the cost
 * records measured locally into the document service.
 *
 * - Writes only while connected to a shared project (both `projectId()` and `linkKey()` return a
 *   value); when not connected, nothing is written and no error is reported;
 * - Mirrors only records measured in this browser (`measuredHere`), and only for cards used by the
 *   current project (`identityKeys()`);
 * - Remembers the "identityKey @ measuredAt" entries already sent per "connection + project"; when the
 *   connection or project changes, it re-uploads from scratch (the server keeps the latest by
 *   measurement time, so duplicates are harmless);
 * - Runs one at a time; a failed write is retried on the next tick.
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
  /** Diagnostics: the most recent writes */
  readonly log: { at: number; projectId: string; count: number; ok: boolean; error?: string }[] = [];

  constructor(deps: SharedCostRelay["deps"]) {
    this.deps = deps;
  }

  /** Check once right now; returns how many entries this run wrote (0 if none) */
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
      // The connection or project changed again during the write: this batch counts against the old copy, and the new copy re-uploads from scratch on the next tick
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
