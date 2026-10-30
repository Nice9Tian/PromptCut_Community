/**
 * 「在手机上打开」要的那点信息（语义 `docs/semantics/mechanism/platforms.md`「局域网里的第二块屏」）。
 *
 * 跨设备进同一个项目走的是**共享项目**那条路：主机把项目设成「多用户协作 + 放本机」，局域网里的设备凭
 * **邀请链接**（`<主机局域网源>/editor#invite=<码>`）或项目名加口令加入（契约 `docs/plan/c10a-contract.md` 第 5 节，
 * 邀请码的规则在 `server/auth/invite.mjs`）。邀请链接与二维码由页面自己拼（`src/editor/LanOpenDialog.tsx`，
 * 链接的源来自文档服务的 base，就是主机的局域网地址），所以本模块**不碰项目，也不签任何码**。
 *
 * 本模块只回答一件事：**这台机器的编辑器现在绑在局域网上没有，局域网地址是哪几个**。
 * 没绑局域网的话，邀请链接给出去手机也连不上，界面要先说清这一点。
 *
 * 绑没绑按**实际监听地址**判，不看环境变量：编辑器绑哪儿由命令行 `--host`（桌面壳给 `127.0.0.1`，
 * `npm run dev` 给 `0.0.0.0`）和 `PROMPTCUT_LAN_HOST` 一起决定（`vite.config.ts` 的 `lanHostPlugin`），
 * 两者还可能对不上。界面上要说的是「手机现在连不连得上」，那只有真正的监听地址说得准。
 *
 * 纯函数：网卡表由调用方给（`lan/discovery.mjs` 的 `selectInterfaces`，它已经排掉了回环、链路本地和没启用的），
 * 监听地址由调用方从 `server.httpServer.address()` 取。不读环境、不碰网络，单测直接用
 * （`server/test/lan-open.test.mjs`）。
 */

/** 页面问这条信息的地址；只答回环的请求（`vite-plugin-lan-open.ts`） */
export const LAN_OPEN_PATH = '/api/lan-open';

/** 编辑器绑局域网的开关（`vite.config.ts` 的 `lanHostPlugin`）；这里只用来写提示文字 */
export const LAN_HOST_ENV = 'PROMPTCUT_LAN_HOST';

/** 没绑局域网时告诉用户怎么起（`package.json` 的 `dev:lan`） */
export const LAN_HOST_COMMAND = 'npm run dev:lan';

const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

/**
 * 这个监听地址对局域网可达吗。
 *
 * - `0.0.0.0`、`::`、空串：绑了全部网卡，可达；
 * - `127.0.0.1`、`::1`、`localhost`、`::ffff:127.*`：只绑回环，不可达；
 * - 别的（绑在某一块网卡上）：可达。
 *
 * 判不出来（不是字符串）时按**不可达**算：宁可让界面多说一句，也不让用户拿着连不上的链接试。
 *
 * @param {unknown} address
 */
export function boundToLan(address) {
  if (typeof address !== 'string') return false;
  const a = address.trim().toLowerCase();
  if (a === '' || a === '0.0.0.0' || a === '::' || a === '[::]') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  if (v4 === 'localhost' || v4 === '::1' || v4 === '[::1]') return false;
  return !v4.startsWith('127.');
}

/**
 * 一次问答的答复。
 *
 * - 只绑回环时 `addresses` 为空：手机连不上，列地址没有意义，界面照 `command` 说清怎么起。
 * - 几块网卡就给几条：用户自己挑手机连的那个网段，软件猜不出来；界面拿它核对邀请链接里的那个地址
 *   是不是局域网上的（链接的源由文档服务的 base 定，主机有几块网卡时未必是用户要的那一块）。
 *
 * @param {{ bound?: unknown, port?: unknown, nics?: Array<{ name?: string, address?: string }> }} o
 */
export function lanOpenInfo({ bound, port, nics = [] } = {}) {
  const info = {
    lanHost: boundToLan(bound),
    port: isPort(port) ? port : null,
    command: LAN_HOST_COMMAND,
    addresses: [],
  };
  if (!info.lanHost || info.port === null) return info;
  for (const nic of Array.isArray(nics) ? nics : []) {
    if (typeof nic?.address !== 'string' || nic.address === '') continue;
    info.addresses.push({ name: String(nic.name ?? ''), address: nic.address });
  }
  return info;
}

/**
 * 一条地址（可以是整条链接，也可以只是主机名）落在这几块网卡上吗。
 * 界面据此判断邀请链接是不是局域网里打得开的；解析不了的一律回 false。
 *
 * @param {unknown} link 整条链接或主机名
 * @param {Array<{ address?: string }>} addresses
 */
export function linkOnLan(link, addresses = []) {
  if (typeof link !== 'string' || link === '') return false;
  let host = link;
  try {
    host = new URL(link).hostname;
  } catch {
    host = link;
  }
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (Array.isArray(addresses) ? addresses : []).some((a) => String(a?.address ?? '').toLowerCase() === h);
}
