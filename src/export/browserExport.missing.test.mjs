import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("browser export mixes the bundled voice, crops to a short missing clip, and never fetches the original URL", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  const old = { fetch: globalThis.fetch, OfflineAudioContext: globalThis.OfflineAudioContext, AudioEncoder: globalThis.AudioEncoder, AudioData: globalThis.AudioData };
  const fetched = [];
  const decodedSizes = [];
  try {
    const M = await server.ssrLoadModule("/src/export/browserExport.ts");
    const wavFile = path.join(ROOT, "src/audio/assets/missing-material.wav");
    const wav = fs.readFileSync(wavFile);
    globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response(wav); };
    globalThis.OfflineAudioContext = class {
      constructor(_channels, length, sampleRate) { this.length = length; this.sampleRate = sampleRate; this.destination = {}; }
      async decodeAudioData(buffer) {
        decodedSizes.push(buffer.byteLength);
        const view = new DataView(buffer);
        const channels = view.getUint16(22, true), bits = view.getUint16(34, true), bytes = view.getUint32(40, true);
        const frames = Math.max(1, Math.floor(bytes / (channels * bits / 8)));
        return { length: frames, numberOfChannels: channels, sampleRate: this.sampleRate, getChannelData: () => new Float32Array(frames) };
      }
      createBufferSource() { return { connect() {}, start() {} }; }
      createGain() { return { gain: { value: 1, setValueCurveAtTime() {} }, connect() {} }; }
      async startRendering() { return { length: this.length, sampleRate: this.sampleRate, getChannelData: () => new Float32Array(this.length) }; }
    };
    globalThis.AudioData = class { constructor(value) { Object.assign(this, value); } close() {} };
    globalThis.AudioEncoder = class {
      constructor(init) { this.init = init; }
      configure() {}
      encode(data) { this.init.output({ byteLength: 2, timestamp: data.timestamp, duration: 1024, copyTo(target) { target.set([1, 2]); } }, { decoderConfig: { description: new Uint8Array([1, 2]) } }); }
      async flush() {}
      close() {}
    };
    const media = { id: "missing-audio", kind: "audio", name: "voice.wav", url: "/@media/original-voice", missingMaterial: {
      v: 1, mediaId: "missing-audio", original: { kind: "audio", name: "voice.wav", url: "/@media/original-voice" }, reason: "confirmed-missing", visual: false, audio: true,
    } };
    const project = { media: [media], tracks: [{ id: "audio", clips: [{ id: "short", mediaId: media.id, start: .25, end: .65, mediaOffset: 39, fadeIn: .1, fadeOut: .1 }] }] };
    const encoded = await M.encodeAudio({ project, signal: new AbortController().signal }, 2);
    assert.ok(encoded?.chunks.length);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], /missing-material\.wav/);
    assert.doesNotMatch(fetched[0], /original-voice/);
    assert.equal(decodedSizes.length, 2);
    assert.equal(decodedSizes[0], wav.byteLength, "the original decode reads the shipped fixed resource");
    assert.ok(decodedSizes[1] < 44 + 1.37 * 48000 * 2 * 4, "sliceWav passes only the short clip duration to OfflineAudioContext");
  } finally {
    globalThis.fetch = old.fetch; globalThis.OfflineAudioContext = old.OfflineAudioContext;
    globalThis.AudioEncoder = old.AudioEncoder; globalThis.AudioData = old.AudioData;
    await server.close();
  }
});
