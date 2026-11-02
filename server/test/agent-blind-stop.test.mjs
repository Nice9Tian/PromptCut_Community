/**
 * 「用不了的能力怎么办」:提示词里那张决策表,与云端注记里素材模式那句话按真实情况写。
 *
 * 起因(docs/plan/agent-blind-stop.md):2026-10-24 的一次云端运行里,模型同时收到三句打架的话 ——
 * 提示词说「排卡前必须先用素材模式看过画面」、云端注记说「素材模式云端还没有」、工具清单里
 * 却真的有这个工具。它试了两轮拿到一串内部错误码,就蒙着眼睛手写了一张 637 行的卡,
 * `create_card` 一次没调到就撞了轮次上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudSystemNote, CLOUD_SYSTEM_NOTE } from '../agent/service/cloud-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const prompt = fs.readFileSync(path.join(here, '..', 'ai-system-prompt.md'), 'utf8');

test('cloud note: once media mode is connected, it no longer says "not in the cloud yet", and tells it what to do when reading fails', () => {
  const on = cloudSystemNote({ look: true, mediaFrames: true });
  assert.match(on, /media mode \(`source: "media"`\) also works/);
  assert.match(on, /retrying won't help/);
  assert.match(on, /what to do when a capability is unavailable/, 'must point back to the decision table in the prompt');
  assert.doesNotMatch(on, /shot mosaic of the media \(`source: "media"`\) is not in the cloud yet/);
});

test('cloud note: when media mode is not connected, it still says "not in the cloud yet"', () => {
  const off = cloudSystemNote({ look: true, mediaFrames: false });
  assert.match(off, /shot mosaic of the media \(`source: "media"`\) is not in the cloud yet/);
  assert.doesNotMatch(off, /media mode \(`source: "media"`\) also works/);
  assert.equal(cloudSystemNote({ look: true }), off, 'mediaFrames defaults to "not connected"');
});

test('cloud note: the two wordings differ only in the media sentence, and the line count stays the same; the version that cannot see frames is unaffected', () => {
  const on = cloudSystemNote({ look: true, mediaFrames: true });
  const off = cloudSystemNote({ look: true, mediaFrames: false });
  assert.equal(on.split('\n').length, off.split('\n').length);
  assert.match(on, /viewing frames works as usual, but is slower than on this machine/);
  assert.match(off, /viewing frames works as usual, but is slower than on this machine/);
  // look 为 false 时 see_frames 整个没交给模型,素材模式接没接上都不改这段话
  assert.equal(cloudSystemNote({ look: false, mediaFrames: true }), CLOUD_SYSTEM_NOTE);
});

test('prompt: the "must look at the media first" item points to the decision table, and is no longer a hard requirement with no way out', () => {
  const must = prompt.slice(prompt.indexOf('Before arranging cards you must first use'), prompt.indexOf('what to do when a capability is unavailable'));
  assert.match(must, /when this cannot be done/);
  assert.match(must, /do not guess and carry on by yourself/);
});

test('prompt: all three options of the decision table are present, and "hard prerequisite" has an actionable criterion', () => {
  const table = prompt.slice(prompt.indexOf('- **What to do when a capability is unavailable'), prompt.indexOf('- **Land it first, then polish'));
  assert.ok(table, 'the decision table section must be in the interaction principles');
  // 三条路
  assert.match(table, /it is a \*\*hard prerequisite\*\*/);
  assert.match(table, /it is \*\*not\*\* a hard prerequisite/);
  assert.match(table, /the same error 2 times in a row/);
  // 硬前提那条要落到 final + blocked 的汇报并停下:blocked 是界面上「等你回话」那一位
  assert.match(table, /`report_progress` with `final: true`, `blocked: true`/);
  assert.match(table, /then stop, and do not call any more tools/);
  // 判据:用户提到画面内容就算硬前提;拿不准就停
  assert.match(table, /who is where, what to avoid/);
  assert.match(table, /if unsure, treat it as a hard prerequisite and stop to ask/);
  // 明确排除「重试第三次」和「当它不存在接着做」
  assert.match(table, /does not include "retry a third time"/);
  assert.match(table, /does not include "when it does not exist, carry on"/);
  // 结果里带 cloudUnavailable 也算一种信号
  assert.match(table, /cloudUnavailable/);
});

test('prompt: land it first and polish later, and state that only what is handed to a tool counts as delivered', () => {
  const ship = prompt.slice(prompt.indexOf('- **Land it first, then polish'));
  assert.match(ship, /only what is actually handed to a tool counts as delivered/);
  assert.match(ship, /card source code written in a code block/);
  assert.match(ship, /reminds you once when half remains and once when only a quarter remains/, 'must match the two hints the harness actually sends');
});

test('prompt: every place that stops to wait for the user is changed to blocked, with a clear note not to fill it in carelessly', () => {
  // 决策表之外还有三处「停下来等用户」:汇报那一节、网页撞墙交接、指令含糊要澄清
  for (const anchor of ['the same applies when the user has to do something or answer', 'Ask when unable to understand', 'Move the window in front of the user']) {
    assert.ok(prompt.includes(anchor), anchor);
  }
  assert.match(prompt, /in every case call `report_progress` with `final: true` \*\*and `blocked: true`\*\*/);
  assert.match(prompt, /- \*\*Ask when unable to understand\*\*: [^\n]*`final: true`, `blocked: true`/);
  // 别乱填:做完了或只是撞上限不算「等你回话」
  assert.match(prompt, /finished on your own, or just hit the round limit, do not set `blocked`/);
  assert.match(prompt, /`blocked: true` implies `final`/);
});
