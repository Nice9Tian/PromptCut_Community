import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCaptions,
  formatCaptions,
  captionSpans,
  captionIndexAt,
  captionBounds,
  editCaption,
  removeCaption,
  insertCaption,
  isCaptionClip,
  mapMediaTime,
  captionsFromTranscript,
} from "./captions.ts";

const L = (start, end, zh, en = "") => ({ start, end, zh, en });

test("parseCaptions: both newlines and // can separate entries, and bad lines are simply dropped", () => {
  const raw = "0|2|第一句|first\n2|4|第二句|\n//\nx|y|坏的|\n5|3|起止反了|\n6|8||";
  const lines = parseCaptions(raw);
  assert.deepEqual(
    lines.map((l) => [l.start, l.end, l.zh, l.en]),
    [
      [0, 2, "第一句", "first"],
      [2, 4, "SecondSentence", ""],
    ],
  );
  assert.deepEqual(parseCaptions(undefined), []);
  assert.deepEqual(parseCaptions(""), []);
});

test("parseCaptions: out-of-order lines are sorted by start time when read in", () => {
  const lines = parseCaptions("4|6|后|\n0|2|前|");
  assert.deepEqual(lines.map((l) => l.zh), ["前", "Then"]);
});

test("formatCaptions: the format matches what fill_captions generates, and pipes and newlines are scrubbed out", () => {
  const out = formatCaptions([L(0, 2.005, "带|竖线\n和换行"), L(2, 4, "SecondSentence", "second")]);
  assert.equal(out, "0.00|2.01|带 竖线 和换行|\n2.00|4.00|第二句|second");
  // 转一圈回来还是同一份数据
  assert.deepEqual(parseCaptions(out).map((l) => l.zh), ["带 竖线 和换行", "SecondSentence"]);
});

test("captionSpans: seconds are converted to absolute timeline positions, and the parts outside the card are cut off", () => {
  const clip = { start: 10, end: 14, params: { lines: "0|2|甲|\n3|9|乙|\n5|6|丙|" } };
  const spans = captionSpans(clip);
  assert.deepEqual(
    spans.map((s) => [s.index, s.from, s.to, s.zh]),
    [
      [0, 10, 12, "A"],
      // 乙 越过了卡片末尾,裁到 14
      [1, 13, 14, "B"],
      // 丙 整条都在卡外,不画
    ],
  );
});

test("captionIndexAt: finds the current entry by relative second, using the same rule as the card component", () => {
  const lines = parseCaptions("0|2|甲|\n2|4|乙|");
  assert.equal(captionIndexAt(lines, 1), 0);
  assert.equal(captionIndexAt(lines, 2), 1);
  assert.equal(captionIndexAt(lines, 4), -1);
});

test("captionBounds: the left and right neighbors are the bounds, and with no neighbor on either end the bounds are 0 and the card length", () => {
  const lines = [L(0, 2, "A"), L(3, 5, "B"), L(6, 8, "C")];
  assert.deepEqual(captionBounds(lines, 1, 10), { min: 2, max: 6 });
  assert.deepEqual(captionBounds(lines, 0, 10), { min: 0, max: 3 });
  assert.deepEqual(captionBounds(lines, 2, 10), { min: 5, max: 10 });
});

test("editCaption: giving only start shifts the whole entry, it sticks to a neighbor when it runs into one, and the length stays the same", () => {
  const lines = [L(0, 2, "A"), L(3, 5, "B"), L(8, 9, "C")];
  const moved = editCaption(lines, 1, { start: 2.5 }, 10);
  assert.deepEqual([moved.lines[1].start, moved.lines[1].end], [2.5, 4.5]);
  // 往左顶死:贴到甲的尾巴上,还是 2 秒长
  const left = editCaption(lines, 1, { start: -5 }, 10);
  assert.deepEqual([left.lines[1].start, left.lines[1].end], [2, 4]);
  // 往右顶死:贴到丙的头上
  const right = editCaption(lines, 1, { start: 99 }, 10);
  assert.deepEqual([right.lines[1].start, right.lines[1].end], [6, 8]);
});

