/**
 * Asset service address registration (D7, contract `docs/plan/asset-store-contract.md` section 5).
 *
 * The editor process reports the LAN address of the local asset service to the document service
 * (service address registration module of M5a, `docs/plan/render-queue-contract.md` G.6), which then
 * distributes it to render nodes and other devices (semantics
 * `docs/semantics/mechanism/document-service.md` "Connection Discovery": service address
 * distribution). This module only exchanges addresses, not bytes.
 *
 * Wired in `mediaPlugin()` of `vite-plugin-media.ts`: lazily imports this module only when
 * listening on non-loopback and `PROMPTCUT_DOCSERVICE_URL` is set. Tokens are only passed to the
 * endpoint into subprotocol (G.5) and do not enter logs. Only imports Node built-in modules and
 * `session-link.mjs` in the same repo.
 *
 * Connection is a session (`createDocEndpoint` in `render-node/session-link.mjs`, HT-a contract
 * `docs/plan/http-transport-contract.md` section 9): transport disconnects resume within the
 * retention period; registration attached to the session persists and is not resent on resume;
 * registered again when creating a new session (`onOpen`) after session ends. Degenerates to
 * "one session per transport" for legacy servers without a session layer, behaving identically to
 * the original `createWsEndpoint`.
 */
import os from 'node:os';
import { createDocEndpoint } from './render-node/session-link.mjs';

/** Private IPv4 subnets: 10/8, 172.16/12, 192.168/16 */
function isPrivateIPv4(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address || ''));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * LAN addresses for local asset service: all non-internal IPv4 addresses belonging to private
 * subnets, each formatted as `http://<ip>:<port><basePath>`, deduplicated and sorted
 * lexicographically by URL string. Returns `[]` when `port` is omitted.
 *
 * @param {{ interfaces?: Record<string, Array<{ address: string, family: string | number, internal: boolean }> | undefined>, port?: number, basePath?: string }} [options]
 * @returns {string[]}
 */
export function lanAssetUrls({ interfaces = os.networkInterfaces(), port, basePath = '/api/asset' } = {}) {
  if (port === undefined || port === null) return [];
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return [];
  const addresses = new Set();
  for (const list of Object.values(interfaces || {})) {
    for (const nic of list || []) {
      if (!nic || nic.internal) continue;
      // In Node 18.0-18.3, family is the number 4
      if (nic.family !== 'IPv4' && nic.family !== 4) continue;
      if (isPrivateIPv4(nic.address)) addresses.add(nic.address);
    }
  }
  // Lexicographical order by URL string (contract section 8 item 5)
  return [...new Set([...addresses].map((ip) => `http://${ip}:${p}${basePath}`))].sort();
}

/**
 * Default announcer identity `asset:<hostname>` (contract section 8 item 1). G.6 announcerId only
 * accepts `[A-Za-z0-9._:-]`, max length 128; other characters in hostname are replaced with `-`
 */
function defaultAnnouncerId() {
  const host = String(os.hostname() || 'host').replace(/[^A-Za-z0-9._:-]/g, '-') || 'host';
  return `asset:${host}`.slice(0, 128);
}

/**
 * Connect to control plane and register `service.announce { announcerId, kind: 'asset', urls }`
 * on each (re)connect. Only logs on `error` without retrying (will re-register naturally on
 * reconnect). `stop()` sends `service.withdraw` first (if connected), then closes connection.
 *
 * @param {object} options
 * @param {string} [options.url]  Control plane URL (ws:// or wss://); does nothing if empty
 * @param {string | null} [options.token]  Cluster token
 * @param {string} [options.announcerId]
 * @param {string[]} [options.urls]  Result of `lanAssetUrls`; does not register if empty
 * @param {(opts: { url: string, token?: string, log?: Function }) => any} [options.createEndpoint]  Defaults to `createDocEndpoint`
 * @param {(event: string, fields: object) => void} [options.log]
 * @returns {{ stop(): void }}
 */
export function startAssetAnnounce({
  url,
  token,
  announcerId = defaultAnnouncerId(),
  urls,
  createEndpoint = createDocEndpoint,
  log = () => {},
} = /** @type {any} */ ({})) {
  const noop = { stop() {} };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging errors do not affect registration */ } };
  if (!url) return noop;
  if (!Array.isArray(urls) || urls.length === 0) {
    say('asset-announce.skip', { reason: 'no-lan-urls', detail: 'This machine has no IPv4 address on a private network range, so the asset service is not registered' });
    return noop;
  }
  const list = [...urls];

  let ep;
  try {
    ep = createEndpoint({ url, token: typeof token === 'string' && token !== '' ? token : undefined, log });
  } catch (error) {
    say('asset-announce.error', { stage: 'connect', message: String(error?.message ?? error) });
    return noop;
  }

  let stopped = false;
  ep.onOpen(() => {
    if (stopped) return;
    const sent = ep.send({ type: 'service.announce', announcerId, kind: 'asset', urls: list });
    say('asset-announce.announce', { announcerId, urls: list, sent });
  });
  ep.onMessage((message) => {
    if (message?.type === 'error') {
      say('asset-announce.error', { stage: 'reply', reason: message.reason ?? null, detail: message.detail ?? null });
    } else if (message?.type === 'service.announced' && message.announcerId === announcerId && message.kind === 'asset') {
      say('asset-announce.announced', { announcerId, urls: message.urls });
    }
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        // Send even if endpoint does not report connected (injected mock endpoint); real endpoint
        // will discard in send if not connected
        if (ep.connected !== false) ep.send({ type: 'service.withdraw', announcerId, kind: 'asset' });
      } catch (error) {
        say('asset-announce.error', { stage: 'withdraw', message: String(error?.message ?? error) });
      }
      try { ep.close(); } catch (error) {
        say('asset-announce.error', { stage: 'close', message: String(error?.message ?? error) });
      }
      say('asset-announce.stopped', { announcerId });
    },
  };
}
