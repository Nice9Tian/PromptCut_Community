/**
 * Stage-side isolation: pure decisions in hardening, self-check conclusions, execution gate,
 * stage entry identification (contract `docs/plan/online-card-exec-contract.md` section 3).
 * Behavior of hardening hooks and self-checks in real browsers asserted by
 * `scripts/probes/online-card-security-probe.mjs`.
 * Run: node --test src/online/isolation/isolation.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FRAME_TAGS, htmlHasFrame, isFrameName, denyPersistentStorage, STAGE_STORAGE_PASSTHROUGH_KEY } from "./harden.ts";
import { judgeIsolation, criticalHardenErrors, ISOLATION_CHECK_BASE_PATH } from "./isolationCheck.ts";
import { cardExecGate, subscribeCardExecGate, markIsolatedStageDocument, setIsolationReport, noteMediaPolicy, noteBreach, resetExecGateForTest } from "./execGate.ts";
import { bootStageGuard, isStageEntryPath, announceStageIsolation, STAGE_ENTRY_FILE, resetStageGuardForTest } from "./stageGuard.ts";

const HARDENED = { installed: true, webrtcRemoved: false, trustedTypes: "unsupported", hooks: 38, errors: [] };
const OK_REPORT = judgeIsolation({ crossOrigin: true, csp: "header", allowlist: true, harden: HARDENED });

beforeEach(() => { resetExecGateForTest(); resetStageGuardForTest(); });

test("OCS-H-01 HTML string with subframes: all seven tags are recognized, in any case, with a prefix, or with whitespace before the tag name; entity declarations are also rejected; similar names are not hit by mistake", () => {
  for (const tag of FRAME_TAGS) {
    assert.ok(htmlHasFrame(`<${tag}>`), tag);
    assert.ok(htmlHasFrame(`<div><${tag.toUpperCase()} src="x"></div>`), tag);
    assert.ok(htmlHasFrame(`<x:${tag} xmlns:x="http://www.w3.org/1999/xhtml"/>`), tag);
    assert.ok(htmlHasFrame(`< ${tag}/>`), tag);
  }
  assert.ok(htmlHasFrame("<svg><foreignObject><iframe/></foreignObject></svg>"));
  assert.ok(htmlHasFrame('<!DOCTYPE r [<!ENTITY f "&#60;iframe/&#62;">]><r>&f;</r>'), "entity expansion can create an element even when the tag name does not appear in the source text");
  assert.ok(htmlHasFrame("<!entity x 'y'>"));
  for (const fine of ["", "<div>iframe</div>", "<p>object embed frame</p>", "<svg><foreignObject><div/></foreignObject></svg>", "<frame-like-custom></frame-like-custom>",
    "<objectives>", "<embedded>", "<iframes>", "<my-iframe>", "&lt;iframe&gt;", "<div data-x=\"<b>\">", null, undefined, 42]) {
    assert.equal(htmlHasFrame(fine), false, String(fine));
  }
});

test("OCS-H-02 whether an element name is a subframe type: case, prefix, and leading or trailing whitespace are all recognized; others are not", () => {
  for (const name of ["iframe", "IFRAME", "iFrAmE", "html:iframe", "x:OBJECT", "embed", "frame", "frameset", "portal", "fencedframe", " iframe "]) assert.ok(isFrameName(name), name);
  for (const name of ["div", "foreignObject", "my-iframe", "iframes", "object-fit", "", null, undefined, "video"]) assert.equal(isFrameName(name), false, String(name));
});

test("OCS-H-03 the no-egress allowlist/Trusted Types/WebRTC guard still pass; per-origin and response header policies are mandatory", () => {
  assert.deepEqual(OK_REPORT,{ok:true,crossOrigin:true,csp:'header',egress:'none',hardened:true,trustedTypes:'unsupported',reasons:[]});
  for(const trustedTypes of ['unsupported','created','failed','enforced']) assert.equal(judgeIsolation({crossOrigin:true,csp:'header',allowlist:false,harden:{...HARDENED,webrtcRemoved:false,trustedTypes}}).ok,true);
  const cases=[
    [{crossOrigin:false,csp:'header',harden:HARDENED},['same-origin']],
    [{crossOrigin:true,csp:'none',harden:HARDENED},['no-policy']],
    [{crossOrigin:true,csp:'meta',harden:HARDENED},['meta-only']],
    [{crossOrigin:true,csp:'header',harden:null},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,installed:false}},['not-hardened']],
    // Critical item not installed (review P3): does not count even if installed
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:localStorage:Cannot redefine property']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:sessionStorage:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:indexedDB:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:caches:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:Worker:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:BroadcastChannel:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:SharedWorker:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:indexedDB:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:locks:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:integrity: built-in objects or platform interfaces were modified before the guard (JSON)']}},['not-hardened']],
  ];
  for(const [facts,reasons] of cases){const r=judgeIsolation(facts);assert.equal(r.ok,false);assert.deepEqual(r.reasons,reasons);}
  // Non-critical items (defense-in-depth layers, legacy filesystem entries, etc.) failing to install
  // do not block execution; names with merely similar prefixes do not count either
  for (const e of ['storage:webkitRequestFileSystem:x', 'scope:IDBFactory.open:x', 'window:name:x', 'MutationObserver:x', 'storage:localStorageX:x', 'scope:WorkerX:x']) {
    assert.equal(judgeIsolation({crossOrigin:true,csp:'header',harden:{...HARDENED,errors:[e]}}).ok, true, e);
  }
  assert.deepEqual(criticalHardenErrors(['scope:Worker:a', 'x', 'storage:caches:b']), ['scope:Worker:a', 'storage:caches:b']);
  assert.deepEqual(criticalHardenErrors(undefined), []);
  assert.ok(ISOLATION_CHECK_BASE_PATH.startsWith('/'));
});

test("OCS-H-04 execution gate: no execution if it is not a stage document, the self-check has no result, the self-check failed, or the parent page has not approved; it opens only when all four are met", () => {
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "not-stage" });
  // Not a stage document: never opens no matter how parent page approves
  noteMediaPolicy({ cardExec: true });
  assert.equal(cardExecGate().reason, "not-stage");
  markIsolatedStageDocument();
  assert.equal(cardExecGate().reason, "checking");
  setIsolationReport(judgeIsolation({ crossOrigin: true, csp: "meta", allowlist: false, harden: HARDENED }));
  assert.equal(cardExecGate().reason, "not-isolated");
  setIsolationReport(OK_REPORT);
  assert.equal(cardExecGate().reason, "ok");
  assert.equal(cardExecGate().allowed, true);
  // Parent page revokes (other instance failed, master switch off): closes; reopens upon re-approval
  noteMediaPolicy({ cardExec: false });
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "parent" });
  noteMediaPolicy(null);
  assert.equal(cardExecGate().reason, "parent");
  noteMediaPolicy({ cardExec: true, ticket: null });
  assert.equal(cardExecGate().allowed, true);
});

test("OCS-H-05 execution gate, no secrets when executing: a document that has seen a ticket never executes; a document whose gate has opened no longer receives tickets", () => {
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  // Legacy approach: parent page gave tier selection policy with ticket → ticket usable, but this
  // document permanently does not execute (even if parent page also approves)
  assert.deepEqual(noteMediaPolicy({ ticket: "v1.aaa.bbb", cardExec: true }), { acceptTicket: true });
  assert.equal(cardExecGate().reason, "ticket-seen");
  noteMediaPolicy({ cardExec: true, ticket: null });
  assert.equal(cardExecGate().reason, "ticket-seen", "approving again afterwards without a ticket still does not open it");
  assert.equal(cardExecGate().allowed, false);

  resetExecGateForTest();
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  noteMediaPolicy({ cardExec: true });
  assert.equal(cardExecGate().allowed, true);
  // Ticket arriving after gate opened (user code may have run): rejected, caller drops it
  assert.deepEqual(noteMediaPolicy({ ticket: "v1.aaa.bbb" }), { acceptTicket: false });
  assert.equal(cardExecGate().allowed, false);
  assert.equal(cardExecGate().reason, "parent");
  // Policy without ticket: acceptTicket is false (no ticket to accept)
  assert.deepEqual(noteMediaPolicy({ ticket: "", cardExec: true }), { acceptTicket: false });
});

test("OCS-H-06 execution gate, hardening has blocked code that creates subframes: closed permanently; subscribers are notified when the state changes, not when it does not", () => {
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  let calls = 0;
  const off = subscribeCardExecGate(() => { calls++; });
  noteMediaPolicy({ cardExec: true });
  assert.equal(calls, 1);
  const same = cardExecGate();
  noteMediaPolicy({ cardExec: true });
  assert.equal(calls, 1);
  assert.equal(cardExecGate(), same, "object identity is unchanged when the state is unchanged");
  noteBreach();
  assert.equal(calls, 2);
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "breach" });
  noteMediaPolicy({ cardExec: true });
  setIsolationReport(OK_REPORT);
  assert.equal(cardExecGate().reason, "breach");
  off();
  noteMediaPolicy({ cardExec: false });
  assert.equal(calls, 2);
});

test("OCS-H-07 stage entry is recognized by path: only stage.html; the editor page, same-origin single stage (/editor/?stage=1) and the export page are not", () => {
  assert.equal(STAGE_ENTRY_FILE, "stage.html");
  for (const p of ["/editor/stage.html", "/stage.html", "/a/b/stage.html"]) assert.ok(isStageEntryPath(p), p);
  for (const p of ["/editor", "/editor/", "/editor/index.html", "/editor/stage.html/", "/editor/xstage.html", "/editor/stage.htm", "", "/"]) assert.equal(isStageEntryPath(p), false, p);
});

test("OCS-H-08 startup hook: does nothing when not an online build, not in a browser, or not a stage entry (no hardening installed, gate stays at not-stage, no message to the parent page)", () => {
  // No window in Node: does nothing for any combination
  assert.equal(bootStageGuard({ online: true, base: "/editor/" }), false);
  assert.equal(bootStageGuard({ online: false, base: "/editor/" }), false);
  assert.equal(cardExecGate().reason, "not-stage");
  assert.doesNotThrow(() => announceStageIsolation());
  // Has window but path is not stage entry (editor page, same-origin single stage): likewise does
  // nothing, leaving only a read-only observation port
  const posted = [];
  const fakeWindow = { parent: { postMessage: (m) => posted.push(m) } };
  globalThis.window = fakeWindow;
  globalThis.location = { pathname: "/editor/" };
  try {
    assert.equal(bootStageGuard({ online: true, base: "/editor/" }), false);
    assert.equal(cardExecGate().reason, "not-stage");
    assert.deepEqual(fakeWindow.__pcCardExecGate(), { allowed: false, reason: "not-stage" });
    assert.equal(fakeWindow.__pcStageIsolation, undefined);
    announceStageIsolation();
    assert.equal(posted.length, 0);
    // Desktop runtime environment (not online build) does not even leave an observation port
    delete fakeWindow.__pcCardExecGate;
    globalThis.location = { pathname: "/editor/stage.html" };
    assert.equal(bootStageGuard({ online: false, base: "/" }), false);
    assert.equal(fakeWindow.__pcCardExecGate, undefined);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

/**
 * Browser-like global object: storage entries attached to instance or prototype (window on
 * instance, Worker indexedDB / caches on prototype), all mutable accessors
 */
