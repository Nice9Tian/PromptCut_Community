/**
 * 云端 Agent 的音效合成(`server/agent/service/hosted-sound.mjs`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4a 节)。
 * 跑:node scripts/test-suite.mjs server/test/cloud-agent-sound.test.mjs
 *
 *   CA-SND-01  提示音与键盘声:云端合成出的 WAV 与桌面版入口(`renderSoundEffectWavInWorker`)同一份配方合成的**逐样本相同**,
 *              内容哈希与钉死的值相同;项目里多了素材(带配方与内容哈希)与片段(带配方、requestId、落点);
 *              键盘声给 sourceClipId 时复用打字机卡片的文字与节奏,落在同一个起点
 *   CA-SND-02  幂等、取消、过期、只读、上限:同一个 requestId 重试不再合成、不多出片段;同一个 requestId 换配方被拒;
 *              只读成员在合成之前就被拒(不合成、不上传);取消后不上传、不提交;合成期间片段被改,旧结果不应用;
 *              队列满了拒;失败原因带回
 *   CA-SND-03  作业表按实例分:另一个实例(别的项目或别的成员)看不到、取消不了这边的作业;作业号不是顺序号
 *   CA-SND-04  进程级的合成名额:两个实例同时合成时不重叠;排队时取消不占名额
 *
 * 不出网;素材服务与文档服务是替身(真的链路由 `scripts/probes/cloud-agent-sound-probe.mjs` 对着托管组合验)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createVite } from 'vite';
import { createSlot, createSoundTools, newSoundState } from '../agent/service/hosted-sound.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { ROOT } from './cloud-agent-kit.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
class ToolError extends Error {}

const typingClip = { id: 'typing', cardId: 'mu-typing', start: 2, end: 6, params: { text: '你好,PromptCut!\nok', duration: 90, delayMs: 100, seed: 7 }, label: '打字' };
const baseProject = (id = 'p-snd') => ({
  version: 1, id, name: '音效', width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
  tracks: [{ id: 't1', name: '序列 1', clips: [structuredClone(typingClip)] }], transitions: [],
});

async function setup(t) {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  const host = await loadSsrHost((id) => vite.ssrLoadModule(id));
  const desktop = await vite.ssrLoadModule('/src/audio/soundGenerationWorkerClient.ts');
  const slot = createSlot();
  /** 一个实例的替身:项目副本、素材服务、文档服务的提交 */
  function instance(projectId, { readOnly = false, putDelayMs = 0, renderHook = null } = {}) {
    const st = { project: baseProject(projectId), puts: [], commits: 0, usage: [], state: newSoundState(), beforeCommit: null };
    const h = renderHook ? { ...host, sound: { ...host.sound, renderWav: (recipe, o) => renderHook(recipe, o, host.sound.renderWav) } } : host;
    st.tools = createSoundTools({
      state: st.state, slot, host: async () => h,
      snapshot: async () => ({ project: st.project }),
      mutate: async (_track, apply) => {
        st.beforeCommit?.();
        host.resetStore();
        host.setProject(st.project);
        try { await apply(host); st.project = host.getProject(); st.commits += 1; } finally { host.clearProject(); }
      },
      ensureCanWrite: async () => { if (readOnly) throw new ToolError('你在这个项目里只有只读权限,云端 Agent 不能替你把素材写进项目。'); },
      put: async (wav) => {
        if (putDelayMs) await new Promise((r) => setTimeout(r, putDelayMs));
        const copy = Buffer.from(wav);
        st.puts.push(copy);
        return { hash: sha256(copy), size: copy.length };
      },
      record: (row) => st.usage.push(row),
      ToolError,
    });
    return st;
  }
  return { host, desktop, instance };
}

const clipsOf = (p) => p.tracks.flatMap((tr) => tr.clips);

