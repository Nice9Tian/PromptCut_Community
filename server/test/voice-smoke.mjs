// 配音的真实冒烟:用 fixtures/voices.json 里的音色,走 API 各合成一句,文件写到临时目录。
// **会花钱**(每句约几分钱;只用已经合成过的音色,不会触发 ¥9.9 的新音色费)。
// 不在 npm test 里;手动跑:
//   VOICE_API_KEY=sk-… node server/test/voice-smoke.mjs      # 用环境变量里的 API Key
//   node server/test/voice-smoke.mjs                          # 用「配音设置」里存的 API Key
// API 地址:配音设置里的(或跟随 API 设置);都没有就用 fixture 里记的那个。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVoiceConfig } from '../voice/voice-config.mjs';
import { generateVoice } from '../voice/generate.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/voices.json', import.meta.url), 'utf8'));
const saved = readVoiceConfig();
const apiKey = process.env.VOICE_API_KEY || saved.apiKey;
if (!apiKey) {
  console.error('没有 API Key:设 VOICE_API_KEY,或者先在「配音设置」里保存一个。');
  process.exit(2);
}

const customVoices = [
  ...fixture.minimax.clone.map((v) => ({ provider: 'minimax', voiceId: v.voiceId, name: v.name, kind: 'clone', createdAt: '', note: '' })),
  ...fixture.minimax.design.map((v) => ({ provider: 'minimax', voiceId: v.voiceId, name: v.name, kind: 'design', createdAt: '', note: '' })),
];
const cfg = { ...saved, apiKey, effectiveBaseUrl: saved.effectiveBaseUrl || fixture.apiBaseUrl, customVoices };
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-voice-smoke-'));
const text = '任务完成了，你回来看一下就行。';

const cases = [
  ...customVoices.map((v) => ({ provider: 'minimax', voiceId: v.voiceId, label: v.name })),
  { provider: 'kling', voiceId: fixture.kling.official[0].voiceId, label: `可灵 ${fixture.kling.official[0].name}` },
  { provider: 'vidu', voiceId: fixture.vidu.system[0], label: `Vidu ${fixture.vidu.system[0]}` },
];

console.log(`API 地址: ${cfg.effectiveBaseUrl}`);
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
console.log(`\n输出目录: ${outDir}`);
process.exit(failed ? 1 : 0);
