// 配音(voice_generate):设置落盘、API Key 加密、三家请求的形状、音色白名单、复刻流程。
// 全部用假 fetch,不花钱。真实合成见 voice-smoke.mjs(手动跑)。
// 跑法:node --test server/test/voice.test.mjs
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

/** 按顺序回放响应的假 fetch,顺手记下每次请求 */
function fakeFetch(...responses) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const r = responses[calls.length - 1];
    if (!r) throw new Error(`多出来的请求: ${url}`);
    return typeof r === 'function' ? r(url, init) : r;
  };
  f.calls = calls;
  return f;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const ctx = (fetch) => ({ baseUrl: 'https://gw.test', apiKey: 'sk-test', fetch });

// ── API Key 加密 ─────────────────────────────────────────────
test('voice 那把 API Key 有自己的封装,且不是对话 API 的合法来源', () => {
  assert.deepEqual(KEY_KINDS, ['custom', 'router'], 'voice 混进来就成了 ai.json 里能选的对话来源');
  const sealed = sealKey('sk-abc', 'voice');
  assert.match(sealed, /^PCVOC1\./);
  assert.equal(openKey(sealed, 'voice'), 'sk-abc');
  assert.equal(openKey(sealed, 'custom'), '', '拿对话那一路解配音的密文必须是空串');
});

// ── 设置 ─────────────────────────────────────────────────
test('默认是 MiniMax speech-2.8-hd,没有 API Key', () => {
  const c = readVoiceConfig();
  assert.equal(c.provider, 'minimax');
  assert.equal(c.minimax.model, 'speech-2.8-hd');
  assert.equal(c.apiKey, '');
});

test('写设置:越界夹回、API Key 只进加密文件、对外只露后四位', () => {
  const c = writeVoiceConfig({ apiKey: 'sk-secret-9876', provider: 'kling', minimax: { speed: 9, emotion: 'nope' }, kling: { speed: 0.1 } });
  assert.equal(c.provider, 'kling');
  assert.equal(c.minimax.speed, 2);
  assert.equal(c.minimax.emotion, '');
  assert.equal(c.kling.speed, 0.8);
  assert.equal(c.minimax.model, 'speech-2.8-hd', '局部更新不能把没提的字段冲掉');
  const onDisk = fs.readFileSync(voiceKeyPath(), 'utf8');
  assert.match(onDisk, /^PCVOC1\./);
  assert.ok(!onDisk.includes('sk-secret'));
  assert.ok(!fs.readFileSync(voiceConfigPath(), 'utf8').includes('sk-secret'), 'voice.json 里不能有 API Key');
  assert.deepEqual(publicVoiceConfig().apiKey, { set: true, last4: '9876' });
  assert.equal(writeVoiceConfig({ apiKey: '' }).apiKey, 'sk-secret-9876', '空串不动 API Key');
  assert.equal(clearVoiceKey().apiKey, '');
  writeVoiceConfig({ provider: 'minimax' });
});

test('不认识的服务退回默认;坏掉的 API 地址当没填(跟随 API 设置)', () => {
  const c = normalizeVoiceConfig({ provider: 'elevenlabs', baseUrl: 'javascript:alert(1)' });
  assert.equal(c.provider, 'minimax');
  assert.equal(c.baseUrl, '');
});

test('Key 走 API 那一套:落在 ai-config 管的 keys/voice.key', () => {
  assert.equal(voiceKeyPath(), keyFilePath('voice'));
  assert.equal(path.dirname(voiceKeyPath()), path.join(dir, 'keys'));
});

test('API 地址留空跟随 API 设置(自定义那一路的协议 + 主机);自己填了用自己的', () => {
  assert.equal(readVoiceConfig().effectiveBaseUrl, '', 'API 设置也没填时就是空的');
  writeConfig({ api: { baseUrl: 'https://api.example.com/v1' } });
  assert.equal(apiOrigin(), 'https://api.example.com');
  assert.equal(readVoiceConfig().effectiveBaseUrl, 'https://api.example.com');
  assert.equal(writeVoiceConfig({ baseUrl: 'https://voice.example.com/' }).effectiveBaseUrl, 'https://voice.example.com');
  writeVoiceConfig({ baseUrl: '' });
});

