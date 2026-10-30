/**
 * 缺省托管地址（契约 `docs/plan/shared-project-contract.md` 第 3 节、验收 SP6）。
 *
 * 托管端的地址（现在的域名，以及换下来的 IP 与 sslip.io 名字）只写在闭源那份产品声明里（`product.mjs`；公开版没有托管端，
 * 这里拿到的是 `null`）。守门：闭源一侧 `cloud/server/test/hosted-migrate.test.mjs`，公开树 `community-boundary.test.mjs` 的 G6。
 * 别处要托管地址，一律经 `resolveHostedUrl` 取。
 *
 * 覆盖顺序（先到先得）：
 * 1. 界面上改过的值（C6.5 接上，调用方以 `ui` 传进来）；
 * 2. 否则环境变量 `PROMPTCUT_HOSTED_URL`；
 * 3. 否则 `DEFAULT_HOSTED_URL`。这一版没有托管端时它是空串，调用方按「没有托管端」跳过，不连任何地方。
 *
 * 空串、只有空白、`null`、`undefined` 都算「没设」，往下一级找。设了但不是 `http(s)://` 或 `ws(s)://` 地址的，抛 TypeError：
 * 用户写错的地址不悄悄换成缺省值，免得连到别处还以为连的是自己设的那台。
 *
 * 浏览器与 Node 通用：除产品声明外不引任何模块；浏览器里没有 `process`，第 2 级自然跳过。
 */
import { PRODUCT } from './product.mjs';

/** 托管服务的自有域名（2026-10-22 用户定）：以后换机器只改它的 DNS 记录，不用再发客户端 */
const HOSTED_HOST = PRODUCT.hosted?.host ?? null;

/** 经节点上 nginx 的 `/hosted` 入口到文档服务；素材服务在同一个源的 `/media` 下 */
export const DEFAULT_HOSTED_URL = HOSTED_HOST ? `https://${HOSTED_HOST}/hosted` : '';

/**
 * 换下来的托管端地址。旧项目文件、本机记的恢复凭证与托管地址里写的是它们；读进来时一律换成现在的，
 * 用户不用重新认证，存回去时写的就是新地址。
 * - 2026-10-06：阿里云到期不续，托管端换到新云节点（数据整体拷过去）；
 * - 2026-10-22：托管地址从新云节点的 IP 换成自有域名（用户定）。节点上 8787（文档服务）、8788（素材服务）已不对外，
 *   只经 nginx 走 https，所以「IP:8787」「IP:8788」换成新域名下的 `/hosted`、`/media`，协议跟着换成 https / wss；
 *   别的写法（sslip.io 名字、不带这两个端口的 IP）只换主机名，协议、端口、路径不变；
 *   sslip.io 的 s1.、s2. 舞台子域换成声明里的舞台主机名。
 */
const RETIRED_IPS = PRODUCT.hosted?.retiredIps ?? [];
const sslipName = (ip) => `${ip.split('.').join('-')}.sslip.io`;
const RETIRED_NAMES = RETIRED_IPS.map(sslipName);
const STAGE_HOSTS = Object.freeze({ ...PRODUCT.hosted?.stageHosts });
const PORT_PATHS = Object.freeze({ 8787: '/hosted', 8788: '/media' });

/** 主机名一级的对照；直连端口那两种另按 `PORT_PATHS` 换（见上） */
export const RETIRED_HOSTED_HOSTS = Object.freeze([...RETIRED_IPS, ...RETIRED_NAMES].map((host) => [host, HOSTED_HOST]));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IPS = RETIRED_IPS.map(escapeRe).join('|');
const NAMES = RETIRED_NAMES.map(escapeRe).join('|');
// 主机名后面只能跟：端口、路径、查询、片段、引号、反斜杠（JSON 里再转义一层）、空白、分隔符，或串尾
const END = String.raw`(?=[:/?#"'\\\s,;)\]}<>]|$)`;
const PORT_RE = new RegExp(String.raw`\b(https?|wss?)://(${IPS}):(8787|8788)(?!\d)`, 'g');
const STAGE_RE = new RegExp(String.raw`(^|[/@.])(s[12])\.(${NAMES})${END}`, 'g');
const HOST_RE = new RegExp(String.raw`(^|[/@.])(${IPS}|${NAMES})${END}`, 'g');
const MARKERS = [...RETIRED_IPS, ...RETIRED_NAMES];

/** 一个字符串里出现的旧托管地址换成现在的；不含旧地址的原样返回 */
export function migrateHostedText(text) {
  if (typeof text !== 'string' || !MARKERS.some((m) => text.includes(m))) return text;
  return text
    .replace(PORT_RE, (_, scheme, _ip, port) => `${scheme.startsWith('ws') ? 'wss' : 'https'}://${HOSTED_HOST}${PORT_PATHS[port]}`)
    .replace(STAGE_RE, (_, pre, stage) => pre + STAGE_HOSTS[stage])
    .replace(HOST_RE, (_, pre) => pre + HOSTED_HOST);
}

/**
 * 深拷一份，把其中所有字符串（含对象的键：恢复记录的键是 JSON 串，里面带服务地址）里的旧托管地址换成现在的。
 * 没有要换的就返回原值本身。
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
    throw new TypeError(`托管地址（${from}）不是合法的地址`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new TypeError(`托管地址（${from}）必须是 http(s):// 或 ws(s)://`);
  return text.replace(/\/+$/, '');
}

/**
 * 按覆盖顺序取托管地址和它的来处。
 * @param {object} [options]
 * @param {string | null} [options.ui] 界面上改过的值
 * @param {Record<string, string | undefined>} [options.env] 缺省 `process.env`（浏览器里没有就当空）
 * @returns {{ url: string, from: 'ui' | 'env' | 'default' }}
 */
export function hostedUrlChoice({ ui, env = globalThis.process?.env ?? {} } = {}) {
  if (isSet(ui)) return { url: checked(ui, 'ui'), from: 'ui' };
  const fromEnv = env?.[HOSTED_URL_ENV];
  if (isSet(fromEnv)) return { url: checked(fromEnv, 'env'), from: 'env' };
  return { url: DEFAULT_HOSTED_URL, from: 'default' };
}

/** 只要地址：`hostedUrlChoice(options).url` */
export function resolveHostedUrl(options) {
  return hostedUrlChoice(options).url;
}
