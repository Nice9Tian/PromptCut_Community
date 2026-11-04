/**
 * Page side of playback keepalive: during playback, sends `{session, t, playing: true}` to
 * `/api/data/playhead` every `PLAYHEAD_KEEPALIVE_MS`, preventing the prerender process from
 * misjudging that the user is not playing when there is "no gap under the playhead"
 * (`FramePipeline.streamBusy()` only considers "playing" if there was activity within 5 seconds).
 * Run: node --experimental-test-module-mocks --test src/render/dataMirrorKeepalive.test.mjs
 *
 * Keepalive takes the same lightweight path as `wanted`: `keepalive: true`, does not read
 * responses, and fails silently. On stop, the existing "push once on stop" remains untouched.
 * Read-only watch pages, stage pages, export pages, and online pages do not mirror, so they
 * do not send keepalive either.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;

// A minimal store: getState / subscribe / manual emit
const listeners = new Set();
let storeState = { project: { id: "p", tracks: [], duration: 10, fps: 30, width: 1280, height: 720 }, t: 0, playing: false };
const setStore = (patch) => { storeState = { ...storeState, ...patch }; for (const l of [...listeners]) l(); };
mock.module(srcUrl("store/project.ts"), { exports: {
  getState: () => storeState,
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
} });
let online = false;
mock.module(srcUrl("online/pageFlag.ts"), { namedExports: { onlinePage: () => online } });

const mirror = await import(srcUrl("render/dataMirror.ts"));
/**
 * Mirrors started by each test case are cleaned up when the case finishes (including assertion
 * failures), so the next case does not see state from the previous one
 */
const disposers = [];
const startMirror = () => { const d = mirror.startDataMirror(); disposers.push(d); return d; };

/** Records every outgoing `/api/data/playhead` */
let calls = [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const heads = () => calls.filter((c) => c.url === "/api/data/playhead");
const keepalives = () => heads().filter((c) => c.init.keepalive === true && c.body.wanted === undefined);

beforeEach(() => {
  calls = [];
  online = false;
  listeners.clear();
  storeState = { ...storeState, t: 0, playing: false };
  globalThis.location = { search: "" };
  globalThis.document = { visibilityState: "visible" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {}, body: init?.body ? JSON.parse(init.body) : null, at: Date.now() });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
});
afterEach(() => { while (disposers.length) disposers.pop()(); mock.timers.reset(); });

/**
 * Advances ms milliseconds, yielding every 100 milliseconds (during playback the store changes
 * every frame; here we also simulate t moving forward)
 */
async function run(ms) {
  for (let i = 0; i < ms / 100; i++) {
    mock.timers.tick(100);
    if (storeState.playing) setStore({ t: storeState.t + 0.1 });
    await flush();
  }
}

test("the keepalive interval is a constant, clearly smaller than the server's 5-second window", () => {
  assert.ok(Number.isFinite(mirror.PLAYHEAD_KEEPALIVE_MS));
  assert.ok(mirror.PLAYHEAD_KEEPALIVE_MS <= 2500, "must be clearly under 5 seconds, so missing a beat or two does not expire it");
  assert.ok(mirror.PLAYHEAD_KEEPALIVE_MS >= 500, "must not be denser than wanted's 100 ms throttle");
});

test("during playback, send a {session, t, playing: true} at most every 2 seconds", async () => {
  const stop = startMirror();
  await run(500);
  calls = [];
  setStore({ playing: true });
  await run(30_000);
  const list = keepalives();
  assert.ok(list.length >= 14 && list.length <= 16, `30 seconds should yield about 15 messages, actual ${list.length}`);
  for (const c of list) {
    assert.equal(c.body.playing, true);
    assert.equal(typeof c.body.session, "string");
    assert.ok(Number.isFinite(c.body.t));
    assert.equal(c.body.wanted, undefined, "keepalive carries no wanted: it neither refreshes nor clears the gap hint");
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.signal, undefined, "the light path does not attach a 10-second timeout");
  }
  const gaps = list.slice(1).map((c, i) => c.at - list[i].at);
  assert.ok(Math.max(...gaps) <= 2000, `the interval between adjacent messages is at most 2 seconds, max ${Math.max(...gaps)}`);
  assert.ok(list[0].at - 1_000_500 <= 2000, "the first keepalive after playback starts also arrives within 2 seconds");
  // t is the playhead at the moment of sending, not when playback started
  assert.ok(list.at(-1).body.t > list[0].body.t);
  stop();
});

