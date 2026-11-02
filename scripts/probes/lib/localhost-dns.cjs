/**
 * Makes Node resolve `*.localhost` to loopback (Chrome already does this, but Node fails on
 * this Windows machine: `pc.localhost` reports ENOTFOUND).
 *
 * Why needed: the three origins in `lib/hosted-proxy.mjs` are `pc.localhost`, `s1.pc.localhost`,
 * and `s2.pc.localhost` (only same-site cross-origin can properly test isolation).
 * The publicly advertised addresses of the hosted stack (`docPublicUrl`, `assetPublicUrl`) have
 * only one value; browser pages and Node-side processes (desktop app dev server, render host, the
 * probe's own fetch / WebSocket) read the exact same value, so Node must also recognize this
 * hostname. Only modifies resolution for this process and child processes launched by the probe,
 * without touching system hosts, DNS, or proxies (constraint: "do not modify host machine network").
 *
 * Usage:
 *   Probe process itself: `import './lib/localhost-dns.cjs';` (placed before other imports)
 *   Node child processes launched by probe: `env.NODE_OPTIONS = withLocalhostDns(env.NODE_OPTIONS)` (`import { withLocalhostDns } from './lib/localhost-dns.cjs'`)
 */
'use strict';
const dns = require('node:dns');
const path = require('node:path');

if (!dns.lookup.__pcLocalhostPatched) {
  const orig = dns.lookup;
  const isLocalhostName = (h) => typeof h === 'string' && /\.localhost\.?$/i.test(h);
  const patched = function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    if (isLocalhostName(hostname) && typeof callback === 'function') {
      const family = options?.family === 6 || options?.family === 'IPv6' ? 6 : 4;
      const entry = family === 6 ? { address: '::1', family: 6 } : { address: '127.0.0.1', family: 4 };
      process.nextTick(() => (options?.all ? callback(null, [entry]) : callback(null, entry.address, entry.family)));
      return {};
    }
    return orig.call(dns, hostname, options, callback);
  };
  patched.__pcLocalhostPatched = true;
  Object.defineProperty(patched, 'name', { value: 'lookup' });
  dns.lookup = patched;
  const origP = dns.promises.lookup;
  dns.promises.lookup = function lookup(hostname, options) {
    if (isLocalhostName(hostname)) {
      const entry = options?.family === 6 ? { address: '::1', family: 6 } : { address: '127.0.0.1', family: 4 };
      return Promise.resolve(options?.all ? [entry] : entry);
    }
    return origP.call(dns.promises, hostname, options);
  };
}

/** Adds preloading of this file to the child process's `NODE_OPTIONS` (does not duplicate if already present). */
function withLocalhostDns(nodeOptions) {
  const me = `--require=${__filename.replace(/\\/g, '/')}`;
  const cur = String(nodeOptions ?? '');
  return cur.includes(me) ? cur : `${cur} ${me}`.trim();
}
module.exports = { withLocalhostDns, preloadPath: path.resolve(__filename) };
