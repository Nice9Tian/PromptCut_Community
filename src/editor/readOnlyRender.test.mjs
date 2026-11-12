/**
 * Rendered appearance of several components in read-only UI: controls that modify the project in
 * read-only projects (guests) are disabled, hovering displays the viewOnlyText() message;
 * read-write (not in a shared project / has write permission) remains unchanged; the legacy
 * `?observe=1` path is unaffected by newly added locks.
 * Each component replaces its heavy dependencies with stubs (same approach as
 * `right/CloudModelBar.test.mjs`), and `useReadOnly` is stubbed to return state based on test
 * permissions.
 * Real behavior of the full page (timeline scrubbing, parameters panel, context menu, project
 * settings dialog, mobile app) see `scripts/probes/guest-readonly-ui-probe.mjs`.
 *
 * Run: node --test src/editor/readOnlyRender.test.mjs
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
const i18n = await import("../i18n/index.ts");
const i18nNames = await import("../i18n/names.ts");
const WHY_MEMBER = "You can only view this project, you cannot change its content.";

/**
 * Run fn under this permission: 'r' = read-only project (guest), 'rw' / null = as usual,
 * 'observe' = ?observe=1
 */
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

/**
 * Compile a .tsx component, replace dependencies, and return exports. `useReadOnly` always emits
 * state based on current permissions
 */
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
  new Function("require", "module", "exports", compiled)((id) => (Object.hasOwn(all, id) ? all[id] : /(^|\/)i18n\/index\.ts$/.test(id) ? i18n : /(^|\/)i18n\/names\.ts$/.test(id) ? i18nNames : actualRequire(id)), mod, mod.exports);
  return mod.exports;
}
const html = (Comp, props) => renderToStaticMarkup(React.createElement(Comp, props));
/** Extract the tag with a specific attribute from markup */
const tag = (markup, attr) => markup.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))?.[0] ?? null;
const has = (t, re) => !!t && re.test(t);

test("RR1 Read-only fence: when read-only it is a disabled fieldset and the hover text is that one sentence; when read-write it is not disabled and has no description; observe is unaffected", async () => {
  const { ReadOnlyFence } = await load("./ReadOnlyFence.tsx", { "./readOnly.css": {}, "./readOnlyKeys": {}, "./io/viewOnly": vo });
  const render = () => html(ReadOnlyFence, { children: React.createElement("button", null, "Edit") });
  const ro = await under("r", render);
  assert.match(ro, /<fieldset[^>]*class="pc-ro-fence"[^>]*disabled=""/);
  assert.ok(ro.includes(`title="${WHY_MEMBER}"`), "The hover text is viewOnlyText()");
  assert.match(ro, /data-pc-ro="1"/);
  const rw = await under("rw", render);
  assert.doesNotMatch(rw, /disabled/);
  assert.doesNotMatch(rw, /title=/);
  const ob = await under("observe", render);
  assert.doesNotMatch(ob, /disabled/, "The ?observe path is not merged into the fence");
});

test("RR2 Preview toolbar: when read-only, move and text are grayed out (select stays available) and the description is that one sentence; with read-write and observe, all three are available", async () => {
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
    assert.ok(b.every((x) => !/disabled/.test(x)), `${access}: all three tools are available`);
  }
});

test("RR3 Start page: when read-only, the guide animation is not shown and the preset buttons are disabled with an explanation; read-write unchanged", async () => {
  const { StartHero } = await load("./right/chat/StartHero.tsx", {
    "../../../ai/agentTabs": { commitDraft() {}, useAgentTabs: () => ({ tabs: [], cleared: false }) },
    "./startHero.css": {},
  });
  const render = () => html(StartHero, { animated: true, onPickPreset() {} });
  const ro = await under("r", render);
  assert.match(ro, /data-pc-start-animated="0"/);
  assert.doesNotMatch(ro, /ai-start-orb/, "No breathing orb");
  assert.doesNotMatch(ro, /ai-start-cue/, "No arrow pointing at the input box");
  assert.ok(ro.includes(WHY_MEMBER));
  assert.match(tag(ro, 'data-pc="ai-start-preset"'), /disabled/);
  const rw = await under("rw", render);
  assert.match(rw, /data-pc-start-animated="1"/);
  assert.match(rw, /ai-start-orb/);
  assert.doesNotMatch(tag(rw, 'data-pc="ai-start-preset"'), /disabled/);
});

test("RR4 Left rail preview card: only cards marked with edits (clicking or dragging them changes the project) do not accept clicks and drags when read-only; unmarked cards are unaffected", async () => {
  const { PreviewCard } = await load("./left/PreviewCard.tsx", {});
  const base = { title: "Number ticker", preview: null, draggable: true, onClick() {}, onDragStart() {}, titleAttr: "Click = add to the playhead" };
  const card = (m) => m.match(/<div[^>]*class="pc-lib-card[ "][^>]*>/)[0];
  const ro = card(await under("r", () => html(PreviewCard, { ...base, edits: true })));
  assert.match(ro, /draggable="false"/);
  assert.doesNotMatch(ro, /is-click|is-grab/);
  assert.match(ro, /is-readonly/);
  assert.match(ro, /aria-disabled="true"/);
  assert.ok(ro.includes(`Number ticker\n${WHY_MEMBER}`), "Hover: name + that one sentence");
  const view = card(await under("r", () => html(PreviewCard, { ...base })));
  assert.match(view, /draggable="true"/, "Cards that do not change the project (not marked with edits) are unchanged");
  assert.match(view, /is-click/);
  const rw = card(await under("rw", () => html(PreviewCard, { ...base, edits: true })));
  assert.match(rw, /draggable="true"/);
  assert.match(rw, /is-click/);
  assert.ok(rw.includes("Click = add to the playhead"));
  const ob = card(await under("observe", () => html(PreviewCard, { ...base, edits: true })));
  assert.match(ob, /draggable="true"/, "?observe is not merged in");
});