test("editCaption: edge trimming is clamped between neighbors, and editing the text does not move the times", () => {
  const lines = [L(0, 2, "A"), L(3, 5, "B"), L(8, 9, "C")];
  const trimmed = editCaption(lines, 1, { start: 1, end: 20 }, 10);
  assert.deepEqual([trimmed.lines[1].start, trimmed.lines[1].end], [2, 8]);
  const text = editCaption(lines, 1, { zh: "换了 | 字" }, 10);
  assert.deepEqual([text.lines[1].start, text.lines[1].end, text.lines[1].zh], [3, 5, "换了 字"]);
});

test("editCaption: shifting too far reorders the entries, and the returned index is the new position", () => {
  const lines = [L(0, 2, "A"), L(3, 5, "B"), L(8, 9, "C")];
  // 甲往后挪:排到乙前面还是第 0 位;把丙往前挪到 2.5 才会真的换位
  const r = editCaption(lines, 2, { start: 5, end: 6 }, 10);
  assert.equal(r.index, 2);
  assert.deepEqual(r.lines.map((l) => l.zh), ["A", "B", "C"]);
});

test("insertCaption / removeCaption: if the insertion point is taken, move it later; if it cannot fit, return -1", () => {
  const lines = [L(0, 2, "A"), L(2, 4, "B")];
  const a = insertCaption(lines, { start: 1, zh: "新" }, 10);
  // 1 秒处被甲乙占着,顺到 4 秒
  assert.deepEqual([a.index, a.lines[a.index].start, a.lines[a.index].end], [2, 4, 6]);

  const full = [L(0, 5, "A"), L(5, 10, "B")];
  assert.equal(insertCaption(full, { start: 1, zh: "挤不进" }, 10).index, -1);

  assert.deepEqual(removeCaption(lines, 0).map((l) => l.zh), ["B"]);
  assert.deepEqual(removeCaption(lines, 9).map((l) => l.zh), ["A", "B"]);
});

test("mapMediaTime: seconds within the media are converted to the timeline, and the trimmed-off part does not count", () => {
  // 素材第 8 秒开始播,落在时间轴 30 秒处,播 10 秒
  const clips = [{ start: 30, end: 40, mediaId: "m1", mediaOffset: 8 }];
  assert.equal(mapMediaTime(clips, "m1", 8), 30);
  assert.equal(mapMediaTime(clips, "m1", 12), 34);
  // 素材第 3 秒被修掉了,时间轴上没有它
  assert.equal(mapMediaTime(clips, "m1", 3), null);
  assert.equal(mapMediaTime(clips, "m2", 8), null);
});

test("captionsFromTranscript: paragraphs follow the media's position on the timeline, and seconds are relative to the card start", () => {
  const clips = [{ start: 30, end: 40, mediaId: "m1", mediaOffset: 8 }];
  const segments = [
    { start: 2, end: 4, text: "被修掉了" },
    { start: 8, end: 10, text: "第一句" },
    { start: 11, end: 13, text: "SecondSentence" },
  ];
  const r = captionsFromTranscript(clips, "m1", segments);
  assert.deepEqual([r.from, r.to], [30, 35]);
  assert.deepEqual(
    r.lines.map((l) => [l.start, l.end, l.zh]),
    [
      [0, 2, "第一句"],
      [3, 5, "SecondSentence"],
    ],
  );

  // 指定范围时超出的部分裁掉
  const clipped = captionsFromTranscript(clips, "m1", segments, { from: 30, to: 34 });
  assert.deepEqual(clipped.lines.map((l) => [l.start, l.end, l.zh]), [[0, 2, "第一句"], [3, 4, "SecondSentence"]]);

  // 素材根本没放上时间轴:没有行,也不炸
  assert.deepEqual(captionsFromTranscript([], "m1", segments).lines, []);
});

test("captionsFromTranscript: when the media starts at 0 and its head is not trimmed, it is passed through as is (old behavior unchanged)", () => {
  const clips = [{ start: 0, end: 20, mediaId: "m1" }];
  const r = captionsFromTranscript(clips, "m1", [{ start: 1, end: 3, text: "Hello" }]);
  assert.deepEqual([r.from, r.to], [1, 3]);
  assert.deepEqual(r.lines.map((l) => [l.start, l.end]), [[0, 2]]);
});

test("isCaptionClip: only recognizes caption-track", () => {
  assert.equal(isCaptionClip({ cardId: "caption-track" }), true);
  assert.equal(isCaptionClip({ cardId: "chapter-bar" }), false);
  assert.equal(isCaptionClip(null), false);
});
