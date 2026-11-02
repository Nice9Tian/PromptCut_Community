/**
 * C6.6 section 4: polling on the page side (queries current asset service `chunks` every 2 seconds),
 * asset service for shared projects, interception before export.
 * Run: node --test src/editor/media/assetTiers.test.mjs
 * `fetch` is replaced with a fake: returns `chunks` by address, records which were queried and
 * whether tickets were attached.
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const T = await import("./assetTiers.ts");
const { TIERS_KNOWN_LOCAL, TIERS_KNOWN_REMOTE } = await import("../../render/mediaTier.ts");

const h = (c) => c.repeat(64);
const project = {
  media: [
    { id: "a", name: "开场.mov", url: `/@media/${h("1")}`, hash: h("1"), tiers: { original: h("1"), small: h("2") } },
    { id: "b", name: "结尾.mp4", url: `/@media/${h("3")}`, hash: h("3") },
    { id: "legacy", name: "老.mp4", url: "/api/media/file?path=x" },
  ],
  tracks: [{ id: "t", clips: [{ id: "x", mediaId: "a", start: 0, end: 5 }, { id: "y", mediaId: "b", start: 5, end: 6 }] }],
};

function fakeFetch(completeOn) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization ?? null, method: init.method ?? "GET", body: init.body ?? null });
    const m = /\/media\/([0-9a-f]{64})\/chunks$/.exec(String(url));
    if (m) return new Response(JSON.stringify({ complete: completeOn(String(url), m[1]) }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  };
  return calls;
}
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; T.resetAssetTiersForTest(); });

test("T5-poll-1: only asks about the tier that has not reached the top tier yet: assets whose original-size asset is complete are no longer asked about; assets in the migration period are not asked about", () => {
  assert.deepEqual(T.hashesToAsk(project, new Set()), [h("1"), h("2"), h("3")]);
  assert.deepEqual(T.hashesToAsk(project, new Set([h("2")])), [h("1"), h("3")], "Once the small-size asset is complete, only the original-size asset is asked about");
  assert.deepEqual(T.hashesToAsk(project, new Set([h("1"), h("3")])), [], "Stop once everything has reached the top tier");
});

test("T5-poll-2: when connected to the local asset service, ask /api/asset on this machine; after asking, the set carries a local marker", async () => {
  const calls = fakeFetch((_u, hash) => hash === h("2"));
  assert.deepEqual(T.tierHashes(), [], "Not asked yet");
  await T.pollOnce(project);
  assert.ok(calls.every((c) => c.url.startsWith("/api/asset/media/")));
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_LOCAL, h("2")]);
});

test("T5-poll-3: when connected to a remote asset service, ask the remote one and send a ticket; when the asset service changes, the set is cleared and the marker becomes remote", async () => {
  const calls = fakeFetch((url, hash) => url.startsWith("http://nas:5460") && hash !== h("3"));
  await T.pollOnce(project);
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_LOCAL]);
  T.setRemoteAssets({ base: "http://nas:5460/api/asset/", ticket: async () => "tkt-r" });
  assert.deepEqual(T.tierHashes(), [], "Asset service changed: back to \"not asked yet\"");
  await new Promise((r) => setTimeout(r, 10)); // The moment it is pushed to the editor process
  const pushed = calls.find((c) => c.url === "/api/media/remote" && c.method === "POST");
  assert.ok(pushed, "Tells the local editor process (on-demand fetch and prefetch)");
  assert.deepEqual(JSON.parse(pushed.body), { base: "http://nas:5460/api/asset", ticket: "tkt-r" });
  calls.length = 0;
  await T.pollOnce(project);
  assert.ok(calls.length && calls.every((c) => c.url.startsWith("http://nas:5460/api/asset/media/") && c.auth === "Bearer tkt-r"));
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_REMOTE, h("1"), h("2")]);
  // Those that have fully arrived are no longer queried
  calls.length = 0;
  await T.pollOnce(project);
  assert.deepEqual(calls.map((c) => c.url.split("/media/")[1]), [`${h("3")}/chunks`]);
});

test("T5-poll-4: those that cannot be queried (network error) count as incomplete, without throwing", async () => {
  globalThis.fetch = async () => { throw new Error("down"); };
  await T.pollOnce(project);
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_LOCAL]);
});

test("T5-shared-1: pick the asset service from the registered service addresses: prefer the one on the same host as the document service; one that points at this page itself does not count", () => {
  const eps = [
    { kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] },
    { kind: "asset", urls: ["http://192.168.1.5:5190/api/asset", "http://127.0.0.1:5190/api/asset"] },
  ];
  assert.equal(T.pickAssetEndpoint(eps, "http://192.168.1.5:5190/", "localhost:5190"), "http://192.168.1.5:5190/api/asset");
  assert.equal(T.pickAssetEndpoint(eps, "https://cloud.example/", "localhost:5190"), "http://10.0.0.9:5460/api/asset");
  assert.equal(T.pickAssetEndpoint([{ kind: "asset", urls: ["http://127.0.0.1:5190/api/asset"] }], "http://x/", "127.0.0.1:5190"), null, "This machine is the host");
  assert.equal(T.pickAssetEndpoint(null, "http://x/", "h"), null);
});

test("T5-shared-1b: online browser mode accepts a same-origin asset service (the page, document service and asset service all sit under one origin on the hosted side, c10a)", () => {
  const eps = [{ kind: "asset", urls: ["https://203-0-113-16.sslip.io/media/api/asset"] }];
  const doc = "https://203-0-113-16.sslip.io/hosted/";
  assert.equal(T.pickAssetEndpoint(eps, doc, "203-0-113-16.sslip.io"), null, "Desktop runtime: a service on the same host counts as this machine itself");
  assert.equal(T.pickAssetEndpoint(eps, doc, "203-0-113-16.sslip.io", { online: true }), "https://203-0-113-16.sslip.io/media/api/asset");
});

test("T5-shared-2: the asset ticket is fetched through the document service connection and renewed only when 1/3 of its validity is left", async () => {
  let now = 0, n = 0;
  const link = { request: async (msg) => { n++; assert.deepEqual(msg, { type: "auth.ticket", kind: "asset", access: "r" }); return { type: "auth.ticket.ok", ticket: `t${n}`, exp: now + 15 * 60_000 }; } };
  const ticket = T.assetTicketSource(link, () => now);
  assert.equal(await ticket(), "t1");
  now += 9 * 60_000;
  assert.equal(await ticket(), "t1", "6 minutes left: no renewal");
  now += 2 * 60_000;
  assert.equal(await ticket(), "t2", "Only 4 minutes left (under 1/3): renew");
  const bad = T.assetTicketSource({ request: async () => ({ type: "error" }) });
  assert.equal(await bad(), null);
});

test("T5-shared-3: enter a shared project → use the asset service from service.watch; leave → back to local", async () => {
  fakeFetch(() => false);
  const link = { request: async (msg) => msg.type === "service.watch" ? { type: "service.endpoints", endpoints: [{ kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] }] } : { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 } };
  assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), "http://10.0.0.9:5460/api/asset");
  assert.equal(T.remoteAssetBase(), "http://10.0.0.9:5460/api/asset");
  T.disconnectSharedAssets();
  assert.equal(T.remoteAssetBase(), null);
});

test("T5-shared-4: the online page retries after one failed service registration request, and a late full notification can also set the address", async () => {
  fakeFetch(() => false);
  const endpoint = { kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] };
  let calls = 0;
  const link = { request: async (msg) => {
    if (msg.type !== "service.watch") return { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 };
    if (++calls === 1) throw new Error("Temporarily disconnected");
    return { type: "service.endpoints", endpoints: [endpoint] };
  } };
  try {
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/", { online: true }), null);
    assert.equal(T.remoteAssetBase(), null);
    await new Promise((resolve, reject) => {
      const end = Date.now() + 3500;
      const check = () => T.remoteAssetBase() ? resolve() : Date.now() > end ? reject(new Error("Service registration was not retried")) : setTimeout(check, 20);
      check();
    });
    assert.equal(T.remoteAssetBase(), endpoint.urls[0]);
    T.receiveSharedAssetEndpoints([]);
    assert.equal(T.remoteAssetBase(), null);
    T.receiveSharedAssetEndpoints([endpoint]);
    assert.equal(T.remoteAssetBase(), endpoint.urls[0]);
  } finally {
    T.disconnectSharedAssets();
  }
});

test("T5-shared-5: if re-registration fails after the same connection reconnects, the asset service already picked does not fall back to local; picking the same one does not reset it", async () => {
  fakeFetch(() => false);
  const endpoint = { kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] };
  let fail = false;
  let changes = 0;
  const link = { request: async (msg) => {
    if (msg.type !== "service.watch") return { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 };
    if (fail) throw new Error("First request after reconnect failed");
    return { type: "service.endpoints", endpoints: [endpoint] };
  } };
  const off = T.subscribeRemoteAssets(() => { changes++; });
  try {
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), endpoint.urls[0]);
    const after = changes;
    fail = true;
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), endpoint.urls[0]);
    assert.equal(T.remoteAssetBase(), endpoint.urls[0]);
    fail = false;
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), endpoint.urls[0]);
    assert.equal(changes, after, "The same asset service is not reset (the tier selection policy is not resent, the upload target is not restarted)");
  } finally {
    off();
    T.disconnectSharedAssets();
  }
});

test("M8-X1-a: fallback address of the asset service for a project kept on this machine: first use the asset announced by LAN discovery, then derive /api/asset of the same process from the document service address; not derived when moved to the cloud", () => {
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "http://192.168.1.5:5190/docservice/", asset: "http://192.168.1.5:5190/api/asset" }), "http://192.168.1.5:5190/api/asset");
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "http://192.168.1.5:5190/docservice/" }), "http://192.168.1.5:5190/api/asset", "A manually entered address / invite link has no announcement: derive from the document service address");
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "https://pc.lan:8443/docservice/" }), "https://pc.lan:8443/api/asset");
  assert.equal(T.lanAssetBaseOf({ where: "hosted", base: "https://203-0-113-16.sslip.io/hosted/" }), null, "Moved to the cloud: only the asset service registered by the hosted bundle counts");
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "Not an address" }), null);
});

test("M8-X1-b: when the host of a project kept on this machine has not registered an asset service, the member page uses the fallback address; when one is registered, the registration takes priority; when the fallback points at this page itself, stay local", async () => {
  fakeFetch(() => false);
  const mk = (endpoints) => ({ request: async (msg) => msg.type === "service.watch" ? { type: "service.endpoints", endpoints } : { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 } });
  const doc = "http://192.168.1.5:5190/docservice/";
  const fallback = "http://192.168.1.5:5190/api/asset";
  try {
    assert.equal(await T.connectSharedAssets(mk([]), doc, { fallback }), fallback, "Not in the registration: use the fallback");
    assert.equal(T.remoteAssetBase(), fallback);
    T.receiveSharedAssetEndpoints([]);
    assert.equal(T.remoteAssetBase(), fallback, "A later full notification is still empty: does not fall back to local");
    T.disconnectSharedAssets();
    const registered = "http://192.168.1.5:5190/api/asset-registered";
    assert.equal(await T.connectSharedAssets(mk([{ kind: "asset", urls: [registered] }]), doc, { fallback }), registered, "Registration takes priority");
    T.disconnectSharedAssets();
    globalThis.location = { host: "127.0.0.1:5190" };
    assert.equal(await T.connectSharedAssets(mk([]), "http://127.0.0.1:5190/docservice/", { fallback: "http://127.0.0.1:5190/api/asset" }), null, "This machine is the host: stay on the local asset service");
  } finally {
    delete globalThis.location;
    T.disconnectSharedAssets();
  }
});

test("T7-gate-2: before export, ask the current asset service: list those whose original-size asset is incomplete (a complete small-size asset does not count); let it pass when all are complete", async () => {
  fakeFetch((_u, hash) => hash === h("2") || hash === h("3"));
  const missing = await T.exportGate(project);
  assert.deepEqual(missing.map((m) => m.name), ["开场.mov"]);
  fakeFetch(() => true);
  assert.deepEqual(await T.exportGate(project), []);
});

test("T7-gate-3: quick check without sending a request: not asked yet gives null, once asked decide by the set", async () => {
  assert.equal(T.exportGateNow(project), null);
  fakeFetch((_u, hash) => hash === h("3"));
  await T.pollOnce(project);
  assert.deepEqual(T.exportGateNow(project).map((m) => m.name), ["开场.mov"]);
});
