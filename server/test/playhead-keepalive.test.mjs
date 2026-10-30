/**
 * 播放保活在服务端一侧的账:页面播放中每 2 秒发一条 `{session, t, playing: true}`(不带 `wanted`),
 * 预渲染进程的 `streamBusy()` 与队列节点的 `interactionReason()` 在整段播放里一直为忙;
 * 保活停了 5 秒以后转闲。服务端的 5 秒、800 毫秒两个窗口不改。
 * 跑:node --test server/test/playhead-keepalive.test.mjs
 *
 * 时钟用 `mock.timers` 的 `Date`:镜像存储的 `setPlayhead` 在收到那一刻盖 `at`,判忙的两处读的是同一个 `at`。
 */
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMirrorStore } from '../mirror-store.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';
import { interactionReason, PLAYING_STALE_MS } from '../queue-idle.mjs';

/** 页面保活的间隔(`src/render/dataMirror.ts` 的 `PLAYHEAD_KEEPALIVE_MS`) */
const KEEPALIVE_MS = 2000;
const PROJECT = { id: 'p', name: 'demo', width: 1920, height: 1080, fps: 30, duration: 60, tracks: [] };

afterEach(() => { mock.timers.reset(); });

/** 只有 `streamBusy` / `interactionReason` 会读的几个字段 */
function fakePipeline(store) {
  return { closed: false, playback: null, backgroundYielding: false, backgroundLeaseUntil: 0, playhead: () => store.latestPlayhead(),
    streamBusy: FramePipeline.prototype.streamBusy };
}

/** 从起播开始走 `seconds` 秒,每 250 毫秒问一次;`keepaliveUntil` 之前每 `KEEPALIVE_MS` 发一条保活 */
function simulate({ seconds, keepaliveUntil, wanted }) {
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const store = createMirrorStore();
  store.pushFull({ session: 's1', localRev: 1, project: PROJECT });
  const pipeline = fakePipeline(store);
  const started = Date.now();
  store.setPlayhead('s1', 0, true, wanted);
  const rows = [];
  let nextKeepalive = KEEPALIVE_MS;
  for (let elapsed = 0; elapsed <= seconds * 1000; elapsed += 250) {
    mock.timers.setTime(started + elapsed);
    if (elapsed >= nextKeepalive && elapsed <= keepaliveUntil) {
      store.setPlayhead('s1', elapsed / 1000, true); // 保活不带 wanted
      nextKeepalive += KEEPALIVE_MS;
    }
    const now = Date.now();
    rows.push({ elapsed, busy: pipeline.streamBusy(now), reason: interactionReason(pipeline, now), head: store.latestPlayhead() });
  }
  return { rows, store };
}

test('每 2 秒一条保活:30 秒的播放里 streamBusy 与 interactionReason 一直为忙', () => {
  const { rows } = simulate({ seconds: 30, keepaliveUntil: 30_000 });
  const notBusy = rows.filter((r) => !r.busy);
  const notPlaying = rows.filter((r) => r.reason !== 'playing');
  assert.deepEqual(notBusy.map((r) => r.elapsed), [], 'streamBusy 一直为真');
  assert.deepEqual(notPlaying.map((r) => r.elapsed), [], 'interactionReason 一直是 playing');
  assert.equal(rows.length, 30 * 4 + 1);
});

test('对照:没有保活时,5 秒以后转闲(这就是毛病本身)', () => {
  const { rows } = simulate({ seconds: 30, keepaliveUntil: -1 });
  assert.equal(rows.find((r) => r.elapsed === 4750).busy, true);
  assert.equal(rows.find((r) => r.elapsed === 5000).busy, false, '5 秒窗口到了');
  assert.equal(rows.find((r) => r.elapsed === 5000).reason, null);
  assert.ok(rows.filter((r) => r.elapsed >= 5000).every((r) => !r.busy && r.reason === null));
});

test('保活停了 5 秒以后转闲;停之前一直忙', () => {
  // 最后一条保活在 20 秒整
  const { rows } = simulate({ seconds: 30, keepaliveUntil: 20_000 });
  assert.ok(rows.filter((r) => r.elapsed <= 24_750).every((r) => r.busy && r.reason === 'playing'), '最后一条保活之后 5 秒内仍忙');
  assert.equal(rows.find((r) => r.elapsed === 20_000 + PLAYING_STALE_MS).busy, false);
  assert.ok(rows.filter((r) => r.elapsed >= 20_000 + PLAYING_STALE_MS).every((r) => !r.busy && r.reason === null), '之后一直闲');
});

test('保活丢一拍(4 秒没音讯)也不过期;连丢两拍以上才会', () => {
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const store = createMirrorStore();
  const pipeline = fakePipeline(store);
  const start = Date.now();
  store.setPlayhead('s1', 0, true);
  mock.timers.setTime(start + 4_000);
  assert.equal(pipeline.streamBusy(Date.now()), true, '丢了一拍保活(间隔 4 秒)');
  store.setPlayhead('s1', 4, true);
  mock.timers.setTime(start + 9_000);
  assert.equal(pipeline.streamBusy(Date.now()), false, '5 秒没音讯');
});

test('保活不带 wanted:沿用上一次的缺口提示,既不刷新也不清掉(与停下那一条一样)', () => {
  const wanted = [{ clipId: 'a', frame: 45 }];
  const { store } = simulate({ seconds: 10, keepaliveUntil: 10_000, wanted });
  const head = store.latestPlayhead();
  assert.deepEqual(head.wanted, wanted);
  assert.equal(head.playing, true);
  assert.ok(head.t > 0, 't 跟着保活走');
});

test('停下推一次(playing:false)仍然立刻转成「刚动过」(streamBusy 800 毫秒、队列门槛 500 毫秒),之后转闲', () => {
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const store = createMirrorStore();
  const pipeline = fakePipeline(store);
  const start = Date.now();
  store.setPlayhead('s1', 0, true);
  mock.timers.setTime(start + 10_000);
  store.setPlayhead('s1', 10, false);
  mock.timers.setTime(start + 10_000 + 499);
  assert.equal(interactionReason(pipeline, Date.now()), 'scrub', '队列节点的门槛是 500 毫秒');
  mock.timers.setTime(start + 10_000 + 799);
  assert.equal(pipeline.streamBusy(Date.now()), true);
  mock.timers.setTime(start + 10_000 + 800);
  assert.equal(pipeline.streamBusy(Date.now()), false);
});
