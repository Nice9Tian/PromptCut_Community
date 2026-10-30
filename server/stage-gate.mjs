/**
 * 舞台端口的闸:**从舞台端口来的请求缺省全拒,只放行下面这张白名单。**
 *
 * # 为什么
 *
 * 舞台窗口(两个 iframe,`server/vite-plugin-stage-ports.ts`)里跑的是卡片代码,其中有用户自己写的、
 * 也有共享项目里别的成员写的。舞台端口对舞台窗口是同源,`/api/**` 的同源守卫(`http-guard.mjs` 的 `originOk`)拦不住它:
 * 不设这道闸,一张卡可以从舞台里调编辑器进程的任何本机接口(实测过 `POST /api/agent/bind` 回 200),
 * 也可以经开发服务器的静态服务读项目根下的任意文件。
 *
 * # 闸在哪
 *
 * 在舞台端口的反向代理里(`vite-plugin-stage-ports.ts`),**转给编辑器进程之前**:不在白名单里的请求当场回 403,
 * 编辑器进程根本收不到;WebSocket 升级同理。编辑器进程那一侧另按代理写的头(`http-guard.mjs` 的 `viaStagePort`)
 * 用同一个函数再判一次,是第二道。直连编辑器端口的请求不经过这里,一个字不变。
 *
 * # 白名单只写在这一处
 *
 * 每一条写明:什么方法、什么路径、谁用、为什么要。加一条之前先确认它在舞台里真的发得出来(探针
 * `scripts/probes/stage-gate-probe.mjs` 会把舞台端口的全部请求记下来),并且它不能让卡片代码拿到
 * 舞台本来拿不到的东西:不放行会改编辑器进程状态的接口,不放行会回票据、密钥、对话、别的项目的接口。
 */
import fs from "node:fs";
import { apiPath } from "./http-guard.mjs";

const READ = ["GET", "HEAD"];

/**
 * 白名单。`exact` 按整条路径比,`prefix` 按前缀比(写到斜杠为止);比的是 `apiPath` 归一化之后的形式(小写、折掉重复斜杠、不含查询串)。
 * `test` 是在路径之外再加的条件(拿到请求行里的原始地址和请求头)。`upgrade: true` 的只对 WebSocket 升级生效,别的只对普通请求生效。
 *
 * 这张表是照真编辑器里舞台端口实际发出的请求定的(新建项目、点、拖、播放、贴轨道流、视频、声音、用户卡、内置卡全走一遍,
 * 流水见探针):舞台自己的页面与脚本、素材字节、动效素材目录,外加两条只读接口。全部只读;没有一条会改编辑器进程的状态。
 *
 * 舞台**不经这个端口**的东西不在这里:生成快照与轨道流的字节舞台直接向预渲染进程那个端口取(`src/render/prerender.ts`),
 * 远程素材直接向素材服务取,项目数据由父页经 `postMessage` 给。
 */
export const STAGE_ALLOW = [
  // —— 舞台页面自己(开发服务器给的页面与模块;打包后的桌面版跑的也是这台开发服务器)——
  { methods: READ, exact: "/", who: "舞台 iframe", why: "舞台文档 `/?stage=1&id=…`;热更新客户端探活也打这一条" },
  { methods: READ, prefix: "/src/", who: "舞台 iframe", why: "页面脚本、样式、卡片与部件的源码(含改动层里的用户卡,它们映射在 /src/cards/user/ 下)" },
  { methods: READ, prefix: "/server/", who: "舞台 iframe", why: "页面脚本引用的几份两端共用的模块和动效素材目录的索引(都是随包发出去的代码,没有数据)" },
  { methods: READ, prefix: "/node_modules/", who: "舞台 iframe", why: "预构建好的依赖(React、粒子、Lottie 等)" },
  { methods: READ, prefix: "/@fs/", test: (raw) => raw.split("?")[0].includes("/node_modules/"), who: "舞台 iframe",
    why: "不在项目根下的依赖(依赖向上解析时走这个前缀);只放行路径里带 /node_modules/ 的,别的文件一概不给" },
  { methods: READ, prefix: "/@vite/", who: "舞台 iframe", why: "开发服务器的热更新客户端" },
  { methods: READ, exact: "/@id/__x00__vite/dynamic-import-helper.js", who: "舞台 iframe", why: "开发服务器动态 import 的运行时辅助模块" },
  { methods: READ, exact: "/@react-refresh", who: "舞台 iframe", why: "React 热更新的运行时" },
  { upgrade: true, methods: ["GET"], exact: "/", test: (_raw, headers) => /(^|,)\s*vite-(hmr|ping)\s*(,|$)/.test(String(headers["sec-websocket-protocol"] ?? "")),
    who: "舞台 iframe", why: "热更新的 WebSocket(改卡之后舞台跟着换);只认开发服务器自己的子协议,文档服务等别的升级不放行" },
  // —— 素材 ——
  { methods: READ, prefix: "/@media/", who: "舞台里的 <video>、<img>、音频素材效果卡、素材效果卡", why: "本机内容库里的素材字节(按哈希或文件名,分段取);含 `/@media/<哈希>/pcm`" },
  { methods: READ, exact: "/api/media/file", who: "舞台里的 <video>、<img>", why: "迁移期的老项目按路径取素材;接口自己只给素材目录里的文件" },
  { methods: READ, prefix: "/catalog/", who: "Lottie 卡、粒子卡", why: "动效素材目录里登记过的 JSON(接口只认登记过的名字)" },
  // —— 两条只读接口 ——
  { methods: READ, exact: "/api/cards/scopes", who: "舞台里的卡片注册表", why: "定制卡的归属表(哪张卡属于哪个项目),只读;改档位的 POST 不放行" },
  { methods: READ, exact: "/api/prerender/info", who: "舞台里取生成快照与轨道流的那一层", why: "问预渲染进程在哪个端口,只读(预渲染进程侧由 prerender-gate 拦死除流与快照字节外的一切请求)" },
];

