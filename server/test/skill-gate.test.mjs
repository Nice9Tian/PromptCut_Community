/**
 * Unit tests for SKILL gate (server/skill-gate.mjs). Plan docs/plan/agent-workflow-plan.md A4
 * changes it to **block by caller type**: registered desktop app sessions (`desktop`) do nothing
 * when SKILL mode is off, AI panel Agents (`api` / `cli`) are not governed by it, and calls without
 * reported identity (`unknown`) are not blocked. Previously blocked by "is this process a headless
 * instance"; headless instances are now archived.
 *
 * State file is only written to temporary directory (PROMPTCUT_SKILL_DIR), not touching user's
 * Documents\PromptCut-Skill.
 * Run: node --test server/test/skill-gate.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skill-gate-'));
process.env.PROMPTCUT_SKILL_DIR = DIR;
const gate = await import('../skill-gate.mjs');
const STATE = path.join(DIR, 'skill-state.json');

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('SG-1 the state file lives under PROMPTCUT_SKILL_DIR; no file counts as off; open / close are persisted to disk, and the old task fields are no longer written', () => {
  assert.equal(gate.statePath(), STATE);
  assert.equal(gate.readState().active, false);
  const on = gate.openGate();
  assert.equal(on.active, true);
  assert.ok(Date.parse(on.since) > 0);
  const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(raw.active, true);
  for (const k of ['jobId', 'jobDir', 'procPath']) assert.equal(k in raw, false, `${k} is archived with the headless instance and is no longer written`);
  const off = gate.closeGate('user');
  assert.equal(off.active, false);
  assert.equal(off.closedBy, 'user');
  assert.ok(Date.parse(off.closedAt) > 0);
});

test('SG-2 gated by caller type: desktop is rejected when SKILL is off and allowed when it is on; api / cli / unknown are always allowed', () => {
  gate.closeGate('test');
  const denied = gate.checkGate('add_clip', 'desktop');
  assert.equal(denied.ok, false);
  for (const t of ['api', 'cli', 'unknown']) assert.equal(gate.checkGate('add_clip', t).ok, true, `${t} is not governed by the SKILL gate`);
  gate.openGate();
  assert.equal(gate.checkGate('add_clip', 'desktop').ok, true, 'Desktop sessions are allowed when SKILL is on');
  gate.closeGate('test');
});

test('SG-3 the explanation on rejection: names the tool, says the project was not changed, says not to retry, tells the user to switch to SKILL', () => {
  gate.closeGate('test');
  const { message } = gate.checkGate('update_clip', 'desktop');
  assert.match(message, /not in SKILL mode/);
  assert.match(message, /update_clip/);
  assert.match(message, /was \*\*not\*\* changed at all/);
  assert.match(message, /Do not retry/);
  assert.match(message, /switch "Classic mode \/ SKILL" to SKILL/);
});

test('SG-4 a corrupted state file is treated as off (desktop sessions are rejected by default)', () => {
  fs.writeFileSync(STATE, '{ this is not JSON');
  assert.equal(gate.readState().active, false);
  assert.equal(gate.checkGate('add_clip', 'desktop').ok, false);
  fs.unlinkSync(STATE);
  assert.equal(gate.checkGate('add_clip', 'desktop').ok, false, 'A missing file is also treated as off');
});
