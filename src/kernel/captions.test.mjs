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

test("parseCaptions:换行和 // 都能分条,坏行直接丢掉", () => {
  const raw = "0|2|第一句|first\n2|4|第二句|\n//\nx|y|坏的|\n5|3|起止反了|\n6|8||";
  const lines = parseCaptions(raw);
  assert.deepEqual(
    lines.map((l) => [l.start, l.end, l.zh, l.en]),
    [
      [0, 2, "第一句", "first"],
      [2, 4, "第二句", ""],
    ],
  );
  assert.deepEqual(parseCaptions(undefined), []);
  assert.deepEqual(parseCaptions(""), []);
});

test("parseCaptions:乱序的行读进来会按起点排好", () => {
  const lines = parseCaptions("4|6|后|\n0|2|前|");
  assert.deepEqual(lines.map((l) => l.zh), ["前", "后"]);
});

test("formatCaptions:格式和 fill_captions 生成的一致,竖线和换行被洗掉", () => {
  const out = formatCaptions([L(0, 2.005, "带|竖线\n和换行"), L(2, 4, "第二句", "second")]);
  assert.equal(out, "0.00|2.01|带 竖线 和换行|\n2.00|4.00|第二句|second");
  // 转一圈回来还是同一份数据
  assert.deepEqual(parseCaptions(out).map((l) => l.zh), ["带 竖线 和换行", "第二句"]);
});

test("captionSpans:秒数换算成时间轴绝对位置,卡外的部分裁掉", () => {
  const clip = { start: 10, end: 14, params: { lines: "0|2|甲|\n3|9|乙|\n5|6|丙|" } };
  const spans = captionSpans(clip);
  assert.deepEqual(
    spans.map((s) => [s.index, s.from, s.to, s.zh]),
    [
      [0, 10, 12, "甲"],
      // 乙 越过了卡片末尾,裁到 14
      [1, 13, 14, "乙"],
      // 丙 整条都在卡外,不画
    ],
  );
});

test("captionIndexAt:按相对秒找当前那条,和卡片组件一个口径", () => {
  const lines = parseCaptions("0|2|甲|\n2|4|乙|");
  assert.equal(captionIndexAt(lines, 1), 0);
  assert.equal(captionIndexAt(lines, 2), 1);
  assert.equal(captionIndexAt(lines, 4), -1);
});

test("captionBounds:左右邻居就是边界,两头没人就是 0 和卡长", () => {
  const lines = [L(0, 2, "甲"), L(3, 5, "乙"), L(6, 8, "丙")];
  assert.deepEqual(captionBounds(lines, 1, 10), { min: 2, max: 6 });
  assert.deepEqual(captionBounds(lines, 0, 10), { min: 0, max: 3 });
  assert.deepEqual(captionBounds(lines, 2, 10), { min: 5, max: 10 });
});

test("editCaption:只给 start 是整条平移,顶到邻居就贴住,长度不变", () => {
  const lines = [L(0, 2, "甲"), L(3, 5, "乙"), L(8, 9, "丙")];
  const moved = editCaption(lines, 1, { start: 2.5 }, 10);
  assert.deepEqual([moved.lines[1].start, moved.lines[1].end], [2.5, 4.5]);
  // 往左顶死:贴到甲的尾巴上,还是 2 秒长
  const left = editCaption(lines, 1, { start: -5 }, 10);
  assert.deepEqual([left.lines[1].start, left.lines[1].end], [2, 4]);
  // 往右顶死:贴到丙的头上
  const right = editCaption(lines, 1, { start: 99 }, 10);
  assert.deepEqual([right.lines[1].start, right.lines[1].end], [6, 8]);
});

test("editCaption:修边被夹在邻居之间,改文字不动时间", () => {
  const lines = [L(0, 2, "甲"), L(3, 5, "乙"), L(8, 9, "丙")];
  const trimmed = editCaption(lines, 1, { start: 1, end: 20 }, 10);
  assert.deepEqual([trimmed.lines[1].start, trimmed.lines[1].end], [2, 8]);
  const text = editCaption(lines, 1, { zh: "换了 | 字" }, 10);
  assert.deepEqual([text.lines[1].start, text.lines[1].end, text.lines[1].zh], [3, 5, "换了 字"]);
});

