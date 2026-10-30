/**
 * 云端 Agent 在服务端实现的工具(`server/agent/service/hosted-tools.mjs`)与用量流水里的外部服务一类。
 * 任务书 `docs/plan/cloud-agent-task.md` J;契约 `docs/plan/cloud-agent-contract.md` 第 9 节。
 * 跑:node scripts/test-suite.mjs server/test/cloud-agent-tools.test.mjs
 *
 *   CA-HT-01  纯函数:文件名收拾、按扩展名认种类、读 PNG / GIF / JPEG / WebP 的宽高、WAV 的时长
 *   CA-HT-02  附件:存进对话工作区的 attachments/ 下,回 `work:` 地址;重名自动改名;带路径的名字写不出去;空文件、超限被拒;
 *             拼进提示词的只有这个对话工作区里真有的文件,小的文本内联,不给磁盘路径
 *   CA-HT-03  建卡改卡(整条链,模拟模型):create_card 把源码放进这个项目的内容库 → 同一轮里 list_cards / add_clip 认得它
 *             → get_card_source 读回 → edit_card 局部替换 → 重复建被拒;审查不过的源码不入库;
 *             卡片的定义只在进锁时临时登记、出锁撤掉;卡片代码没有在服务进程里执行(跨项目由隔离探针 T5 验)
 *   CA-HT-03b remotion 式的卡(`frameMode: "direct"`):云端 Agent 建卡与桌面走同一道检查,违规的被拒并指出行号、不入库;
 *             用框架写的合规的卡入库;改卡时新加违规同样被拒
 *   CA-HT-04  创造力等级:「中」建不了新卡,但能重写这个项目里已有的卡(按项目内容库判有没有)
 *   CA-HT-05  导入素材:没配素材服务时在最前面回明确的原因,不下载(出网闸与素材写入由 CA-EGRESS、CA-ASSET-01 与隔离探针 T1、T3 验)
 *   CA-HT-06  用量:外部服务的调用单记一类,不占 token 额度、不混进模型的调用次数;汇总里按服务与成员单列
 *   CA-HT-07  托管方的配音配置:从数据目录读,令牌是密文落盘;没配回 null
 *
 * 全部不出网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { safeName, kindOfName, extOf, imageSize, wavDuration, saveAttachment, attachmentsPrompt, readHostedVoiceConfig, voiceConfigPaths } from '../agent/service/hosted-tools.mjs';
import { createWorkspaces, WorkspaceError } from '../agent/service/workspace.mjs';
import { createUsageLog, queryUsage } from '../agent/service/usage.mjs';
import { sealKey } from '../runners/config-crypt.mjs';
import { project, script, startKit } from './cloud-agent-kit.mjs';

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-tools-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 留给系统清 */ } });
  return dir;
};
const OWNER = 'c'.repeat(32);

test('CA-HT-01 纯函数:文件名、种类、图片宽高、WAV 时长', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Windows\\win.ini'), 'win.ini');
  assert.equal(safeName('a<b>:c|d?.png'), 'a_b__c_d_.png');
  assert.equal(safeName('...'), 'file');
  assert.equal(safeName('  .hidden.txt. '), 'hidden.txt');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('片头 素材.MP4'), '片头 素材.MP4');
  assert.deepEqual([kindOfName('a.MP4'), kindOfName('b.jpeg'), kindOfName('c.wav'), kindOfName('d.txt'), kindOfName('noext')], ['video', 'image', 'audio', null, null]);
  assert.equal(extOf('x.tar.GZ'), 'gz');
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 360 });
  const gif = Buffer.alloc(16); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(120, 6); gif.writeUInt16LE(80, 8);
  assert.deepEqual(imageSize(gif), { width: 120, height: 80 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0x00, 0x00, 0x00]);
  assert.deepEqual(imageSize(jpeg), { width: 400, height: 300 });
  assert.deepEqual(imageSize(Buffer.from('not an image at all')), {});
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'latin1'); wav.write('WAVE', 8, 'latin1'); wav.write('fmt ', 12, 'latin1'); wav.writeUInt32LE(16, 16);
  wav.writeUInt32LE(32000, 28); wav.write('data', 36, 'latin1'); wav.writeUInt32LE(64000, 40);
  assert.equal(wavDuration(wav, 44 + 64000), 2);
  assert.equal(wavDuration(Buffer.from('nope')), undefined);
});

