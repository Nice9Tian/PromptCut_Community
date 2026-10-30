import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMirrorStore } from "./mirror-store.mjs";
import { isPrerender } from "./render-role.mjs";
import { prerenderState } from "./prerender-client.mjs";
import { createReadySessionRegistry, replayReadySessions as replaySessions } from "./ready-session-registry.mjs";

/**
 * 数据管理的只读镜像(A7)。**两个进程都挂这一份插件。**
 *
 * # 它解决什么
 *
 * 以前镜像住在 `vite-plugin-ai` 里,而 ai 插件只在编辑器那一端挂(预渲染那一端不挂它 ——
 * 它会改写全局 port.json,把 MCP 指到预渲染去)。于是预渲染进程手里没有项目,每一个帧请求
 * 都得把整份项目塞进 body 再发一遍:拖一个片段的 2 秒里几百 KB 发十几次,而真正变的
 * 只有一段。镜像单独成插件之后两个进程各存一份,帧请求的 body 只剩 `{session, localRev, lane}`。
 *
 * # 键、版本窗口、两种拒收
 *
 * 见 `server/mirror-store.mjs` 的说明(存储本体在那儿,这里只是 HTTP 面)。
 *
 * # 谁把项目送到预渲染进程手里
 *
 * 三条路,缺一不可:
 *
 * 1. **转发**:编辑器进程每收到一次推送(整份或补丁)就原样转给当前就绪的预渲染进程。
 *    补丁被它回 409 的话(它刚重启、手里没有基线)当场补一次整份。
 * 2. **回拉**:预渲染进程按 `PROMPTCUT_EDITOR_URL`(spawn 时给的,见 vite-plugin-prerender)
 *    向编辑器 `GET /api/data/project?session=&localRev=` 要那一版。转发丢了、或者进程
 *    刚起来就收到帧请求时走这条。`agent` 模式的预渲染进程不带这个变量 —— 它的项目由
 *    Agent 服务端推(I2),回拉自然空转。
 * 3. **补推**:预渲染进程重启、健康检查刚过时,编辑器把每个 session 的最新一版整份推过去。
 *
 * 转发按目标串成一条链发(一次只飞一个),否则到达顺序没保证,补丁会踩空基线。
 *
 * 补推之后还有一步(Item 4 方案 A):照「会话版本登记」把每个会话最后一次被接受的 preload
 * 串行重放一遍,预渲染进程据此重新知道每个会话当前是哪一版、把就绪索引长回来(`replayReadySessions`)。
 */

const store = createMirrorStore();

export type MirrorVersion = { session: string; localRev: number; project: any; hash: string; at: number };

/** 当前编辑页 session 的最新一版 */
export function latestMirror(): MirrorVersion | null { return store.latestMirror() as MirrorVersion | null; }
(globalThis as any).__PC_LATEST_MIRROR__ = latestMirror;
/** 按 `{session, localRev}` 取。`localRev` 省略 = 那个 session 的最新一版 */
export function getMirror(session: string, localRev?: number | string | null): MirrorVersion | null {
  return store.getMirror(session, localRev as any) as MirrorVersion | null;
}
/** C4:页面报上来的「播放头附近现在缺哪些层」,最多 8 条 */
export type WantedFrame = { clipId: string; frame: number };
/** 当前编辑页 session 的播放头 */
export function latestPlayhead(): { session: string; t: number; playing: boolean; at: number; wanted?: WantedFrame[] } | null {
  return store.latestPlayhead() as any;
}

/** 编辑器那一端的地址(只有预渲染进程有);`agent` 模式不带 */
function editorUrl(): string { return String(process.env.PROMPTCUT_EDITOR_URL || "").replace(/\/+$/, ""); }

const pulling = new Map<string, Promise<MirrorVersion | null>>();

/**
 * 取一版项目;本进程没有就按 `PROMPTCUT_EDITOR_URL` 回拉一次。
 * 拿不到返回 null —— 调用方(帧插件的 prologue)据此回 409 `MIRROR_MISSING`。
 */
