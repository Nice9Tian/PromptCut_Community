import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadCosts, loadTuning, saveTuning, upsertCosts, filterCosts } from "./costs-store.mjs";
import { isPrerender } from "./render-role.mjs";
import { prerenderState } from "./prerender-client.mjs";

/**
 * HTTP surface for K1 probe records (target K/K1). **Both processes mount this plugin**, just like
 * the mirror in A7.
 *
 *   GET  /api/data/costs?device=<string>[&mode=dev|build]   → { ok, device, mode, costs, tuning }
 *   PUT  /api/data/costs  { records: [] }  → { ok, count, added, updated }
 *   PUT  /api/data/costs/tuning  { tuning: {…} | null }  → { ok, tuning }
 *
 * # Why the tuning write entry point is mounted under this prefix
 *
 * R4a only implemented read (changing coefficients relied on manually editing
 * `out/pipeline-tuning.json`), leaving "tune without changing code" only half-done.
 * Mounting the write entry point as `/api/data/costs/tuning` instead of opening another top-level
 * route is because connect's `middlewares.use(prefix)` already includes subpaths by default: having
 * both entry points that read and write the same data in the same middleware allows reusing the
 * forwarding section to the prerender process as is (both sides must use the same coefficients,
 * otherwise they cannot compute the same table).
 * The request body is `{ tuning: {…} }`; passing `null` / non-object for `tuning` = **clear overrides,
 * use all defaults** (delete file).
 * What is written to disk is the clamped copy (see `saveTuning` in `costs-store.mjs`). No UI is built.
 *
 * # Why `tuning` piggybacks on this
 *
 * Override values for the three tunable coefficients of K2 (`COST_SCALE` / `STEP_PERCENTILE` /
 * `STEP_MIN_SAMPLES`) are stored locally in `out/pipeline-tuning.json` (absence of this file = use
 * all defaults). `planPipelines` is computed once each in the page and prerender process, and both
 * sides must use the **same coefficients**, while both sides already fetch `costs` anyway: opening
 * another endpoint would only introduce an extra window where "one side gets new coefficients while
 * the other side still has old ones". Therefore, **add a `tuning` field** in the GET response,
 * keeping the original `{ ok, device, mode, costs }` completely untouched:
 * `scripts/probe-card-costs.mjs`, `server/test/costs.test.mjs`, and the future page side only read
 * fields they recognize, remaining unaffected (task brief K2 specified `{ records, tuning }`, which
 * would rename `costs` and change all existing callers; adding a field achieves the same effect at
 * a much lower cost).
 *
 * # Why the prerender side also mounts it
 *
 * The prerender process in `user` / `full` mode needs to compute `plan.prerenderSet` according to
 * `costs` (the K6 closed loop of downgrade → prerender → ready → switch). Its own page does not run
 * probes, so records can only come from the editor process.
 * Same pattern as the mirror: after writing to disk, the editor process forwards the **exact same
 * PUT** as is (without waiting for a reply); this plugin on the prerender side writes its own local
 * copy, and `frame-pipeline.mjs` reads it at 4-frame batch boundaries.
 * Dropped forwarded requests are not fatal: the next probe PUT will bring the entire batch along
 * again, and records themselves are idempotent upserts.
 *
 * The prerender process in `agent` mode does not need it (Agent queries are all live rendered, no
 * prerendering), but "whether it is in agent mode" cannot be seen from the editor side (that is the
 * prerender process's own startup argument), so it forwards regardless: writing one more unread
 * file over there has no side effects.
 *
 * # Deduplication
 *
 * By `(identityKey, device)`, see `server/costs-store.mjs`. `identityKey` already includes fps,
 * so fps is no longer listed separately in the key.
 *
 * # Method
 *
 * Semantically this is a batch upsert, so PUT is used; POST is also accepted (the forwarding chain
 * and some legacy callers only send POST). The same-origin guard (`vite-plugin-api-guard`) is placed
 * in front of all endpoints, so checks are not repeated here.
 */

const MAX_BODY = 8 * 1024 * 1024;

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, res: ServerResponse, then: (d: any) => void) {
  let body = "", size = 0, over = false;
  req.on("data", (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY) { over = true; sendJson(res, 413, { ok: false, error: "Probe record too large" }); req.destroy(); return; }
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

/* ---------------------------------------------------------------- Forwarding */

// Send as a chained sequence: if two probe record batches fly concurrently, arrival order is not
// guaranteed, and the batch sent later might be written to disk first.
// Upsert is idempotent, but "writing older data later" still allows the prerender side to briefly
// receive stale scores.
let forwardChain: Promise<unknown> = Promise.resolve();

/** Forward this PUT to the ready prerender process. Only editor process does this, without waiting for reply */
function forwardToPrerender(path: string, body: unknown) {
  if (isPrerender) return;
  const remote = prerenderState();
  if (!remote.ready || !remote.url) return;
  const url = remote.url + path;
  forwardChain = forwardChain.then(async () => {
    try {
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch { /* Prerender not ready / restarting: next batch of probe PUTs will bring the records along */ }
  }, () => {});
}

export function costsPlugin(): Plugin {
  return {
    name: "promptcut-costs",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.middlewares.use("/api/data/costs", (req, res) => {
        const method = String(req.method || "GET").toUpperCase();
        // connect stripped the prefix: req.url is `/tuning` when `/api/data/costs/tuning` comes in
        let sub = "/";
        try { sub = new URL(req.url || "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/"; } catch { sub = "/"; }

        if (sub === "/tuning") {
          if (method !== "PUT" && method !== "POST") return sendJson(res, 405, { ok: false, error: "PUT only" });
          return readBody(req, res, (d) => {
            /*
             * body is `{ tuning: {…} }`; bare objects are also accepted (same treatment as the records branch).
             * `tuning: null` = clear overrides, use all defaults. The same-origin guard is handled upfront by
             * vite-plugin-api-guard, not rechecked here (it guarantees: reject cross-origin Origin, requests
             * with body must be application/json).
             */
            const raw = d && typeof d === "object" && "tuning" in d ? d.tuning : d;
            try {
              const tuning = saveTuning(root, raw);
              sendJson(res, 200, { ok: true, tuning });
              // Both sides must use the same coefficients; otherwise planPipelines cannot compute the same table (K2)
              forwardToPrerender("/api/data/costs/tuning", { tuning: raw });
            } catch (e: any) {
              sendJson(res, 500, { ok: false, error: e?.message || String(e) });
            }
          });
        }
        if (sub !== "/") return sendJson(res, 404, { ok: false, error: `No such endpoint: ${sub}` });

        if (method === "GET") {
          const device = query(req, "device");
          // mode(dev | build): dispatch uses records of current run mode (task brief 3.1);
          // legacy records missing fields are treated as dev
          const mode = query(req, "mode");
          const costs = filterCosts(loadCosts(root), device, mode);
          // tuning is an added field, leaving original four items untouched
          // (see "Why tuning piggybacks on this" at the file header)
          return sendJson(res, 200, { ok: true, device: device ?? null, mode: mode ?? null, costs, tuning: loadTuning(root) });
        }
        if (method !== "PUT" && method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / PUT only" });
        readBody(req, res, (d) => {
          const records = Array.isArray(d?.records) ? d.records : Array.isArray(d) ? d : null;
          if (!records) return sendJson(res, 400, { ok: false, error: "Missing records:[]" });
          try {
            const out = upsertCosts(root, records);
            sendJson(res, 200, { ok: true, count: out.count, added: out.added, updated: out.updated });
            forwardToPrerender("/api/data/costs", { records });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}

export default costsPlugin;
