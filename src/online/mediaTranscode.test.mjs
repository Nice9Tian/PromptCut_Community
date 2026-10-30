import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { smallVideoDimensions, Sha256, sha256Blob, transcodeVideoSmall } from "./mediaTranscode.ts";

test("smallVideoDimensions: 保持比例缩放至 800×600 以内且宽高均为偶数", () => {
  // 1080p (1920×1080) -> 800×450
  assert.deepEqual(smallVideoDimensions(1920, 1080), { width: 800, height: 450 });

  // 竖屏 9:16 (1080×1920) -> 338×600 或 336×600，两者均 <= 800×600 且偶数
  const v = smallVideoDimensions(1080, 1920);
  assert.ok(v.width <= 800 && v.height <= 600);
  assert.equal(v.width % 2, 0);
  assert.equal(v.height % 2, 0);
  assert.equal(v.height, 600);

  // 4:3 (1600×1200) -> 800×600
  assert.deepEqual(smallVideoDimensions(1600, 1200), { width: 800, height: 600 });

  // 本身较小 (640×480 <= 800×600): 不放大
  assert.deepEqual(smallVideoDimensions(640, 480), { width: 640, height: 480 });

  // 奇数尺寸 (801×599) -> 偶数 (800×598)
  const odd = smallVideoDimensions(801, 599);
  assert.ok(odd.width <= 800 && odd.height <= 600);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);

  // 异常尺寸保护
  const fallback = smallVideoDimensions(0, -100);
  assert.equal(fallback.width, 800);
  assert.equal(fallback.height % 2, 0);
});

test("Sha256 & sha256Blob: 与 node:crypto 结果逐位一致", async () => {
  const cases = [
    "",
    "hello world",
    "PromptCut 0.7.18 media import small first",
    crypto.randomBytes(64).toString("hex"),
    crypto.randomBytes(127).toString("hex"),
    crypto.randomBytes(256).toString("hex"),
    crypto.randomBytes(1024 * 1024).toString("hex"), // 1MB 文本
  ];

  for (const text of cases) {
    const expected = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    const blob = new Blob([text]);
    const actual = await sha256Blob(blob);
    assert.equal(actual, expected, `哈希不匹配: text length = ${text.length}`);
  }

  // 二进制分块数据
  const binary = crypto.randomBytes(5 * 1024 * 1024 + 1234); // 5MB+
  const expectedBin = crypto.createHash("sha256").update(binary).digest("hex");
  const actualBin = await sha256Blob(new Blob([binary]));
  assert.equal(actualBin, expectedBin, "大文件二进制哈希不匹配");
});

test("transcodeVideoSmall: 无 VideoEncoder 环境优雅降级返回 null，不抛错", async () => {
  const dummyBlob = new Blob([crypto.randomBytes(100)], { type: "video/mp4" });
  // 在未注入 WebCodecs 的 Node 环境下直接运行
  const result = await transcodeVideoSmall(dummyBlob, {
    env: { VideoEncoder: undefined, VideoFrame: undefined },
  });
  assert.equal(result, null);
});

test("transcodeVideoSmall: 视频元数据探测失败时优雅降级返回 null", async () => {
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

test("transcodeVideoSmall: 正常 WebCodecs + mp4Mux 模拟产出合法 MP4", async () => {
  const dummyBlob = new Blob([crypto.randomBytes(200)], { type: "video/mp4" });
  const mockVideo = {
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    duration: 0.1, // 约 2-3 帧
    currentTime: 0,
    addEventListener(event, cb) {
      if (event === "loadedmetadata" || event === "seeked") setTimeout(cb, 5);
    },
    removeEventListener() {},
  };

  // 构造标准 avcC (AVCDecoderConfigurationRecord)
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
      const sample = new Uint8Array([0, 0, 0, 5, 0x65, 1, 2, 3, 4]); // 4 字节前缀 + NAL
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

  assert.ok(res !== null, "转码应成功返回结果");
  assert.equal(res.width, 800);
  assert.equal(res.height, 450);
  assert.ok(res.blob.size > 0);
  assert.match(res.hash, /^[0-9a-f]{64}$/);
});
