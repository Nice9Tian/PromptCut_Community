import { tr } from "../../i18n/index.ts";
/**
 * 打开旧云端项目文件、缺失素材这两件事里给用户看的字，集中在这一处。
 *
 * 这些都是界面文字（一级语义），任务书 `docs/plan/account-binding-task.md` 里没有逐字的原文，
 * 现在的写法是草稿，等用户定稿后只改这一个文件（草稿与出处列在 `docs/reports/AGENT-v18-missing.md`「要用户定的事」）。
 * 画面占位上的「找不到素材xxx」是任务书原文，在 `src/render/MissingMaterial.tsx`，不在这里。
 */
export const CLOUD_GONE_TEXT = {
  /** 转成本地项目后提示一次的窗口 */
  title: tr("Cloud project no longer exists"),
  body: tr("The cloud project for this file has been deleted from the cloud. The content saved in the file was converted into a local project and multi-user collaboration is turned off; you can turn it back on in project settings if needed."),
  keep: tr("The original file is unchanged; saving will save it as a new file."),
  ok: tr("Got it"),
  /** 协作状态条：服务明确答了没有这个项目，但拿不到「已删除」的证明 */
  missingUnconfirmed: tr("The cloud could not find this project and cannot confirm it was deleted; local content has been kept and was not converted to a local project."),
  /** 协作状态条：回来的「已删除」证明核对不过 */
  proofRejected: tr("The deletion proof returned by the cloud failed verification, possibly because it connected to a different service; local content has been kept and was not converted to a local project."),
} as const;

export const UNSUPPORTED_PROC_TEXT = (version: unknown) =>
  tr("This project file was saved by a newer version of PromptCut (format version {0}) and cannot be opened by this version; the original file was not changed.", String(version));

export const MISSING_MATERIALS_TEXT = {
  title: tr("Media not found"),
  missing: (n: number) => tr("The files for the {0} media items below could not be found on this computer. The positions and arrangement of the clips that use them are kept; the picture shows \"Media not found\" and the file name, and the audio plays a \"Media not found\" prompt tone once. Import the files back and they will be restored automatically.", n),
  changed: tr("The file at the original location has changed"),
  ok: tr("Got it"),
} as const;
