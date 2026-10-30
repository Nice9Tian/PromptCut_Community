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

test('云端注记:素材模式接上了就不再说「云端还没有」,并告诉它读不了时怎么办', () => {
  const on = cloudSystemNote({ look: true, mediaFrames: true });
  assert.match(on, /素材模式\(`source: "media"`\)也能用/);
  assert.match(on, /重试也没用/);
  assert.match(on, /用不了的能力怎么办/, '要指回提示词里那张决策表');
  assert.doesNotMatch(on, /素材的镜头拼图\(`source: "media"`\)云端还没有/);
});

test('云端注记:素材模式没接上照旧说「云端还没有」', () => {
  const off = cloudSystemNote({ look: true, mediaFrames: false });
  assert.match(off, /素材的镜头拼图\(`source: "media"`\)云端还没有/);
  assert.doesNotMatch(off, /素材模式\(`source: "media"`\)也能用/);
  assert.equal(cloudSystemNote({ look: true }), off, 'mediaFrames 缺省按「没接上」算');
});

test('云端注记:两种写法只差素材那一句,行数不变;看不了画面那一版不受影响', () => {
  const on = cloudSystemNote({ look: true, mediaFrames: true });
  const off = cloudSystemNote({ look: true, mediaFrames: false });
  assert.equal(on.split('\n').length, off.split('\n').length);
  assert.match(on, /看画面照常用,但比本机慢/);
  assert.match(off, /看画面照常用,但比本机慢/);
  // look 为 false 时 see_frames 整个没交给模型,素材模式接没接上都不改这段话
  assert.equal(cloudSystemNote({ look: false, mediaFrames: true }), CLOUD_SYSTEM_NOTE);
});

test('提示词:「必须先看素材」那条指向决策表,不再是一条没有出口的硬要求', () => {
  const must = prompt.slice(prompt.indexOf('排卡之前必须先用'), prompt.indexOf('用不了的能力怎么办'));
  assert.match(must, /这一条做不到时/);
  assert.match(must, /不要自己蒙着做下去/);
});

test('提示词:决策表三条路都在,且「硬前提」有可操作的判据', () => {
  const table = prompt.slice(prompt.indexOf('- **用不了的能力怎么办'), prompt.indexOf('- **先落地,再打磨'));
  assert.ok(table, '决策表那一节要在交互原则里');
  // 三条路
  assert.match(table, /它是\*\*硬前提\*\*/);
  assert.match(table, /它\*\*不是\*\*硬前提/);
  assert.match(table, /同一个错误连续 2 次/);
  // 硬前提那条要落到 final + blocked 的汇报并停下:blocked 是界面上「等你回话」那一位
  assert.match(table, /`final: true`、`blocked: true` 的 `report_progress`/);
  assert.match(table, /然后停下,不要再调工具/);
  // 判据:用户提到画面内容就算硬前提;拿不准就停
  assert.match(table, /谁在哪、避开什么/);
  assert.match(table, /拿不准就当硬前提停下来问/);
  // 明确排除「重试第三次」和「当它不存在接着做」
  assert.match(table, /不包括"重试第三次"/);
  assert.match(table, /不包括"当它不存在,接着做"/);
  // 结果里带 cloudUnavailable 也算一种信号
  assert.match(table, /cloudUnavailable/);
});

test('提示词:先落地再打磨,并说明只有交给工具的才算交付', () => {
  const ship = prompt.slice(prompt.indexOf('- **先落地,再打磨'));
  assert.match(ship, /只有真正交给工具的东西才算交付/);
  assert.match(ship, /写在代码块里的卡片源码/);
  assert.match(ship, /还剩一半和只剩四分之一时提醒你一次/, '要和 harness 真发的那两条提示对得上');
});

test('提示词:停下来等用户的那几处都改成 blocked,并说清不该乱填', () => {
  // 决策表之外还有三处「停下来等用户」:汇报那一节、网页撞墙交接、指令含糊要澄清
  for (const anchor of ['要用户做事或回答时也一样', '无法理解时询问', '把窗口挪到用户面前']) {
    assert.ok(prompt.includes(anchor), anchor);
  }
  assert.match(prompt, /都调 `final: true` \*\*且 `blocked: true`\*\* 的 `report_progress`/);
  assert.match(prompt, /- \*\*无法理解时询问\*\*: [^\n]*`final: true`、`blocked: true`/);
  // 别乱填:做完了或只是撞上限不算「等你回话」
  assert.match(prompt, /自己做完了、或者只是撞上轮次上限,不要填 `blocked`/);
  assert.match(prompt, /`blocked: true` 隐含 `final`/);
});