test("RR5 Audio bar: items marked with edits cannot be dragged and do not accept clicks when read-only", async () => {
  const { AudioStrip } = await load("./left/library/AudioStrip.tsx", { "../../timeline/AudioWaveform": { loadWave: () => Promise.resolve(null) } });
  const props = { name: "Background music", className: "is-grab", draggable: true, onClick() {}, onDragStart() {}, edits: true, title: "Drag = drag onto the timeline" };
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

test("RR6 Preview context menu: when read-only, \"Delete\" and \"Quote to AI\" are grayed out with an explanation; read-write unchanged", async () => {
  const { PreviewContextMenu } = await load("./preview/PreviewContextMenu.tsx", {
    "../../store/project": { actions: { removeClip() {} } },
    "../../kernel/registry": { getCard: () => ({ name: "Card" }) },
  });
  const render = () => html(PreviewContextMenu, { x: 1, y: 1, clipId: "c", cardId: "k", onClose() {} });
  const items = (m) => [...m.matchAll(/<div[^>]*class="pc-menu-item"[^>]*>/g)].map((x) => x[0]);
  const ro = items(await under("r", render));
  assert.equal(ro.length, 2);
  assert.ok(ro.every((x) => /aria-disabled="true"/.test(x) && x.includes(WHY_MEMBER)));
  const rw = items(await under("rw", render));
  assert.ok(rw.every((x) => !/aria-disabled/.test(x) && !/title=/.test(x)));
});

test("RR7 Track row header: when read-only, the mute / hide / lock buttons are disabled and the hover text is that one sentence; read-write and observe unchanged", async () => {
  const icon = () => null;
  const { TrackHeader } = await load("./timeline/TrackHeader.tsx", {
    "../../kernel/project": { activeCutKind: () => "2d" },
    "../../store/project": { actions: { updateTrack() {}, removeTrack() {} }, useStore: (sel) => sel({ project: {} }) },
    "./ContextMenu": { ContextMenu: () => null },
    "./TimelineContext": { useTimelineContext: () => ({ trackH: 44 }) },
    "./useReorder": { useReorderDrag: () => ({ start() {} }), useRowOffset: () => ({ dragging: false, y: 0, animated: false }) },
    "../../ui/icons": { IconVolume: icon, IconVolumeMute: icon, IconDrag: icon, IconEye: icon, IconEyeOff: icon, IconLock: icon, IconUnlock: icon },
  });
  const render = () => html(TrackHeader, { track: { id: "t1", name: "Track 1", clips: [], muted: false, hidden: false, locked: false }, index: 0 });
  const buttons = (m) => [...m.matchAll(/<button[^>]*>/g)].map((x) => x[0]);
  const ro = buttons(await under("r", render));
  assert.equal(ro.length, 3);
  assert.ok(ro.every((b) => /disabled/.test(b) && b.includes(`title="${WHY_MEMBER}"`)));
  const rowTitle = await under("r", () => tag(render(), "data-pc-track-header"));
  assert.ok(rowTitle.includes(WHY_MEMBER), "The row header's \"Hold and drag up or down\" description is also replaced with that one sentence");
  for (const access of ["rw", "observe"]) {
    const b = buttons(await under(access, render));
    assert.ok(b.every((x) => !/disabled/.test(x)), `${access}: the buttons are clickable`);
    assert.ok(b.some((x) => x.includes("Mute track")), `${access}: the hover text is still the original`);
  }
});

test("RR8 Agent input area: when read-only, the edit box, send and attachment controls are disabled, the placeholder and hover text are that one sentence, and there is no guidance; stop cannot be clicked; read-write unchanged (read-only is passed in by the panel through readOnly)", async () => {
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
  assert.match(tag(ro, 'data-pc="ai-new-chat"'), /disabled/, "A new chat has to send a message to the Agent, so it is not allowed either");
  assert.match(tag(ro, 'data-pc="ai-auto-workflow"'), /disabled/);
  assert.doesNotMatch(ro, /data-pc-guide/, "No pulsing input guide");
  const running = await under("r", () => html(Composer, { ...base, ...roProps, streaming: true, text: "hi" }));
  assert.match(tag(running, 'data-pc="ai-stop"'), /disabled/, "Cannot stop other people's tasks");
  assert.match(tag(running, 'data-pc="ai-enqueue"'), /disabled/);
  const rw = await under("rw", () => html(Composer, base));
  assert.doesNotMatch(tag(rw, 'data-pc="ai-input"'), /disabled/);
  assert.doesNotMatch(tag(rw, 'data-pc="ai-send"'), /disabled/);
  assert.match(rw, /data-pc-guide="input"/);
  const ob = await under("observe", () => html(Composer, base));
  assert.doesNotMatch(tag(ob, 'data-pc="ai-input"'), /disabled/, "?observe is not merged in");
  // Existing reason "No read permission for this chat" still takes precedence, not overwritten by
  // read-only
  const revoked = await under("r", () => html(Composer, { ...base, ...roProps, disabled: true, disabledReason: "The current account can no longer read this chat" }));
  assert.ok(tag(revoked, 'data-pc="ai-input"').includes('placeholder="The current account can no longer read this chat"'));
});
