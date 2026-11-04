import { useEffect, useState } from "react";

/**
 * Address of the prerender process (docs/archive/topics/decoupling-plan.md Section 3 "Prerender").
 *
 * Long-hanging requests in the editor page: idle prerender for 3D views, animated images in the chat
 * panel, export progress: are sent directly to that prerender origin, bypassing the editor's own
 * origin. The reason is that browsers open only about 6 HTTP/1.1 connections per origin: when these
 * requests hang for seconds to minutes, crowding them onto the editor's origin exhausts connections;
 * subsequently, modules, assets, and APIs that the editor needs to load all queue up, freezing the
 * UI while CPU is completely idle (measured light requests waiting 7.7 seconds).
 *
 * **Throws `PRERENDER_UNAVAILABLE` if address is unavailable; no longer falls back to same-origin**
 * (D5 "Same-origin fallback removal", R7). After R7, the editor process's `FramePipeline` has
 * `interactive: false`: both `user` and `playback` lanes immediately return `USE_PRERENDER`, with no
 * warm Chrome on its side to take jobs. Quietly falling back to same-origin does not yield "a bit
 * slower but functioning as usual", but a request bound to fail while still hogging the editor's
 * connections; worse, it masks the real failure of "prerender failed to start" behind a cryptic
 * series of 404s / timeouts. By throwing, callers can fall back individually according to D5 rules:
 * stage runs as usual (light cards, asset layer, and clicks do not depend on prerender), except that
 * layer lacks dead assets; the Agent side records failures into tool results; the UI clearly
 * indicates what needs to be indicated.
 *
 * **Address is cached for only a few seconds**: if prerender crashes, it is respawned, using a new
 * free port each time (vite-plugin-prerender). If cached statically, once it restarts, all direct
 * requests on the page hit the old port until the user refreshes the page. **The conclusion "queried
 * and none found" is likewise cached for `CACHE_MS`**: otherwise, whenever prerender fails to start,
 * every `fetchSnapshot` has to wait through another round of `/api/prerender/info`.
 */

/** How long the address (or the "not ready yet" conclusion) remains valid */
const CACHE_MS = 5000;

/** Last queried conclusion: has address, or queried and none found. `null` = not queried yet / cache invalidated */
type Probe = { ok: true; url: string } | { ok: false };

let cached: Probe | null = null;
let checkedAt = 0;
let asking: Promise<Probe> | null = null;
/** First query: prerender may still be starting up, wait a bit longer; only query once thereafter */
let firstAsk = true;

/** Prerender process unavailable. Callers match by `code`, not message text */
export function prerenderUnavailable(): Error {
  return Object.assign(new Error("The prerender process is not ready yet, and this item needs it to finish."), {
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

/** Prerender origin (`http://127.0.0.1:port`); throws `PRERENDER_UNAVAILABLE` if unobtainable */
export async function prerenderBase(): Promise<string> {
  if (cached && Date.now() - checkedAt < CACHE_MS) {
    if (!cached.ok) throw prerenderUnavailable();
    return cached.url;
  }
  if (!asking) {
    // Starting prerender takes 1-2 seconds (initial dependency pre-bundling takes longer): wait up to
    // 10 seconds on first attempt, no busy waiting thereafter
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

/** Replaces an /api/... path with the full address on prerender; throws if address is unavailable (**does not construct an empty string**) */
export async function prerenderUrl(path: string): Promise<string> {
  return (await prerenderBase()) + path;
}

/**
 * For synchronous contexts such as <img src>: addresses can only be rendered after obtaining the
 * prerender origin. Returns a prefix to be used before /api/...
 *
 * **`null` = not known yet / prerender unavailable** (R7: previously this was `""`, meaning a quiet
 * fallback to same-origin). When callers receive `null`, do not construct an address: what gets
 * constructed is the editor's own origin, which is precisely the fallback path that was removed.
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

/** Prefixes a relative address (/api/ai/visual/...) with the prerender origin; returns unchanged if already an absolute address */
export function withBase(b: string, url: string): string {
  return url.startsWith("/") ? b + url : url;
}