function fakeGlobal({ onProto = false } = {}) {
  const realLocal = new Map(), realSession = new Map();
  const storageOf = (m) => ({
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  });
  const proto = {};
  const scope = Object.create(proto);
  const host = onProto ? proto : scope;
  const accessor = (o, k, v) => Object.defineProperty(o, k, { configurable: true, enumerable: true, get: () => v });
  accessor(scope, "localStorage", storageOf(realLocal));
  accessor(scope, "sessionStorage", storageOf(realSession));
  const idb = { open: () => ({}) };
  accessor(host, "indexedDB", idb);
  accessor(host, "caches", { open: async () => ({}) });
  Object.defineProperty(scope, "webkitRequestFileSystem", { configurable: true, writable: true, value: () => {} });
  class StorageManager { async getDirectory() { return "opfs-root"; } async estimate() { return {}; } }
  class StorageBucketManager { async open() { return "bucket"; } }
  scope.StorageManager = StorageManager;
  scope.StorageBucketManager = StorageBucketManager;
  scope.navigator = { storage: new StorageManager(), storageBuckets: new StorageBucketManager() };
  return { scope, proto, realLocal, realSession, idb };
}

test("OCS-H-09 persistent storage of the stage origin is withdrawn: localStorage / sessionStorage written by a card stays only in this document's memory; IndexedDB, Cache Storage, the legacy file system, the origin private file system and storage buckets are all unusable and cannot be restored", async () => {
  const { scope, realLocal, realSession } = fakeGlobal();
  realLocal.set("old-key", "old-value");
  const r = denyPersistentStorage(scope);
  assert.deepEqual(r.errors, []);
  for (const k of ["localStorage", "sessionStorage", "indexedDB", "caches", "webkitRequestFileSystem", "StorageManager.getDirectory", "StorageBucketManager.open"]) assert.ok(r.denied.includes(k), k);

  // "Card" stores media URL from params (with path id): readable in this document, absent in real storage
  const leak = "/media-s/0123456789abcdef0123456789abcdef/media/" + "a".repeat(64);
  scope.localStorage.setItem("params", leak);
  scope.sessionStorage.setItem("params", leak);
  scope.localStorage.leakProp = leak; // Property syntax also remains in memory only
  assert.equal(scope.localStorage.leakProp, leak);
  assert.equal(realLocal.has("leakProp"), false);
  assert.equal(scope.localStorage.getItem("params"), leak);
  assert.equal(scope.sessionStorage.getItem("params"), leak);
  assert.equal(realLocal.has("params"), false);
  assert.equal(realSession.has("params"), false);
  // Pre-existing keys in real storage cannot be listed, read, or deleted
  assert.equal(scope.localStorage.getItem("old-key"), null);
  assert.equal(scope.localStorage.length, 1);
  assert.deepEqual([0, 1].map((i) => scope.localStorage.key(i)), ["params", null]);
  scope.localStorage.removeItem("old-key"); scope.localStorage.clear();
  assert.equal(realLocal.get("old-key"), "old-value");

  // Only pass-through: "can release" decision of tier selection; key shape and value must both match
  const hash = "b".repeat(64);
  assert.ok(STAGE_STORAGE_PASSTHROUGH_KEY.test(`pc.playable.152:${hash}`));
  scope.localStorage.setItem(`pc.playable.152:${hash}`, "1");
  assert.equal(realLocal.get(`pc.playable.152:${hash}`), "1");
  assert.equal(scope.localStorage.getItem(`pc.playable.152:${hash}`), "1");
  scope.localStorage.setItem(`pc.playable.152:${"c".repeat(64)}`, leak); // Invalid value: does not write to real storage, nor keep in memory
  assert.equal(realLocal.has(`pc.playable.152:${"c".repeat(64)}`), false);
  assert.equal(scope.localStorage.getItem(`pc.playable.152:${"c".repeat(64)}`), null);
  for (const bad of [`pc.playable.152:${hash}x`, `pc.playable.x:${hash}`, `pc.playable.152:${"B".repeat(64)}`, `pc.stageSid.v1:a:b`, `xpc.playable.152:${hash}`]) {
    scope.localStorage.setItem(bad, "1");
    assert.equal(realLocal.has(bad), false, bad);
  }
  realLocal.set(`pc.playable.152:${"d".repeat(64)}`, leak); // Malformed values read from real storage are treated as absent
  assert.equal(scope.localStorage.getItem(`pc.playable.152:${"d".repeat(64)}`), null);
  // Allowed keys cannot delete conclusions in real storage
  scope.localStorage.removeItem(`pc.playable.152:${hash}`);
  assert.equal(realLocal.get(`pc.playable.152:${hash}`), "1");

  assert.equal(scope.indexedDB, undefined);
  assert.equal(scope.caches, undefined);
  assert.equal(scope.webkitRequestFileSystem, undefined);
  await assert.rejects(scope.navigator.storage.getDirectory(), /persistent storage/);
  await assert.rejects(scope.navigator.storageBuckets.open("x"), /persistent storage/);
  assert.deepEqual(await scope.navigator.storage.estimate(), {}, "unrelated methods stay as before");

  // Card code attempting to revert: redefining, assigning, and deleting all fail
  for (const k of ["localStorage", "sessionStorage", "indexedDB", "caches"]) {
    assert.throws(() => Object.defineProperty(scope, k, { value: {} }), TypeError, k);
    assert.equal(Reflect.set(scope, k, {}), false, k);
    assert.equal(Reflect.deleteProperty(scope, k), false, k);
  }
  assert.throws(() => Object.defineProperty(scope.StorageManager.prototype, "getDirectory", { value: async () => "x" }), TypeError);
  assert.throws(() => { scope.localStorage.getItem = () => leak; }, TypeError, "methods of the in-memory copy are locked");
  assert.throws(() => Object.defineProperty(scope.localStorage, "setItem", { value: () => {} }), TypeError);
});

