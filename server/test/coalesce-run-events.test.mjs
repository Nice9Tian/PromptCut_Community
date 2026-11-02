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

test('Consecutive text coalesces into one event; when another event arrives, the accumulated text is emitted first, order unchanged', () => {
  const w = fakeWriter(), t = manualTimers(), c = coalesceRunEvents(w, t);
  for (const d of ['你', 'OK', '世界']) assert.equal(c.emit({ type: 'text', delta: d }), undefined);
  assert.deepEqual(w.emitted, [], 'Still accumulating');
  assert.equal(c.emit({ type: 'tool_call', name: 'x' }), 'e2');
  assert.deepEqual(w.emitted, [{ type: 'text', delta: '你好世界' }, { type: 'tool_call', name: 'x' }]);
});

test('Thinking and text, and thinking from different rounds, are each coalesced separately and not mixed', () => {
  const w = fakeWriter(), c = coalesceRunEvents(w, manualTimers());
  c.emit({ type: 'thinking', delta: 'a', round: 1 }); c.emit({ type: 'thinking', delta: 'b', round: 1 });
  c.emit({ type: 'thinking', delta: 'c', round: 2 }); c.emit({ type: 'text', delta: 'd' }); c.emit({ type: 'text', delta: 'e' });
  c.emit({ type: 'progress', text: 'p' });
  assert.deepEqual(w.emitted, [{ type: 'thinking', delta: 'ab', round: 1 }, { type: 'thinking', delta: 'c', round: 2 },
    { type: 'text', delta: 'de' }, { type: 'progress', text: 'p' }]);
});

test('Emit when time is up; emit first before flush / beforeCall / receiptOf', async () => {
  const w = fakeWriter(), t = manualTimers(), c = coalesceRunEvents(w, t);
  c.emit({ type: 'text', delta: 'x' }); t.fire();
  assert.deepEqual(w.emitted, [{ type: 'text', delta: 'x' }]);
  c.emit({ type: 'text', delta: 'y' }); await c.beforeCall();
  c.emit({ type: 'text', delta: 'z' }); await c.flush();
  c.emit({ type: 'text', delta: 'w' }); await c.receiptOf('e9');
  assert.deepEqual(w.emitted, [{ type: 'text', delta: 'x' }, { type: 'text', delta: 'y' }, 'beforeCall',
    { type: 'text', delta: 'z' }, 'flush', { type: 'text', delta: 'w' }]);
  t.fire(); assert.equal(w.emitted.length, 6, 'Anything already emitted is not emitted again');
});

test('Emit once the character limit is reached, without waiting for the timer', () => {
  const w = fakeWriter(), c = coalesceRunEvents(w, { ...manualTimers(), maxChars: 5 });
  c.emit({ type: 'text', delta: 'abc' }); c.emit({ type: 'text', delta: 'def' }); c.emit({ type: 'text', delta: 'g' });
  assert.deepEqual(w.emitted, [{ type: 'text', delta: 'abcdef' }]);
});

test('The remaining interfaces pass through unchanged; the return value of terminal events stays as before', () => {
  const w = fakeWriter(), c = coalesceRunEvents(w, manualTimers());
  assert.equal(c.binding, w.binding); assert.equal(c.failed, w.failed); assert.equal(c.stop, w.stop);
  c.emit({ type: 'text', delta: 'x' });
  assert.equal(c.emit({ type: 'runner_done', settlement: 'pending', outcome: 'done' }), 'e2');
});

test('The merge window defaults to 1 second (user decision, 2026-10-22), the character threshold is 4000; the timer follows the window', () => {
  assert.equal(COALESCE_WINDOW_MS, 1000);
  assert.equal(COALESCE_MAX_CHARS, 4000);
  const waits = [];
  const w = fakeWriter(), c = coalesceRunEvents(w, { setTimer: (fn, ms) => { waits.push(ms); return 1; }, clearTimer: () => {} });
  c.emit({ type: 'text', delta: 'x' }); c.emit({ type: 'text', delta: 'y' });
  assert.deepEqual(waits, [1000], 'One accumulating run starts only one timer, 1000 milliseconds');
});
