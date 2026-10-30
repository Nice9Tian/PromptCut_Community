/**
 * 在线页面逐帧导出的文案(`docs/plan/c10a-contract.md` 第 14 节表 C,照抄)。
 * 「等待上传方」那一条沿用 C6.6(`src/render/mediaTier.ts` 的 `awaitingUploaderMessage`,带缺的素材名)。
 */
/** 渲染节点说渲不了的原因(`server/frame-pipeline.mjs` 的 `exportStreamSpecs`)→ 给用户看的话 */
const NODE_REASON: Record<string, string> = {
  "no-card": "渲染节点上没有这张卡片的代码",
  "no-stream": "这张卡片暂时不能单独渲染",
  "publish-failed": "上一次没渲成的记录还在，再点一次导出会重新渲染",
};

export const ONLINE_EXPORT_TEXT = {
  /** 导出：重卡缺预渲染原尺寸(旧的「逐帧取每张卡的 HTML 快照」那条路的提示;两种新导出都不再走它,等撤快照那一块一并删) */
  missingOriginals: (n: number) => `还有 ${n} 个重卡片段没有预渲染原尺寸，等渲染节点做完再导出。`,
  /** 导出方式(名字是用户 2026-10-13 定的;两句说明是草稿,用户事后改) */
  modeTitle: "选择导出方式",
  fast: "快速导出",
  fastHint: "重卡直接用预渲染好的轨道流画面，速度快，画质略低。",
  full: "完整导出",
  fullHint: "每一帧都重新渲染，画质和桌面版一样，速度慢。",
  /** 导出：这台设备运行不了的卡要渲染节点逐帧渲,还没有节点接 */
  waitingNode: (n: number) => `有 ${n} 个片段的卡片这台设备运行不了，要由渲染节点逐帧渲染好才能导出。现在没有渲染节点在线：请在电脑上打开桌面版并进入这个项目，或等托管方的渲染服务接手。`,
  /** 导出：渲染节点接了,正在准备 */
  planningNode: (n: number) => `渲染节点已接手，正在准备渲染 ${n} 个片段。`,
  /** 导出：渲染节点正在逐帧渲 */
  renderingNode: (done: number, total: number) => `渲染节点正在为这次导出逐帧渲染：已完成 ${done} / ${total} 帧，全部到齐后开始导出。`,
  /** 导出：渲染节点说有片段渲不了 */
  nodeCannot: (n: number, reason: string) => `有 ${n} 个片段渲染节点渲染不了（${NODE_REASON[reason] ?? "渲染节点暂时不可用"}），这次导不出来。`,
  /** 导出：渲染节点没渲完 */
  nodeFailed: (reason: string) => `渲染节点没能渲完这次导出要的画面（${reason}），请重新导出。`,
  /** 导出：渲染节点一直没有进展(节点退出了、或一直没空) */
  nodeStalled: (ms: number) => `渲染节点已经 ${ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`}没有进展（可能已经离线），这次没导出来。请确认渲染节点在线后重新导出。`,
  /** 导出：等渲染节点期间项目被改了 */
  projectChanged: "导出期间项目被改动了，请重新导出。",
  /** 导出：要请渲染节点,但这个页面没有连着项目 */
  noLink: "这个页面没有连着项目，请不到渲染节点，导不出来。",
  /** 导出：浏览器不支持这个尺寸的编码 */
  unsupportedSize: "这个浏览器不能导出这个尺寸的视频，请在电脑上的桌面版或浏览器里导出。",
  /** 导出：没有音频编码 */
  noAudio: "这台设备不能编码声音，导出的视频将没有声音。继续导出？",
  /** 导出：开始 */
  start: "导出期间请保持页面在前台、不要锁屏。",
  progress: (x: number, y: number) => `已导出 ${x}/${y} 帧`,
  done: "导出完成",
  cancelled: "导出已取消",
  failed: (reason: string) => `导出失败：${reason}`,
} as const;