test('CA-HT-02 附件:只进对话工作区,回 work: 地址;提示词里只有真有的文件', async (t) => {
  const ws = createWorkspaces({ dataDir: tmpDir(t) });
  const w = ws.open({ projectId: 'p-a', ownerKey: OWNER, conversationId: 'c1' });
  const other = ws.open({ projectId: 'p-a', ownerKey: OWNER, conversationId: 'c2' });
  const a = await saveAttachment(w, '字幕.srt', Readable.from([Buffer.from('1\n00:00:01 --> 00:00:02\n你好\n')]));
  assert.deepEqual({ name: a.name, url: a.url, kind: a.kind }, { name: '字幕.srt', url: 'work:attachments/字幕.srt', kind: 'text' });
  assert.match(a.text, /你好/);
  const b = await saveAttachment(w, '字幕.srt', Readable.from([Buffer.from('second')]));
  assert.equal(b.url, 'work:attachments/字幕-1.srt', '重名自动改名,不覆盖');
  const v = await saveAttachment(w, 'clip.mp4', Readable.from([Buffer.alloc(2048, 1)]));
  assert.deepEqual({ kind: v.kind, size: v.size, text: v.text }, { kind: 'video', size: 2048, text: undefined });
  // 带路径的名字:只留最后一段,落在 attachments/ 下
  for (const name of ['../../../evil.txt', '..\\..\\evil2.txt', '/etc/evil3.txt', 'C:\\x\\evil4.txt']) {
    const r = await saveAttachment(w, name, Readable.from([Buffer.from('x')]));
    assert.match(r.url, /^work:attachments\/evil\d?\.txt$/);
  }
  assert.equal(fs.readdirSync(path.join(ws.root, 'p-a', OWNER)).sort().join(','), 'c1', '别的地方没有多出东西');
  await assert.rejects(saveAttachment(w, 'nul', Readable.from([Buffer.from('x')])), (err) => err instanceof WorkspaceError);
  await assert.rejects(saveAttachment(w, 'empty.txt', Readable.from([])), /空的/);
  await assert.rejects(saveAttachment(w, 'big.bin', Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { maxBytes: 1000 }), /太大/);
  assert.equal(w.exists('attachments/big.bin'), false, '超限的不留半个文件');
  // 提示词:只认这个对话工作区里真有的;别的对话的、乱写的、往上走的都不进
  await saveAttachment(other, 'secret.txt', Readable.from([Buffer.from('FAKE-CREDENTIAL-other')]));
  const text = attachmentsPrompt(w, [
    { url: a.url }, { url: v.url }, { url: 'work:attachments/secret.txt' }, { url: 'work:attachments/../../c2/attachments/secret.txt' },
    { url: 'work:../c2/attachments/secret.txt' }, { url: '/etc/passwd' }, { url: 42 }, null,
  ]);
  assert.match(text, /字幕\.srt · 地址 work:attachments\/字幕\.srt/);
  assert.match(text, /你好/);
  assert.match(text, /\[视频\] clip\.mp4/);
  assert.equal(text.includes('FAKE-CREDENTIAL'), false);
  assert.equal(text.includes('secret.txt'), false);
  assert.equal(text.includes(ws.root), false, '不给磁盘路径');
  assert.equal(attachmentsPrompt(w, []), '');
  // 页面发送时已放进素材库的(2026-10-18 用户定):写明是哪一条、叫它别再 import_media;放不进去的写原因
  const lib = attachmentsPrompt(w, [{ url: v.url, library: { mediaId: 'm-abc', url: '/@media/abc.mp4' } }]);
  assert.match(lib, /clip\.mp4 · 地址 work:attachments\/clip\.mp4 · 已在素材库:mediaId m-abc · cardUrl \/@media\/abc\.mp4\(直接用这一条,不要再 import_media\)/);
  assert.match(lib, /^\n\n附件\(页面已放进素材库/);
  const mixed = attachmentsPrompt(w, [{ url: v.url, library: { mediaId: 'm-abc', url: '/@media/abc.mp4' } }, { url: a.url, libraryError: '上传超时' }]);
  assert.match(mixed, /标了「已在素材库」的直接用那一条/);
  assert.match(mixed, /字幕\.srt · 地址 work:attachments\/字幕\.srt · 页面没能把它放进素材库:上传超时/);
});

const CARD = (id, marker = '') => [
  'import type { CardDef, CardProps } from "../../kernel/types";',
  marker ? `console.log(${JSON.stringify(marker)}); (globalThis as any).__PC_TEST_CARD_RAN = true;` : '',
  'interface Params { text: string; size: number }',
  'function C({ params }: CardProps<Params>) { return <div style={{ fontSize: params.size }}>{params.text}</div>; }',
  'export const probeCard: CardDef<Params> = {',
  `  id: "${id}", name: "测试卡", description: "单测建的卡", source: "user",`,
  '  frameMode: "stateless",',
  '  defaults: { text: "你好", size: 48 },',
  '  controls: [{ key: "text", label: "文字", type: "text" }, { key: "size", label: "字号", type: "number" }],',
  '  Component: C,',
  '};',
  '',
].join('\n');

const A = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice' };
const toolResults = (events) => events.filter((e) => e.type === 'tool_result').map((e) => ({ name: e.name, ok: e.ok === true, summary: String(e.summary ?? '') }));

test('CA-HT-03 / CA-HT-04 / CA-HT-05 建卡改卡、创造力等级、导入素材的前置检查(整条链,模拟模型)', { timeout: 240_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', '甲'));
  const svc = kit.service;
  const id = 'unit-probe-card';
  const key = `src/cards/user/${id}.tsx`;
  const marker = 'PC-UNIT-CARD-EXECUTED-7f3a';
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); realLog(...args); };
  t.after(() => { console.log = realLog; });

  await t.test('CA-HT-03 建卡 → 认得 → 读回 → 改 → 重复建被拒;登记是临时的;卡片代码没有执行', async () => {
    await svc.send(A, 'c-card', { creativity: 'high', prompt: script([
      { tool: 'create_card', input: { id, source: CARD(id, marker) } },
      { tool: 'list_cards', input: { cardId: id } },
      { tool: 'add_clip', input: { cardId: id, start: 5, duration: 2, params: { text: '单测', size: 30 } } },
      { tool: 'get_card_source', input: { cardId: id } },
      { tool: 'edit_card', input: { cardId: id, find: 'size: 48', replace: 'size: 72' } },
      { tool: 'create_card', input: { id, source: CARD(id) } },
      { tool: 'create_card', input: { id: 'bad-card', source: 'export const x = 1;' } },
      { tool: 'create_card', input: { id: 'timer-card', source: CARD('timer-card').replace('return <div', 'setTimeout(() => {}, 1); return <div') } },
      { tool: 'get_card_source', input: { cardId: 'title' } },
      { tool: 'card_authoring_guide', input: {} },
      { say: '完' },
    ]) });
    const r = toolResults(await kit.finished(A, 'c-card', 120_000));
    assert.deepEqual(r.map((x) => `${x.name}:${x.ok}`), [
      'create_card:true', 'list_cards:true', 'add_clip:true', 'get_card_source:true', 'edit_card:true',
      'create_card:false', 'create_card:false', 'create_card:false', 'get_card_source:true', 'card_authoring_guide:true',
    ], JSON.stringify(r.filter((x) => !x.ok).map((x) => x.summary.slice(0, 160))));
    assert.match(r[5].summary, /已存在/);
    assert.match(r[7].summary, /setTimeout/);
    // 源码在这个项目的内容库里(别的成员、渲染节点从这里取);改过的那一处到了
    const pa = await kit.doc.stateOf('p-a');
    const clip = pa.project.tracks.flatMap((tr) => tr.clips).find((c) => c.cardId === id);
    assert.ok(clip, '用新卡加的片段落地了');
    assert.deepEqual(clip.params, { text: '单测', size: 30 });
    const inst = svc._instance(A);
    const stored = await inst.callTool('get_card_source', { cardId: id }, 'c-card');
    assert.ok(stored.source.includes('size: 72') && stored.source.includes(marker));
    assert.equal(stored.builtin, false);
    // 「另一个项目的对话不认得这张卡」不在这里验:这套单测的文档服务是本机档,两个项目同在一个空间、共用一份内容库;
    // 托管端每个项目各是一个空间,由隔离探针 T5 与 auth 探针 P3 对着真的托管组合验。这里验登记是临时的:
    // 不带项目卡片的调用(别的实例进锁)之后,这个项目仍然认得它,而卡片表里平时没有它
    const host = await (await import('../agent/ssr-host.mjs')).loadSsrHost((m) => kit.vite.ssrLoadModule(m));
    assert.equal(host.cardIds().includes(id), false, '出锁之后卡片表里不留项目的卡');
    assert.equal((await inst.callTool('list_cards', { cardId: id }, 'c-card'))[0].id, id);
    assert.equal(host.cardIds().includes(id), false);
    // 卡片代码没有在服务进程里执行
    assert.equal(logged.some((l) => l.includes(marker)), false);
    assert.equal(globalThis.__PC_TEST_CARD_RAN, undefined);
    assert.equal(fs.existsSync(path.join(kit.vite.config.root, key)), false, '检出目录里没有多出这张卡的文件');
  });

  await t.test('CA-HT-03b remotion 式的卡:违规的被拒并指出行号、不入库;用框架写的入库;改卡新加违规被拒', async () => {
    const FIX = path.join(kit.vite.config.root, 'server', 'test', 'fixtures', 'remotion-style');
    const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n');
    const lineOf = (source, needle) => source.slice(0, source.indexOf(needle)).split('\n').length;
    const inst = svc._instance(A);
    await svc.send(A, 'c-rs', { creativity: 'high', prompt: script([{ sleepMs: 60_000 }]) });
    const call = (tool, args) => inst.callTool(tool, args, 'c-rs').catch((err) => ({ ok: false, error: String(err?.message ?? err), errors: err?.errors }));
    // 每条规矩的违规样例:云端这条路同样拒绝,报错带行号,源码不进内容库
    const cases = [
      ['random.tsx', 'Math.random()', /不带种子的随机/], ['real-time.tsx', 'performance.now()', /真实时间/], ['timer.tsx', 'setTimeout(', /定时器/],
      ['frame-callback.tsx', 'requestAnimationFrame(', /逐帧回调/], ['motion.tsx', '<motion.div', /Motion/], ['presence.tsx', '<AnimatePresence>', /进出场组件/],
      ['css-animation.tsx', 'transition: "opacity', /CSS 的动画和过渡/], ['state.tsx', 'useState(0)', /活得比一帧长/], ['top-level.tsx', 'let frames = 0', /顶层写了 let/],
      ['import.tsx', 'from "lottie-web"', /只许引用框架/],
    ];
    for (const [file, needle, says] of cases) {
      const source = fixture(`violations/${file}`);
      const id = /\bid:\s*"([^"]+)"/.exec(source)[1];
      const r = await call('create_card', { id, source });
      assert.equal(r.ok, false, file);
      const text = String(r.error ?? '');
      assert.match(text, new RegExp(`\\[remotion 式\\] 第 ${lineOf(source, needle)} 行：`), `${file}: ${text.slice(0, 400)}`);
      assert.match(text, says, file);
      assert.doesNotMatch(text, /交给 motion|用 motion\/react|改用 motion|initial \+ animate/, file);
      const stored = await call('get_card_source', { cardId: id });
      assert.equal(stored.ok, false, `${file} 被拒的源码不该入库`);
    }
    // 用框架写的示例卡:入库,同一轮里认得它
    for (const file of ['rs-title-reveal.tsx', 'rs-bar-race.tsx', 'rs-orbit-canvas.tsx']) {
      const source = fixture(file);
      const id = /\bid:\s*"([^"]+)"/.exec(source)[1];
      const r = await call('create_card', { id, source });
      assert.equal(r.ok, true, `${file}: ${String(r.error ?? '').slice(0, 400)}`);
      const stored = await call('get_card_source', { cardId: id });
      assert.equal(stored.source, source, '入库的源码与交上来的一字不差');
      assert.equal((await call('list_cards', { cardId: id }))[0].id, id);
    }
    // 改卡:往合规的卡里新加一条违规,被拒并指出行号;改文案照常
    const edit = await call('edit_card', { cardId: 'rs-bar-race', find: '  const count = Math.max(', replace: '  const jitter = Math.random();\n  const count = Math.max(' });
    assert.equal(edit.ok, false);
    assert.match(String(edit.error), /\[remotion 式\] 第 \d+ 行：用了不带种子的随机（Math\.random）/);
    const rename = await call('edit_card', { cardId: 'rs-bar-race', find: 'name: "随机柱状起伏"', replace: 'name: "随机柱子"' });
    assert.equal(rename.ok, true, String(rename.error ?? ''));
    assert.equal(fs.existsSync(path.join(kit.vite.config.root, 'src/cards/user/rs-bar-race.tsx')), false, '检出目录里没有多出文件');
    svc.abort(A, 'c-rs');
  });

  await t.test('CA-HT-04 创造力「中」:建不了新卡,能重写这个项目里已有的卡', async () => {
    const inst = svc._instance(A);
    await svc.send(A, 'c-mid', { creativity: 'medium', prompt: script([{ sleepMs: 30_000 }]) });
    const fresh = await inst.callTool('create_card', { id: 'another-new-card', source: CARD('another-new-card') }, 'c-mid');
    assert.equal(fresh.ok, false);
    assert.ok(fresh.creativity, '被创造力等级的闸拦下');
    const rewrite = await inst.callTool('create_card', { id, source: CARD(id), overwrite: true }, 'c-mid');
    assert.equal(rewrite.ok, true, JSON.stringify(rewrite).slice(0, 300));
    assert.equal(rewrite.overwritten, true);
    svc.abort(A, 'c-mid');
  });

  await t.test('CA-HT-05 导入素材:没配素材服务时在最前面回明确的原因', async () => {
    const inst = svc._instance(A);
    await svc.send(A, 'c-net', { prompt: script([{ sleepMs: 30_000 }]) });
    // 这套单测的服务没配素材服务:导入在最前面就明说
    const none = await inst.callTool('import_media', { url: 'https://example.com/a.png' }, 'c-net').catch((err) => ({ ok: false, error: err.message }));
    assert.equal(none.ok, false);
    assert.match(none.error, /没有配置素材服务/);
    svc.abort(A, 'c-net');
  });
});

