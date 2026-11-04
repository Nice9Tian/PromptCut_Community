/**
 * Gate for stage ports: **requests from stage ports are rejected by default; only the allowlist
 * below is permitted.**
 *
 * # Why
 *
 * Stage windows (two iframes, `server/vite-plugin-stage-ports.ts`) run card code, including code
 * written by the user and code written by other members in shared projects. Stage ports are
 * same-origin to stage windows, so the same-origin guard for `/api/**` (`originOk` in
 * `http-guard.mjs`) cannot stop them: without this gate, a card could call any local API of the
 * editor process from within the stage (tested `POST /api/agent/bind` returning 200), or read any
 * file under the project root through the dev server's static file serving.
 *
 * # Where the gate is
 *
 * In the reverse proxy of stage ports (`vite-plugin-stage-ports.ts`), **before forwarding to the
 * editor process**: requests not on the allowlist return 403 on the spot, and the editor process
 * never receives them; the same applies to WebSocket upgrades. The editor process side checks again
 * with the same function based on the header written by the proxy (`viaStagePort` in
 * `http-guard.mjs`), serving as a second line of defense. Requests connecting directly to the editor
 * port do not pass through here, completely unchanged.
 *
 * # The allowlist is written only in this one place
 *
 * Each entry specifies: what method, what path, who uses it, and why it is needed. Before adding an
 * entry, first verify that it can really be sent from within the stage (the probe
 * `scripts/probes/stage-gate-probe.mjs` records all requests on stage ports), and ensure it does not
 * let card code obtain anything the stage was not meant to access: do not permit APIs that modify
 * the editor process state, and do not permit APIs that return tickets, keys, chats, or other
 * projects.
 */
import fs from "node:fs";
import { apiPath } from "./http-guard.mjs";

const READ = ["GET", "HEAD"];

/**
 * Allowlist. `exact` matches against the entire path, while `prefix` matches prefixes (up to the
 * slash); comparisons use the normalized form of `apiPath` (lowercase, collapsing duplicate
 * slashes, without query strings). `test` adds conditions beyond the path (accessing the raw URL
 * and headers in the request line). `upgrade: true` takes effect only for WebSocket upgrades;
 * others take effect only for regular requests.
 *
 * This table is determined by requests actually sent by stage ports in the real editor (running
 * through new project, click, scrub, playback, track stream paste, video, sound, user cards, and
 * built-in cards; see probe for access logs): the stage's own pages and scripts, asset bytes,
 * motion graphics asset catalog, plus two read-only APIs. All read-only; none modify the state of
 * the editor process.
 *
 * Things that **do not pass through this port** for the stage are not here: bytes for generating
 * snapshots and track streams are fetched by the stage directly from the prerender process port
 * (`src/render/prerender.ts`), remote assets are fetched directly from the asset service, and
 * project data is provided by the parent page via `postMessage`.
 */
export const STAGE_ALLOW = [
  // Stage page itself (pages and modules provided by the dev server; packaged desktop apps also run
  // this dev server)
  { methods: READ, exact: "/", who: "stage iframe", why: "Stage document `/?stage=1&id=…`; the hot-reload client liveness probe also hits this one" },
  { methods: READ, prefix: "/src/", who: "stage iframe", why: "Source code of page scripts, styles, cards and parts (including user cards in the overlay layer, which are mapped under /src/cards/user/)" },
  { methods: READ, prefix: "/server/", who: "stage iframe", why: "Index of a few modules shared by both sides and the motion graphics asset catalog that page scripts reference (all code shipped with the package, no data)" },
  { methods: READ, prefix: "/node_modules/", who: "stage iframe", why: "Prebuilt dependencies (React, particles, Lottie, etc.)" },
  { methods: READ, prefix: "/@fs/", test: (raw) => raw.split("?")[0].includes("/node_modules/"), who: "stage iframe",
    why: "Dependencies outside the project root (this prefix is used when dependencies resolve upward); only paths containing /node_modules/ are allowed, no other files are served" },
  { methods: READ, prefix: "/@vite/", who: "stage iframe", why: "Hot-reload client of the dev server" },
  { methods: READ, exact: "/@id/__x00__vite/dynamic-import-helper.js", who: "stage iframe", why: "Runtime helper module for the dev server's dynamic import" },
  { methods: READ, exact: "/@react-refresh", who: "stage iframe", why: "React hot-reload runtime" },
  { upgrade: true, methods: ["GET"], exact: "/", test: (_raw, headers) => /(^|,)\s*vite-(hmr|ping)\s*(,|$)/.test(String(headers["sec-websocket-protocol"] ?? "")),
    who: "stage iframe", why: "Hot-reload WebSocket (the stage follows after a card is edited); only the dev server's own subprotocol is accepted, other upgrades such as the document service are not allowed" },
  // Assets
  { methods: READ, prefix: "/@media/", who: "<video>, <img>, audio media effect cards and media effect cards in the stage", why: "Asset bytes in the local content store (by hash or file name, fetched in segments); includes `/@media/<hash>/pcm`" },
  { methods: READ, exact: "/api/media/file", who: "<video> and <img> in the stage", why: "Legacy projects in the migration period fetch assets by path; the endpoint itself only serves files in the asset directory" },
  { methods: READ, prefix: "/catalog/", who: "Lottie cards, particle cards", why: "JSON registered in the motion graphics asset catalog (the endpoint only accepts registered names)" },
  // Two read-only APIs
  { methods: READ, exact: "/api/cards/scopes", who: "Card registry in the stage", why: "Ownership table of custom cards (which card belongs to which project), read-only; the POST that changes tiers is not allowed" },
  { methods: READ, exact: "/api/prerender/info", who: "The layer in the stage that fetches generate snapshots and track streams", why: "Asks which port the prerender process is on, read-only (on the prerender process side, prerender-gate blocks every request except streams and snapshot bytes)" },
];

