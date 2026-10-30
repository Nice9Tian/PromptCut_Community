/**
 * subjectForRange / positionForSafeSide / subjectSampleTimes 的单测。跑：node --test src/kernel/subject.test.mjs
 *
 * 这两个函数是「主体检测」到「卡片位置」之间唯一的那道换算，list_shots 每个镜头的
 * suggestedPosition 都从这里出来。它算错不会报错，只会让 AI 把卡片放到人脸上，
 * 而画面里看起来「就是位置没选好」，没人会想到是这段折叠逻辑的问题。所以钉死：
 *   - 区间里一个采样都没有时必须退回最近的一个，并且**说出来**（approximate）；
 *   - safeSide 取众数、并列时的顺序是确定的（不然同一段素材两次调用给两种建议）；
 *   - safeSide 为 top 时不能原样传给卡片 —— 卡片没有 top 档，会掉进 center。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  subjectForRange, positionForSafeSide, subjectSampleTimes, suggestPosition, MAX_SUBJECT_TIMES,
} from "./project.ts";

/** 造一个采样：t 时刻、safeSide、四侧占用率 */
function sample(t, safeSide, occ, boxes = []) {
  return { t, safeSide, occupancy: occ, boxes };
}

const OCC = (left, right, top, bottom) => ({ left, right, top, bottom });

const 三个采样 = {
  engine: "light",
  createdAt: "2026-09-07T00:00:00.000Z",
  prompt: "",
  width: 1920,
  height: 1080,
  samples: [
    sample(1, "right", OCC(0.6, 0.1, 0.2, 0.5), [{ label: "person", x: 100, y: 100, w: 400, h: 800, conf: 0.9 }]),
    sample(2, "right", OCC(0.5, 0.2, 0.1, 0.4), [{ label: "face", x: 200, y: 120, w: 120, h: 140, conf: 0.95 }]),
    sample(3, "left", OCC(0.1, 0.7, 0.3, 0.6), [{ label: "person", x: 1200, y: 90, w: 420, h: 820, conf: 0.88 }]),
  ],
};

test("区间内的采样都参与合并：boxes 累加、occupancy 取平均", () => {
  const r = subjectForRange(三个采样, 0.5, 3.5);
  assert.deepEqual(r.times, [1, 2, 3]);
  assert.equal(r.approximate, false);
  assert.equal(r.boxes.length, 3, "三个采样的框要全带上");
  assert.equal(Math.round(r.occupancy.left * 1000) / 1000, 0.4); // (0.6+0.5+0.1)/3
  assert.equal(Math.round(r.occupancy.right * 1000) / 1000, 0.333);
});

test("safeSide 取众数，不是取第一个也不是取最后一个", () => {
  // right 出现两次、left 一次 —— 只看首尾都会得到错的那一边
  assert.equal(subjectForRange(三个采样, 0, 10).safeSide, "right");
});

test("众数并列时按固定顺序取，同一份数据两次调用结果一致", () => {
  const 并列 = {
    ...三个采样,
    samples: [sample(1, "bottom", OCC(0.4, 0.4, 0.4, 0.1)), sample(2, "left", OCC(0.1, 0.4, 0.4, 0.4))],
  };
  const a = subjectForRange(并列, 0, 5);
  const b = subjectForRange(并列, 0, 5);
  assert.equal(a.safeSide, "left", "顺序是 right > left > bottom > top");
  assert.equal(a.safeSide, b.safeSide);
});

test("区间里一个采样都没有：退回最近的一个，并标成 approximate", () => {
  // 镜头 [5, 6] 上没有采样，最近的是 t=3
  const r = subjectForRange(三个采样, 5, 6);
  assert.equal(r.approximate, true, "不标出来的话，调用方会拿邻镜头的结论当本镜头的");
  assert.deepEqual(r.times, [3]);
  assert.equal(r.safeSide, "left");
});

test("最近的那一个可能在区间左边", () => {
  const r = subjectForRange(三个采样, 1.2, 1.4);
  assert.deepEqual(r.times, [1]);
  assert.equal(r.approximate, true);
});

