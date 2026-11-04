import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { smallVideoDimensions, Sha256, sha256Blob, transcodeVideoSmall } from "./mediaTranscode.ts";

test("smallVideoDimensions: scales proportionally to fit within 800×600 with both width and height even", () => {
  // 1080p (1920×1080) -> 800×450
  assert.deepEqual(smallVideoDimensions(1920, 1080), { width: 800, height: 450 });

  // Vertical 9:16 (1080×1920) -> 338×600 or 336×600, both <= 800×600 and even
  const v = smallVideoDimensions(1080, 1920);
  assert.ok(v.width <= 800 && v.height <= 600);
  assert.equal(v.width % 2, 0);
  assert.equal(v.height % 2, 0);
  assert.equal(v.height, 600);

  // 4:3 (1600×1200) -> 800×600
  assert.deepEqual(smallVideoDimensions(1600, 1200), { width: 800, height: 600 });

  // Already small (640×480 <= 800×600): do not upscale
  assert.deepEqual(smallVideoDimensions(640, 480), { width: 640, height: 480 });

  // Odd dimensions (801×599) -> even (800×598)
  const odd = smallVideoDimensions(801, 599);
  assert.ok(odd.width <= 800 && odd.height <= 600);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);

  // Abnormal dimension protection
  const fallback = smallVideoDimensions(0, -100);
  assert.equal(fallback.width, 800);
  assert.equal(fallback.height % 2, 0);
});

test("Sha256 & sha256Blob: bit-for-bit identical to node:crypto results", async () => {
  const cases = [
    "",
    "hello world",
    "PromptCut 0.7.18 media import small first",
    crypto.randomBytes(64).toString("hex"),
    crypto.randomBytes(127).toString("hex"),
    crypto.randomBytes(256).toString("hex"),
    crypto.randomBytes(1024 * 1024).toString("hex"), // 1MB text
  ];

  for (const text of cases) {
    const expected = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    const blob = new Blob([text]);
    const actual = await sha256Blob(blob);
    assert.equal(actual, expected, `Hash mismatch: text length = ${text.length}`);
  }

  // Binary chunked data
  const binary = crypto.randomBytes(5 * 1024 * 1024 + 1234); // 5MB+
  const expectedBin = crypto.createHash("sha256").update(binary).digest("hex");
  const actualBin = await sha256Blob(new Blob([binary]));
  assert.equal(actualBin, expectedBin, "Large file binary hash mismatch");
});

test("transcodeVideoSmall: without VideoEncoder, downgrades gracefully and returns null, no throw", async () => {
  const dummyBlob = new Blob([crypto.randomBytes(100)], { type: "video/mp4" });
  // Run directly in a Node environment without injected WebCodecs
  const result = await transcodeVideoSmall(dummyBlob, {
    env: { VideoEncoder: undefined, VideoFrame: undefined },
  });
  assert.equal(result, null);
});

test("transcodeVideoSmall: when video metadata probing fails, downgrades gracefully and returns null", async () => {
  const dummyBlob = new Blob([crypto.randomBytes(100)], { type: "video/mp4" });
  const mockVideo = {
    addEventListener(event, cb) {
      if (event === "error") setTimeout(cb, 10);
    },
    removeEventListener() {},
    videoWidth: 0,
    videoHeight: 0,
    duration: 0,
  };
  const mockVideoEncoder = class {
    static isConfigSupported() { return Promise.resolve({ supported: true }); }
  };
  const mockVideoFrame = class {};

  const result = await transcodeVideoSmall(dummyBlob, {
    env: {
      VideoEncoder: mockVideoEncoder,
      VideoFrame: mockVideoFrame,
      createVideo: () => mockVideo,
    },
  });
  assert.equal(result, null);
});

test("transcodeVideoSmall: normal WebCodecs + mp4Mux simulation produces a valid MP4", async () => {
  const dummyBlob = new Blob([crypto.randomBytes(200)], { type: "video/mp4" });
  const mockVideo = {
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    duration: 0.1, // About 2-3 frames
    currentTime: 0,
    addEventListener(event, cb) {
      if (event === "loadedmetadata" || event === "seeked") setTimeout(cb, 5);
    },
    removeEventListener() {},
  };

  // Construct standard avcC (AVCDecoderConfigurationRecord)
  const avcC = new Uint8Array([
    1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 10,
    0x27, 0x64, 0, 0x28, 0xac, 0x2b, 0x40, 0x3c, 0x1, 0x13,
    1, 0, 4, 0x28, 0xee, 0x3c, 0x80
  ]);

  let encodedCount = 0;
  class MockVideoEncoder {
    constructor(init) {
      this.init = init;
      this.encodeQueueSize = 0;
    }
    static isConfigSupported() {
      return Promise.resolve({ supported: true });
    }
    configure() {}
    encode(frame, opts) {
      encodedCount++;
      const sample = new Uint8Array([0, 0, 0, 5, 0x65, 1, 2, 3, 4]); // 4-byte prefix + NAL
      const meta = encodedCount === 1 ? { decoderConfig: { codec: "avc1.640028", description: avcC } } : {};
      this.init.output({
        byteLength: sample.length,
        timestamp: frame.timestamp,
        type: opts.keyFrame ? "key" : "delta",
        copyTo: (dst) => dst.set(sample),
      }, meta);
    }
    flush() { return Promise.resolve(); }
    close() {}
  }

  class MockVideoFrame {
    constructor(canvas, opts) {
      this.timestamp = opts.timestamp;
      this.duration = opts.duration;
    }
    close() {}
  }

  const mockCanvas = {
    getContext() {
      return {
        drawImage() {},
      };
    },
  };

  const res = await transcodeVideoSmall(dummyBlob, {
    fps: 24,
    env: {
      VideoEncoder: MockVideoEncoder,
      VideoFrame: MockVideoFrame,
      createCanvas: () => mockCanvas,
      createVideo: () => mockVideo,
    },
  });

  assert.ok(res !== null, "Transcoding should return a result successfully");
  assert.equal(res.width, 800);
  assert.equal(res.height, 450);
  assert.ok(res.blob.size > 0);
  assert.match(res.hash, /^[0-9a-f]{64}$/);
});
