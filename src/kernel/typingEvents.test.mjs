import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypingSchedule, typingTextAt, typingScheduleOptionsFromParams } from './typingEvents.ts';

test('typing default ASCII boundaries preserve the original interval baseline', () => {
  const text = 'Hello, world!';
  for (const duration of [0, 0.1, 70, 120, 333.3]) {
    const s = createTypingSchedule({ text, duration });
    for (const elapsed of [0, 0.01, 50, 120, 240, 500, 2000, 5000]) {
      const expected = duration === 0 ? text : text.substring(0, Math.floor(elapsed / duration));
      assert.equal(typingTextAt(s, elapsed), expected, `${duration}ms @ ${elapsed}`);
    }
    assert.equal(s.settleMs, text.length * duration);
  }
});

test('typing extended graphemes keep CJK, combining marks, emoji and CRLF intact', () => {
  const parts = ['中', '文', '，', '👩🏽‍💻', 'e\u0301', '🇨🇳', ' ', '\r\n', '尾'];
  const s = createTypingSchedule({ text: parts.join(''), duration: 10 });
  assert.deepEqual(s.events.map(e => e.grapheme), parts);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(typingTextAt(s, (i + 1) * 10), parts.slice(0, i + 1).join(''));
    assert.equal(typingTextAt(s, (i + 1) * 10 - 0.001), parts.slice(0, i).join(''));
  }
  assert.deepEqual(s.events.map(e => e.sound), [true,true,true,true,true,true,false,false,true]);
});

test('typing pauses, seed and sound policies share a deterministic source', () => {
  const options = { text: 'a, \nb', duration: 100, delayMs: 50, punctuationPauseMs: 200, newlinePauseMs: 300, pauses: [{ afterIndex: 0, durationMs: 70 }] };
  const s = createTypingSchedule(options);
  assert.deepEqual(s.events.map(e => e.atMs), [150,320,620,720,1120]);
  const jittered = createTypingSchedule({...options,jitterMs:30,seed:77});
  assert.deepEqual(createTypingSchedule({...options,jitterMs:30,seed:77}),jittered);
  assert.notDeepEqual(createTypingSchedule({...options,jitterMs:30,seed:78}).events,jittered.events);
  assert.equal(typingTextAt(jittered,-1),'');
  assert.equal(typingTextAt(jittered,Infinity),options.text);
  assert.deepEqual(createTypingSchedule({text:', \n', punctuationSound:false,whitespaceSound:true}).events.map(e=>e.sound),[false,true,true]);
  assert.deepEqual(typingScheduleOptionsFromParams({text:'hi',duration:50,punctuationSound:'off',whitespaceSound:'on'}), {
    text:'hi',duration:50,delayMs:undefined,punctuationPauseMs:undefined,newlinePauseMs:undefined,jitterMs:undefined,seed:undefined,punctuationSound:false,whitespaceSound:true,
  });
});

test('typing rejects resource excess and malformed timing instead of truncating', () => {
  for (const options of [{text:'a'.repeat(10001)}, {text:'a',duration:NaN}, {text:'a',duration:-1}, {text:'a',duration:1,jitterMs:2}, {text:'a',seed:1.5}, {text:'a',pauses:[{afterIndex:1,durationMs:2}]}]) assert.throws(()=>createTypingSchedule(options));
  assert.throws(()=>typingScheduleOptionsFromParams({text:'a',duration:'120'}),/number/);
});

test('typing frame-boundary times with float error still show the character (default params match the old integer-ms clock)', () => {
  const s = createTypingSchedule({ text: 'Hello, PromptCut typing!', duration: 120 });
  const fps = 30;
  // 整帧边界:每字 120 ms,6 帧=200 ms,所以 18、36、54、72 帧恰好落在字边界上。舞台把「帧时刻相减」的秒数乘 1000 传入。
  for (const startFrame of [51, 165, 237, 327, 411, 507]) {
    for (let k = 1; k <= s.events.length; k++) {
      const frames = (k * 120 * fps) / 1000;
      if (!Number.isInteger(frames)) continue;
      const t = (startFrame + frames) / fps - startFrame / fps;
      assert.equal(typingTextAt(s, t * 1000), s.source.text.slice(0, k), `start ${startFrame} char ${k} t=${t}`);
    }
  }
  // 容差只吸收浮点误差:差 0.001 ms 仍然是上一个字
  assert.equal(typingTextAt(s, 120 - 0.001), '');
});

test('typing boundary tolerance is opt-out: clocks that already subtract milliseconds keep their own float error', async () => {
  const { typingMountClockMs, TYPING_BOUNDARY_EPSILON_MS } = await import('./typingEvents.ts');
  const s = createTypingSchedule({ text: 'Hello, world!', duration: 120 });
  // 30 fps:挂载在第 179 帧,第 197 帧是「整 600 ms」,两个毫秒钟点相减却得 599.9999999999991
  const elapsed = typingMountClockMs(197 / 30, 179 / 30);
  assert.equal(elapsed, (197 / 30) * 1000 - (179 / 30) * 1000);
  assert.ok(elapsed < 600 && 600 - elapsed < TYPING_BOUNDARY_EPSILON_MS);
  assert.equal(typingTextAt(s, elapsed, 0), 'Hell');   // 旧实现:floor(599.99…/120) = 4
  assert.equal(typingTextAt(s, elapsed), 'Hello');     // 按 t 的那条路:容差补上
  assert.equal(typingTextAt(s, 600, 0), 'Hello');
});