test('CA-HT-06 用量:外部服务的调用单记一类,不占 token 额度', (t) => {
  const dir = tmpDir(t);
  const usage = createUsageLog({ dir });
  t.after(() => usage.close());
  const base = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', conversationId: 'c1', runId: 'r1' };
  usage.append({ ...base, vendor: 'mock', model: 'mock-1', input: 100, output: 20, ms: 5 });
  const row = usage.append({ ...base, kind: 'service', service: 'voice', vendor: 'minimax', model: 'speech-2.8-hd', units: 12, unit: 'chars', ms: 300, prompt: '不该落盘的正文' });
  usage.append({ ...base, userId: 'bob@dev-b', username: 'bob', kind: 'service', service: 'voice', vendor: 'minimax', model: 'speech-2.8-hd', units: 8, unit: 'chars', ok: false });
  assert.deepEqual({ kind: row.kind, service: row.service, units: row.units, unit: row.unit, input: row.input }, { kind: 'service', service: 'voice', units: 12, unit: 'chars', input: 0 });
  assert.equal('prompt' in row, false, '多的字段不落盘');
  assert.equal(usage.used('p-a'), 120, '外部服务的调用不占 token 额度');
  const s = usage.summary('p-a');
  assert.deepEqual(s.project, { tokens: 120, calls: 1 }, '不混进模型的调用次数');
  assert.deepEqual(s.services, [{ service: 'voice', vendor: 'minimax', calls: 2, units: 20, unit: 'chars', members: [
    { userId: 'alice@dev-a', username: 'alice', calls: 1, units: 12 }, { userId: 'bob@dev-b', username: 'bob', calls: 1, units: 8 },
  ] }]);
  const q = queryUsage(dir, { projectId: 'p-a' });
  assert.equal(q.rows.length, 3);
  assert.equal(q.rows.filter((r) => r.kind === 'service').length, 2);
  assert.equal(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))), 'utf8').includes('不该落盘'), false);
  // 重启后从流水重建:结果相同
  usage.close();
  const again = createUsageLog({ dir });
  t.after(() => again.close());
  assert.equal(again.used('p-a'), 120);
  assert.equal(again.summary('p-a').services[0].units, 20);
});

