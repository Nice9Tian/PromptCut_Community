import { tr } from "../i18n/index.ts";
/**
 * 在线页面逐帧导出的文案(`docs/plan/c10a-contract.md` 第 14 节表 C,照抄)。
 * 「等待上传方」那一条沿用 C6.6(`src/render/mediaTier.ts` 的 `awaitingUploaderMessage`,带缺的素材名)。
 */
/** 渲染节点说渲不了的原因(`server/frame-pipeline.mjs` 的 `exportStreamSpecs`)→ 给用户看的话 */
const NODE_REASON: Record<string, string> = {
  "no-card": tr("The render node does not have the code for this card"),
  "no-stream": tr("This card cannot be rendered on its own for now"),
  "publish-failed": tr("A record of the previous failed render is still there; clicking export again will render it again"),
};

export const ONLINE_EXPORT_TEXT = {
  /** 导出：重卡缺预渲染原尺寸(旧的「逐帧取每张卡的 HTML 快照」那条路的提示;两种新导出都不再走它,等撤快照那一块一并删) */
  missingOriginals: (n: number) => tr("{0} heavy card clips have no prerender original size yet. Wait for the render node to finish, then export.", n),
  /** 导出方式(名字是用户 2026-10-13 定的;两句说明是草稿,用户事后改) */
  modeTitle: tr("Choose export method"),
  fast: tr("Fast export"),
  fastHint: tr("Heavy cards use the prerendered track stream frames directly. Fast, slightly lower quality."),
  full: tr("Full export"),
  fullHint: tr("Every frame is rendered again. Same quality as the desktop app, slow."),
  /** 导出：这台设备运行不了的卡要渲染节点逐帧渲,还没有节点接 */
  waitingNode: (n: number) => tr("This device cannot run the cards of {0} clips, so they must be rendered frame by frame by a render node before export. No render node is online now: open the desktop app on a computer and enter this project, or wait for the host's render service to take over.", n),
  /** 导出：渲染节点接了,正在准备 */
  planningNode: (n: number) => tr("A render node has taken over and is preparing to render {0} clips.", n),
  /** 导出：渲染节点正在逐帧渲 */
  renderingNode: (done: number, total: number) => tr("A render node is rendering frame by frame for this export: {0} / {1} frames done. Export starts once all of them arrive.", done, total),
  /** 导出：渲染节点说有片段渲不了 */
  nodeCannot: (n: number, reason: string) => tr("The render node cannot render {0} clips ({1}), so this export is not possible.", n, NODE_REASON[reason] ?? tr("The render node is temporarily unavailable")),
  /** 导出：渲染节点没渲完 */
  nodeFailed: (reason: string) => tr("The render node could not finish rendering the frames this export needs ({0}). Please export again.", reason),
  /** 导出：渲染节点一直没有进展(节点退出了、或一直没空) */
  nodeStalled: (ms: number) => tr("The render node has made no progress for {0} (it may be offline), so this export did not complete. Make sure the render node is online, then export again.", ms >= 60_000 ? tr("{0} min", Math.round(ms / 60_000)) : tr("{0} s", Math.round(ms / 1000))),
  /** 导出：等渲染节点期间项目被改了 */
  projectChanged: tr("The project was changed during export. Please export again."),
  /** 导出：要请渲染节点,但这个页面没有连着项目 */
  noLink: tr("This page is not linked to a project, so it cannot reach a render node and cannot export."),
  /** 导出：浏览器不支持这个尺寸的编码 */
  unsupportedSize: tr("This browser cannot export video at this size. Please export in the desktop app on a computer, or in a browser."),
  /** 导出：没有音频编码 */
  noAudio: tr("This device cannot encode audio, so the exported video will have no sound. Continue exporting?"),
  /** 导出：开始 */
  start: tr("Keep the page in the foreground and do not lock the screen during export."),
  progress: (x: number, y: number) => tr("Exported {0}/{1} frames", x, y),
  done: tr("Export complete"),
  cancelled: tr("Export cancelled"),
  failed: (reason: string) => tr("Export failed: {0}", reason),
} as const;
