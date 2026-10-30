import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionFrameAt, compileCaptionFrames } from './captionFrame.mjs';

test('captions preserve wait-style exits and entries with no playback history', () => {
  const c = compileCaptionFrames('0|5|First|en // 5|8|Second // 9|10|Gap');
  assert.equal(captionFrameAt(c, 4).line.zh, 'First');
  assert.equal(captionFrameAt(c, 5.1).line.zh, 'First');
  assert.ok(captionFrameAt(c, 5.1).opacity < 1);
  assert.equal(captionFrameAt(c, 5.2).line.zh, 'Second');
  assert.ok(captionFrameAt(c, 5.3).opacity > 0);
  assert.equal(captionFrameAt(c, 7).opacity, 1);
  assert.equal(captionFrameAt(c, 8.5), null);
  assert.equal(captionFrameAt(c, 9).opacity, 0);
  assert.equal(captionFrameAt(c, 10), null);
});
test('dense changes, malformed lines and shuffled seeks have deterministic results', () => {
  const c = compileCaptionFrames('broken // 0|5|A // 5|5.1|B // 5.1|5.2|C // 5.2|8|D');
  const times = [0, .1, 5, 5.1, 5.15, 5.2, 5.3, 6, 8];
  const expected = times.map(t => captionFrameAt(c, t));
  for (const i of [7, 2, 0, 6, 4, 8, 3, 1, 5]) assert.deepEqual(captionFrameAt(c, times[i]), expected[i]);
  assert.equal(captionFrameAt(c, 6).line.zh, 'D');
  assert.ok(c.events.length < 20, 'events track subtitle changes, not video frames');
});