test('CA-SND-01 云端合成的 WAV 与桌面版同配方逐样本相同;素材、配方、片段原子登记', { timeout: 120_000 }, async (t) => {
  const { host, desktop, instance } = await setup(t);
  const a = instance('p-snd');

  // 提示音:放在 1 秒处
  const chime = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'chime-1', name: '叮', params: { frequency: 660, notes: [0, 4, 7] }, seed: 3 });
  assert.equal(chime.ok, true, JSON.stringify(chime));
  assert.equal(chime.state, 'succeeded');
  assert.match(chime.jobId, /^sound-[a-f0-9]{12}$/);
  const media1 = a.project.media.find((m) => m.id === chime.result.mediaId);
  const clip1 = clipsOf(a.project).find((c) => c.id === chime.result.clipId);
  assert.ok(media1 && clip1);
  assert.equal(media1.kind, 'audio');
  assert.equal(media1.name, '叮.wav');
  assert.equal(media1.ext, 'wav');
  assert.equal(media1.hash, sha256(a.puts[0]), '素材条目里的内容哈希就是写进素材服务的那份字节的哈希');
  assert.equal(media1.url, `/@media/${media1.hash}`);
  assert.equal(media1.size, a.puts[0].length);
  assert.equal(clip1.start, 1);
  assert.equal(clip1.mediaId, media1.id);
  assert.equal(clip1.soundEffect.requestId, 'chime-1');
  assert.deepEqual(clip1.soundEffect.recipe, media1.soundEffect.recipe);
  assert.match(clip1.soundEffect.reuseKey, /^sound-effect-sha256:[a-f0-9]{64}$/);
  assert.equal(media1.duration, media1.soundEffect.recipe.frames / media1.soundEffect.recipe.sampleRate);

  // 与桌面版的入口同一份配方:逐样本相同(桌面版在 Worker 里跑的是同一个函数;这里是它在没有 Worker 的环境下的同一条路)
  const desk1 = Buffer.from(await desktop.renderSoundEffectWavInWorker(structuredClone(media1.soundEffect.recipe)));
  assert.equal(desk1.length, a.puts[0].length);
  assert.ok(desk1.equals(a.puts[0]), '提示音:云端与桌面版逐字节相同');
  // 配方本身也与桌面版从同一组参数算出来的相同
  const planned = host.sound.plan(baseProject('p-snd'), { preset: 'notification', start: 1, requestId: 'x', params: { frequency: 660, notes: [0, 4, 7] }, seed: 3 });
  assert.deepEqual(planned.recipe, media1.soundEffect.recipe);
  assert.equal(a.puts[0].toString('latin1', 0, 4), 'RIFF');
  assert.equal(a.puts[0].readUInt16LE(20), 1, 'PCM');
  assert.equal(a.puts[0].readUInt16LE(34), 16, '16 位');
  let nonzero = 0;
  for (let i = 44; i < a.puts[0].length; i += 2) if (a.puts[0].readInt16LE(i) !== 0) nonzero += 1;
  assert.ok(nonzero > 1000, '不是一段静音');

  // 键盘声:复用打字机卡片的文字与节奏,落在它的起点
  const keys = await a.tools.sound_generate({ preset: 'keyboard', sourceClipId: 'typing', requestId: 'keys-1' });
  assert.equal(keys.ok, true, JSON.stringify(keys));
  const media2 = a.project.media.find((m) => m.id === keys.result.mediaId);
  const clip2 = clipsOf(a.project).find((c) => c.id === keys.result.clipId);
  assert.equal(clip2.start, typingClip.start, '落在打字机卡片的起点');
  assert.ok(clip2.end <= typingClip.end + 1e-9);
  assert.equal(clip2.soundEffect.sourceClipId, 'typing');
  assert.equal(media2.soundEffect.recipe.preset, 'keyboard');
  assert.ok(media2.soundEffect.recipe.events.length >= 10, '每个字一个事件');
  const desk2 = Buffer.from(await desktop.renderSoundEffectWavInWorker(structuredClone(media2.soundEffect.recipe)));
  assert.ok(desk2.equals(a.puts[1]), '键盘声:云端与桌面版逐字节相同');

  // 钉死的内容哈希:Node 或合成内核变了、与已经入库的旧素材不再相同时,这里先红
  const pinned = { chime: sha256(a.puts[0]), keys: sha256(a.puts[1]) };
  console.log('CA-SND-01', JSON.stringify({ ...pinned, chimeBytes: a.puts[0].length, keysBytes: a.puts[1].length }));
  assert.deepEqual(pinned, PINNED);

  // 只进素材库(不传 start):有素材、没有片段
  const lib = await a.tools.sound_generate({ preset: 'notification', requestId: 'lib-1' });
  assert.equal(lib.ok, true);
  assert.equal(lib.result.clipId, undefined);
  assert.ok(a.project.media.some((m) => m.id === lib.result.mediaId));

  // 用量:每次合成一行,按字节
  assert.deepEqual(a.usage.map((u) => [u.service, u.vendor, u.model, u.unit, u.ok]), [
    ['sound', 'builtin', 'notification', 'bytes', true], ['sound', 'builtin', 'keyboard', 'bytes', true], ['sound', 'builtin', 'notification', 'bytes', true],
  ]);
  assert.equal(a.usage[0].units, a.puts[0].length);
});

