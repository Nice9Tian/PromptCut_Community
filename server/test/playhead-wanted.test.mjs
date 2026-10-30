/**
 * C4 的 `wanted`(播放头缺口提示)在镜像存储这一侧的单测。
 * 跑:node --test server/test/playhead-wanted.test.mjs
 *
 * 「要改四处,少一处 `wanted` 就静默丢掉」—— 这份测的是第一处(`setPlayhead` 的
 * 白名单)。转发体那一处在 `vite-plugin-mirror.ts`、页面侧两处在 `dataMirror.ts`,
 * 端到端那一趟在 `scripts/probes/ready-index-probe.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMirrorStore, MAX_WANTED } from '../mirror-store.mjs';

const PROJECT = { id: 'p', name: 'demo', width: 1920, height: 1080, fps: 30, duration: 10, tracks: [] };

test('setPlayhead 收得下 wanted,最多 8 条,坏条目丢掉', () => {
  const store = createMirrorStore();
  store.pushFull({ session: 's1', localRev: 1, project: PROJECT });

  const head = store.setPlayhead('s1', 1.5, true, [{ clipId: 'a', frame: 45 }, { clipId: 'b', frame: 45 }]);
  assert.deepEqual(head.wanted, [{ clipId: 'a', frame: 45 }, { clipId: 'b', frame: 45 }]);
  assert.deepEqual(store.latestPlayhead().wanted, head.wanted);

  // 坏条目直接丢,不让一个 NaN 把整份提示作废(它是提示,不是队列)
  const cleaned = store.setPlayhead('s1', 1.5, true, [
    { clipId: 'a', frame: 1.5 }, { clipId: '', frame: 3 }, { clipId: 'b', frame: -1 },
    { clipId: 'c', frame: 3 }, null,
  ]);
  assert.deepEqual(cleaned.wanted, [{ clipId: 'c', frame: 3 }]);

  // C4 原文:最多 8 条
  assert.equal(MAX_WANTED, 8);
  const many = store.setPlayhead('s1', 1.5, true, Array.from({ length: 20 }, (_, i) => ({ clipId: `c${i}`, frame: i })));
  assert.equal(many.wanted.length, MAX_WANTED);
  assert.deepEqual(many.wanted.at(-1), { clipId: 'c7', frame: 7 });
});

test('原有的播放头推送路径行为不变,而且不抹掉上一次的提示', () => {
  const store = createMirrorStore();
  store.pushFull({ session: 's1', localRev: 1, project: PROJECT });
  store.setPlayhead('s1', 1.5, true, [{ clipId: 'a', frame: 45 }]);
  // 不带 wanted 的那一趟(暂停下来报一次当前时刻)照旧
  const plain = store.setPlayhead('s1', 2.5, false);
  assert.equal(plain.t, 2.5);
  assert.equal(plain.playing, false);
  // 拖动中两条路交替发;抹掉了预渲染就永远读不到提示
  assert.deepEqual(plain.wanted, [{ clipId: 'a', frame: 45 }]);
  assert.deepEqual(store.setPlayhead('s1', 0, false, []).wanted, [{ clipId: 'a', frame: 45 }], '空数组当成「这一趟没报」');
  // 没报过 wanted 的 session 就是 undefined,不是空数组
  store.pushFull({ session: 's2', localRev: 1, project: PROJECT });
  assert.equal(store.setPlayhead('s2', 0, false).wanted, undefined);
  assert.throws(() => store.setPlayhead('', 0, false), /session/);
});
