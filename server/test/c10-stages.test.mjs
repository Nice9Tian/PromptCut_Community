/**
 * Two stages for C10 online page: runtime configuration and fallback
 * (`docs/plan/c10-contract.md` section 2).
 * Run: node --test server/test/c10-stages.test.mjs
 *
 *   C10-ST-01 Stage origin configuration parsing: two same-site cross-origin https origins
 *             (subdomains) → one each for A and B; also accepts same host with different ports
 *             for local development;
 *   C10-ST-02 Unreadable or invalid (missing, empty, one, two identical, not a URL, not http(s),
 *             corrupted JSON) → returns empty, does not throw;
 *   C10-ST-03 Decision: stage gate reaches level 2 or above + configuration read + handshake
 *             succeeds → dual stage;
 *   C10-ST-04 Configuration unreadable or stage handshake fails → falls back to same-origin
 *             single stage (never fail to show video);
 *   C10-ST-05 Stage gate stops at level 1 (lite, low-spec) always single stage (even if
 *             configuration and handshake are both good; originally the low-memory tier item,
 *             changed 2026-10-22).
 *
 * For assumptions, see K5 of `c10-kit.mjs`. Skip the entire group when implementation is absent.
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
  assert.ok(hit, `Assumption K5: no stage selection function found in ${STAGE_FILES.join(', ')} (${STAGE_DECIDE_NAMES.join(' / ')})`);
  const mod = await importRepo(hit.file);
  return (args) => normalizeLayout(mod[hit.name](args));
}

const S1 = 'https://s1.203-0-113-16.sslip.io';
const S2 = 'https://s2.203-0-113-16.sslip.io';

it('C10-ST-01 two origins that are same-site but cross-origin → one each for A and B; the same host on different ports in local development is accepted too', async () => {
  const parse = await parseFn();
  assert.deepEqual(parse({ stageOrigins: [S1, S2] }), { A: S1, B: S2 });
  assert.deepEqual(parse(JSON.stringify({ stageOrigins: [S1, S2] })), { A: S1, B: S2 }, 'JSON text is accepted too');
  assert.deepEqual(parse({ stageOrigins: [`${S1}/`, `${S2}/`] }), { A: S1, B: S2 }, 'Trailing slashes are stripped, leaving only the origin');
  assert.deepEqual(parse({ stageOrigins: ['http://127.0.0.1:5431', 'http://127.0.0.1:5432'] }), { A: 'http://127.0.0.1:5431', B: 'http://127.0.0.1:5432' });
});

it('C10-ST-02 unreadable or invalid → returns empty, does not throw', async () => {
  const parse = await parseFn();
  const bad = [
    undefined, null, '', '{', 'null', {}, { stageOrigins: null }, { stageOrigins: [] }, { stageOrigins: [S1] },
    { stageOrigins: [S1, S1] }, { stageOrigins: ['not a url', S2] }, { stageOrigins: ['javascript:alert(1)', S2] },
    { stageOrigins: ['ftp://s1.example', S2] }, { stageOrigins: [42, S2] },
  ];
  for (const cfg of bad) {
    let r;
    assert.doesNotThrow(() => { r = parse(cfg); }, `Config ${JSON.stringify(cfg)} should not throw`);
    assert.equal(r ?? null, null, `Config ${JSON.stringify(cfg)} should return empty, got ${JSON.stringify(r)}`);
  }
});

it('C10-ST-03 the stage gate is tried up to level 2 or above + the config is read + the handshake succeeds → dual stage', async () => {
  const decide = await decideFn();
  assert.equal(decide({ single: false, origins: { A: S1, B: S2 }, handshake: 'ok' }), 'dual');
});

it('C10-ST-04 config unreadable or stage handshake fails → same-origin single stage', async () => {
  const decide = await decideFn();
  assert.equal(decide({ single: false, origins: null, handshake: 'ok' }), 'single');
  assert.equal(decide({ single: false, origins: { A: S1, B: S2 }, handshake: 'failed' }), 'single');
  assert.equal(decide({ single: false, origins: null, handshake: 'failed' }), 'single');
});

it('C10-ST-05 a stage gate that stops at level 1 always gives a single stage', async () => {
  const decide = await decideFn();
  for (const handshake of ['ok', 'failed']) {
    for (const origins of [{ A: S1, B: S2 }, null]) assert.equal(decide({ single: true, origins, handshake }), 'single');
  }
});
