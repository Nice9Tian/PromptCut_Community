/**
 * 舞台(`Stage.tsx`)上这台设备跑不了的卡(C10 契约第 9 节,2026-09-29 用户改语义)。服务端渲染出 HTML 来核,跑:
 *   node --test src/render/stageLocalOnly.test.mjs
 *
 *   SL-01 在线浏览器模式:构建时就在包里的用户卡照常挂组件(2026-10-21 用户定「暂停时渲染出精确的帧」,
 *         不按档挡本页能运行的卡);同步来的用户卡没有定义时不挂组件,包裹层照内置重卡的路子挂流平面与抑制占位
 *         (撤快照后无快照平面);占位槽位默认 `hidden`(进显隐调度),一律是沙漏(`awaiting`),预览缩到多小都没有
 *         「需要本地 PC 渲染辅助」(2026-10-21 用户定撤掉);沙漏按预览缩放补偿(`fit`);两边都没有的 id 不画
 *   SL-02 模式关着(桌面、导出、预渲染):用户卡、素材效果卡照常挂组件,同步表不起作用,没有 `unsupported`
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function withStage(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const R = await server.ssrLoadModule("/src/kernel/registry.ts");
    const H = await server.ssrLoadModule("/src/render/placeholderHost.ts");
    const P = await server.ssrLoadModule("/src/kernel/project.ts");
    const S = await server.ssrLoadModule("/src/render/Stage.tsx");
    const marker = (id) => function Marker() { return React.createElement("i", { "data-test-component": id }); };
    R.resetCards();
    R.registerCards([
      { id: "builtin", name: "内置", defaults: {}, controls: [], frameMode: "direct", Component: marker("builtin") },
      { id: "mine", name: "构建时用户卡", defaults: {}, controls: [], frameMode: "direct", Component: marker("mine") },
    ]);
    R.setUserCardSources({ mine: "" }, { mine: "mine" });
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡" }, { id: "synced-two", name: "同步卡二" }]);
    const clips = [["b", "builtin"], ["u", "mine"], ["s", "synced-card"], ["v", "synced-two"], ["x", "unknown-card"]].map(([id, cardId]) => ({ id, cardId, start: 0, end: 4, params: {} }));
    const project = { version: 1, id: "p", name: "p", width: 640, height: 360, fps: 30, duration: 4, media: [], tracks: clips.map((c, i) => ({ id: `t${i}`, name: "t", clips: [c] })) };
    const timeline = P.flattenOverlay(project);
    const render = (props = {}) => renderToStaticMarkup(React.createElement(S.Stage, { timeline, t: 1, playToken: 1, ...props }));
    await fn({ R, H, render, marker });
  } finally {
    await server.close();
  }
}

/** 某个片段的包裹层(到下一个包裹层为止) */
const wrapOf = (html, id) => html.match(new RegExp(`<div data-pc-clip="${id}"[\\s\\S]*?(?=<div data-pc-clip=|$)`))?.[0] ?? null;

