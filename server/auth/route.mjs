/**
 * Routing when creating and opening shared projects (contract `docs/plan/shared-project-contract.md`
 * section 3, acceptance check SP5).
 *
 * Universal across browser and Node: imports only `client.mjs` (WebCrypto, `fetch`) and
 * `hosted-default.mjs`, importing no Node modules. Browsers cannot send UDP, so **LAN discovery is
 * injected by caller**: Node side passes `lan.discover` (`discoverLan` in
 * `server/lan/discovery.mjs`), browser side does not pass it, only using manually entered addresses
 * `lan.manual` and hosted side (C10).
 *
 * - `findSharedProject({ name, hostedUrl, lan: { discover, manual, timeoutMs }, fetch })`
 *   Returns `{ candidates: [{ where: 'lan' | 'hosted', base, projectId, name, mode, hostDeviceName?, asset?, via? }], errors: [{ where, reason, … }] }`:
 *   - LAN discovery timeout 3 s; hosted side `GET shared/lookup?name=`; manual address directly
 *     `GET /docservice/shared/lookup?name=`. All three paths run concurrently (the contract states
 *     "first... then...", both sides' results are listed without preference; running concurrently
 *     simply saves time with identical results);
 *   - Listed on both sides if present on both, without preference; multiple hosts with the same
 *     name on LAN are listed side-by-side with host device names for the user to choose;
 *   - Unreachable hosted side and LAN discovery timeout (no responders) are added to `errors`
 *     without throwing exceptions; hosted side 404 is not an error, simply having no candidate;
 *   - `hostedUrl`: if omitted (`undefined`), resolved by override order (`resolveHostedUrl`: UI
 *     value → `PROMPTCUT_HOSTED_URL` → default); passing `null` or `false` means skipping hosted
 *     side this time (LAN mode probe uses this to ensure never connecting to hosted side);
 *   - `base` is normalized to document service http address ending with `/` (contract section 11
 *     ruling): LAN `http://<ip>:<port>/docservice/`, hosted side `http://<host>:<port>/`. Directly
 *     accepted by `buildAuthProtocols({ base })` in `client.mjs`; use `wsBaseOf(base)` when
 *     connecting to WebSocket;
 *   - Manual and discovered LAN candidates are deduplicated by `base` (same address listed once,
 *     discovered comes first); when the same project is discovered across multiple network
 *     adapters, discovery itself lists it once (by `projectId`, keeping the first seen).
 * - `pickRoute(result)`: single candidate → `{ action: 'enter', candidate }`; multiple →
 *   `{ action: 'choose', candidates }`; none → `{ action: 'not-found', errors }` ("not found" is
 *   stated by the caller).
 * - `createSharedProject({ where: 'hosted' | 'lan', … })`: hosted side sends `POST shared/create` to
 *   hosted address; LAN sends `POST /docservice/shared/create` to local editor document service
 *   (creatable only via local loopback, M6a). After creation, the editor starts broadcasting
 *   (`vite-plugin-docservice.ts`, section 4); broadcasting is not handled here.
 */
import { lookupProject, createSharedProject as createOn } from './client.mjs';
import { resolveHostedUrl } from './hosted-default.mjs';
import { tr } from '../i18n.mjs';

export const ROUTE_DEFAULTS = Object.freeze({
  /** LAN discovery timeout (contract section 3) */
  LAN_TIMEOUT_MS: 3_000,
  /** Timeout for looking up names via hosted side and manual addresses */
  LOOKUP_TIMEOUT_MS: 5_000,
});

const LAN_DOC_PATH = '/docservice';

/** Address → document service WebSocket address: replace `http:` with `ws:`, `https:` with `wss:`, preserve path, strip trailing slash */
export function wsBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new TypeError(tr("The address must be http(s):// or ws(s)://"));
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Manually entered LAN address → document service address. Accepts `http://192.168.x.y:port`
 * (editor address, appends `/docservice`), `http://…/docservice` with path, `ws://…/docservice`,
 * and `192.168.x.y:port` without protocol.
 */
export function manualBaseOf(address) {
  let text = String(address ?? '').trim();
  if (text === '') throw new TypeError(tr("The address entered manually is empty"));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  const base = wsBaseOf(text);
  const u = new URL(base);
  return u.pathname === '' || u.pathname === '/' ? `${u.protocol}//${u.host}${LAN_DOC_PATH}` : base;
}

/**
 * Candidate `base` (contract section 11 ruling): document service http(s) address, preserving path
 * and ending with `/`. `ws://192.168.1.5:5190/docservice` → `http://192.168.1.5:5190/docservice/`;
 * `http://h:8787` → `http://h:8787/`.
 */