// 配音配置要闭源侧的 service-keys 扩展（cloud/agent/manifest.mjs）；社区版没有 cloud/，readHostedVoiceConfig 本来就回 null
test('CA-HT-07 托管方的配音配置:从数据目录读,令牌密文落盘', { skip: fs.existsSync(new URL('../../cloud', import.meta.url)) ? false : '当前工作区无 cloud/ 目录（社区版）' }, async (t) => {
  const dataDir = tmpDir(t);
  assert.equal(await readHostedVoiceConfig(dataDir), null, '没配回 null');
  assert.equal(await readHostedVoiceConfig(null), null);
  const { file, keyFile } = voiceConfigPaths(dataDir);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:9/', provider: 'kling' }));
  const noKey = await readHostedVoiceConfig(dataDir);
  assert.deepEqual([noKey.provider, noKey.effectiveBaseUrl, noKey.apiKey], ['kling', 'http://127.0.0.1:9', '']);
  const FAKE = 'FAKE-VOICE-KEY-unit';
  fs.writeFileSync(keyFile, `${sealKey(FAKE, 'voice')}\n`);
  assert.equal(fs.readFileSync(keyFile, 'utf8').includes(FAKE), false, '落盘的是密文');
  assert.equal((await readHostedVoiceConfig(dataDir)).apiKey, FAKE);
  // 别的种类的密文(模型 Key)放错位置不认
  fs.writeFileSync(keyFile, `${sealKey(FAKE, 'custom')}\n`);
  assert.equal((await readHostedVoiceConfig(dataDir)).apiKey, '');
});
