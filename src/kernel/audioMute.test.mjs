import test from "node:test";
import assert from "node:assert/strict";
import { audioClipsAt, videoLayersAt } from "./project.ts";
import { buildAudioPlan } from "../../server/bakery/mux-audio.mjs";

const fixture = () => ({
  media: [
    { id: "v", kind: "video", url: "/media/video.mp4" },
    { id: "a", kind: "audio", url: "/media/video.mp4" },
  ],
  tracks: [
    { id: "video", clips: [{ id: "v1", mediaId: "v", start: 2, end: 7, mediaOffset: 4, audioMuted: true }] },
    { id: "audio", clips: [{ id: "a1", mediaId: "a", start: 2, end: 7, mediaOffset: 4, fadeIn: 0.5 }] },
  ],
});

test("separated video remains visible and only its extracted audio is exported", () => {
  const p = fixture();
  assert.equal(videoLayersAt(p, 3).length, 1);
  assert.equal(audioClipsAt(p, 3).length, 1);
  const plan = buildAudioPlan(p, ".", () => true);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].offset, 4);
  assert.equal(plan[0].start, 2);
  assert.equal(plan[0].dur, 5);
  assert.equal(plan[0].fadeIn, 0.5);
});

test("track mute affects preview and export, unmute restores audio", () => {
  const p = fixture();
  p.tracks[1].muted = true;
  assert.equal(audioClipsAt(p, 3).length, 0);
  assert.equal(buildAudioPlan(p, ".", () => true).length, 0);
  assert.equal(videoLayersAt(p, 3).length, 1);
  p.tracks[1].muted = false;
  assert.equal(audioClipsAt(p, 3).length, 1);
  assert.equal(buildAudioPlan(p, ".", () => true).length, 1);
});

test("素材库里的 /@media/ 声音按传入的 sourceOf 找文件,不再被跳过", () => {
  const p = fixture();
  p.media[1].url = "/@media/%E9%85%8D%E4%B9%90.m4a";
  // 默认规则只认 /@export/<id>/media/,这条以前直接被丢掉,成片没声音
  assert.equal(buildAudioPlan(p, ".", () => true).length, 0);
  const plan = buildAudioPlan(p, ".", () => true, (m) => (m.url.startsWith("/@media/") ? "C:/lib/配乐.m4a" : null));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].file, "C:/lib/配乐.m4a");
  // 同源 http 地址不查本地磁盘
  assert.equal(buildAudioPlan(p, ".", () => false, () => "http://127.0.0.1:5190/@media/x.m4a").length, 1);
});

test("muting a video sequence excludes its original sound from export without hiding its image", () => {
  const p = fixture();
  p.tracks = [p.tracks[0]];
  p.tracks[0].clips[0].audioMuted = false;
  p.tracks[0].muted = true;
  assert.equal(buildAudioPlan(p, ".", () => true).length, 0);
  assert.equal(videoLayersAt(p, 3).length, 1);
});