test("no keepalives after stopping; the existing \"push once on stop\" behavior is unchanged", async () => {
  const stop = startMirror();
  await run(500);
  setStore({ playing: true });
  await run(5_000);
  assert.ok(keepalives().length >= 2);
  setStore({ playing: false });
  calls = [];
  await run(20_000);
  assert.equal(keepalives().length, 0, "no keepalives at all after stopping");
  const pushed = heads().filter((c) => c.body.playing === false);
  assert.equal(pushed.length, 1, "push once on stop");
  assert.equal(pushed[0].init.keepalive, undefined, "the stop push takes the original path (waits for the response, with a timeout)");
  stop();
});

test("stop and play again during playback: each playback keeps alive on its own, intervals do not stack", async () => {
  const stop = startMirror();
  await run(500);
  setStore({ playing: true });
  await run(3_000);
  setStore({ playing: false });
  await run(2_000);
  calls = [];
  setStore({ playing: true });
  setStore({ playing: true });
  await run(10_000);
  const list = keepalives();
  assert.ok(list.length >= 4 && list.length <= 6, `expected about 5 in 10 seconds, got ${list.length} (a repeated subscription callback must not start two timers)`);
  stop();
});

test("no keepalives while the page is hidden (the user is not watching, resuming the stream is acceptable); resume sending when back in the foreground", async () => {
  const stop = startMirror();
  await run(500);
  setStore({ playing: true });
  await run(3_000);
  globalThis.document.visibilityState = "hidden";
  calls = [];
  await run(10_000);
  assert.equal(keepalives().length, 0);
  globalThis.document.visibilityState = "visible";
  await run(4_000);
  assert.ok(keepalives().length >= 1);
  stop();
});

test("fetch throws or is rejected: stay silent, send on the next tick as usual", async () => {
  const stop = startMirror();
  await run(500);
  let n = 0;
  globalThis.fetch = (url, init) => {
    n++;
    calls.push({ url: String(url), init: init ?? {}, body: init?.body ? JSON.parse(init.body) : null, at: Date.now() });
    if (n % 2) throw new Error("Page is unloading");
    return Promise.reject(new Error("Network disconnected"));
  };
  setStore({ playing: true });
  await run(8_000);
  assert.ok(keepalives().length >= 3, "a failure does not affect later keepalives");
  stop();
});

test("disposer clears the keepalive timer", async () => {
  const stop = startMirror();
  await run(500);
  setStore({ playing: true });
  await run(3_000);
  stop();
  calls = [];
  await run(10_000);
  assert.equal(heads().length, 0, "nothing is sent after clearing");
});

test("page is already playing at start: keepalive attaches as soon as mirroring starts", async () => {
  storeState = { ...storeState, playing: true };
  const stop = startMirror();
  await run(6_000);
  assert.ok(keepalives().length >= 2);
  stop();
});

for (const [label, search] of [["read-only viewer page ?observe", "?observe"], ["read-only viewer page ?view=x", "?view=abc"], ["stage page ?stage", "?stage=1"], ["export page ?export", "?export=1"]]) {
  test(`${label} does no mirroring and sends no keepalives`, async () => {
    globalThis.location = { search };
    const stop = startMirror();
    setStore({ playing: true });
    await run(10_000);
    assert.equal(calls.length, 0, "no requests at all");
    stop();
  });
}

test("online page has no local prerender process: no keepalives", async () => {
  online = true;
  const stop = startMirror();
  setStore({ playing: true });
  await run(10_000);
  assert.equal(calls.length, 0);
  stop();
});