export async function ensureMirror(session: string, localRev?: number | string | null): Promise<MirrorVersion | null> {
  if (!session) return null;
  const hit = getMirror(session, localRev);
  if (hit) return hit;
  const base = editorUrl();
  if (!base) return null;
  const key = `${session}@${localRev ?? ""}`;
  let inFlight = pulling.get(key);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const query = `session=${encodeURIComponent(session)}` + (localRev === undefined || localRev === null || localRev === "" ? "" : `&localRev=${encodeURIComponent(String(localRev))}`);
        const res = await fetch(`${base}/api/data/project?${query}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        const data: any = await res.json();
        if (!data?.ok || !data.project) return null;
        // 回拉回来的按定义是「本进程缺的那一版」,常常比手里最新的还旧 —— 走 insert,
        // 不走 pushFull 的 stale 闸(那道是拦乱序推送的,拦到回拉就再也补不回来了)
        store.insert({ session: data.session || session, localRev: data.localRev, project: data.project });
        return getMirror(data.session || session, data.localRev);
      } catch { return null; }
      finally { pulling.delete(key); }
    })();
    pulling.set(key, inFlight);
  }
  return inFlight;
}

/* ---------------------------------------------------------------- 转发 */

let forwardChain: Promise<unknown> = Promise.resolve();

async function postJson(url: string, body: unknown, timeoutMs = 15000) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.PROMPTCUT_INTERNAL_TOKEN) headers["x-pc-internal-token"] = process.env.PROMPTCUT_INTERNAL_TOKEN;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, data: await res.json().catch(() => null) as any };
}

/** 把这一次推送转给预渲染进程。只有编辑器进程做这件事 */
function forward(pathname: string, payload: any, fallbackFull: () => any | null) {
  if (isPrerender) return;
  const remote = prerenderState();
  if (!remote.ready || !remote.url) return;
  const url = remote.url;
  forwardChain = forwardChain.then(async () => {
    try {
      const { status } = await postJson(url + pathname, payload);
      // 它刚重启、手里没有基线:补一次整份,不然接下来每一版补丁都会踩空
      if (status === 409) {
        const full = fallbackFull();
        if (full) await postJson(url + "/api/data/project", full);
      }
    } catch { /* 预渲染没就绪 / 正在重启:回拉和补推还能兜住 */ }
  }, () => {});
}

/** 预渲染进程重启之后:把每个 session 的最新一版整份补过去 */
export async function repushMirror(url: string): Promise<void> {
  const all = store.allLatest() as MirrorVersion[];
  for (const v of all) {
    try { await postJson(url + "/api/data/project", { session: v.session, localRev: v.localRev, project: v.project }); }
    catch { /* 补不上就等下一次推送或回拉 */ }
  }
}

/* ------------------------------------------------ 会话版本登记(Item 4 方案 A) */

/**
 * 每个页面会话最后一次被预渲染进程接受的 preload(`server/ready-session-registry.mjs`)。
 * 只在编辑器进程里有内容;预渲染进程重启后由 `replayReadySessions` 照着重放。
 */
const readySessions = createReadySessionRegistry();

/**
 * 预渲染进程接受了一次 preload:报给编辑器进程登记。编辑器进程自己收到的就地登记。
 * 发出去就不管 —— 登记只为重启恢复,丢一次无妨(下一次 preload 会再报)。
 */
export function reportReadySession(session: string, localRev: unknown): void {
  if (!session) return;
  if (!isPrerender) { readySessions.record(session, localRev); return; }
  const base = editorUrl();
  if (!base) return;
  void postJson(base + "/api/data/ready-session", { session, localRev }, 3000).catch(() => {});
}

/** 测试 / 诊断用 */
export function readySessionList() { return readySessions.list(); }

/**
 * 预渲染进程重启、镜像补推完之后:按登记表把 preload 串行重放一遍(一次一个,最近活跃的先)。
 * `isCurrent`:重放途中预渲染进程又换了(再次重启)就停,交给下一轮。
 */
export async function replayReadySessions(url: string, isCurrent: () => boolean = () => true) {
  return replaySessions({
    sessions: readySessions.list(),
    resolve: (session: string, localRev: number) => (getMirror(session, localRev) ?? getMirror(session))?.localRev ?? null,
    preload: async ({ session, localRev }: { session: string; localRev: number }) => {
      const { status, data } = await postJson(url + "/api/frames/preload", { session, localRev, lane: "background" }, 10000);
      return { ok: status >= 200 && status < 300, status: data?.status ?? status };
    },
    isCurrent,
  });
}

/* ---------------------------------------------------------------- HTTP */

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, res: ServerResponse, limit: number, then: (d: any) => void) {
  let body = "", size = 0, over = false;
  req.on("data", (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > limit) { over = true; sendJson(res, 413, { ok: false, error: "推送体太大" }); req.destroy(); return; }
    body += c;
  });
  req.on("end", () => {
    if (over) return;
    try { then(JSON.parse(body || "{}")); }
    catch (e: any) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
  });
}

function query(req: IncomingMessage, key: string): string | null {
  try { return new URL(req.url || "/", "http://127.0.0.1").searchParams.get(key); } catch { return null; }
}

export function mirrorPlugin(): Plugin {
  return {
    name: "promptcut-mirror",
    configureServer(server: ViteDevServer) {
      /* 整份推送 + 按键读取 */
      server.middlewares.use("/api/data/project", (req, res) => {
        if (req.method === "GET") {
          const session = query(req, "session");
          const localRev = query(req, "localRev");
          const v = session ? getMirror(session, localRev) : latestMirror();
          if (!v) return sendJson(res, 404, { ok: false, error: "还没有镜像:编辑器页面没打开过,或者这一版已经滑出窗口" });
          const head = latestPlayhead();
          // rev / t 是老字段名,留着给还没改口的调用方
          return sendJson(res, 200, { ok: true, session: v.session, localRev: v.localRev, rev: v.localRev, projectHash: v.hash, at: v.at, t: head?.t ?? 0, project: v.project });
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / POST only" });
        readBody(req, res, 64 * 1024 * 1024, (d) => {
          try {
            const session = String(d.session || "");
            const localRev = Number(d.localRev ?? d.rev) || 0;
            const out = store.pushFull({ session, localRev, project: d.project });
            sendJson(res, 200, { ok: true, session, localRev: out.localRev, projectHash: out.hash, ...(out.status === "stale" ? { stale: true } : {}) });
            /*
             * 整份推送**一律**转发,`stale` 也转 —— 页面收到帧请求的 409 MIRROR_MISSING 之后
             * 会整份重推一次,而这一版编辑器这边多半已经有了(缺的是预渲染那边)。这时候不转发的话,
             * 「重推」就只在编辑器里打转,预渲染永远补不上那一版。
             * 转过去的整份是自带基线的,到得晚了对面按 `stale` 自己挡掉,不会踩乱顺序
             * (补丁不能这么干:它要基线,所以只在 `ok` 时转)。
             */
            const payload = { session, localRev, project: d.project };
            forward("/api/data/project", payload, () => payload);
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /* 两层 diff */
      server.middlewares.use("/api/data/diff", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        readBody(req, res, 16 * 1024 * 1024, (d) => {
          try {
            const session = String(d.session || "");
            const out = store.pushDiff({ session, fromLocalRev: d.fromLocalRev, toLocalRev: d.toLocalRev, hash: d.projectHash, patch: d.patch });
            if (out.status === "resync") {
              return sendJson(res, 409, { ok: false, code: "MIRROR_RESYNC", reason: out.reason, localRev: out.localRev, error: `镜像对不上(${out.reason}),请整份重推` });
            }
            sendJson(res, 200, { ok: true, session, localRev: out.localRev, projectHash: out.hash, ...(out.status === "stale" ? { stale: true } : {}) });
            if (out.status === "ok") {
              const payload = { session, fromLocalRev: d.fromLocalRev, toLocalRev: d.toLocalRev, projectHash: d.projectHash, patch: d.patch };
              forward("/api/data/diff", payload, () => {
                const v = getMirror(session, out.localRev);
                return v ? { session, localRev: v.localRev, project: v.project } : null;
              });
            }
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /*
       * 会话版本登记(Item 4 方案 A):预渲染进程每接受一次 preload 就报到这里。
       * 只在编辑器进程里登记 —— 它是预渲染进程的父进程,预渲染崩溃重启后由它照表重放 preload。
       */
      server.middlewares.use("/api/data/ready-session", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        if (isPrerender) return sendJson(res, 404, { ok: false, error: "会话版本只登记在编辑器进程" });
        readBody(req, res, 4 * 1024, (d) => {
          const session = typeof d.session === "string" ? d.session : "";
          if (!session || session.length > 200) return sendJson(res, 400, { ok: false, error: "session 参数不合法" });
          sendJson(res, 200, { ok: true, changed: readySessions.record(session, d.localRev) });
        });
      });

      /*
       * 播放头单独一条路。它和项目的节奏完全不同:项目是「改了才推」,播放头是
       * 「停下来的时候报一次当前时刻」—— 混在一起的话,拖播放头会带着整份项目再飞一趟。
       *
       * C4 的 `wanted` 搭在同一条路上(最多 8 条 `{clipId, frame}`):页面每 100 ms
       * 至多报一次「播放头附近现在缺哪些层」,编辑器进程**和 diff 一样原样转发**给
       * 预渲染进程、不等回复,预渲染进程的 `latestPlayhead()` 才带得上它。
       * 转发体漏掉 `wanted` 就等于整条提示静默丢掉,所以这里和 `setPlayhead` 的
       * 白名单必须一起改。
       */
      server.middlewares.use("/api/data/playhead", (req, res) => {
        if (req.method === "GET") {
          const head = latestPlayhead();
          return sendJson(res, head ? 200 : 404, head ? { ok: true, ...head } : { ok: false, error: "还没有播放头" });
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / POST only" });
        readBody(req, res, 64 * 1024, (d) => {
          try {
            const session = String(d.session || "");
            const head = store.setPlayhead(session, d.t, d.playing, d.wanted);
            sendJson(res, 200, { ok: true, ...head });
            forward("/api/data/playhead", { session, t: head.t, playing: head.playing, ...(head.wanted ? { wanted: head.wanted } : {}) }, () => null);
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}

export default mirrorPlugin;
