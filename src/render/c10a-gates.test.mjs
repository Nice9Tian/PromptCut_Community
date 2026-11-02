/**
 * C10a 能力闸：最低一档下素材只拉小尺寸（`docs/plan/c10a-contract.md` 第 8 节「素材只拉小尺寸」，第 12 节「能力闸」）。
 * 跑：node --experimental-test-module-mocks --test src/render/c10a-gates.test.mjs
 *
 * 最低一档怎么告诉 `mediaTier.ts`：`opts.smallOnly === true`（原假设 K3 的 `opts.lowMemory`，2026-10-22 随低内存档撤销改名）。
 * `src/online/onlineTier.ts` 不在时整组 skip。可播性模块换成桩，记下有没有去探原尺寸（探测要拉原尺寸的首帧）。
 *
 * 只用视频素材：C6.6 只给视频做素材小尺寸（`c66-design.md` 第 2 节），图片、音频在最低一档怎么办契约没写，
 * 见报告的更正建议。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, TIER_FILE } from "../../server/test/c10a-kit.mjs";

const missing = !exists(TIER_FILE);
const skip = skipIf(missing, `${TIER_FILE} (the small-size-only branch of mediaTier follows the tier)`);
const it = (name, fn) => test(name, { skip }, fn);

const probes = [];
let T = null;
if (!missing) {
  mock.module(srcUrl("render/playability.ts"), {
    exports: {
      playableOnThisHost: () => undefined,
      probePlayable: async (...args) => { probes.push(args); return undefined; },
      shouldProbe: () => true,
      rememberPlayable: () => {},
      forgetPlayable: () => {},
    },
  });
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  T = await import(srcUrl("render/mediaTier.ts"));
}
beforeEach(() => { probes.length = 0; });

const h = (c) => c.repeat(64);
const ORIG = h("a");
const SMALL = h("b");
const video = { id: "v", kind: "video", ext: "mp4", url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG, small: SMALL } };
const onlyOriginal = { id: "o", kind: "video", ext: "mp4", url: `/@media/${h("c")}`, hash: h("c"), tiers: { original: h("c") } };
const REMOTE = "@known:remote";
const LOW = { smallOnly: true };

it("C10A-GT-01 lowest tier: both tiers arrived and original size can be placed, still give small size; do not probe original size", () => {
  const all = [REMOTE, ORIG, SMALL];
  assert.equal(T.playbackUrl(video, all, { ...LOW, playable: () => true }), `/@media/${SMALL}`);
  assert.equal(T.playbackUrl(video, all, { ...LOW, playable: () => undefined }), `/@media/${SMALL}`);
  assert.equal(probes.length, 0, "do not probe original size even when playability is unknown");
  assert.equal(T.chooseTier(video, all, LOW).tier, "small");
  // 对照：别的档照 C6.6 换回原尺寸
  assert.equal(T.playbackUrl(video, all, { playable: () => true }), `/@media/${ORIG}`);
});

/*
 * 集成对账改了这一条：实现在「问过素材服务、小尺寸还没到齐」时不挂地址（`url: ''`、`tier: 'none'`、`awaiting: true`），
 * 这一层显示占位与「等待上传方」角标，小尺寸到齐后地址从空变成小尺寸、重新挂上；而不是先挂一个素材服务上还没有的
 * 小尺寸地址（会 404，还会被舞台记成视频解码失败）。不变的是本条要核的：一律不给原尺寸。还没问过素材服务时照旧先给小尺寸。
 */
it("C10A-GT-02 lowest tier: only original size arrived, small size has not, still do not give original size (this layer waits for the uploader, no URL that has not arrived is attached)", () => {
  const choice = T.chooseTier(video, [REMOTE, ORIG], LOW);
  assert.notEqual(choice.tier, "original");
  assert.equal(choice.url.includes(ORIG), false, `the URL must not contain original size: ${choice.url}`);
  assert.equal(choice.awaiting, true, "this layer is waiting for the uploader");
  assert.equal(T.chooseTier(video, [], LOW).url, `/@media/${SMALL}`, "asset service not queried yet: give small size first");
  const none = T.chooseTier(video, [REMOTE], LOW);
  assert.equal(none.url.includes(ORIG), false, "no tier arrived: do not give original size");
  assert.equal(none.awaiting, true, "no tier arrived: wait for the uploader");
});

it("C10A-GT-03 lowest tier: a video without small size does not fetch original size, this layer waits for the uploader (placeholder + badge)", () => {
  for (const hashes of [[], [REMOTE], [REMOTE, h("c")]]) {
    const choice = T.chooseTier(onlyOriginal, hashes, LOW);
    assert.notEqual(choice.tier, "original", `hashes=${JSON.stringify(hashes)}`);
    assert.equal(choice.url.includes(h("c")), false, `the URL must not contain original size: ${choice.url}`);
    if (hashes.length) assert.equal(choice.awaiting, true, "after the asset service was queried, this layer is waiting for the uploader");
  }
  assert.equal(T.playbackUrl(onlyOriginal, [REMOTE, h("c")], LOW).includes(h("c")), false);
});

it("C10A-GT-04 lowest tier + online asset service: the small-size URL is built on the public URL of the asset service", () => {
  const base = "https://203-0-113-16.sslip.io/media/api/asset";
  const url = T.playbackUrl(video, [REMOTE, ORIG, SMALL], { ...LOW, cloudBase: base, playable: () => true });
  assert.ok(url.startsWith(base), url);
  assert.ok(url.endsWith(SMALL), url);
});
