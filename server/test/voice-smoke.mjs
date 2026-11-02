// Real voiceover smoke: use voices in fixtures/voices.json, synthesize one sentence each via API,
// and write files to a temporary directory.
// **Costs money** (a few cents per sentence; only uses already synthesized voices, won't trigger
// the ¥9.9 new-voice fee).
// Not in npm test; run manually:
//   VOICE_API_KEY=sk-… node server/test/voice-smoke.mjs      # Use API Key from environment variable
//   node server/test/voice-smoke.mjs                          # Use API Key stored in "Voiceover settings"
// API address: from Voiceover settings (or follows API settings); if neither, use the one recorded in fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVoiceConfig } from '../voice/voice-config.mjs';
import { generateVoice } from '../voice/generate.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/voices.json', import.meta.url), 'utf8'));
const saved = readVoiceConfig();
const apiKey = process.env.VOICE_API_KEY || saved.apiKey;
if (!apiKey) {
  console.error('No API Key: set VOICE_API_KEY, or first save one in "Voiceover settings".');
  process.exit(2);
}

const customVoices = [
  ...fixture.minimax.clone.map((v) => ({ provider: 'minimax', voiceId: v.voiceId, name: v.name, kind: 'clone', createdAt: '', note: '' })),
  ...fixture.minimax.design.map((v) => ({ provider: 'minimax', voiceId: v.voiceId, name: v.name, kind: 'design', createdAt: '', note: '' })),
];
const cfg = { ...saved, apiKey, effectiveBaseUrl: saved.effectiveBaseUrl || fixture.apiBaseUrl, customVoices };
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-voice-smoke-'));
const text = 'The task is done, just come back and take a look.';

const cases = [
  ...customVoices.map((v) => ({ provider: 'minimax', voiceId: v.voiceId, label: v.name })),
  { provider: 'kling', voiceId: fixture.kling.official[0].voiceId, label: `Kling ${fixture.kling.official[0].name}` },
  { provider: 'vidu', voiceId: fixture.vidu.system[0], label: `Vidu ${fixture.vidu.system[0]}` },
];

console.log(`API URL: ${cfg.effectiveBaseUrl}`);
let failed = 0;
for (const c of cases) {
  try {
    const r = await generateVoice({ cfg, args: { text, provider: c.provider, voiceId: c.voiceId, name: c.label }, outDir });
    console.log(`ok   ${c.label.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s  ${r.bytes} bytes  ${r.path}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.label.padEnd(20)} ${e.message}`);
  }
}
console.log(`\nOutput directory: ${outDir}`);
process.exit(failed ? 1 : 0);
