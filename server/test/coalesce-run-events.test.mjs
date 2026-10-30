/** 文字 / 思考增量攒成一条再交:次序不变、收尾前交齐、字数到顶就交(`server/agent/service/coalesce-run-events.mjs`) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceRunEvents, COALESCE_WINDOW_MS, COALESCE_MAX_CHARS } from '../agent/service/coalesce-run-events.mjs';

function fakeWriter() {
  const emitted = []; let id = 0;
  return { emitted, binding: { b: 1 }, failed: new Promise(() => {}), stop() {},
    emit(event) { emitted.push(event); return `e${++id}`; },
    async flush() { emitted.push('flush'); }, async beforeCall() { emitted.push('beforeCall'); },
    async receiptOf(eventId) { return { eventId }; } };
}
function manualTimers() {
  const timers = [];
  return { timers, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, fire() { timers.splice(0).forEach(fn => fn()); } };
}

test('连续文字攒成一条;来了别的事件先交攒着的,次序不变', () => {
  const w = fakeWriter(), t = manualTimers(), c = coalesceRunEvents(w, t);
  for (const d of ['你', '好', '世界']) assert.equal(c.emit({ type: 'text', delta: d }), undefined);
  assert.deepEqual(w.emitted, [], '还在攒');
  assert.equal(c.emit({ type: 'tool_call', name: 'x' }), 'e2');
  assert.deepEqual(w.emitted, [{ type: 'text', delta: '你好世界' }, { type: 'tool_call', name: 'x' }]);
});

test('思考和文字、不同轮的思考各攒各的,不混', () => {
  const w = fakeWriter(), c = coalesceRunEvents(w, manualTimers());
  c.emit({ type: 'thinking', delta: 'a', round: 1 }); c.emit({ type: 'thinking', delta: 'b', round: 1 });
  c.emit({ type: 'thinking', delta: 'c', round: 2 }); c.emit({ type: 'text', delta: 'd' }); c.emit({ type: 'text', delta: 'e' });
  c.emit({ type: 'progress', text: 'p' });
  assert.deepEqual(w.emitted, [{ type: 'thinking', delta: 'ab', round: 1 }, { type: 'thinking', delta: 'c', round: 2 },
    { type: 'text', delta: 'de' }, { type: 'progress', text: 'p' }]);
});

test('到时间就交;flush / beforeCall / receiptOf 之前先交', async () => {
  const w = fakeWriter(), t = manualTimers(), c = coalesceRunEvents(w, t);
  c.emit({ type: 'text', delta: 'x' }); t.fire();
  assert.deepEqual(w.emitted, [{ type: 'text', delta: 'x' }]);
  c.emit({ type: 'text', delta: 'y' }); await c.beforeCall();
  c.emit({ type: 'text', delta: 'z' }); await c.flush();
  c.emit({ type: 'text', delta: 'w' }); await c.receiptOf('e9');
  assert.deepEqual(w.emitted, [{ type: 'text', delta: 'x' }, { type: 'text', delta: 'y' }, 'beforeCall',
    { type: 'text', delta: 'z' }, 'flush', { type: 'text', delta: 'w' }]);
  t.fire(); assert.equal(w.emitted.length, 6, '交过的不再交');
});

test('攒到字数上限就交,不等时间', () => {
  const w = fakeWriter(), c = coalesceRunEvents(w, { ...manualTimers(), maxChars: 5 });
  c.emit({ type: 'text', delta: 'abc' }); c.emit({ type: 'text', delta: 'def' }); c.emit({ type: 'text', delta: 'g' });
  assert.deepEqual(w.emitted, [{ type: 'text', delta: 'abcdef' }]);
});

test('其余接口原样透出;终态事件的返回值照旧', () => {
  const w = fakeWriter(), c = coalesceRunEvents(w, manualTimers());
  assert.equal(c.binding, w.binding); assert.equal(c.failed, w.failed); assert.equal(c.stop, w.stop);
  c.emit({ type: 'text', delta: 'x' });
  assert.equal(c.emit({ type: 'runner_done', settlement: 'pending', outcome: 'done' }), 'e2');
});

test('合并窗口缺省 1 秒(2026-10-22 用户定),字数阈值 4000;计时器按窗口定', () => {
  assert.equal(COALESCE_WINDOW_MS, 1000);
  assert.equal(COALESCE_MAX_CHARS, 4000);
  const waits = [];
  const w = fakeWriter(), c = coalesceRunEvents(w, { setTimer: (fn, ms) => { waits.push(ms); return 1; }, clearTimer: () => {} });
  c.emit({ type: 'text', delta: 'x' }); c.emit({ type: 'text', delta: 'y' });
  assert.deepEqual(waits, [1000], '一段攒着的只起一个计时器,1000 毫秒');
});
