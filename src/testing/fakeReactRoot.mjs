/**
 * 单测里跑真的 React 渲染(react-dom/client),不要 DOM:组件只渲 `null`,容器是个假的元素。
 * 够测 hook 的订阅、重渲次数、context 翻转;测不了真的 DOM 输出(那要探针)。
 *
 *   const { React, mount } = await import("./fakeReactRoot.mjs");
 *   const root = mount(React.createElement(App));  … await root.flush(); root.unmount();
 *
 * react-dom 在提交阶段要读 `window.event`、`window.HTMLIFrameElement`、容器的 `ownerDocument`,
 * 这里只补这几样。`node --test` 每个测试文件一个进程,补上的 `window` 不会漏到别的文件。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.window ??= { event: undefined, HTMLIFrameElement: class {} };

export const React = require("react");
const { createRoot } = require("react-dom/client");
const { flushSync } = require("react-dom");

const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {}, defaultView: globalThis.window, activeElement: null };

/** 等 React 把排着的同步渲染和 effect 都做完(它们排在微任务和宏任务里) */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export function mount(element) {
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: doc, childNodes: [], firstChild: null, textContent: "",
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
  };
  const errors = [];
  const root = createRoot(container, { onUncaughtError: (e) => errors.push(e), onCaughtError: (e) => errors.push(e) });
  // 挂载、换 props 用 flushSync 当场渲完;store 触发的更新是同步档,排在微任务里,flush() 等得到
  flushSync(() => root.render(element));
  return {
    errors,
    render: (next) => flushSync(() => root.render(next)),
    flush,
    unmount: () => root.unmount(),
  };
}
