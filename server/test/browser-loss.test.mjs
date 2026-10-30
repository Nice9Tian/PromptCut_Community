import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { browserExitNote, isBrowserLoss, resumableSink, retryOnBrowserLoss, useBakery } from '../bakery/browser-loss.mjs';

const named = (name, message) => Object.assign(new Error(message), { name });
// The error the Tokyo export reported when its shard's Chrome exited.
const targetClosed = () => named('TargetCloseError', 'Protocol error (HeadlessExperimental.beginFrame): Target closed');
// puppeteer 25 throws this plain Error for a call made after the browser
// disconnected, because the page's main frame was already detached.
const detachedFrame = () => new Error("Attempted to use detached Frame 'A1B2C3'.");

function fakeProcess({ exitCode = null, signalCode = null } = {}) {
  return Object.assign(new EventEmitter(), { exitCode, signalCode });
}
function fakeBakery({ connected = true, exitCode = null, events = [] } = {}) {
  const proc = fakeProcess({ exitCode });
  return { browser: { connected, process: () => proc }, close: async () => { events.push('close'); proc.exitCode ??= 1; } };
}

test('puppeteer errors for a closed connection are a browser loss; timeouts, page errors and cancellations are not', () => {
  assert.equal(isBrowserLoss(targetClosed()), true);
  assert.equal(isBrowserLoss(named('TargetCloseError', 'Protocol error (Runtime.callFunctionOn): Session closed. Most likely the page has been closed.')), true);
  assert.equal(isBrowserLoss(named('ConnectionClosedError', 'Connection closed.')), true);
  assert.equal(isBrowserLoss(named('ProtocolError', 'Protocol error (Page.navigate): Target closed')), true);
  assert.equal(isBrowserLoss(new Error('wrapped', { cause: targetClosed() })), true);
  assert.equal(isBrowserLoss(Object.assign(detachedFrame(), { browserLost: true })), true);
  assert.equal(isBrowserLoss(named('ProtocolError', 'Runtime.callFunctionOn timed out. Increase the protocolTimeout setting in launch/connect calls for a higher timeout if needed.')), false);
  // A page script whose message happens to contain the words is not a loss.
  assert.equal(isBrowserLoss(new Error('Evaluation failed: Error: Target closed')), false);
  assert.equal(isBrowserLoss(detachedFrame()), false);
  assert.equal(isBrowserLoss(new Error('Chrome did not return the requested frame after 4 compositor ticks')), false);
  assert.equal(isBrowserLoss(Object.assign(targetClosed(), { cancelled: true })), false);
  assert.equal(isBrowserLoss(null), false);
});

test('a lost browser is retried and the later attempt result is returned', async () => {
  const seen = [];
  const logs = [];
  const result = await retryOnBrowserLoss(async (attempt) => {
    seen.push(attempt);
    if (attempt === 0) throw Object.assign(targetClosed(), { browserExit: '退出码 0xC0000409' });
    return 'ok';
  }, { label: '分片 0-99', log: (line) => logs.push(line) });
  assert.equal(result, 'ok');
  assert.deepEqual(seen, [0, 1]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /分片 0-99.*0xC0000409.*第 2\/3 次/);
});

test('other failures are not retried', async () => {
  let calls = 0;
  const error = new Error('Timeline not found');
  await assert.rejects(retryOnBrowserLoss(async () => { calls++; throw error; }, { log: () => {} }), (e) => e === error);
  assert.equal(calls, 1);
});

test('the final error names the shard and the exit code and keeps the cause', async () => {
  let calls = 0;
  const lost = Object.assign(targetClosed(), { browserExit: '退出码 0xC0000409' });
  await assert.rejects(
    retryOnBrowserLoss(async () => { calls++; throw lost; }, { attempts: 2, label: '分片 100-199', log: () => {} }),
    (e) => /分片 100-199/.test(e.message) && /0xC0000409/.test(e.message) && /重试 1 次/.test(e.message) && e.cause === lost,
  );
  assert.equal(calls, 2);
});

test('a restarted shard delivers each frame exactly once', async () => {
  const delivered = [];
  const sink = resumableSink(async (frame) => { delivered.push(frame); });
  sink.begin();
  for (const frame of [10, 11, 12]) await sink.write(frame, Buffer.alloc(0));
  // Chrome was lost while frame 13 rendered; the retry renders the shard again.
  sink.begin();
  for (const frame of [10, 11, 12, 13, 14]) await sink.write(frame, Buffer.alloc(0));
  assert.deepEqual(delivered, [10, 11, 12, 13, 14]);
});

test('a failed write is delivered again by the next attempt', async () => {
  const delivered = [];
  let fail = true;
  const sink = resumableSink(async (frame) => {
    if (frame === 2 && fail) { fail = false; throw new Error('ffmpeg stdin closed'); }
    delivered.push(frame);
  });
  sink.begin();
  await sink.write(1);
  await assert.rejects(sink.write(2));
  sink.begin();
  for (const frame of [1, 2, 3]) await sink.write(frame);
  assert.deepEqual(delivered, [1, 2, 3]);
});

test('the exit status is read after the process reports it', async () => {
  assert.equal(await browserExitNote({ process: () => fakeProcess({ exitCode: 3221226505 }) }), '退出码 0xC0000409');
  assert.equal(await browserExitNote({ process: () => fakeProcess({ exitCode: -1073740791 }) }), '退出码 0xC0000409');
  const late = fakeProcess();
  setTimeout(() => { late.exitCode = 3221225477; late.emit('exit', late.exitCode, null); }, 10);
  assert.equal(await browserExitNote({ process: () => late }), '退出码 0xC0000005');
  assert.equal(await browserExitNote({ process: () => fakeProcess({ signalCode: 'SIGKILL' }) }), '信号 SIGKILL');
  assert.equal(await browserExitNote({ process: () => fakeProcess() }, 5), '');
  assert.equal(await browserExitNote({ process: () => null }), '');
});

test('useBakery describes a lost browser before closing it, and always closes', async () => {
  const events = [];
  await assert.rejects(useBakery(fakeBakery({ exitCode: 3221226505, events }), async () => { throw targetClosed(); }),
    (e) => e.browserLost === true && e.browserExit === '退出码 0xC0000409');
  assert.deepEqual(events, ['close']);
  assert.equal(await useBakery(fakeBakery({ events }), async () => 7), 7);
  assert.deepEqual(events, ['close', 'close']);
});

test('an error thrown after the browser disconnected is a loss and is retried', async () => {
  const seen = [];
  const result = await retryOnBrowserLoss(async (attempt) => {
    seen.push(attempt);
    const bakery = fakeBakery({ connected: attempt > 0, exitCode: attempt === 0 ? 3221226505 : null });
    return useBakery(bakery, async () => {
      if (attempt === 0) throw detachedFrame();
      return 'rendered';
    });
  }, { log: () => {} });
  assert.equal(result, 'rendered');
  assert.deepEqual(seen, [0, 1]);
});

test('with the browser still connected, other errors and cancellations are not marked', async () => {
  await assert.rejects(useBakery(fakeBakery(), async () => { throw detachedFrame(); }),
    (e) => e.browserLost === undefined && !isBrowserLoss(e));
  const cancelled = Object.assign(new Error('已取消'), { cancelled: true });
  await assert.rejects(useBakery(fakeBakery({ connected: false }), async () => { throw cancelled; }),
    (e) => e === cancelled && e.browserLost === undefined);
});
