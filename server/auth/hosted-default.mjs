/**
 * Default hosted URL (contract `docs/plan/shared-project-contract.md` section 3, acceptance check SP6).
 *
 * Addresses of the hosted side (current domain, as well as replaced IPs and sslip.io names) are
 * written only in the closed-source product declaration (`product.mjs`; public release has no hosted
 * side, so it receives `null` here). Gatekeeper: `cloud/server/test/hosted-migrate.test.mjs` on the
 * closed-source side, G6 in `community-boundary.test.mjs` in the public tree. Anywhere else requiring
 * the hosted URL must obtain it via `resolveHostedUrl`.
 *
 * Override order (highest priority first):
 * 1. Value modified in the UI (wired in C6.5, passed in by the caller via `ui`);
 * 2. Otherwise environment variable `PROMPTCUT_HOSTED_URL`;
 * 3. Otherwise `DEFAULT_HOSTED_URL`. When this version has no hosted side, it is an empty string,
 *    and caller skips it as "no hosted side" without connecting anywhere.
 *
 * Empty string, whitespace-only, `null`, and `undefined` are all considered "unset", falling through
 * to the next tier. If set but not an `http(s)://` or `ws(s)://` URL, throws a TypeError: mistyped
 * URLs are not silently replaced with the default, avoiding connecting elsewhere while assuming it
 * connected to the user-configured host.
 *
 * Universal across browser and Node: imports no modules except the product declaration; without
 * `process` in the browser, tier 2 is naturally skipped.
 */
import { PRODUCT } from './product.mjs';
import { tr } from '../i18n.mjs';

/** Custom domain for hosted service (user decision, 2026-10-22): future migrations only update DNS without releasing a client */
const HOSTED_HOST = PRODUCT.hosted?.host ?? null;

/** Reaches document service via nginx `/hosted` on the node; asset service is under `/media` on the same origin */
export const DEFAULT_HOSTED_URL = HOSTED_HOST ? `https://${HOSTED_HOST}/hosted` : '';

/**
 * Replaced hosted side URLs. These appear in legacy project files, local recovery credentials,
 * and hosted URLs; when read in, they are replaced with current ones so users do not need to
 * re-authenticate, and saving writes the new URL.
 * - 2026-10-06: Alibaba Cloud expired without renewal, hosted side migrated to new cloud node
 *   (data copied over entirely);
 * - 2026-10-22: Hosted URL changed from new cloud node IP to custom domain (user decision). Ports
 *   8787 (document service) and 8788 (asset service) on the node are no longer exposed, routing
 *   only via nginx over HTTPS, so "IP:8787" and "IP:8788" are replaced with `/hosted` and `/media`
 *   under the new domain, with protocol updated to HTTPS / WSS; other formats (sslip.io names, IPs
 *   without these two ports) only replace the hostname, keeping protocol, port, and path unchanged;
 *   sslip.io s1. and s2. stage subdomains are replaced with stage hostnames from the declaration.
 */
const RETIRED_IPS = PRODUCT.hosted?.retiredIps ?? [];
const sslipName = (ip) => `${ip.split('.').join('-')}.sslip.io`;
const RETIRED_NAMES = RETIRED_IPS.map(sslipName);
const STAGE_HOSTS = Object.freeze({ ...PRODUCT.hosted?.stageHosts });
const PORT_PATHS = Object.freeze({ 8787: '/hosted', 8788: '/media' });

/** Hostname-level mapping; the two direct port formats are replaced according to `PORT_PATHS` (see above) */
export const RETIRED_HOSTED_HOSTS = Object.freeze([...RETIRED_IPS, ...RETIRED_NAMES].map((host) => [host, HOSTED_HOST]));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IPS = RETIRED_IPS.map(escapeRe).join('|');
const NAMES = RETIRED_NAMES.map(escapeRe).join('|');
// The hostname can only be followed by: port, path, query, fragment, quote, backslash (escaped once
// more in JSON), whitespace, delimiter, or end of string
const END = String.raw`(?=[:/?#"'\\\s,;)\]}<>]|$)`;
const PORT_RE = new RegExp(String.raw`\b(https?|wss?)://(${IPS}):(8787|8788)(?!\d)`, 'g');
const STAGE_RE = new RegExp(String.raw`(^|[/@.])(s[12])\.(${NAMES})${END}`, 'g');
const HOST_RE = new RegExp(String.raw`(^|[/@.])(${IPS}|${NAMES})${END}`, 'g');
const MARKERS = [...RETIRED_IPS, ...RETIRED_NAMES];

/** Replaces legacy hosted URLs in a string with current ones; returns the string unchanged if it has no legacy URLs */
export function migrateHostedText(text) {
  if (typeof text !== 'string' || !MARKERS.some((m) => text.includes(m))) return text;
  return text
    .replace(PORT_RE, (_, scheme, _ip, port) => `${scheme.startsWith('ws') ? 'wss' : 'https'}://${HOSTED_HOST}${PORT_PATHS[port]}`)
    .replace(STAGE_RE, (_, pre, stage) => pre + STAGE_HOSTS[stage])
    .replace(HOST_RE, (_, pre) => pre + HOSTED_HOST);
}

/**
 * Deep clones and replaces legacy hosted URLs in all strings (including object keys: recovery
 * record keys are JSON strings containing service URLs) with current ones.
 * Returns the original value itself if nothing needs replacing.
 */
export function migrateHostedDeep(value) {
  if (typeof value === 'string') return migrateHostedText(value);
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  if (Array.isArray(value)) {
    const out = value.map((v) => { const m = migrateHostedDeep(v); if (m !== v) changed = true; return m; });
    return changed ? out : value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const mk = migrateHostedText(k), mv = migrateHostedDeep(v);
    if (mk !== k || mv !== v) changed = true;
    out[mk] = mv;
  }
  return changed ? out : value;
}

export const HOSTED_URL_ENV = 'PROMPTCUT_HOSTED_URL';

const isSet = (v) => typeof v === 'string' && v.trim() !== '';

function checked(value, from) {
  const text = value.trim();
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new TypeError(tr("The hosted address ({0}) is not a valid address", from));
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new TypeError(tr("The hosted address ({0}) must be http(s):// or ws(s)://", from));
  return text.replace(/\/+$/, '');
}

/**
 * Resolves the hosted URL and its source in override order.
 * @param {object} [options]
 * @param {string | null} [options.ui] Value modified in the UI
 * @param {Record<string, string | undefined>} [options.env] Defaults to `process.env` (treated as
 *   empty in browser)
 * @returns {{ url: string, from: 'ui' | 'env' | 'default' }}
 */
export function hostedUrlChoice({ ui, env = globalThis.process?.env ?? {} } = {}) {
  if (isSet(ui)) return { url: checked(ui, 'ui'), from: 'ui' };
  const fromEnv = env?.[HOSTED_URL_ENV];
  if (isSet(fromEnv)) return { url: checked(fromEnv, 'env'), from: 'env' };
  return { url: DEFAULT_HOSTED_URL, from: 'default' };
}

/** URL only: `hostedUrlChoice(options).url` */
export function resolveHostedUrl(options) {
  return hostedUrlChoice(options).url;
}