/** CA-SND-01 钉死的内容哈希(同一份配方在桌面版的浏览器里合成出来也是它:`cloud-agent-sound-probe` 的 S4 对着真浏览器比) */
const PINNED = { chime: '9af90898ad856b9a7a04f92d1e7dcdd01630af09b6b1e2d9bb1736de02321772', keys: '649e4ac2176e651b3dce41d41a2b57732ea96c58a0877154a698b4701db4d078' };

test('CA-SND-02 幂等、取消、过期、只读、上限', { timeout: 120_000 }, async (t) => {
  const { instance, host } = await setup(t);

  await t.test('同一个 requestId 重试:不再合成、不多出片段;换配方被拒', async () => {
    const a = instance('p-idem');
    const first = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'r1' });
    const again = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'r1' });
    assert.equal(again.jobId, first.jobId);
    assert.deepEqual(again.result, first.result);
    assert.equal(a.puts.length, 1);
    assert.equal(clipsOf(a.project).filter((c) => c.soundEffect).length, 1);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'r1', params: { frequency: 990 } }), /requestId 已用于不同配方/);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', start: 1 }), /requestId/);
    await assert.rejects(a.tools.sound_generate({ preset: 'keyboard', requestId: 'k0' }), /键盘声需要/);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', start: 99, requestId: 'far' }), /start 必须在项目时间范围内/);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', requestId: 'big', params: { duration: 1e9 } }), ToolError);
  });

  await t.test('只读成员:合成之前就被拒,不合成、不上传、项目不变', async () => {
    let rendered = 0;
    const ro = instance('p-ro', { readOnly: true, renderHook: (r, o, real) => { rendered += 1; return real(r, o); } });
    const before = JSON.stringify(ro.project);
    await assert.rejects(ro.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'ro-1' }), /只读/);
    assert.equal(rendered, 0);
    assert.equal(ro.puts.length, 0);
    assert.equal(JSON.stringify(ro.project), before);
    assert.deepEqual((await ro.tools.sound_status({})).jobs, []);
  });

  await t.test('取消:合成中取消,不上传、不提交;旧音效不动', async () => {
    let started;
    const waitStart = new Promise((r) => { started = r; });
    const a = instance('p-cancel', { renderHook: async (recipe, o, real) => { started(); await new Promise((r) => setTimeout(r, 150)); return real(recipe, o); } });
    const pending = a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'c1' });
    await waitStart;
    const { jobs } = await a.tools.sound_status({});
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, 'rendering');
    const cancelled = await a.tools.sound_cancel({ jobId: jobs[0].jobId });
    assert.equal(cancelled.state, 'cancelled');
    const out = await pending;
    assert.deepEqual([out.ok, out.state, out.error], [false, 'cancelled', '已取消,原音效保持不变']);
    assert.equal(a.puts.length, 0);
    assert.equal(a.commits, 0);
    assert.equal(a.project.media.length, 0);
    // 取消过的 requestId 可以重来
    const redo = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'c1' });
    assert.equal(redo.ok, true);
    await assert.rejects(a.tools.sound_cancel({ jobId: 'sound-nope' }), /找不到音效任务/);
    await assert.rejects(a.tools.sound_status({ jobId: 'sound-nope' }), /找不到音效任务/);
  });

  await t.test('过期:合成期间来源片段被改,旧结果不应用;重生成时目标片段被改同理', async () => {
    const a = instance('p-stale');
    a.beforeCommit = () => {
      a.project = { ...a.project, tracks: a.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === 'typing' ? { ...c, params: { ...c.params, text: '改了' } } : c)) })) };
      a.beforeCommit = null;
    };
    const out = await a.tools.sound_generate({ preset: 'keyboard', sourceClipId: 'typing', requestId: 's1' });
    assert.deepEqual([out.ok, out.state], [false, 'stale'], JSON.stringify(out));
    assert.match(out.error, /已改变/);
    assert.equal(a.project.media.length, 0, '素材已经上传,但没有登记进项目');
    assert.equal(clipsOf(a.project).filter((c) => c.soundEffect).length, 0);

    const ok = await a.tools.sound_generate({ preset: 'notification', start: 8, requestId: 's2' });
    assert.equal(ok.ok, true);
    a.beforeCommit = () => {
      a.project = { ...a.project, tracks: a.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === ok.result.clipId ? { ...c, audioVolume: 0.5 } : c)) })) };
      a.beforeCommit = null;
    };
    const regen = await a.tools.sound_generate({ clipId: ok.result.clipId, params: { frequency: 440 }, requestId: 's3' });
    assert.deepEqual([regen.ok, regen.state], [false, 'stale']);
    const kept = clipsOf(a.project).find((c) => c.id === ok.result.clipId);
    assert.equal(kept.mediaId, ok.result.mediaId, '旧音效保持不变');
    // 没有被改时重生成:同一个片段换了素材,位置不变
    const regen2 = await a.tools.sound_generate({ clipId: ok.result.clipId, params: { frequency: 440 }, requestId: 's4' });
    assert.equal(regen2.ok, true, JSON.stringify(regen2));
    assert.equal(regen2.result.clipId, ok.result.clipId);
    const after = clipsOf(a.project).find((c) => c.id === ok.result.clipId);
    assert.notEqual(after.mediaId, ok.result.mediaId);
    assert.deepEqual([after.start, after.audioVolume, after.soundEffect.recipe.params.frequency], [8, 0.5, 440]);
  });

  await t.test('上限:一位成员在一个项目里最多排 4 个;上传失败带回原因', async () => {
    const gate = { open: null };
    const hold = new Promise((r) => { gate.open = r; });
    const a = instance('p-queue', { renderHook: async (recipe, o, real) => { await hold; return real(recipe, o); } });
    const running = [0, 1, 2, 3].map((i) => a.tools.sound_generate({ preset: 'notification', requestId: `q${i}`, params: { frequency: 400 + i } }));
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', requestId: 'q4', params: { frequency: 500 } }), /队列已满/);
    gate.open();
    assert.deepEqual((await Promise.all(running)).map((r) => r.state), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);

    const b = instance('p-fail');
    const failing = createSoundTools({
      state: newSoundState(), slot: createSlot(), host: async () => host,
      snapshot: async () => ({ project: b.project }), mutate: async () => { throw new Error('不该走到提交'); },
      ensureCanWrite: async () => {}, put: async () => { throw new Error('素材服务拒绝了这次写入(413)'); }, record: (row) => b.usage.push(row), ToolError,
    });
    const out = await failing.sound_generate({ preset: 'notification', start: 1, requestId: 'f1' });
    assert.deepEqual([out.ok, out.state], [false, 'failed']);
    assert.match(out.error, /413/);
    assert.equal(b.usage[0].ok, false);
  });
});