test("边界闭区间：t 正好等于 start 或 end 都算落在区间里", () => {
  assert.deepEqual(subjectForRange(三个采样, 1, 2).times, [1, 2]);
});

test("没检测过就是 null，不要造一个空壳出来", () => {
  assert.equal(subjectForRange(null, 0, 1), null);
  assert.equal(subjectForRange(undefined, 0, 1), null);
  assert.equal(subjectForRange({ ...三个采样, samples: [] }, 0, 1), null);
});

test("start / end 传反了也不崩", () => {
  assert.deepEqual(subjectForRange(三个采样, 3, 1).times, [1, 2, 3]);
});

// ── safeSide → 卡片 position ────────────────────────────────────────
test("左右下三档原样映射", () => {
  assert.equal(positionForSafeSide("left"), "left");
  assert.equal(positionForSafeSide("right"), "right");
  assert.equal(positionForSafeSide("bottom"), "bottom");
});

test("top 不能原样传：卡片没有 top 档，会掉进 center 正好糊在人脸上", () => {
  const p = positionForSafeSide("top", OCC(0.7, 0.15, 0.05, 0.6));
  assert.notEqual(p, "center");
  assert.equal(p, "right", "剩下三个合法档里挑占用率最低的");
});

test("top 且没有 occupancy 时也要给一个合法值", () => {
  assert.ok(["left", "right", "bottom"].includes(positionForSafeSide("top")));
});

// ── 采样时刻 ────────────────────────────────────────────────────────
// 采样点选错不会报错，只会让检测在人物没出现的那几帧上做出结论。

const 镜头 = (start, end) => ({ start, end, inTransition: null, outTransition: null });

test("有镜头划分：每个镜头 20% / 50% / 80% 三点", () => {
  const times = subjectSampleTimes({
    duration: 20,
    shots: { engine: "transnetv2", createdAt: "", transitions: [], shots: [镜头(0, 10)] },
  });
  assert.deepEqual(times, [2, 5, 8]);
});

test("镜头短于 1 秒只取中点：三次抽帧抽到的是同一帧，白花两次前向", () => {
  const times = subjectSampleTimes({
    duration: 20,
    shots: { engine: "transnetv2", createdAt: "", transitions: [], shots: [镜头(4, 4.6)] },
  });
  assert.deepEqual(times, [4.3]);
});

test("没做过镜头识别：每 2 秒一点", () => {
  assert.deepEqual(subjectSampleTimes({ duration: 7 }), [1, 3, 5]);
});

test("采样点不会超出素材时长 —— ffmpeg seek 过界会抽不到帧，那条采样白丢", () => {
  const times = subjectSampleTimes({
    duration: 5,
    shots: { engine: "scdet", createdAt: "", transitions: [], shots: [镜头(0, 5)] },
  });
  assert.ok(times.every((t) => t <= 5), `越界了：${times}`);
});

test("很短的素材也要给出至少一个采样点，不能返回空数组", () => {
  assert.equal(subjectSampleTimes({ duration: 0.6 }).length, 1);
});

test("相邻镜头算出同一个时刻时去重，不重复抽同一帧", () => {
  const times = subjectSampleTimes({
    duration: 10,
    shots: {
      engine: "transnetv2", createdAt: "", transitions: [],
      shots: [镜头(0, 5), 镜头(0, 5)],
    },
  });
  assert.deepEqual(times, [1, 2.5, 4]);
});

// ── 采样上限 ────────────────────────────────────────────────────────
// 服务端 /api/subject/detect 硬拒超过 MAX_SUBJECT_TIMES 的请求，而「不传 times 就
// 自动算」是工具描述里承诺的默认路径。这两件事以前是矛盾的：校验员把 subjectSampleTimes
// 原样搬到 node 里复算，三个真实场景全部超限（7 分钟无镜头 210 点、5 分钟 80 镜头
// 240 点、3 分钟 90 个 2 秒镜头 270 点），标准流程 detect_shots → detect_subjects
// 会直接被 400 拒掉；服务端给的补救话术「请分批」在客户端还做不成——setMediaSubjects
// 是整体替换，第二批会把第一批冲掉。所以上限必须在这一层就夹住。