const EXTRA_ALLOW = Symbol.for("promptcut.stage-allow");

/**
 * Page scripts in the commercial edition import a few more directories; allow rules are provided
 * by its build manifest (`buildExtensions.stageAllow`), and these paths are not written on the
 * open-source side. Recorded on `globalThis`: this module has one copy in the vite config bundle
 * and one in the editor process; both gates must check the same table.
 * @param {typeof STAGE_ALLOW} rules
 */
export function registerStageAllow(rules) {
  globalThis[EXTRA_ALLOW] = rules;
}

/** Matches /@media/<hash>, /@media/<hash>.<ext>, /@media/<hash>/pcm */
const MEDIA_HASH_RE = /^\/@media\/([0-9a-fA-F]{64})(?:\.[a-zA-Z0-9]+)?(?:\/pcm)?$/i;

let stageMediaHashesGetter = null;

/**
 * Registers the getter function for current project asset hashes (for validation by the desktop
 * app stage port proxy)
 * @param {(() => Set<string> | string[] | null) | null} fn
 */
export function setStageMediaHashesGetter(fn) {
  stageMediaHashesGetter = fn;
}

/**
 * Whether the path contains patterns attempting to escape the prefix: `..` segments, backslashes,
 * encoded dots, slashes, or backslashes. URLs sent by browsers will not contain these.
 */
function sneaky(rawPath) {
  return /(^|\/)\.\.(\/|$)/.test(rawPath) || /\\|%2e|%2f|%5c|%00/i.test(rawPath);
}

/**
 * Whether to permit this request coming from a stage port.
 * @param {string} method
 * @param {string} url URL in the request line (including query string)
 * @param {{ upgrade?: boolean, headers?: Record<string, unknown>, projectMediaHashes?: Set<string> | string[] | (() => Set<string> | string[] | null) }} [opts] `upgrade`: this is a WebSocket upgrade
 */
export function stageRequestAllowed(method, url, opts = {}) {
  const m = String(method || "GET").toUpperCase();
  const raw = String(url || "/");
  const rawPath = raw.split("?")[0];
  if (!rawPath.startsWith("/") || sneaky(rawPath)) return false;

  // Reading assets by hash from the stage only permits assets in `project.media` of the current project
  const mediaHashMatch = MEDIA_HASH_RE.exec(rawPath);
  if (mediaHashMatch) {
    const hash = mediaHashMatch[1].toLowerCase();
    const hashesSource = opts.projectMediaHashes !== undefined
      ? (typeof opts.projectMediaHashes === "function" ? opts.projectMediaHashes() : opts.projectMediaHashes)
      : (stageMediaHashesGetter ? stageMediaHashesGetter() : null);
    if (hashesSource) {
      const allowedSet = hashesSource instanceof Set ? hashesSource : new Set(Array.from(hashesSource).map((h) => String(h).toLowerCase()));
      if (!allowedSet.has(hash)) return false;
    }
  }

  const p = apiPath(raw);
  for (const rule of [...STAGE_ALLOW, ...(globalThis[EXTRA_ALLOW] ?? [])]) {
    if (!!rule.upgrade !== !!opts.upgrade) continue;
    if (!rule.methods.includes(m)) continue;
    if (rule.exact !== undefined ? p !== rule.exact : !p.startsWith(rule.prefix)) continue;
    if (rule.test && !rule.test(raw, opts.headers ?? {})) continue;
    return true;
  }
  return false;
}

/** Content returned upon rejection (both the proxy and the editor process side return the same message) */
export const STAGE_DENY_BODY = JSON.stringify({ ok: false, error: "The stage port does not provide this endpoint" });

/**
 * Log for troubleshooting and probes: when `PROMPTCUT_STAGE_PORT_LOG=<file>` is set, each incoming
 * request on stage ports appends a line `{ m, u, ws, ok }` (method, URL, whether it is an upgrade,
 * whether permitted). Does nothing when unset. Only logs without checking, not affecting whether
 * permitted.
 */
export function stageGateLog(method, url, upgrade, ok) {
  const file = process.env.PROMPTCUT_STAGE_PORT_LOG;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ m: String(method || "GET").toUpperCase(), u: String(url || "/"), ws: !!upgrade, ok }) + "\n"); } catch { /* Logging failure does not affect the request */ }
}

export { READ as STAGE_READ_METHODS };
