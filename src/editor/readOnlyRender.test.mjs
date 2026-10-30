/**
 * 只读界面里几个组件画出来的样子：只读项目（游客）里改项目的控件禁用、悬停是 viewOnlyText() 那一句；
 * 读写（没进共享项目 / 有写权限）里一切照旧；`?observe=1` 那条老路不受新增的锁影响。
 * 每个组件把自己的重依赖换成桩（同 `right/CloudModelBar.test.mjs` 的做法），`useReadOnly` 换成按测试里的权限出状态。
 * 整页的真实表现（时间轴拖动、参数面板、右键菜单、项目设置对话框、手机版）见 `scripts/probes/guest-readonly-ui-probe.mjs`。
 *
 * 跑：node --test src/editor/readOnlyRender.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const vo = await import("./io/viewOnly.ts");
const core = await import("./readOnlyCore.ts");
const WHY_MEMBER = "你在这个项目里只能查看，改不了内容。";

/** 在这个权限下跑 fn：'r' = 只读项目（游客），'rw' / null = 照旧，'observe' = ?observe=1 */
async function under(access, fn) {
  const hadLoc = Object.hasOwn(globalThis, "location");
  const prevLoc = globalThis.location;
  if (access === "observe") { globalThis.location = { search: "?observe=1" }; vo.setProjectAccess(null); }
  else vo.setProjectAccess(access);
  try { return await fn(); } finally {
    vo.setProjectAccess(null);
    if (hadLoc) globalThis.location = prevLoc; else delete globalThis.location;
  }
}

