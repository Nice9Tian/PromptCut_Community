/*
 * 社区版的空桩：浏览器侧那几个「云端扩展包」别名在没有闭源目录时指到这里。
 *
 * 为什么需要它：浏览器侧的加载点引的是**别名说明符**（`#promptcut-cloud-*`），由
 * `server/vite-plugin-cloud-seams.ts` 在构建时解析。社区版没有闭源目录，别名必须仍然能解析到
 * 一个真实模块，否则 `vite build` 会当场报 "Failed to resolve import" —— 构建期的失败，
 * 不是运行期的优雅降级。所以这里给一个什么都不导出的模块。
 *
 * 各加载点判「装上了没有」看的是 `register` / `registerUi` / `manifest` 这几个导出在不在。
 * 本文件一个都不导出，所以它们一律落回公开侧自带的默认实现（局域网成员源、云端关着、
 * codeVersion 为 null 等等），这正是社区版该有的样子。
 */
export {};
