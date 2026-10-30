/**
 * C10 在线页面的两个舞台：运行配置与退回（`docs/plan/c10-contract.md` 第 2 节）。
 * 跑：node --test server/test/c10-stages.test.mjs
 *
 *   C10-ST-01 舞台源配置解析：两个同站跨源的 https 源（子域）→ A、B 各一个；本机开发的同主机不同端口也认；
 *   C10-ST-02 读不到或不合法（缺、空、一个、两个相同、不是地址、不是 http(s)、JSON 坏了）→ 回空，不抛；
 *   C10-ST-03 取舍：舞台闸门要试到第二级以上 + 配置读到 + 握手成功 → 双舞台；
 *   C10-ST-04 读不到配置或舞台握手失败 → 退回同源单舞台（不许开不出画面）；
 *   C10-ST-05 舞台闸门停在第一级（精简、低配）恒单舞台（配置、握手都好也一样；原来是低内存档那一条，2026-10-22 改）。
 *
 * 假设见 `c10-kit.mjs` 的 K5。实现不在时整组 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stageGate, findExport, importRepo, normalizeOrigins, normalizeLayout, STAGE_FILES, STAGE_DECIDE_NAMES } from './c10-kit.mjs';

const gate = stageGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);

async function parseFn() {
  const mod = await importRepo(gate.file);
  return (cfg) => normalizeOrigins(mod[gate.name](cfg));
}
async function decideFn() {
  const hit = findExport(STAGE_FILES, STAGE_DECIDE_NAMES);
  assert.ok(hit, `假设 K5：${STAGE_FILES.join('、')} 里找不到舞台取舍函数（${STAGE_DECIDE_NAMES.join(' / ')}）`);
  const mod = await importRepo(hit.file);
  return (args) => normalizeLayout(mod[hit.name](args));
}

const S1 = 'https://s1.203-0-113-16.sslip.io';
const S2 = 'https://s2.203-0-113-16.sslip.io';

it('C10-ST-01 两个同站跨源的源 → A、B 各一个；本机开发的同主机不同端口也认', async () => {
  const parse = await parseFn();
  assert.deepEqual(parse({ stageOrigins: [S1, S2] }), { A: S1, B: S2 });
  assert.deepEqual(parse(JSON.stringify({ stageOrigins: [S1, S2] })), { A: S1, B: S2 }, 'JSON 文本也认');
  assert.deepEqual(parse({ stageOrigins: [`${S1}/`, `${S2}/`] }), { A: S1, B: S2 }, '末尾斜杠去掉，只留源');
  assert.deepEqual(parse({ stageOrigins: ['http://127.0.0.1:5431', 'http://127.0.0.1:5432'] }), { A: 'http://127.0.0.1:5431', B: 'http://127.0.0.1:5432' });
});

it('C10-ST-02 读不到或不合法 → 回空，不抛', async () => {
  const parse = await parseFn();
  const bad = [
    undefined, null, '', '{', 'null', {}, { stageOrigins: null }, { stageOrigins: [] }, { stageOrigins: [S1] },
    { stageOrigins: [S1, S1] }, { stageOrigins: ['not a url', S2] }, { stageOrigins: ['javascript:alert(1)', S2] },
    { stageOrigins: ['ftp://s1.example', S2] }, { stageOrigins: [42, S2] },
  ];
  for (const cfg of bad) {
    let r;
    assert.doesNotThrow(() => { r = parse(cfg); }, `配置 ${JSON.stringify(cfg)} 不该抛`);
    assert.equal(r ?? null, null, `配置 ${JSON.stringify(cfg)} 应回空，实际 ${JSON.stringify(r)}`);
  }
});

it('C10-ST-03 舞台闸门要试到第二级以上 + 配置读到 + 握手成功 → 双舞台', async () => {
  const decide = await decideFn();
  assert.equal(decide({ single: false, origins: { A: S1, B: S2 }, handshake: 'ok' }), 'dual');
});

it('C10-ST-04 读不到配置或舞台握手失败 → 同源单舞台', async () => {
  const decide = await decideFn();
  assert.equal(decide({ single: false, origins: null, handshake: 'ok' }), 'single');
  assert.equal(decide({ single: false, origins: { A: S1, B: S2 }, handshake: 'failed' }), 'single');
  assert.equal(decide({ single: false, origins: null, handshake: 'failed' }), 'single');
});

it('C10-ST-05 舞台闸门停在第一级恒单舞台', async () => {
  const decide = await decideFn();
  for (const handshake of ['ok', 'failed']) {
    for (const origins of [{ A: S1, B: S2 }, null]) assert.equal(decide({ single: true, origins, handshake }), 'single');
  }
});
