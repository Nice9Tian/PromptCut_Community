/**
 * 播放保活的页面一侧:播放中每隔 `PLAYHEAD_KEEPALIVE_MS` 向 `/api/data/playhead` 发一条 `{session, t, playing: true}`,
 * 免得预渲染进程在「播放头下没有缺口」时误判用户不在播放(`FramePipeline.streamBusy()` 只认 5 秒内有过音讯的「在播」)。
 * 跑:node --experimental-test-module-mocks --test src/render/dataMirrorKeepalive.test.mjs
 *
 * 保活走和 `wanted` 同一条轻路:`keepalive: true`、不读响应、失败静默。停下时原有的「停下推一次」不动。
 * 只读观看页、舞台页、导出页、在线页面不做镜像,所以也不发保活。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;

// 一个最小的 store:getState / subscribe / 手动 emit
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
/** 每个用例起的镜像,用例结束(含断言失败)统一收掉,免得下一个用例看到上一个的状态 */
const disposers = [];
const startMirror = () => { const d = mirror.startDataMirror(); disposers.push(d); return d; };

/** 记下发出去的每一条 `/api/data/playhead` */
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

/** 推进 ms 毫秒,每 100 毫秒让出一次(播放中 store 每帧都变,这里也模拟 t 在走) */
async function run(ms) {
  for (let i = 0; i < ms / 100; i++) {
    mock.timers.tick(100);
    if (storeState.playing) setStore({ t: storeState.t + 0.1 });
    await flush();
  }
}

test("保活间隔是常量、明显小于服务端的 5 秒窗口", () => {
  assert.ok(Number.isFinite(mirror.PLAYHEAD_KEEPALIVE_MS));
  assert.ok(mirror.PLAYHEAD_KEEPALIVE_MS <= 2500, "要明显小于 5 秒,丢一两拍也不过期");
  assert.ok(mirror.PLAYHEAD_KEEPALIVE_MS >= 500, "不能比 wanted 的 100 毫秒节流还密");
});

test("播放中每隔不超过 2 秒发一条 {session, t, playing: true}", async () => {
  const stop = startMirror();
  await run(500);
  calls = [];
  setStore({ playing: true });
  await run(30_000);
  const list = keepalives();
  assert.ok(list.length >= 14 && list.length <= 16, `30 秒该有 15 条左右,实际 ${list.length}`);
  for (const c of list) {
    assert.equal(c.body.playing, true);
    assert.equal(typeof c.body.session, "string");
    assert.ok(Number.isFinite(c.body.t));
    assert.equal(c.body.wanted, undefined, "保活不带 wanted:不刷新也不清掉缺口提示");
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.signal, undefined, "轻路不挂 10 秒超时");
  }
  const gaps = list.slice(1).map((c, i) => c.at - list[i].at);
  assert.ok(Math.max(...gaps) <= 2000, `相邻两条间隔不超过 2 秒,最大 ${Math.max(...gaps)}`);
  assert.ok(list[0].at - 1_000_500 <= 2000, "起播后第一条保活也在 2 秒内");
  // t 是发的那一刻的播放头,不是起播时的
  assert.ok(list.at(-1).body.t > list[0].body.t);
  stop();
});

test("停下之后不再发保活;原有的「停下推一次」照旧", async () => {
  const stop = startMirror();
  await run(500);
  setStore({ playing: true });
  await run(5_000);
  assert.ok(keepalives().length >= 2);
  setStore({ playing: false });
  calls = [];
  await run(20_000);
  assert.equal(keepalives().length, 0, "停下以后一条保活都没有");
  const pushed = heads().filter((c) => c.body.playing === false);
  assert.equal(pushed.length, 1, "停下推一次");
  assert.equal(pushed[0].init.keepalive, undefined, "停下那一条走原来的路(等响应、带超时)");
  stop();
});

test("播放过程中停了又播:每次播放各自保活,间隔不叠加", async () => {
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
  assert.ok(list.length >= 4 && list.length <= 6, `10 秒该有 5 条左右,实际 ${list.length}(重复订阅回调不会起两个计时器)`);
  stop();
});

test("页面隐藏时不发保活(用户没在看,恢复产流可以接受);回到前台接着发", async () => {
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

test("fetch 抛错或被拒:静默,下一拍照发", async () => {
  const stop = startMirror();
  await run(500);
  let n = 0;
  globalThis.fetch = (url, init) => {
    n++;
    calls.push({ url: String(url), init: init ?? {}, body: init?.body ? JSON.parse(init.body) : null, at: Date.now() });
    if (n % 2) throw new Error("页面正在卸载");
    return Promise.reject(new Error("网络断了"));
  };
  setStore({ playing: true });
  await run(8_000);
  assert.ok(keepalives().length >= 3, "失败不影响后面的保活");
  stop();
});

test("disposer 把保活的计时器收掉", async () => {
  const stop = startMirror();
  await run(500);
  setStore({ playing: true });
  await run(3_000);
  stop();
  calls = [];
  await run(10_000);
  assert.equal(heads().length, 0, "收掉以后什么都不发");
});

test("起播时页面已经在播放:开始镜像就接上保活", async () => {
  storeState = { ...storeState, playing: true };
  const stop = startMirror();
  await run(6_000);
  assert.ok(keepalives().length >= 2);
  stop();
});

for (const [label, search] of [["只读观看页 ?observe", "?observe"], ["只读观看页 ?view=x", "?view=abc"], ["舞台页 ?stage", "?stage=1"], ["导出页 ?export", "?export=1"]]) {
  test(`${label} 不做镜像、不发保活`, async () => {
    globalThis.location = { search };
    const stop = startMirror();
    setStore({ playing: true });
    await run(10_000);
    assert.equal(calls.length, 0, "一条请求都没有");
    stop();
  });
}

test("在线页面没有本机预渲染进程:不发保活", async () => {
  online = true;
  const stop = startMirror();
  setStore({ playing: true });
  await run(10_000);
  assert.equal(calls.length, 0);
  stop();
});