test('CA-SND-03 / CA-SND-04 作业表按实例分;合成在进程里同时只跑一个', { timeout: 120_000 }, async (t) => {
  const { instance } = await setup(t);
  let active = 0;
  let peak = 0;
  const hook = async (recipe, o, real) => {
    active += 1; peak = Math.max(peak, active);
    try { await new Promise((r) => setTimeout(r, 60)); return await real(recipe, o); } finally { active -= 1; }
  };
  const a = instance('p-a', { renderHook: hook });
  const b = instance('p-b', { renderHook: hook });
  const pa = a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'a1' });
  const pb = b.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'b1' });
  const pb2 = b.tools.sound_generate({ preset: 'notification', start: 3, requestId: 'b2', params: { frequency: 700 } });
  await new Promise((r) => setTimeout(r, 20));
  const ja = (await a.tools.sound_status({})).jobs;
  const jb = (await b.tools.sound_status({})).jobs;
  assert.equal(ja.length, 1);
  assert.equal(jb.length, 2);
  assert.ok(ja.every((j) => /^sound-[a-f0-9]{12}$/.test(j.jobId)), '作业号带随机数,不是顺序号');
  // 乙实例看不到、查不到、取消不了甲实例的作业
  assert.equal(jb.some((j) => j.jobId === ja[0].jobId), false);
  await assert.rejects(b.tools.sound_status({ jobId: ja[0].jobId }), /找不到音效任务/);
  await assert.rejects(b.tools.sound_cancel({ jobId: ja[0].jobId }), /找不到音效任务/);
  // 排队中的取消:不占名额、不合成
  const queued = jb.find((j) => j.state === 'queued');
  assert.ok(queued, '乙的第二个在排队');
  assert.equal((await b.tools.sound_cancel({ jobId: queued.jobId })).state, 'cancelled');
  const [ra, rb, rb2] = await Promise.all([pa, pb, pb2]);
  assert.deepEqual([ra.state, rb.state, rb2.state].sort(), ['cancelled', 'succeeded', 'succeeded']);
  assert.equal(peak, 1, '两个实例的合成没有重叠');
  assert.equal(a.project.id, 'p-a');
  assert.equal(a.project.media.length, 1);
  assert.equal(b.project.media.length, 1);
});