test('我的音色:增删、去重', () => {
  addCustomVoice({ provider: 'minimax', voiceId: 'pcVideoMale1789119355225', name: '视频人声', kind: 'clone' });
  addCustomVoice({ provider: 'minimax', voiceId: 'pcVideoMale1789119355225', name: '改个名', kind: 'clone' });
  let list = readVoiceConfig().customVoices;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '改个名');
  list = removeCustomVoice('minimax', 'pcVideoMale1789119355225').customVoices;
  assert.equal(list.length, 0);
});

// ── 三家请求 ─────────────────────────────────────────────
test('MiniMax:t2a_v2 请求形状、hex 解码', async () => {
  const f = fakeFetch(json({ data: { audio: '494433' }, extra_info: { usage_characters: 5 }, base_resp: { status_code: 0 } }));
  const r = await synthesize(ctx(f), { provider: 'minimax', text: '你好。', voiceId: 'female-shaonv', model: 'speech-2.8-hd', speed: 1.2, emotion: 'calm' });
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

test('MiniMax 业务错误(base_resp 非 0)要报出来', async () => {
  const f = fakeFetch(json({ base_resp: { status_code: 2013, status_msg: 'voice_id 不存在' } }));
  await assert.rejects(synthesize(ctx(f), { provider: 'minimax', text: 'x', voiceId: 'nope' }), /voice_id 不存在/);
});

test('可灵:拿到 url 再下载', async () => {
  const f = fakeFetch(
    json({ code: 0, data: { task_result: { audios: [{ url: 'https://cdn.test/a.mp3' }] } } }),
    new Response(Buffer.from('ID3kling')),
  );
  const r = await synthesize(ctx(f), { provider: 'kling', text: '你好', voiceId: 'ai_kaiya', speed: 1 });
  assert.equal(r.buf.toString(), 'ID3kling');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: '你好', voice_id: 'ai_kaiya', voice_language: 'zh', voice_speed: 1 });
  assert.equal(f.calls[1].url, 'https://cdn.test/a.mp3');
});

test('Vidu:参数按接口要求写成字符串', async () => {
  const f = fakeFetch(json({ state: 'success', file_url: 'https://oss.test/v.mp3' }), new Response(Buffer.from('ID3vidu')));
  await synthesize(ctx(f), { provider: 'vidu', text: '你好', voiceId: 'male-qn-jingying', speed: 1.5, volume: 2, pitch: -3, emotion: 'happy' });
  assert.equal(f.calls[0].url, 'https://gw.test/ent/v2/audio-tts');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    text: '你好', voice_setting_voice_id: 'male-qn-jingying', voice_setting_speed: '1.5',
    voice_setting_volume: '2', voice_setting_pitch: '-3', voice_setting_emotion: 'happy',
  });
});

test('额度用完翻成人话,且不提具体哪家中转', async () => {
  const f = fakeFetch(new Response('{"error":{"message":"Token quota exhausted"}}', { status: 401 }));
  await assert.rejects(synthesize(ctx(f), { provider: 'minimax', text: 'x', voiceId: 'female-shaonv' }), (e) => e instanceof VoiceError && /额度用完/.test(e.message) && !/openlux/i.test(e.message));
});

test('没 API Key、没 API 地址、文字超长,都在发请求之前拦下', async () => {
  const f = fakeFetch();
  await assert.rejects(synthesize({ baseUrl: 'https://gw.test', apiKey: '', fetch: f }, { provider: 'minimax', text: 'x', voiceId: 'a' }), /API Key/);
  await assert.rejects(synthesize({ baseUrl: '', apiKey: 'sk-test', fetch: f }, { provider: 'minimax', text: 'x', voiceId: 'a' }), /API 地址/);
  await assert.rejects(synthesize(ctx(f), { provider: 'kling', text: '字'.repeat(1001), voiceId: 'ai_kaiya' }), /1000/);
  assert.equal(f.calls.length, 0);
});