const 一串镜头 = (n, len) =>
  Array.from({ length: n }, (_, i) => 镜头(i * len, (i + 1) * len));

test("7 分钟无镜头素材：原本 210 点，夹到 200 以内", () => {
  const times = subjectSampleTimes({ duration: 420 });
  assert.equal(subjectSampleTimes({ duration: 420 }, Number.MAX_SAFE_INTEGER).length, 210, "先钉住原始点数，免得以后改了步长这条用例悄悄失效");
  assert.ok(times.length <= MAX_SUBJECT_TIMES, `超限了：${times.length}`);
  assert.equal(times.length, MAX_SUBJECT_TIMES, "抽稀应当正好抽到上限，不要白扔点");
  assert.ok(times.every((t) => t >= 0 && t <= 420), "抽稀之后仍然要落在素材里");
  assert.deepEqual([...times].sort((a, b) => a - b), times, "抽稀不能打乱顺序");
  assert.equal(new Set(times).size, times.length, "抽稀不能抽出重复的时刻");
});

test("5 分钟 80 镜头：原本 240 点，按镜头分组抽稀到正好 200，每个镜头保底留中点", () => {
  const shots = { engine: "transnetv2", createdAt: "", transitions: [], shots: 一串镜头(80, 3.75) };
  const media = { duration: 300, shots };
  assert.equal(subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length, 240);
  const times = subjectSampleTimes(media);
  assert.ok(times.length <= MAX_SUBJECT_TIMES, `超限了：${times.length}`);
  // 只超一点点就整体塌成每镜头一个中点（80 点）是降过了头：明明能留 200 个。
  // 正确做法是每个镜头保底留中点，剩下 120 个名额在 20%/80% 点里等距分。
  assert.equal(times.length, MAX_SUBJECT_TIMES, "抽稀应当正好抽到上限，不要白扔点");
  for (const s of shots.shots) {
    const mid = Math.round((s.start + (s.end - s.start) / 2) * 100) / 100;
    assert.ok(times.includes(mid), `镜头 ${s.start}-${s.end} 的中点丢了`);
  }
});

test("3 分钟 90 个 2 秒镜头（提示词点名的「镜头特别碎」场景）：原本 270 点，夹到 200 以内", () => {
  const shots = { engine: "transnetv2", createdAt: "", transitions: [], shots: 一串镜头(90, 2) };
  const media = { duration: 180, shots };
  assert.equal(subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length, 270);
  const times = subjectSampleTimes(media);
  assert.ok(times.length <= MAX_SUBJECT_TIMES, `超限了：${times.length}`);
  // 90 个中点保底 + 110 个名额分给 20%/80% 点 = 正好 200；镜头一个不少
  assert.equal(times.length, MAX_SUBJECT_TIMES, "抽稀应当正好抽到上限");
  for (const s of shots.shots) {
    const mid = Math.round((s.start + (s.end - s.start) / 2) * 100) / 100;
    assert.ok(times.includes(mid), `镜头 ${s.start}-${s.end} 的中点丢了`);
  }
});

test("镜头多到中点也放不下时：等距抽稀到上限，而不是留下前 200 个", () => {
  // 300 个 1.5 秒镜头 → 三点 900、中点 300，两步都超，只能抽稀
  const shots = { engine: "transnetv2", createdAt: "", transitions: [], shots: 一串镜头(300, 1.5) };
  const times = subjectSampleTimes({ duration: 450, shots });
  assert.equal(times.length, MAX_SUBJECT_TIMES);
  // 等距的关键证据：最后一个采样要落在素材尾部附近，不能只覆盖前 2/3
  assert.ok(times[times.length - 1] > 440, `尾部丢了：${times[times.length - 1]}`);
  assert.ok(times[0] < 5, `头部丢了：${times[0]}`);
});

