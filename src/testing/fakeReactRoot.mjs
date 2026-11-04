/**
 * Run real React rendering (react-dom/client) in unit tests without DOM: components render only
 * `null`, container is a fake element. Sufficient to test hook subscriptions, re-render counts,
 * and context toggles; cannot test real DOM output (that requires probes).
 *
 *   const { React, mount } = await import("./fakeReactRoot.mjs");
 *   const root = mount(React.createElement(App));  … await root.flush(); root.unmount();
 *
 * react-dom reads `window.event`, `window.HTMLIFrameElement`, container's `ownerDocument` during
 * commit phase; only polyfill these few here. `node --test` runs one process per test file, so
 * polyfilled `window` will not leak to other files.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.window ??= { event: undefined, HTMLIFrameElement: class {} };

export const React = require("react");
const { createRoot } = require("react-dom/client");
const { flushSync } = require("react-dom");

const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {}, defaultView: globalThis.window, activeElement: null };

/** Wait for React to finish queued synchronous renders and effects (queued in microtasks and macrotasks) */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export function mount(element) {
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: doc, childNodes: [], firstChild: null, textContent: "",
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
  };
  const errors = [];
  const root = createRoot(container, { onUncaughtError: (e) => errors.push(e), onCaughtError: (e) => errors.push(e) });
  // Mount and prop changes render immediately with flushSync; store-triggered updates are in
  // synchronous tier, queued in microtasks, flush() can wait for them
  flushSync(() => root.render(element));
  return {
    errors,
    render: (next) => flushSync(() => root.render(next)),
    flush,
    unmount: () => root.unmount(),
  };
}
