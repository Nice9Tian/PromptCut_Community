import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const probes = [];
mock.module(srcUrl("render/playability.ts"), {
  exports: {
    playableOnThisHost: () => undefined,
    shouldProbe: () => true,
    probePlayable: (_hash, url) => { probes.push(url); return Promise.resolve(undefined); },
  },
});
const { chooseTier } = await import(srcUrl("render/mediaTier.ts"));
const original = "a".repeat(64), small = "b".repeat(64);
const video = { url: `/@media/${original}`, hash: original, tiers: { original, small }, ext: "mp4", kind: "video" };

test("在线页地址未就绪时连后台可播性探针也不请求 /@media", () => {
  const hashes = [original, small];
  assert.deepEqual(chooseTier(video, hashes, { online: true, remote: null, smallOnly: false }), { url: "", tier: "none", awaiting: true });
  assert.deepEqual(probes, []);
  chooseTier(video, hashes, { online: true, remote: { base: "https://asset.example", ticket: null }, smallOnly: false });
  assert.deepEqual(probes, [`https://asset.example/media/${original}`]);
});
