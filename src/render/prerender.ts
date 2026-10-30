import { useEffect, useState } from "react";

/**
 * 预渲染进程的地址(docs/archive/topics/decoupling-plan.md 第 3 节「预渲染」)。
 *
 * 编辑器页面里**挂得久**的请求 —— 3D 视图的空闲预渲染、聊天栏里的动图、导出进度 —— 直接发到
 * 预渲染那个源上,不走编辑器自己的源。原因是浏览器对同一个源只开约 6 条 HTTP/1.1 连接:
 * 这些请求一挂几秒到几分钟,挤在编辑器的源上会把连接占满,之后编辑器要加载的模块、素材、
 * 接口全部排队,界面卡死而 CPU 一点都不忙(实测轻请求要等 7.7 秒)。
 *
 * **拿不到地址就抛 `PRERENDER_UNAVAILABLE`,不再退回同源**(D5「同源退回删除」,R7)。
 * R7 之后编辑器进程的 `FramePipeline` 是 `interactive: false` —— `user` / `playback`
 * 两条 lane 立即回 `USE_PRERENDER`,它那一侧根本没有热 Chrome 可以接活。再悄悄退回同源,
 * 得到的不是「慢一点但功能照旧」,而是一条必然失败、还把编辑器的连接占着的请求;
 * 更糟的是它把「预渲染没起来」这个真实故障藏成一串看不懂的 404 / 超时。
 * 抛出来,调用方才能照 D5 的规矩各自兜底:舞台照常跑(轻卡、素材层、点选都不依赖预渲染),
 * 只是那一层没有死素材;Agent 侧把失败写进工具结果;界面上该明示的明示。
 *
 * **地址只缓存几秒**:预渲染崩了会被重新拉起,每次都换一个新的空闲端口(vite-plugin-prerender)。
 * 缓存死了的话,它一重启,页面上所有直连请求都打到旧端口上,直到用户刷新页面。
 * **「问过了,没有」这个结论同样缓存 `CACHE_MS`** —— 否则预渲染没起来的时候,
 * 每一次 `fetchSnapshot` 都要重新等一轮 `/api/prerender/info`。
 */

/** 地址(或者「还没就绪」这个结论)能用多久 */
const CACHE_MS = 5000;

/** 上一次问到的结论:有地址,或者问过了没有。`null` = 还没问过 / 缓存已作废 */
type Probe = { ok: true; url: string } | { ok: false };

let cached: Probe | null = null;
let checkedAt = 0;
let asking: Promise<Probe> | null = null;
/** 头一次问:预渲染可能还在启动,多等一会儿;之后只问一次 */
let firstAsk = true;

/** 预渲染进程不可用。调用方按 `code` 认,不认文案 */
export function prerenderUnavailable(): Error {
  return Object.assign(new Error("预渲染进程还没就绪,这一项要它才能完成。"), {
    code: "PRERENDER_UNAVAILABLE",
    retryable: true,
  });
}

/** Drop a cached port after a connection reset so the next request asks the
 * editor for the freshly restarted prerender process. */
export function invalidatePrerenderBase() {
  cached = null;
  checkedAt = 0;
}

async function ask(tries: number): Promise<Probe> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("/api/prerender/info", { cache: "no-store" });
      if (!r.ok) return { ok: false };
      const d = await r.json();
      if (d?.ready && typeof d.url === "string") return { ok: true, url: d.url };
    } catch {
      return { ok: false };
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false };
}

/** 预渲染的源(`http://127.0.0.1:端口`);拿不到就抛 `PRERENDER_UNAVAILABLE` */
export async function prerenderBase(): Promise<string> {
  if (cached && Date.now() - checkedAt < CACHE_MS) {
    if (!cached.ok) throw prerenderUnavailable();
    return cached.url;
  }
  if (!asking) {
    // 起预渲染要一两秒(首次预构建依赖更久):头一次最多等 10 秒,之后不再干等
    asking = ask(firstAsk ? 20 : 1).then((p) => {
      firstAsk = false;
      cached = p;
      checkedAt = Date.now();
      asking = null;
      return p;
    });
  }
  const probe = await asking;
  if (!probe.ok) throw prerenderUnavailable();
  return probe.url;
}

/** 把一个 /api/... 路径换成预渲染上的完整地址;拿不到地址就抛(**不拼空串**) */
export async function prerenderUrl(path: string): Promise<string> {
  return (await prerenderBase()) + path;
}

/**
 * 给 <img src> 这类同步场合用:拿到预渲染的源之后才渲得出地址。
 * 返回的是一个前缀,拼在 /api/... 前面用。
 *
 * **`null` = 还不知道 / 预渲染不可用**(R7:以前这里是 `""`,也就是悄悄退回同源)。
 * 调用方拿到 `null` 时不要去拼地址 —— 拼出来的是编辑器自己的源,那正是被删掉的那条退路。
 */
export function usePrerenderBase(): string | null {
  const [b, setB] = useState<string | null>(cached?.ok ? cached.url : null);
  useEffect(() => {
    let live = true;
    prerenderBase().then((u) => { if (live) setB(u); }, () => { if (live) setB(null); });
    return () => { live = false; };
  }, []);
  return b;
}

/** 把相对地址(/api/ai/visual/...)前缀上预渲染的源;已经是绝对地址的原样返回 */
export function withBase(b: string, url: string): string {
  return url.startsWith("/") ? b + url : url;
}
