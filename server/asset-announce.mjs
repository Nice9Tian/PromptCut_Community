/**
 * 素材服务地址登记（D7，契约 `docs/plan/asset-store-contract.md` 第 5 节）。
 *
 * 编辑器进程把本机素材服务的局域网地址报给文档服务（M5a 的服务地址登记模块，
 * `docs/plan/render-queue-contract.md` G.6），文档服务再下发给渲染节点和别的设备
 * （语义 `docs/semantics/mechanism/document-service.md`「连接发现」：服务地址下发）。
 * 本模块只交换地址，不传字节。
 *
 * 接线在 `vite-plugin-media.ts` 的 `mediaPlugin()`：监听的不是回环、设了 `PROMPTCUT_DOCSERVICE_URL` 才惰性 import 本模块。
 * 令牌只交给端点放进子协议（G.5），不进日志。只引 Node 内置模块和同仓库的 `session-link.mjs`。
 *
 * 连接是一个会话（`render-node/session-link.mjs` 的 `createDocEndpoint`，HT-a 契约 `docs/plan/http-transport-contract.md` 第 9 节）：
 * 传输断开在保留期内接续，登记挂在会话上不掉，接续时不重发；会话结束后建新会话（`onOpen`）时再登记一次。
 * 对没有会话层的旧服务端退化为「一条传输一个会话」，行为与原来的 `createWsEndpoint` 相同。
 */
import os from 'node:os';
import { createDocEndpoint } from './render-node/session-link.mjs';

/** 私有网段的 IPv4：10/8、172.16/12、192.168/16 */
function isPrivateIPv4(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address || ''));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * 本机素材服务在局域网里的地址：所有非 internal 的 IPv4 里属于私有网段的，
 * 每个拼成 `http://<ip>:<port><basePath>`，去重后按 URL 字符串的字典序排序。`port` 缺省时返回 `[]`。
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
      // Node 18.0～18.3 的 family 是数字 4
      if (nic.family !== 'IPv4' && nic.family !== 4) continue;
      if (isPrivateIPv4(nic.address)) addresses.add(nic.address);
    }
  }
  // 按 URL 字符串的字典序（契约第 8 节第 5 条）
  return [...new Set([...addresses].map((ip) => `http://${ip}:${p}${basePath}`))].sort();
}

/** 缺省登记者身份 `asset:<主机名>`（契约第 8 节第 1 条）。G.6 的 announcerId 只收 `[A-Za-z0-9._:-]`、最长 128，主机名里别的字符换成 `-` */
function defaultAnnouncerId() {
  const host = String(os.hostname() || 'host').replace(/[^A-Za-z0-9._:-]/g, '-') || 'host';
  return `asset:${host}`.slice(0, 128);
}

/**
 * 连到控制面，每次（重）连上都登记一次 `service.announce { announcerId, kind: 'asset', urls }`。
 * 收到 `error` 只打日志、不重试（重连时自然会再登记）。`stop()` 先发 `service.withdraw`（连着的话），再关连接。
 *
 * @param {object} options
 * @param {string} [options.url]  控制面地址（ws:// 或 wss://）；为空就什么都不做
 * @param {string | null} [options.token]  集群令牌
 * @param {string} [options.announcerId]
 * @param {string[]} [options.urls]  `lanAssetUrls` 的结果；为空不登记
 * @param {(opts: { url: string, token?: string, log?: Function }) => any} [options.createEndpoint]  缺省 `createDocEndpoint`
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
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响登记 */ } };
  if (!url) return noop;
  if (!Array.isArray(urls) || urls.length === 0) {
    say('asset-announce.skip', { reason: 'no-lan-urls', detail: '本机没有私有网段的 IPv4 地址，不登记素材服务' });
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
        // 端点不报 connected 的（注入的假端点）也发；真端点没连上时 send 自己会丢弃
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
