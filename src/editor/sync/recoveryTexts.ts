/**
 * 打开旧云端项目文件、缺失素材这两件事里给用户看的字，集中在这一处。
 *
 * 这些都是界面文字（一级语义），任务书 `docs/plan/account-binding-task.md` 里没有逐字的原文，
 * 现在的写法是草稿，等用户定稿后只改这一个文件（草稿与出处列在 `docs/reports/AGENT-v18-missing.md`「要用户定的事」）。
 * 画面占位上的「找不到素材xxx」是任务书原文，在 `src/render/MissingMaterial.tsx`，不在这里。
 */
export const CLOUD_GONE_TEXT = {
  /** 转成本地项目后提示一次的窗口 */
  title: "云端项目已不存在",
  body: "这个文件对应的云端项目已经从云端删除。文件里保存的内容已转成一个本地项目，多用户协作已关闭，需要时可以在项目设置里重新打开。",
  keep: "原文件没有改动；保存时会另存为一个新文件。",
  ok: "知道了",
  /** 协作状态条：服务明确答了没有这个项目，但拿不到「已删除」的证明 */
  missingUnconfirmed: "云端没有找到这个项目，也无法确认它已被删除；本地内容已保留，没有转成本地项目。",
  /** 协作状态条：回来的「已删除」证明核对不过 */
  proofRejected: "云端返回的删除证明核对不通过，可能连到了别的服务；本地内容已保留，没有转成本地项目。",
} as const;

export const UNSUPPORTED_PROC_TEXT = (version: unknown) =>
  `这个项目文件是更新版本的 PromptCut 保存的（格式版本 ${String(version)}），这一版打不开；原文件没有改动。`;

export const MISSING_MATERIALS_TEXT = {
  title: "找不到素材",
  missing: (n: number) => `下面 ${n} 个素材在这台电脑上找不到文件。用到它们的片段位置和编排都保留着，画面显示「找不到素材」和文件名，声音放一次「找不到素材」的提示音；把文件导入回来后会自动恢复。`,
  changed: "原位置的文件内容已经变了",
  ok: "知道了",
} as const;
