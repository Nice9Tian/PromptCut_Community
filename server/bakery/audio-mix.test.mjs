import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { audioClipInput } from "./audio-mix.mjs";
import { MISSING_MATERIAL_WAV } from "./mux-audio.mjs";

test("Chrome audio slicing reads the fixed shipped voice at source offset zero", () => {
  const input = audioClipInput({ missingMaterial: true, file: "C:/user/project/arbitrary.wav", offset: 82 });
  assert.deepEqual(input, { file: MISSING_MATERIAL_WAV, offset: 0 });
  assert.ok(fs.existsSync(input.file));
  const wav = fs.readFileSync(input.file);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  const ordinary = { file: "source.wav", offset: 7 };
  assert.deepEqual(audioClipInput(ordinary), { file: "source.wav", offset: 7 });
});
