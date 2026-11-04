// Voiceover (voice_generate): settings persistence, API Key encryption, request shapes for three
// providers, voice whitelist, clone workflow.
// All use mock fetch, costing no money. For real synthesis see voice-smoke.mjs (run manually).
// How to run: node --test server/test/voice.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealKey, openKey, KEY_KINDS } from '../runners/config-crypt.mjs';
import {
  readVoiceConfig, writeVoiceConfig, clearVoiceKey, publicVoiceConfig, addCustomVoice, removeCustomVoice,
  voiceKeyPath, voiceConfigPath, normalizeVoiceConfig,
} from '../voice/voice-config.mjs';
import { synthesize, designVoice, cloneVoice, VoiceError } from '../voice/providers.mjs';
import { generateVoice, resolveOptions } from '../voice/generate.mjs';
import { isVoiceIdShape, isCloneIdShape } from '../voice/presets.mjs';
import { keyFilePath, writeConfig, apiOrigin } from '../ai-config.mjs';

let dir;
const savedEnv = process.env.PROMPTCUT_AI_CONFIG;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-voice-'));
  process.env.PROMPTCUT_AI_CONFIG = path.join(dir, 'ai.json');
});
after(() => {
  if (savedEnv === undefined) delete process.env.PROMPTCUT_AI_CONFIG; else process.env.PROMPTCUT_AI_CONFIG = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Mock fetch that replays responses in order, also recording each request */
function fakeFetch(...responses) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const r = responses[calls.length - 1];
    if (!r) throw new Error(`Unexpected extra request: ${url}`);
    return typeof r === 'function' ? r(url, init) : r;
  };
  f.calls = calls;
  return f;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const ctx = (fetch) => ({ baseUrl: 'https://gw.test', apiKey: 'sk-test', fetch });

// ── API Key encryption ─────────────────────────────────────────────
test('The API Key for voice has its own wrapper and is not a valid source for the chat API', () => {
  assert.deepEqual(KEY_KINDS, ['custom', 'router'], 'If voice were mixed in, it would become a selectable chat source in ai.json');
  const sealed = sealKey('sk-abc', 'voice');
  assert.match(sealed, /^PCVOC1\./);
  assert.equal(openKey(sealed, 'voice'), 'sk-abc');
  assert.equal(openKey(sealed, 'custom'), '', 'Decrypting the voiceover ciphertext through the chat path must give an empty string');
});

// ── Settings ─────────────────────────────────────────────────
test('The default is MiniMax speech-2.8-hd, with no API Key', () => {
  const c = readVoiceConfig();
  assert.equal(c.provider, 'minimax');
  assert.equal(c.minimax.model, 'speech-2.8-hd');
  assert.equal(c.apiKey, '');
});

test('Writing settings: out-of-range values are clamped back, the API Key goes only into the encrypted file, and only the last four characters are exposed externally', () => {
  const c = writeVoiceConfig({ apiKey: 'sk-secret-9876', provider: 'kling', minimax: { speed: 9, emotion: 'nope' }, kling: { speed: 0.1 } });
  assert.equal(c.provider, 'kling');
  assert.equal(c.minimax.speed, 2);
  assert.equal(c.minimax.emotion, '');
  assert.equal(c.kling.speed, 0.8);
  assert.equal(c.minimax.model, 'speech-2.8-hd', 'A partial update must not wipe out fields it did not mention');
  const onDisk = fs.readFileSync(voiceKeyPath(), 'utf8');
  assert.match(onDisk, /^PCVOC1\./);
  assert.ok(!onDisk.includes('sk-secret'));
  assert.ok(!fs.readFileSync(voiceConfigPath(), 'utf8').includes('sk-secret'), 'voice.json must not contain an API Key');
  assert.deepEqual(publicVoiceConfig().apiKey, { set: true, last4: '9876' });
  assert.equal(writeVoiceConfig({ apiKey: '' }).apiKey, 'sk-secret-9876', 'An empty string leaves the API Key alone');
  assert.equal(clearVoiceKey().apiKey, '');
  writeVoiceConfig({ provider: 'minimax' });
});

test('An unknown service falls back to the default; a broken API URL is treated as unset (following the API settings)', () => {
  const c = normalizeVoiceConfig({ provider: 'elevenlabs', baseUrl: 'javascript:alert(1)' });
  assert.equal(c.provider, 'minimax');
  assert.equal(c.baseUrl, '');
});

test('The Key follows the API\'s mechanism: it lands in keys/voice.key managed by ai-config', () => {
  assert.equal(voiceKeyPath(), keyFilePath('voice'));
  assert.equal(path.dirname(voiceKeyPath()), path.join(dir, 'keys'));
});

test('An empty API URL follows the API settings (the protocol + host of the custom path); a filled-in one uses its own value', () => {
  assert.equal(readVoiceConfig().effectiveBaseUrl, '', 'It is empty when the API settings are not filled in either');
  writeConfig({ api: { baseUrl: 'https://api.example.com/v1' } });
  assert.equal(apiOrigin(), 'https://api.example.com');
  assert.equal(readVoiceConfig().effectiveBaseUrl, 'https://api.example.com');
  assert.equal(writeVoiceConfig({ baseUrl: 'https://voice.example.com/' }).effectiveBaseUrl, 'https://voice.example.com');
  writeVoiceConfig({ baseUrl: '' });
});

test('My voices: add, remove, deduplicate', () => {
  addCustomVoice({ provider: 'minimax', voiceId: 'pcVideoMale1789119355225', name: 'Video vocals', kind: 'clone' });
  addCustomVoice({ provider: 'minimax', voiceId: 'pcVideoMale1789119355225', name: 'Renamed', kind: 'clone' });
  let list = readVoiceConfig().customVoices;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Renamed');
  list = removeCustomVoice('minimax', 'pcVideoMale1789119355225').customVoices;
  assert.equal(list.length, 0);
});

// ── Requests for three providers ─────────────────────────────────────
test('MiniMax: t2a_v2 request shape, hex decoding', async () => {
  const f = fakeFetch(json({ data: { audio: '494433' }, extra_info: { usage_characters: 5 }, base_resp: { status_code: 0 } }));
  const r = await synthesize(ctx(f), { provider: 'minimax', text: 'Hello.', voiceId: 'female-shaonv', model: 'speech-2.8-hd', speed: 1.2, emotion: 'calm' });
  assert.equal(r.buf.toString('latin1'), 'ID3');
  assert.equal(r.chars, 5);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://gw.test/minimax/v1/t2a_v2');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'speech-2.8-hd');
  assert.equal(body.output_format, 'hex');
  assert.deepEqual(body.voice_setting, { voice_id: 'female-shaonv', speed: 1.2, vol: 1, pitch: 0, emotion: 'calm' });
});

test('MiniMax business errors (base_resp non-zero) must be reported', async () => {
  const f = fakeFetch(json({ base_resp: { status_code: 2013, status_msg: 'voice_id does not exist' } }));
  await assert.rejects(synthesize(ctx(f), { provider: 'minimax', text: 'x', voiceId: 'nope' }), /voice_id does not exist/);
});

test('Kling: get the url, then download', async () => {
  const f = fakeFetch(
    json({ code: 0, data: { task_result: { audios: [{ url: 'https://cdn.test/a.mp3' }] } } }),
    new Response(Buffer.from('ID3kling')),
  );
  const r = await synthesize(ctx(f), { provider: 'kling', text: 'Hello', voiceId: 'ai_kaiya', speed: 1 });
  assert.equal(r.buf.toString(), 'ID3kling');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'Hello', voice_id: 'ai_kaiya', voice_language: 'zh', voice_speed: 1 });
  assert.equal(f.calls[1].url, 'https://cdn.test/a.mp3');
});