// ── 音色白名单 + 落盘 ────────────────────────────────────
test('没登记过的音色不发请求:防止第一次合成时被扣 ¥9.9', async () => {
  const cfg = { ...readVoiceConfig(), apiKey: 'sk-test' };
  const f = fakeFetch();
  await assert.rejects(generateVoice({ cfg, args: { text: '你好', voiceId: 'someoneElsesVoice01' }, outDir: dir, fetch: f }), /不在 minimax 的可用列表里/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => resolveOptions(cfg, { text: 'x', provider: 'kling', speed: 0.5 }), /0.8~2/);
});

test('登记过的复刻音色能用;文件写进素材目录,试听用固定文件名', async () => {
  const cfg = { ...readVoiceConfig(), apiKey: 'sk-test', effectiveBaseUrl: 'https://gw.test', customVoices: [{ provider: 'minimax', voiceId: 'pcVideoMale1789119355225', name: 'x', kind: 'clone', createdAt: '', note: '' }] };
  const out = path.join(dir, 'media');
  const ok = () => json({ data: { audio: '494433' }, base_resp: { status_code: 0 } });
  const r = await generateVoice({ cfg, args: { text: '开场旁白：你好', voiceId: 'pcVideoMale1789119355225' }, outDir: out, fetch: fakeFetch(ok()) });
  assert.match(r.name, /^voice-\d{8}-\d{6}-开场旁白你好-[0-9a-f]{4}\.mp3$/);
  assert.equal(r.url, `/@media/${encodeURIComponent(r.name)}`);
  assert.equal(fs.readFileSync(r.path, 'latin1'), 'ID3');
  const p = await generateVoice({ cfg, args: { text: '试听' }, outDir: out, fetch: fakeFetch(ok()), preview: true });
  assert.equal(p.name, 'voice-preview-minimax.mp3');
});

// ── 设计 / 复刻 ──────────────────────────────────────────
test('音色设计:返回新 id 和试听', async () => {
  const f = fakeFetch(json({ voice_id: 'ttv-voice-1', trial_audio: '494433', base_resp: { status_code: 0 } }));
  const r = await designVoice(ctx(f), { prompt: '年轻男声', previewText: '你好' });
  assert.equal(r.voiceId, 'ttv-voice-1');
  assert.equal(r.trial.toString('latin1'), 'ID3');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { prompt: '年轻男声', preview_text: '你好', aigc_watermark: false });
});

test('复刻:先按 voice_clone 上传,再拿 file_id 建音色;id 不合规直接拒', async () => {
  await assert.rejects(cloneVoice(ctx(fakeFetch()), { audio: Buffer.from('x'), voiceId: '1bad' }), /字母开头/);
  const f = fakeFetch(
    json({ file: { file_id: 440592067436945 }, base_resp: { status_code: 0 } }),
    json({ demo_audio: '494433', base_resp: { status_code: 0 } }),
  );
  const r = await cloneVoice(ctx(f), { audio: Buffer.from('RIFF'), voiceId: 'pcVoiceTest001', previewText: '你好' });
  assert.equal(f.calls[0].url, 'https://gw.test/minimax/v1/files');
  assert.ok(f.calls[0].init.body instanceof FormData);
  assert.equal(f.calls[0].init.body.get('purpose'), 'voice_clone');
  assert.equal(f.calls[0].init.headers['Content-Type'], undefined, 'multipart 的边界要让 fetch 自己填');
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.file_id, 440592067436945);
  assert.equal(body.voice_id, 'pcVoiceTest001');
  assert.equal(body.text, '你好');
  assert.equal(r.demo.toString('latin1'), 'ID3');
});

// ── 可提交的音色清单 ─────────────────────────────────────
test('fixtures/voices.json:只有音色 id,没有 API Key', () => {
  const raw = fs.readFileSync(new URL('./fixtures/voices.json', import.meta.url), 'utf8');
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw), 'API Key 不能进仓库');
  const v = JSON.parse(raw);
  for (const c of v.minimax.clone) assert.ok(isCloneIdShape(c.voiceId), c.voiceId);
  for (const d of [...v.minimax.design, ...v.kling.official]) assert.ok(isVoiceIdShape(d.voiceId), d.voiceId);
});
