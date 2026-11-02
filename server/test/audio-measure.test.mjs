import test from "node:test";
import assert from "node:assert";
import { parseEbur128, timelineMeasureArgs } from "../audio-measure.mjs";
import { buildFfmpegArgs } from "../bakery/mux-audio.mjs";

test("parseEbur128 parses full log", () => {
  const stderr = [
    "[Parsed_ebur128_0 @ 0000021bd94a2540] t: 0.000000 TARGET:-23 LUFS    M: -120.7 S: -120.7     I: -120.7 LUFS       LRA:   0.0 LU  FTPK: -13.2 -13.0 dBFS  TPK: -13.2 -13.0 dBFS",
    "[Parsed_ebur128_0 @ 0000021bd94a2540] t: 0.099977 TARGET:-23 LUFS    M: -18.3 S: -20.1     I: -19.5 LUFS       LRA:   0.0 LU  FTPK: -13.2 -13.0 dBFS  TPK: -13.2 -13.0 dBFS",
    "[Parsed_ebur128_0 @ 0000021bd94a2540] t: 0.999977 TARGET:-23 LUFS    M: -18.3 S: -15.1     I: -19.5 LUFS       LRA:   0.0 LU  FTPK: -13.2 -13.0 dBFS  TPK: -13.2 -13.0 dBFS",
    "[Parsed_ebur128_0 @ 0000021bd94a2540] t: 1.099977 TARGET:-23 LUFS    M: -18.3 S: -15.1     I: -19.5 LUFS       LRA:   0.0 LU  FTPK: -13.2 -13.0 dBFS  TPK: -13.2 -13.0 dBFS",
    "[Parsed_ebur128_0 @ 0000021bd94a2540] t: 1.999977 TARGET:-23 LUFS    M: -18.3 S: -14.1     I: -19.5 LUFS       LRA:   0.0 LU  FTPK: -13.2 -13.0 dBFS  TPK: -13.2 -13.0 dBFS",
    "[Parsed_ebur128_0 @ 0000021bd94a2540] t: 2.099977 TARGET:-23 LUFS    M: -18.3 S: -14.1     I: -19.5 LUFS       LRA:   0.0 LU  FTPK: -13.2 -13.0 dBFS  TPK: -13.2 -13.0 dBFS",
    "[Parsed_ebur128_0 @ 0000021bd94a2540] Summary:",
    "",
    "  Integrated loudness:",
    "    I:         -12.4 LUFS",
    "    Threshold: -22.9 LUFS",
    "",
    "  Loudness range:",
    "    LRA:        11.5 LU",
    "    Threshold: -32.9 LUFS",
    "    LRA low:   -20.9 LUFS",
    "    LRA high:   -9.3 LUFS",
    "",
    "  True peak:",
    "    Peak:        0.0 dBFS",
    "size=N/A time=00:00:02.10 bitrate=N/A speed=122x"
  ].join("\n");

  const res = parseEbur128(stderr);
  assert.equal(res.integrated, -12.4);
  assert.equal(res.threshold, -22.9);
  assert.equal(res.lra, 11.5);
  assert.equal(res.lraLow, -20.9);
  assert.equal(res.lraHigh, -9.3);
  assert.equal(res.truePeak, 0.0);
  assert.equal(res.duration, 2.1); 
  assert.deepEqual(res.series, [
    { t: 0, lufs: -120.7 },
    { t: 1, lufs: -15.1 },
    { t: 2, lufs: -14.1 }
  ]);
});

test("parseEbur128 handles -inf and nan", () => {
  const stderr = [
    "  Integrated loudness:",
    "    I:         -inf LUFS",
    "    Threshold: -inf LUFS",
    "",
    "  Loudness range:",
    "    LRA:         0.0 LU",
    "    Threshold: -inf LUFS",
    "    LRA low:   -inf LUFS",
    "    LRA high:  -inf LUFS",
    "",
    "  True peak:",
    "    Peak:       -inf dBFS"
  ].join("\n");

  const res = parseEbur128(stderr);
  assert.equal(res.integrated, null);
  assert.equal(res.threshold, null);
  assert.equal(res.truePeak, null);
  assert.equal(res.lra, 0.0);
  assert.equal(res.lraLow, null);
  assert.equal(res.lraHigh, null);
});