test("editCaption:平移过头会重新排序,返回的 index 是新位置", () => {
  const lines = [L(0, 2, "甲"), L(3, 5, "乙"), L(8, 9, "丙")];
  // 甲往后挪:排到乙前面还是第 0 位;把丙往前挪到 2.5 才会真的换位
  const r = editCaption(lines, 2, { start: 5, end: 6 }, 10);
  assert.equal(r.index, 2);
  assert.deepEqual(r.lines.map((l) => l.zh), ["甲", "乙", "丙"]);
});

test("insertCaption / removeCaption:落点被占就往后挪,塞不下返回 -1", () => {
  const lines = [L(0, 2, "甲"), L(2, 4, "乙")];
  const a = insertCaption(lines, { start: 1, zh: "新" }, 10);
  // 1 秒处被甲乙占着,顺到 4 秒
  assert.deepEqual([a.index, a.lines[a.index].start, a.lines[a.index].end], [2, 4, 6]);

  const full = [L(0, 5, "甲"), L(5, 10, "乙")];
  assert.equal(insertCaption(full, { start: 1, zh: "挤不进" }, 10).index, -1);

  assert.deepEqual(removeCaption(lines, 0).map((l) => l.zh), ["乙"]);
  assert.deepEqual(removeCaption(lines, 9).map((l) => l.zh), ["甲", "乙"]);
});

test("mapMediaTime:素材内的秒换算到时间轴,修过头的部分不算数", () => {
  // 素材第 8 秒开始播,落在时间轴 30 秒处,播 10 秒
  const clips = [{ start: 30, end: 40, mediaId: "m1", mediaOffset: 8 }];
  assert.equal(mapMediaTime(clips, "m1", 8), 30);
  assert.equal(mapMediaTime(clips, "m1", 12), 34);
  // 素材第 3 秒被修掉了,时间轴上没有它
  assert.equal(mapMediaTime(clips, "m1", 3), null);
  assert.equal(mapMediaTime(clips, "m2", 8), null);
});

test("captionsFromTranscript:段落跟着素材在时间轴上的位置走,秒数相对卡片起点", () => {
  const clips = [{ start: 30, end: 40, mediaId: "m1", mediaOffset: 8 }];
  const segments = [
    { start: 2, end: 4, text: "被修掉了" },
    { start: 8, end: 10, text: "第一句" },
    { start: 11, end: 13, text: "第二句" },
  ];
  const r = captionsFromTranscript(clips, "m1", segments);
  assert.deepEqual([r.from, r.to], [30, 35]);
  assert.deepEqual(
    r.lines.map((l) => [l.start, l.end, l.zh]),
    [
      [0, 2, "第一句"],
      [3, 5, "第二句"],
    ],
  );

  // 指定范围时超出的部分裁掉
  const clipped = captionsFromTranscript(clips, "m1", segments, { from: 30, to: 34 });
  assert.deepEqual(clipped.lines.map((l) => [l.start, l.end, l.zh]), [[0, 2, "第一句"], [3, 4, "第二句"]]);

  // 素材根本没放上时间轴:没有行,也不炸
  assert.deepEqual(captionsFromTranscript([], "m1", segments).lines, []);
});

test("captionsFromTranscript:素材从 0 开始、没修头时就是原样(老行为不变)", () => {
  const clips = [{ start: 0, end: 20, mediaId: "m1" }];
  const r = captionsFromTranscript(clips, "m1", [{ start: 1, end: 3, text: "你好" }]);
  assert.deepEqual([r.from, r.to], [1, 3]);
  assert.deepEqual(r.lines.map((l) => [l.start, l.end]), [[0, 2]]);
});

test("isCaptionClip:只认 caption-track", () => {
  assert.equal(isCaptionClip({ cardId: "caption-track" }), true);
  assert.equal(isCaptionClip({ cardId: "chapter-bar" }), false);
  assert.equal(isCaptionClip(null), false);
});