test("SL-01 在线:本页运行不了的卡不挂组件,照挂流平面与抑制占位,占位一律是沙漏;能运行的用户卡照常挂;未知 id 不画", () => withStage(async ({ R, H, render, marker }) => {
  H.setOnlineBrowserMode(true);
  H.setPlaceholdersEnabled(true);
  try {
    const props = { snapshots: new Map([["s", "<p>snap-s</p>"]]), suppressed: new Set(["u", "s", "v"]), streamPlanes: [{ clipIds: ["v"] }], awaiting: new Set(), settling: new Map() };
    const html = render(props);
    const b = wrapOf(html, "b"), s = wrapOf(html, "s"), v = wrapOf(html, "v");
    assert.match(b, /data-test-component="builtin"/, "内置卡照常挂组件");
    // 2026-10-06(online-card-exec-contract.md 第 6 节):构建时就在包里的用户卡是页面自己的代码,照内置卡挂组件
    assert.match(wrapOf(html, "u"), /data-test-component="mine"/, "构建时的用户卡照常挂组件");
    // 2026-10-21 起不按档挡本页能运行的用户卡(停下时要画出精确的帧);原来那道按档的开关 2026-10-22 删掉
    const lowHtml = render(props);
    // 同步来的卡在舞台里载入成功(运行时注册表里有定义):照常挂组件;没载入的(v)照旧不挂
    R.setRuntimeCards([{ id: "synced-card", name: "同步卡", defaults: {}, controls: [], frameMode: "direct", Component: marker("synced") }]);
    const live = render({ snapshots: new Map(), suppressed: new Set(), awaiting: new Set(), settling: new Map() });
    assert.match(wrapOf(live, "s"), /data-test-component="synced"/, "载入成功的同步卡挂组件");
    assert.doesNotMatch(wrapOf(live, "v"), /data-test-component/, "没载入的同步卡不挂组件");
    R.setRuntimeCards([]);
    assert.doesNotMatch(v, /data-test-component/, "没有定义的同步卡不挂组件");
    assert.match(v, /data-pc-stream-plane=""/, "跑不了的卡照挂流平面");
    // 撤快照后:没有流的同步卡(没有定义)由 suppressed 占位接管,不再挂快照平面
    assert.doesNotMatch(s, /data-pc-snapshot-plane/, "同步卡撤除快照平面");
    assert.match(s, /class="pc-suppressed"/, "同步卡(没有定义)由 suppressed 占位接管");
    for (const w of [s, v]) {
      assert.match(w, /data-pc-placeholder-slot="" hidden=""/, "槽位默认藏着,由显隐调度切");
      assert.doesNotMatch(w, /data-pc-placeholder-fixed/, "不是常驻槽位");
      assert.match(w, /data-pc-placeholder-reason="awaiting"/, "跑不了的卡是沙漏(结果由渲染节点出)");
    }
    // 预览缩放 25%:沙漏屏幕上保持原大小(28 × 4 舞台像素);任何情况下都没有「需要本地 PC 渲染辅助」
    H.setPlaceholderViewScale(0.25);
    const html2 = render(props);
    for (const id of ["s", "v", "b"]) {
      const w = wrapOf(html2, id);
      assert.match(w, /data-pc-placeholder-kind="badge"[^>]*width:28px;height:28px;transform:scale\(4\)/, `${id} 的沙漏按预览缩放补偿`);
    }
    for (const doc of [html, lowHtml, html2]) assert.doesNotMatch(doc, /unsupported|需要本地 PC 渲染辅助/);
    H.setPlaceholderViewScale(1);
    assert.equal(wrapOf(html, "x"), null, "两边都没有的 id 不画");
    // 后台舞台(占位关着):照样不挂组件,也没有槽位
    H.setPlaceholdersEnabled(false);
    const back = render({ snapshots: new Map(), suppressed: new Set() });
    assert.doesNotMatch(wrapOf(back, "v"), /data-test-component|data-pc-placeholder-slot/);
  } finally {
    H.setPlaceholderViewScale(1);
    R.setRuntimeCards([]);
    H.setOnlineBrowserMode(false);
    H.setPlaceholdersEnabled(false);
  }
}));

test("SL-02 模式关着:用户卡照常挂组件,同步表不起作用,没有 unsupported", () => withStage(async ({ H, render }) => {
  H.setOnlineBrowserMode(false);
  for (const placeholders of [false, true]) {
    H.setPlaceholdersEnabled(placeholders);
    const html = render(placeholders ? { snapshots: new Map(), suppressed: new Set(["u"]) } : {});
    assert.match(wrapOf(html, "u"), /data-test-component="mine"/);
    assert.equal(wrapOf(html, "s"), null, "同步卡本机没有定义:桌面不画");
    assert.doesNotMatch(html, /unsupported/);
  }
  // 桌面预览也按预览缩放补偿沙漏(屏幕上约 28 像素),不补偿这一层自己的缩放
  H.setPlaceholdersEnabled(true);
  H.setPlaceholderViewScale(0.5);
  try {
    const html = render({ snapshots: new Map(), suppressed: new Set(["u"]) });
    assert.match(wrapOf(html, "u"), /data-pc-placeholder-kind="badge"[^>]*width:28px;height:28px;transform:scale\(2\)/);
  } finally {
    H.setPlaceholderViewScale(1);
    H.setPlaceholdersEnabled(false);
  }
}));