/** 编译一个 .tsx 组件、换掉依赖、返回导出。`useReadOnly` 一律按当下的权限出状态 */
async function load(rel, mocks) {
  const source = await fs.readFile(new URL(rel, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const actualRequire = createRequire(import.meta.url);
  const all = {
    "./readOnly": { useReadOnly: () => core.readOnlyState(core.memberReadOnlyNow()), useMemberReadOnly: () => core.memberReadOnlyNow() },
    "../readOnly": { useReadOnly: () => core.readOnlyState(core.memberReadOnlyNow()), useMemberReadOnly: () => core.memberReadOnlyNow() },
    "../../readOnly": { useReadOnly: () => core.readOnlyState(core.memberReadOnlyNow()), useMemberReadOnly: () => core.memberReadOnlyNow() },
    "../../../readOnly": { useReadOnly: () => core.readOnlyState(core.memberReadOnlyNow()) },
    ...mocks,
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((id) => (Object.hasOwn(all, id) ? all[id] : actualRequire(id)), mod, mod.exports);
  return mod.exports;
}
const html = (Comp, props) => renderToStaticMarkup(React.createElement(Comp, props));
/** 从标记里取带某个属性的那个标签 */
const tag = (markup, attr) => markup.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))?.[0] ?? null;
const has = (t, re) => !!t && re.test(t);

test("RR1 只读围栏：只读时是 disabled 的 fieldset 且悬停是那一句；读写时不禁用也没有说明；observe 不受影响", async () => {
  const { ReadOnlyFence } = await load("./ReadOnlyFence.tsx", { "./readOnly.css": {}, "./readOnlyKeys": {}, "./io/viewOnly": vo });
  const render = () => html(ReadOnlyFence, { children: React.createElement("button", null, "改") });
  const ro = await under("r", render);
  assert.match(ro, /<fieldset[^>]*class="pc-ro-fence"[^>]*disabled=""/);
  assert.ok(ro.includes(`title="${WHY_MEMBER}"`), "悬停说明是 viewOnlyText()");
  assert.match(ro, /data-pc-ro="1"/);
  const rw = await under("rw", render);
  assert.doesNotMatch(rw, /disabled/);
  assert.doesNotMatch(rw, /title=/);
  const ob = await under("observe", render);
  assert.doesNotMatch(ob, /disabled/, "?observe 那条路不并进围栏");
});

test("RR2 预览工具条：只读时移动、文字置灰（选择可用），说明是那一句；读写、observe 三个都可用", async () => {
  const { ToolBar } = await load("./preview/ToolBar.tsx", {
    "../../store/project": { useStore: (sel) => sel({ project: { width: 1920, height: 1080, fps: 30 } }) },
    "../../ui/icons": { IconCursor: () => null, IconText: () => null, IconMove: () => null },
    "./preview.css": {},
  });
  const render = () => html(ToolBar, { tool: "select", onToolChange() {}, zoom: 1, fitted: true, onFit() {} });
  const buttons = (m) => [...m.matchAll(/<button[^>]*class="pc-pv-tool[^>]*>/g)].map((x) => x[0]);
  const ro = buttons(await under("r", render));
  assert.equal(ro.length, 3);
  assert.doesNotMatch(ro[0], /disabled/);
  assert.match(ro[1], /disabled/);
  assert.match(ro[2], /disabled/);
  assert.ok(ro[1].includes(WHY_MEMBER) && ro[2].includes(WHY_MEMBER));
  for (const access of ["rw", null, "observe"]) {
    const b = buttons(await under(access, render));
    assert.ok(b.every((x) => !/disabled/.test(x)), `${access}：三个工具都可用`);
  }
});

test("RR3 开始页：只读时不放引导动画、预设按钮禁用并说明；读写照旧", async () => {
  const { StartHero } = await load("./right/chat/StartHero.tsx", {
    "../../../ai/agentTabs": { commitDraft() {}, useAgentTabs: () => ({ tabs: [], cleared: false }) },
    "./startHero.css": {},
  });
  const render = () => html(StartHero, { animated: true, onPickPreset() {} });
  const ro = await under("r", render);
  assert.match(ro, /data-pc-start-animated="0"/);
  assert.doesNotMatch(ro, /ai-start-orb/, "没有呼吸的光点");
  assert.doesNotMatch(ro, /ai-start-cue/, "没有指向输入框的箭头");
  assert.ok(ro.includes(WHY_MEMBER));
  assert.match(tag(ro, 'data-pc="ai-start-preset"'), /disabled/);
  const rw = await under("rw", render);
  assert.match(rw, /data-pc-start-animated="1"/);
  assert.match(rw, /ai-start-orb/);
  assert.doesNotMatch(tag(rw, 'data-pc="ai-start-preset"'), /disabled/);
});

test("RR4 左栏预览卡：只有标了 edits 的卡（点它 / 拖它会改项目）在只读时不接点击和拖动；没标的不受影响", async () => {
  const { PreviewCard } = await load("./left/PreviewCard.tsx", {});
  const base = { title: "数字滚动", preview: null, draggable: true, onClick() {}, onDragStart() {}, titleAttr: "点击 = 加到播放头" };
  const card = (m) => m.match(/<div[^>]*class="pc-lib-card[ "][^>]*>/)[0];
  const ro = card(await under("r", () => html(PreviewCard, { ...base, edits: true })));
  assert.match(ro, /draggable="false"/);
  assert.doesNotMatch(ro, /is-click|is-grab/);
  assert.match(ro, /is-readonly/);
  assert.match(ro, /aria-disabled="true"/);
  assert.ok(ro.includes(`数字滚动\n${WHY_MEMBER}`), "悬停：名字 + 那一句");
  const view = card(await under("r", () => html(PreviewCard, { ...base })));
  assert.match(view, /draggable="true"/, "不改项目的卡(没标 edits)照旧");
  assert.match(view, /is-click/);
  const rw = card(await under("rw", () => html(PreviewCard, { ...base, edits: true })));
  assert.match(rw, /draggable="true"/);
  assert.match(rw, /is-click/);
  assert.ok(rw.includes("点击 = 加到播放头"));
  const ob = card(await under("observe", () => html(PreviewCard, { ...base, edits: true })));
  assert.match(ob, /draggable="true"/, "?observe 不并进来");
});

test("RR5 音频条：标了 edits 的在只读时不可拖、不接点击", async () => {
  const { AudioStrip } = await load("./left/library/AudioStrip.tsx", { "../../timeline/AudioWaveform": { loadWave: () => Promise.resolve(null) } });
  const props = { name: "配乐", className: "is-grab", draggable: true, onClick() {}, onDragStart() {}, edits: true, title: "拖动 = 拖到时间轴" };
  const strip = (m) => m.match(/<div[^>]*class="pc-lib-strip[^>]*>/)[0];
  const ro = strip(await under("r", () => html(AudioStrip, props)));
  assert.match(ro, /draggable="false"/);
  assert.match(ro, /is-readonly/);
  assert.doesNotMatch(ro, /is-grab/);
  assert.ok(ro.includes(WHY_MEMBER));
  const rw = strip(await under("rw", () => html(AudioStrip, props)));
  assert.match(rw, /draggable="true"/);
  assert.match(rw, /is-grab/);
});

test("RR6 预览右键菜单：只读时「删除」「引用到 AI」置灰并说明；读写照旧", async () => {
  const { PreviewContextMenu } = await load("./preview/PreviewContextMenu.tsx", {
    "../../store/project": { actions: { removeClip() {} } },
    "../../kernel/registry": { getCard: () => ({ name: "卡" }) },
  });
  const render = () => html(PreviewContextMenu, { x: 1, y: 1, clipId: "c", cardId: "k", onClose() {} });
  const items = (m) => [...m.matchAll(/<div[^>]*class="pc-menu-item"[^>]*>/g)].map((x) => x[0]);
  const ro = items(await under("r", render));
  assert.equal(ro.length, 2);
  assert.ok(ro.every((x) => /aria-disabled="true"/.test(x) && x.includes(WHY_MEMBER)));
  const rw = items(await under("rw", render));
  assert.ok(rw.every((x) => !/aria-disabled/.test(x) && !/title=/.test(x)));
});

test("RR7 序列行头：只读时静音 / 隐藏 / 锁定三个按钮禁用，悬停是那一句；读写、observe 照旧", async () => {
  const icon = () => null;
  const { TrackHeader } = await load("./timeline/TrackHeader.tsx", {
    "../../store/project": { actions: { updateTrack() {}, removeTrack() {} } },
    "./ContextMenu": { ContextMenu: () => null },
    "./TimelineContext": { useTimelineContext: () => ({ trackH: 44 }) },
    "./useReorder": { useReorderDrag: () => ({ start() {} }), useRowOffset: () => ({ dragging: false, y: 0, animated: false }) },
    "../../ui/icons": { IconVolume: icon, IconVolumeMute: icon, IconDrag: icon, IconEye: icon, IconEyeOff: icon, IconLock: icon, IconUnlock: icon },
  });
  const render = () => html(TrackHeader, { track: { id: "t1", name: "序列 1", clips: [], muted: false, hidden: false, locked: false }, index: 0 });
  const buttons = (m) => [...m.matchAll(/<button[^>]*>/g)].map((x) => x[0]);
  const ro = buttons(await under("r", render));
  assert.equal(ro.length, 3);
  assert.ok(ro.every((b) => /disabled/.test(b) && b.includes(`title="${WHY_MEMBER}"`)));
  const rowTitle = await under("r", () => tag(render(), "data-pc-track-header"));
  assert.ok(rowTitle.includes(WHY_MEMBER), "行头「按住上下拖」的说明也换成那一句");
  for (const access of ["rw", "observe"]) {
    const b = buttons(await under(access, render));
    assert.ok(b.every((x) => !/disabled/.test(x)), `${access}：按钮可点`);
    assert.ok(b.some((x) => x.includes("静音序列")), `${access}：悬停还是原来的`);
  }
});

test("RR8 Agent 输入区：只读时编辑框、发送、附件禁用，占位和悬停是那一句、没有引导；停止不能点；读写照旧（只读由面板通过 readOnly 传进来）", async () => {
  const { Composer } = await load("./right/chat/Composer.tsx", {
    "../ModelBar": { ModelBar: () => null },
    "../../../ui/icons": { IconPaperclip: () => null },
    "./attachIcon": { attachIcon: () => "" },
    "./usePopover": { usePopover: () => ({ anchorRef: { current: null }, open: false, setOpen() {}, toggle() {} }) },
    "./composerHeight": { COMPOSER_MAX_RATIO: 0.7, COMPOSER_MIN_H: 80, MESSAGES_MIN_H: 100, persistComposerHeight() {}, resetComposerHeight() {}, setComposerHeight() {}, useComposerHeight: () => null },
    "./chat.css": {},
  });
  const base = {
    text: "", onTextChange() {}, textareaRef: { current: null }, attachments: [], uploading: false, onPickFiles() {}, onRetryAttachment() {},
    onRemoveAttachment() {}, onSubmit() {}, onStop() {}, streaming: false, provider: "claude",
    providers: [{ id: "claude", available: true, label: "Claude Code" }], onSetProvider() {}, config: null,
    menu: { workflowRoles: [], onRunWorkflow() {}, canDiagnose: false, onOpenDiagnostics() {}, onNewChat() {} }, guide: "input",
  };
  const roProps = { readOnly: true, readOnlyReason: WHY_MEMBER };
  const ro = await under("r", () => html(Composer, { ...base, ...roProps }));
  assert.match(tag(ro, 'data-pc="ai-input"'), /disabled/);
  assert.ok(tag(ro, 'data-pc="ai-input"').includes(`placeholder="${WHY_MEMBER}"`));
  assert.match(tag(ro, 'data-pc="ai-send"'), /disabled/);
  assert.ok(tag(ro, 'data-pc="ai-send"').includes(`title="${WHY_MEMBER}"`));
  assert.match(tag(ro, 'data-pc="ai-attach"'), /disabled/);
  assert.match(tag(ro, 'data-pc="ai-new-chat"'), /disabled/, "新对话要给 Agent 发话，也不给");
  assert.match(tag(ro, 'data-pc="ai-auto-workflow"'), /disabled/);
  assert.doesNotMatch(ro, /data-pc-guide/, "没有引导输入的脉动");
  const running = await under("r", () => html(Composer, { ...base, ...roProps, streaming: true, text: "hi" }));
  assert.match(tag(running, 'data-pc="ai-stop"'), /disabled/, "不能停别人的任务");
  assert.match(tag(running, 'data-pc="ai-enqueue"'), /disabled/);
  const rw = await under("rw", () => html(Composer, base));
  assert.doesNotMatch(tag(rw, 'data-pc="ai-input"'), /disabled/);
  assert.doesNotMatch(tag(rw, 'data-pc="ai-send"'), /disabled/);
  assert.match(rw, /data-pc-guide="input"/);
  const ob = await under("observe", () => html(Composer, base));
  assert.doesNotMatch(tag(ob, 'data-pc="ai-input"'), /disabled/, "?observe 不并进来");
  // 已有的「这个对话没有读取权限」那一条原因仍然优先，不被只读这句盖掉
  const revoked = await under("r", () => html(Composer, { ...base, ...roProps, disabled: true, disabledReason: "当前账号已无法读取这个对话" }));
  assert.ok(tag(revoked, 'data-pc="ai-input"').includes('placeholder="当前账号已无法读取这个对话"'));
});