export function candidateBaseOf(url) {
  const u = new URL(wsBaseOf(url));
  const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/`;
}

const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/** fetch wrapper for `client.mjs`: each request has a timeout */
function timedFetch(fetchImpl, ms) {
  const f = fetchImpl ?? globalThis.fetch;
  return (url, init = {}) => f(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** `lookupProject` failure → `{ reason, status? }`; 404 returns null (project does not exist, not considered an error) */
function lookupFailure(err) {
  if (err?.status === 404) return null;
  if (Number.isInteger(err?.status)) return { reason: `http-${err.status}`, status: err.status };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError') return { reason: 'timeout' };
  return { reason: 'unreachable' };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]);
}
const TIMED_OUT = Symbol('timeout');

/**
 * @param {object} options
 * @param {string} options.name Project name (case-insensitive, compared via NFC lowercase same as server)
 * @param {string | null | false} [options.hostedUrl]
 * @param {string | null} [options.uiHostedUrl] Modified hosted address from UI (participates in override order when `hostedUrl` is omitted)
 * @param {object} [options.lan]
 * @param {(o: { name: string, timeoutMs: number }) => Promise<Array<object> | { hosts: object[], errors?: object[] }>} [options.lan.discover]
 * @param {string[]} [options.lan.manual]
 * @param {number} [options.lan.timeoutMs] Defaults to 3000
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.lookupTimeoutMs] Defaults to 5000
 */
export async function findSharedProject({
  name, hostedUrl, uiHostedUrl, lan = {}, fetch, lookupTimeoutMs = ROUTE_DEFAULTS.LOOKUP_TIMEOUT_MS,
} = {}) {
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('findSharedProject: name cannot be empty');
  const wanted = nameKey(name);
  const lanTimeout = Number.isFinite(lan?.timeoutMs) ? lan.timeoutMs : ROUTE_DEFAULTS.LAN_TIMEOUT_MS;
  const errors = [];
  const f = timedFetch(fetch, lookupTimeoutMs);

  const discovered = (async () => {
    if (typeof lan?.discover !== 'function') return [];
    let r;
    try {
      r = await withTimeout(Promise.resolve(lan.discover({ name, timeoutMs: lanTimeout })), lanTimeout + 1_000);
    } catch (err) {
      errors.push({ where: 'lan', reason: 'discover-failed', message: String(err?.message ?? err) });
      return [];
    }
    if (r === TIMED_OUT) {
      errors.push({ where: 'lan', reason: 'timeout' });
      return [];
    }
    const hosts = Array.isArray(r) ? r : Array.isArray(r?.hosts) ? r.hosts : [];
    let fatal = false;
    for (const e of (Array.isArray(r?.errors) ? r.errors : [])) {
      if (e?.reason === 'no-interface' || e?.reason === 'socket') {
        fatal = true;
        errors.push({ where: 'lan', reason: e.reason, ...(e.message ? { message: e.message } : {}) });
      }
    }
    const matched = hosts.filter((h) => h && typeof h.name === 'string' && nameKey(h.name) === wanted && typeof h.docservice === 'string');
    if (hosts.length === 0 && !fatal) errors.push({ where: 'lan', reason: 'timeout' });
    // Same project discovered across multiple network adapters: listed once, keeping first seen (discovery path merge)
    const byProject = new Set();
    const once = [];
    for (const h of matched) {
      let base;
      try { base = candidateBaseOf(h.docservice); } catch { continue; }
      if (byProject.has(h.projectId)) continue;
      byProject.add(h.projectId);
      once.push({ h, base });
    }
    return once.map(({ h, base }) => ({
      where: 'lan', base, projectId: h.projectId, name: h.name, mode: h.mode,
      hostDeviceName: h.hostDeviceName, ...(h.asset ? { asset: h.asset } : {}), via: 'discover',
      ...(Number.isFinite(h.firstSeenMs) ? { firstSeenMs: h.firstSeenMs } : {}),
    }));
  })();

  const manual = Promise.all((Array.isArray(lan?.manual) ? lan.manual : []).map(async (address) => {
    let base;
    try {
      base = manualBaseOf(address);
    } catch {
      errors.push({ where: 'lan', reason: 'bad-address', address: String(address) });
      return null;
    }
    try {
      const p = await lookupProject({ base, name, fetch: f });
      return { where: 'lan', base: candidateBaseOf(base), projectId: p.projectId, name: p.name, mode: p.mode, via: 'manual' };
    } catch (err) {
      const fail = lookupFailure(err);
      if (fail) errors.push({ where: 'lan', address: base, ...fail });
      return null;
    }
  }));

  const hosted = (async () => {
    if (hostedUrl === null || hostedUrl === false) return null;
    let url;
    try {
      url = typeof hostedUrl === 'string' && hostedUrl.trim() !== '' ? hostedUrl.trim() : resolveHostedUrl({ ui: uiHostedUrl });
      if (!url) return null; // No hosted side in this version and no address entered: do not search
      url = wsBaseOf(url);
    } catch (err) {
      errors.push({ where: 'hosted', reason: 'bad-address', message: String(err?.message ?? err) });
      return null;
    }
    try {
      const p = await lookupProject({ base: url, name, fetch: f });
      return { where: 'hosted', base: candidateBaseOf(url), projectId: p.projectId, name: p.name, mode: p.mode };
    } catch (err) {
      const fail = lookupFailure(err);
      if (fail) errors.push({ where: 'hosted', ...fail });
      return null;
    }
  })();

  const [lanFound, manualFound, hostedFound] = await Promise.all([discovered, manual, hosted]);
  const candidates = [];
  const seen = new Set();
  // Manual entry and discovery deduplicated by base (contract section 11 ruling), discovered comes first
  for (const c of [...lanFound, ...manualFound.filter(Boolean)]) {
    if (seen.has(c.base)) continue;
    seen.add(c.base);
    candidates.push(c);
  }
  if (hostedFound) candidates.push(hostedFound);
  // If manual address lookup succeeds, LAN discovery "timeout" is ignored (discovery blocked by
  // firewall or AP isolation is why manual entry exists)
  const lanOk = candidates.some((c) => c.where === 'lan');
  return { candidates, errors: lanOk ? errors.filter((e) => !(e.where === 'lan' && e.reason === 'timeout')) : errors };
}

/**
 * Routing on open (SP5): only on LAN or only hosted → enter directly; present on both (or multiple
 * with same name on LAN) → list side-by-side to choose; neither → not found.
 * @param {{ candidates: object[], errors?: object[] }} result
 */
export function pickRoute(result) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (candidates.length === 0) return { action: 'not-found', errors: Array.isArray(result?.errors) ? result.errors : [] };
  if (candidates.length === 1) return { action: 'enter', candidate: candidates[0] };
  return { action: 'choose', candidates };
}

/** Document service address of the local editor in the browser; Node has no `location`, returns null */
function localEditorBase() {
  const loc = globalThis.location;
  if (!loc || typeof loc.origin !== 'string' || !/^https?:/.test(loc.origin)) return null;
  return `${loc.origin}${LAN_DOC_PATH}`;
}

/**
 * Creates a new shared project.
 * @param {object} options
 * @param {'hosted' | 'lan'} options.where
 * @param {string} options.name
 * @param {'free' | 'restricted'} options.mode
 * @param {{ username: string, password: string }} options.creator
 * @param {string} [options.password] Project passphrase for open entry
 * @param {Array<{ username: string, password: string }>} [options.list] List for restricted entry
 * @param {object} [options.kdf]
 * @param {string} [options.hostedUrl] Hosted side address; if omitted, resolved by override order
 * @param {string | null} [options.uiHostedUrl]
 * @param {string} [options.lanBase] Document service address of the local editor (required in Node,
 *   e.g. `ws://127.0.0.1:5190/docservice`; browser defaults to current page origin)
 * @param {typeof globalThis.fetch} [options.fetch]
 * @returns {Promise<{ where, base, projectId, name, mode }>} Throws a `client.mjs` error on failure
 *   (with `status`, `reason`, e.g. 409 `name-taken`)
 */
export async function createSharedProject({ where, hostedUrl, uiHostedUrl, lanBase, ...rest } = {}) {
  let base;
  if (where === 'hosted') {
    base = typeof hostedUrl === 'string' && hostedUrl.trim() !== '' ? hostedUrl.trim() : resolveHostedUrl({ ui: uiHostedUrl });
    if (!base) throw new TypeError('createSharedProject: this build has no hosted side, hostedUrl is required');
  } else if (where === 'lan') {
    base = lanBase ?? localEditorBase();
    if (!base) throw new TypeError('createSharedProject: LAN mode requires lanBase (the document service address of the local editor)');
  } else {
    throw new TypeError("createSharedProject: where must be 'hosted' or 'lan'");
  }
  const ws = wsBaseOf(base);
  const r = await createOn({ ...rest, base: ws });
  return { where, base: candidateBaseOf(ws), projectId: r.projectId, name: r.name, mode: r.mode };
}