test("OCS-H-10 The Worker global object (entry point is on the prototype) is withdrawn the same way, and the original accessor on the prototype cannot be recovered; the sound thread and stage hardening both call it", () => {
  const { scope, proto, idb } = fakeGlobal({ onProto: true });
  denyPersistentStorage(scope);
  assert.equal(scope.indexedDB, undefined);
  assert.equal(scope.caches, undefined);
  const d = Object.getOwnPropertyDescriptor(proto, "indexedDB");
  assert.equal(d.get, undefined, "the accessor on the prototype was replaced with a value");
  assert.equal(d.value, undefined);
  assert.notEqual(scope.indexedDB, idb);
  // Wiring: stage hardening and sound thread both invoke it (source check; behavior in real browsers
  // verified by media-cache-probe)
  const harden = fs.readFileSync(new URL("./harden.ts", import.meta.url), "utf8");
  assert.match(harden, /const storage = denyPersistentStorage\(w\);/);
  const worker = fs.readFileSync(new URL("../cardRuntime/soundWorker.ts", import.meta.url), "utf8");
  const call = worker.indexOf("denyPersistentStorage(self);");
  assert.ok(call > 0 && call < worker.indexOf("createSoundThread({"), "the sound thread withdraws storage before creating the thread (loading card code)");
});