test('Vidu: parameters are written as strings, as the API requires', async () => {
  const f = fakeFetch(json({ state: 'success', file_url: 'https://oss.test/v.mp3' }), new Response(Buffer.from('ID3vidu')));
  await synthesize(ctx(f), { provider: 'vidu', text: 'Hello', voiceId: 'male-qn-jingying', speed: 1.5, volume: 2, pitch: -3, emotion: 'happy' });
  assert.equal(f.calls[0].url, 'https://gw.test/ent/v2/audio-tts');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    text: 'Hello', voice_setting_voice_id: 'male-qn-jingying', voice_setting_speed: '1.5',
    voice_setting_volume: '2', voice_setting_pitch: '-3', voice_setting_emotion: 'happy',
  });
});

test('Quota exhaustion is translated into plain language, without naming which relay service', async () => {
  const f = fakeFetch(new Response('{"error":{"message":"Token quota exhausted"}}', { status: 401 }));
  await assert.rejects(synthesize(ctx(f), { provider: 'minimax', text: 'x', voiceId: 'female-shaonv' }), (e) => e instanceof VoiceError && /run out of quota/.test(e.message) && !/openlux/i.test(e.message));
});

test('No API Key, no API URL, or overlong text are all blocked before the request is sent', async () => {
  const f = fakeFetch();
  await assert.rejects(synthesize({ baseUrl: 'https://gw.test', apiKey: '', fetch: f }, { provider: 'minimax', text: 'x', voiceId: 'a' }), /No API key for voiceover yet/);
  await assert.rejects(synthesize({ baseUrl: '', apiKey: 'sk-test', fetch: f }, { provider: 'minimax', text: 'x', voiceId: 'a' }), /No API address/);
  await assert.rejects(synthesize(ctx(f), { provider: 'kling', text: 'x'.repeat(1001), voiceId: 'ai_kaiya' }), /1000/);
  assert.equal(f.calls.length, 0);
});