/** 匹配 /@media/<hash>、/@media/<hash>.<ext>、/@media/<hash>/pcm */
const MEDIA_HASH_RE = /^\/@media\/([0-9a-fA-F]{64})(?:\.[a-zA-Z0-9]+)?(?:\/pcm)?$/i;

let stageMediaHashesGetter = null;

/**
 * 注册当前项目素材哈希的获取函数（供桌面版舞台端口代理校验）
 * @param {(() => Set<string> | string[] | null) | null} fn
 */
export function setStageMediaHashesGetter(fn) {
  stageMediaHashesGetter = fn;
}

/** 路径里有没有想跳出前缀的写法:`..` 段、反斜杠、编码过的点、斜杠、反斜杠。浏览器发出来的地址不会有这些 */
function sneaky(rawPath) {
  return /(^|\/)\.\.(\/|$)/.test(rawPath) || /\\|%2e|%2f|%5c|%00/i.test(rawPath);
}

/**
 * 这条从舞台端口来的请求放不放行。
 * @param {string} method
 * @param {string} url 请求行里的地址(含查询串)
 * @param {{ upgrade?: boolean, headers?: Record<string, unknown>, projectMediaHashes?: Set<string> | string[] | (() => Set<string> | string[] | null) }} [opts] `upgrade`:这是一次 WebSocket 升级
 */
export function stageRequestAllowed(method, url, opts = {}) {
  const m = String(method || "GET").toUpperCase();
  const raw = String(url || "/");
  const rawPath = raw.split("?")[0];
  if (!rawPath.startsWith("/") || sneaky(rawPath)) return false;

  // 舞台按哈希读素材只放行当前项目 project.media 里的素材
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
  for (const rule of STAGE_ALLOW) {
    if (!!rule.upgrade !== !!opts.upgrade) continue;
    if (!rule.methods.includes(m)) continue;
    if (rule.exact !== undefined ? p !== rule.exact : !p.startsWith(rule.prefix)) continue;
    if (rule.test && !rule.test(raw, opts.headers ?? {})) continue;
    return true;
  }
  return false;
}

/** 拒绝时回的内容(代理和编辑器进程那一侧回的是同一句) */
export const STAGE_DENY_BODY = JSON.stringify({ ok: false, error: "舞台端口不提供这个接口" });

/**
 * 排障和探针用的流水:设了 `PROMPTCUT_STAGE_PORT_LOG=<文件>` 时,舞台端口每来一个请求追加一行
 * `{ m, u, ws, ok }`(方法、地址、是不是升级、放没放行)。不设时什么都不做。只记不判,不影响放行与否。
 */
export function stageGateLog(method, url, upgrade, ok) {
  const file = process.env.PROMPTCUT_STAGE_PORT_LOG;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ m: String(method || "GET").toUpperCase(), u: String(url || "/"), ws: !!upgrade, ok }) + "\n"); } catch { /* 记不下来不影响请求 */ }
}

export { READ as STAGE_READ_METHODS };