test("max 可以自己传，1 也是合法值（取中间那一个，不是取第一个）", () => {
  const one = subjectSampleTimes({ duration: 420 }, 1);
  assert.equal(one.length, 1);
  assert.ok(one[0] > 100 && one[0] < 320, `取的不是中间那个：${one[0]}`);
});

// ── 抽帧失败的采样 ───────────────────────────────────────────────────
// 失败的采样在 JSON 里和「这一帧真的没有人」逐字段相同（boxes 空、occupancy 四个 0、
// safeSide 是个占位值）。不过滤的话，一次部分失败的检测会给出「这段没人、卡片随便放、
// right 侧安全」的伪结论——恰好是这个功能最该避免的那种错。

const 失败样本 = (t) => ({
  t, failed: true, reason: "抽帧失败：没有解出数据（时刻超出时长？）",
  boxes: [], safeSide: "right", occupancy: OCC(0, 0, 0, 0),
});

test("抽帧失败的采样不参与合并：占用率不能被那几个 0 洗淡", () => {
  const 混着失败 = {
    ...三个采样,
    samples: [三个采样.samples[0], 失败样本(1.5), 三个采样.samples[1]],
  };
  const r = subjectForRange(混着失败, 0, 5);
  assert.deepEqual(r.times, [1, 2], "失败的那条不能出现在 times 里");
  assert.equal(Math.round(r.occupancy.left * 1000) / 1000, 0.55, "(0.6+0.5)/2，掺进一个 0 就成了 0.367");
});

test("全都失败时返回 null，不要造一个假的 right 出来", () => {
  const 全失败 = { ...三个采样, samples: [失败样本(1), 失败样本(2)] };
  assert.equal(subjectForRange(全失败, 0, 5), null);
});

test("区间里只有失败样本时，退回最近的那个成功样本并标 approximate", () => {
  const 混着失败 = { ...三个采样, samples: [三个采样.samples[0], 失败样本(9)] };
  const r = subjectForRange(混着失败, 8, 10);
  assert.equal(r.approximate, true);
  assert.deepEqual(r.times, [1]);
});

// ── 被占住时不给建议 ─────────────────────────────────────────────────
// positionForSafeSide 是在剩下三个合法档里挑「最不坏」的，不等于「保证不遮」。
// 实测 out/media/talker.mp4（720x1280 正面说话人）t=2.75：
// occupancy {left:0.895, right:0.895, top:0.692, bottom:0.993}、safeSide="top"，
// 挑出来的 right 有 89.5% 是人——卡片照着填就正压在脸上。

test("有真正空的一侧时照常给建议，并报出那一侧的占用率", () => {
  const s = suggestPosition("top", OCC(0.7, 0.15, 0.05, 0.6));
  assert.equal(s.suggestedPosition, "right");
  assert.equal(s.suggestedOccupancy, 0.15);
  assert.equal(s.warning, undefined);
});

test("四档全被占住：suggestedPosition 置 null 并给出 warning（talker.mp4 的实测数）", () => {
  const s = suggestPosition("top", OCC(0.895, 0.895, 0.692, 0.993));
  assert.equal(s.suggestedPosition, null, "89.5% 是人的那一侧不能当作建议给出去");
  assert.equal(s.suggestedOccupancy, 0.9);
  assert.match(s.warning, /没有不遮人的位置/);
});

test("刚好卡在阈值上不算被占住（0.5 是「超过才算」）", () => {
  assert.equal(suggestPosition("right", OCC(0.9, 0.5, 0.9, 0.9)).suggestedPosition, "right");
  assert.equal(suggestPosition("right", OCC(0.9, 0.51, 0.9, 0.9)).suggestedPosition, null);
});

test("suggestedPosition 的值域里没有 center —— 居中正是人脸所在", () => {
  for (const side of ["left", "right", "top", "bottom"]) {
    const s = suggestPosition(side, OCC(0.1, 0.1, 0.1, 0.1));
    assert.notEqual(s.suggestedPosition, "center");
    assert.ok(["left", "right", "bottom"].includes(s.suggestedPosition));
  }
});
