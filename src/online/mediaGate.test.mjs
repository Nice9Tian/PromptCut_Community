/**
 * 素材闸门(`mediaGate.ts`、`render/netSpeed.ts`、`render/mediaTier.ts` 的 `smallOnlyFor` 与 `smallFirst`;语义 `product/platforms.md`
 * 「素材闸门」)。用例 MG-01～MG-08。跑:npm test -- src/online/mediaGate.test.mjs
 *
 *   MG-01 解码上限:从高往低问,第一个解得动的就是;问不出来按 1080p;都说解不动按最低一级
 *   MG-02 撑崩过的往下调级(累计,最低到最后一级)
 *   MG-03 打开时测一次,这次使用期间不变(之后再问回同一个结果,不再问浏览器)
 *   MG-04 按素材判:宽 × 高超过上限的视频只用小尺寸(没有小尺寸就等上传方,不拉原尺寸);没超过的照常;没记下宽高的不按它判;最低一档一律小尺寸
 *   MG-05 网速:资源计时里素材服务的大请求才算样本;滑动平均低于 8 Mbps 先拉小尺寸,高于 12 Mbps 只拉原尺寸,中间不变
 *   MG-06 只拉原尺寸(网速快):两档都到齐、可播性还不知道时直接给原尺寸(后台照样探可播性);先小后大(慢、没样本)照旧
 *   MG-07 要载入原尺寸的素材签名:超过上限的不算;换了一批才变(留崩溃记录用)
 *   MG-08 桌面不受影响:缺省策略不限上限、先小后大
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DECODE_LADDER, DECODE_FALLBACK_INDEX, ensureDecodeLimit, measureDecodeLimit, originalLoadSignature, resetMediaGateForTest } from "./mediaGate.ts";
import { FAST_ABOVE_MBPS, MIN_SAMPLE_BYTES, SLOW_BELOW_MBPS, addSample, sampleMbps } from "../render/netSpeed.ts";
import { chooseTier, mediaTierPolicy, smallOnlyFor, TIERS_KNOWN_REMOTE } from "../render/mediaTier.ts";

const askUpTo = (name) => async (lv) => DECODE_LADDER.findIndex((l) => l.name === lv.name) >= DECODE_LADDER.findIndex((l) => l.name === name);

test("MG-01 解码上限:从高往低问,第一个解得动的就是;问不出来按 1080p", async () => {
  assert.deepEqual(DECODE_LADDER.map((l) => l.name), ["2160p", "1440p", "1080p", "720p", "480p"]);
  const asked = [];
  const r = await measureDecodeLimit(async (lv) => { asked.push(lv.name); return lv.name === "1080p" || lv.name === "720p" || lv.name === "480p"; });
  assert.deepEqual([r.name, r.maxPixels, r.by], ["1080p", 1920 * 1080, "browser"]);
  assert.deepEqual(asked, ["2160p", "1440p", "1080p"], "问到第一个解得动的就停");
  const none = await measureDecodeLimit(async () => null);
  assert.deepEqual([none.index, none.by], [DECODE_FALLBACK_INDEX, "fallback"]);
  assert.equal(DECODE_LADDER[DECODE_FALLBACK_INDEX].name, "1080p");
  const weak = await measureDecodeLimit(async () => false);
  assert.equal(weak.name, "480p", "都说解不动:最低一级(还是给一个上限,超过的只用小尺寸)");
  const thrown = await measureDecodeLimit(async () => { throw new Error("boom"); });
  assert.equal(thrown.by, "fallback");
});

test("MG-02 撑崩过的往下调级", async () => {
  assert.equal((await measureDecodeLimit(askUpTo("2160p"), 1)).name, "1440p");
  assert.equal((await measureDecodeLimit(askUpTo("2160p"), 2)).name, "1080p");
  assert.equal((await measureDecodeLimit(askUpTo("1080p"), 9)).name, "480p", "最低到最后一级");
});

test("MG-03 打开时测一次,这次使用期间不变", async () => {
  resetMediaGateForTest();
  let calls = 0;
  const a = await ensureDecodeLimit({ ask: async (lv) => { calls++; return lv.name === "1440p"; } });
  const n = calls;
  const b = await ensureDecodeLimit({ ask: async () => { calls++; return true; } });
  assert.equal(a, b);
  assert.equal(calls, n, "之后导入更大的素材不重新测");
  assert.equal(b.name, "1440p");
  resetMediaGateForTest();
});

const H = (c) => c.repeat(64);
const video = (w, h, small = true) => ({ id: "v", kind: "video", ext: "mp4", url: `/@media/${H("a")}`, hash: H("a"), width: w, height: h, tiers: small ? { original: H("a"), small: H("b") } : { original: H("a") } });

test("MG-04 按素材判:超过上限只用小尺寸,没超过照常", () => {
  const lim = 1920 * 1080;
  assert.equal(smallOnlyFor(video(3840, 2160), { smallOnly: false, decodeMaxPixels: lim }), true);
  assert.equal(smallOnlyFor(video(1920, 1080), { smallOnly: false, decodeMaxPixels: lim }), false, "正好等于上限:照常");
  assert.equal(smallOnlyFor({}, { smallOnly: false, decodeMaxPixels: lim }), false, "没记下宽高:不按它判");
  assert.equal(smallOnlyFor(video(640, 360), { smallOnly: true, decodeMaxPixels: null }), true, "最低一档一律小尺寸");
  const all = [TIERS_KNOWN_REMOTE, H("a"), H("b")];
  const big = chooseTier(video(3840, 2160), all, { decodeMaxPixels: lim, playable: () => true, probe: false });
  assert.equal(big.tier, "small", "超过上限:原尺寸能放也只给小尺寸");
  const ok = chooseTier(video(1280, 720), all, { decodeMaxPixels: lim, playable: () => true, probe: false });
  assert.equal(ok.tier, "original", "没超过:照常");
  const noSmall = chooseTier(video(3840, 2160, false), all, { decodeMaxPixels: lim, playable: () => true, probe: false });
  assert.deepEqual(noSmall, { url: "", tier: "none", awaiting: true }, "超过上限又没有小尺寸:等上传方,不拉原尺寸");
});

test("MG-05 网速:只算素材服务的大请求;慢先小后大,快只拉原尺寸,中间不变", () => {
  assert.equal(SLOW_BELOW_MBPS, 8);
  assert.equal(FAST_ABOVE_MBPS, 12);
  const e = (o) => ({ name: "http://s1.x/media-s/abc/media/" + H("a"), initiatorType: "video", encodedBodySize: 2 * 1024 * 1024, responseStart: 0, responseEnd: 1000, ...o });
  assert.ok(Math.abs(sampleMbps(e({})) - 16.777) < 0.01, "2 MiB / 1 s ≈ 16.8 Mbps");
  assert.equal(sampleMbps(e({ name: "http://x/assets/app.js" })), null, "不是素材");
  assert.equal(sampleMbps(e({ encodedBodySize: MIN_SAMPLE_BYTES - 1 })), null, "太小");
  assert.equal(sampleMbps(e({ responseEnd: 10 })), null, "太快(缓存命中)");
  let s = { mbps: null, samples: 0, smallFirst: true };
  s = addSample(s, 20);
  assert.equal(s.smallFirst, false, "第一个样本 20 Mbps:只拉原尺寸");
  s = addSample(s, 10);
  assert.equal(s.smallFirst, false, "平均落在 8～12 之间:不变");
  for (let i = 0; i < 6; i++) s = addSample(s, 2);
  assert.equal(s.smallFirst, true, "慢下来:先拉小尺寸");
  for (let i = 0; i < 6; i++) s = addSample(s, 30);
  assert.equal(s.smallFirst, false, "恢复:改回只拉原尺寸");
});

test("MG-06 只拉原尺寸:两档都到齐、可播性还不知道时直接给原尺寸;先小后大照旧", () => {
  const all = [TIERS_KNOWN_REMOTE, H("a"), H("b")];
  const fast = chooseTier(video(1920, 1080), all, { smallFirst: false, playable: () => undefined, probe: false });
  assert.equal(fast.tier, "original");
  const slow = chooseTier(video(1920, 1080), all, { smallFirst: true, playable: () => undefined, probe: false });
  assert.equal(slow.tier, "small");
  const cant = chooseTier(video(1920, 1080), all, { smallFirst: false, playable: () => false, probe: false });
  assert.equal(cant.tier, "small", "放不了的照旧回小尺寸");
});

test("MG-07 要载入原尺寸的素材签名", () => {
  const m = [{ kind: "video", hash: "h1", width: 1920, height: 1080 }, { kind: "video", hash: "h2", width: 3840, height: 2160 }, { kind: "audio", hash: "h3" }];
  assert.equal(originalLoadSignature(m, 1920 * 1080), "h1", "超过上限的不载入原尺寸,不算");
  assert.equal(originalLoadSignature(m, null), "h1,h2");
  assert.equal(originalLoadSignature([...m, { kind: "video", hash: "h0", width: 10, height: 10 }], 1920 * 1080), "h0,h1", "新导入一份:变了");
});

test("MG-08 桌面不受影响:缺省策略不限上限、先小后大", () => {
  const p = mediaTierPolicy();
  assert.deepEqual([p.smallOnly, p.decodeMaxPixels, p.smallFirst], [false, null, true]);
});