// ── Voice whitelist + persistence ────────────────────────────────────
test('A voice that has not been registered sends no request: this prevents being charged ¥9.9 on the first synthesis', async () => {
  const cfg = { ...readVoiceConfig(), apiKey: 'sk-test' };
  const f = fakeFetch();
  await assert.rejects(generateVoice({ cfg, args: { text: 'Hello', voiceId: 'someoneElsesVoice01' }, outDir: dir, fetch: f }), /is not in the available list for minimax/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => resolveOptions(cfg, { text: 'x', provider: 'kling', speed: 0.5 }), /0.8~2/);
});

test('A registered cloned voice can be used; the file is written to the asset catalog, and the preview uses a fixed file name', async () => {
  const cfg = { ...readVoiceConfig(), apiKey: 'sk-test', effectiveBaseUrl: 'https://gw.test', customVoices: [{ provider: 'minimax', voiceId: 'pcVideoMale1789119355225', name: 'x', kind: 'clone', createdAt: '', note: '' }] };
  const out = path.join(dir, 'media');
  const ok = () => json({ data: { audio: '494433' }, base_resp: { status_code: 0 } });
  const r = await generateVoice({ cfg, args: { text: '开场旁白：你好', voiceId: 'pcVideoMale1789119355225' }, outDir: out, fetch: fakeFetch(ok()) });
  assert.match(r.name, /^voice-\d{8}-\d{6}-开场旁白你好-[0-9a-f]{4}\.mp3$/);
  assert.equal(r.url, `/@media/${encodeURIComponent(r.name)}`);
  assert.equal(fs.readFileSync(r.path, 'latin1'), 'ID3');
  const p = await generateVoice({ cfg, args: { text: 'Preview' }, outDir: out, fetch: fakeFetch(ok()), preview: true });
  assert.equal(p.name, 'voice-preview-minimax.mp3');
});

// ── Design / clone ──────────────────────────────────────────
test('Voice design: returns a new id and a preview', async () => {
  const f = fakeFetch(json({ voice_id: 'ttv-voice-1', trial_audio: '494433', base_resp: { status_code: 0 } }));
  const r = await designVoice(ctx(f), { prompt: 'Young male voice', previewText: 'Hello' });
  assert.equal(r.voiceId, 'ttv-voice-1');
  assert.equal(r.trial.toString('latin1'), 'ID3');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { prompt: 'Young male voice', preview_text: 'Hello', aigc_watermark: false });
});

test('Clone: upload as voice_clone first, then use the file_id to create the voice; an invalid id is rejected outright', async () => {
  await assert.rejects(cloneVoice(ctx(fakeFetch()), { audio: Buffer.from('x'), voiceId: '1bad' }), /start with a letter/);
  const f = fakeFetch(
    json({ file: { file_id: 440592067436945 }, base_resp: { status_code: 0 } }),
    json({ demo_audio: '494433', base_resp: { status_code: 0 } }),
  );
  const r = await cloneVoice(ctx(f), { audio: Buffer.from('RIFF'), voiceId: 'pcVoiceTest001', previewText: 'Hello' });
  assert.equal(f.calls[0].url, 'https://gw.test/minimax/v1/files');
  assert.ok(f.calls[0].init.body instanceof FormData);
  assert.equal(f.calls[0].init.body.get('purpose'), 'voice_clone');
  assert.equal(f.calls[0].init.headers['Content-Type'], undefined, 'Let fetch fill in the multipart boundary itself');
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.file_id, 440592067436945);
  assert.equal(body.voice_id, 'pcVoiceTest001');
  assert.equal(body.text, 'Hello');
  assert.equal(r.demo.toString('latin1'), 'ID3');
});

// ── Submittable voice manifest ───────────────────────────────────────
test('fixtures/voices.json: only voice ids, no API Key', () => {
  const raw = fs.readFileSync(new URL('./fixtures/voices.json', import.meta.url), 'utf8');
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw), 'An API Key must not go into the repository');
  const v = JSON.parse(raw);
  for (const c of v.minimax.clone) assert.ok(isCloneIdShape(c.voiceId), c.voiceId);
  for (const d of [...v.minimax.design, ...v.kling.official]) assert.ok(isVoiceIdShape(d.voiceId), d.voiceId);
});
