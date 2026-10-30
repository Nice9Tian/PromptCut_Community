/**
 * 让 Node 把 `*.localhost` 解析到回环(Chrome 本来就这么做,Node 在这台 Windows 上不行:`pc.localhost` 报 ENOTFOUND)。
 *
 * 为什么要:`lib/hosted-proxy.mjs` 的三个源是 `pc.localhost`、`s1.pc.localhost`、`s2.pc.localhost`(同站跨源才测得出隔离)。
 * 托管组合对外说的地址(`docPublicUrl`、`assetPublicUrl`)只有一个值,浏览器页面和 Node 这边的进程(桌面版 dev server、渲染主机、
 * 探针自己的 fetch / WebSocket)读的是同一个,所以 Node 这边也得认得这个主机名。只改本进程与探针自己起的子进程的解析,
 * 不动系统的 hosts、DNS、代理(约束「不动宿主机的网络」)。
 *
 * 用法:
 *   探针进程自己:`import './lib/localhost-dns.cjs';`(放在别的 import 之前)
 *   探针起的 Node 子进程:`env.NODE_OPTIONS = withLocalhostDns(env.NODE_OPTIONS)`(`import { withLocalhostDns } from './lib/localhost-dns.cjs'`)
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

/** 给子进程的 `NODE_OPTIONS` 加上本文件的预加载(已经有就不重复) */
function withLocalhostDns(nodeOptions) {
  const me = `--require=${__filename.replace(/\\/g, '/')}`;
  const cur = String(nodeOptions ?? '');
  return cur.includes(me) ? cur : `${cur} ${me}`.trim();
}
module.exports = { withLocalhostDns, preloadPath: path.resolve(__filename) };