test("timelineMeasureArgs filter chain matches mux-audio", () => {
  const entries = [
    { file: "A.mp3", start: 0, dur: 2, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
    { file: "B.mp3", start: 1, dur: 2, offset: 1, volume: 0.5, fadeIn: 1, fadeOut: 1 }
  ];
  
  const mArgs = timelineMeasureArgs(entries);
  const mxArgs = buildFfmpegArgs("dummy.mp4", entries, "out.mp4", 5);

  const mFilters = mArgs[mArgs.indexOf("-filter_complex") + 1];
  const mxFilters = mxArgs[mxArgs.indexOf("-filter_complex") + 1];

  const mParts = mFilters.split(";");
  const mxParts = mxFilters.split(";");
  
  for (let i = 0; i < entries.length; i++) {
    const mxStr = mxParts[i].replace("[" + (i+1) + ":a]", "[" + i + ":a]").replace("[a" + (i+1) + "]", "[a" + i + "]");
    assert.equal(mParts[i], mxStr);
  }

  const mAmix = mParts[entries.length];
  const mxAmix = mxParts[entries.length];
  
  let expectedMxAmix = mxAmix;
  for (let i = 0; i < entries.length; i++) {
    expectedMxAmix = expectedMxAmix.replace("[a" + (i+1) + "]", "[a" + i + "]");
  }
  // Loudness measurement adds an extra asetpts=N/SR/TB step after mixing (when amix occasionally has
  // NOPTS, the per-second curve misses points, see audio-measure.mjs); mixing itself is identical to export
  expectedMxAmix = expectedMxAmix.replace("[aout]", ",asetpts=N/SR/TB,ebur128=peak=true[aout]");
  assert.equal(mAmix, expectedMxAmix);
});

// Progress lines are \r-separated and get squeezed into the same line with ebur128 frame-by-frame
// lines; previously split by \n, when a line had multiple t:, only the first was matched, and the
// per-second curve would miss points (in actual testing, only 20 points remained out of 36 seconds).
// Now also split by \r, and take the first frame of each whole second by floor(t).
test("parseEbur128:\r-delimited progress lines mixed in do not drop whole-second points; a timeline with duration is truncated", () => {
  const frame = (t, s) => `[Parsed_ebur128_0 @ 0] t: ${t.toFixed(1)}  TARGET:-23 LUFS  M: -20.0 S: ${s}  I: -19.0 LUFS  LRA: 2.0 LU`;
  const lines = [];
  for (let i = 0; i <= 25; i++) {
    const t = i / 10;
    lines.push(frame(t, (-20 - i / 10).toFixed(1)));
    if (i % 7 === 3) lines.push("size=N/A time=00:00:0" + Math.floor(t) + ".00 bitrate=N/A speed=100x\r" + frame(t + 0.05, "-99.0"));
  }
  const r = parseEbur128(lines.join("\r\n") + "\n  Integrated loudness:\n    I:  -19.0 LUFS\n    Threshold: -29.0 LUFS\n");
  assert.deepEqual(r.series.map((p) => p.t), [0, 1, 2]);
  assert.deepEqual(r.series.map((p) => p.lufs), [-20, -21, -22]);
  const withTrim = timelineMeasureArgs([{ file: "a.wav", start: 0, dur: 30, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 }], 24);
  assert.match(withTrim[withTrim.indexOf("-filter_complex") + 1], /amix=[^,]+,atrim=0:24,asetpts=N\/SR\/TB,ebur128/);
  assert.ok(withTrim.includes("-nostats"));
  const noTrim = timelineMeasureArgs([{ file: "a.wav", start: 0, dur: 30, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 }]);
  assert.doesNotMatch(noTrim[noTrim.indexOf("-filter_complex") + 1], /atrim/);
});
