/**
 * 这个页面此刻改不改得了项目。两个来源：
 *
 * 1. **`?observe=1` 打开的只读查看页**：不连 MCP 桥（见 src/ai/mcpExecutor.ts），不会把编辑台从工具通道上挤掉；
 *    不能保存（顶栏的保存按钮禁用），不接文档服务、不转码素材。
 * 2. **这个项目只给了只读权限**（`access: 'r'`）：游客进别人的项目就是这样（2026-10-23 用户定），
 *    将来有了只读成员也走这一条。由 `src/editor/sync/syncManager.ts` 进项目时把服务端发的权限交过来。
 *
 * 真正拦住写的是服务端（账号这条路在 `server/account/authority.mjs` 的 `permission`，
 * 文档服务另在 `server/docservice/modules/project.mjs` 再拦一次）。这里只是让界面别让人白做一遍，
 * **不是**权限本身：这一份被绕过去也改不动云端的项目。
 *
 * 原来还有一种带钥匙的只读链接(`?view=`,给 SKILL 无头实例里的 agent 看画面用),随无头实例归档
 * (计划 `docs/plan/agent-workflow-plan.md` A4)。
 */

/** 当前项目给的权限；没进共享项目（本机空间）时是 null，那时能不能改由别处决定 */
let projectAccess: 'r' | 'rw' | null = null;

/** 进项目 / 续会话时把服务端发的权限记下来；离开项目传 null */
export function setProjectAccess(access: 'r' | 'rw' | null): void {
  projectAccess = access === 'r' || access === 'rw' ? access : null;
}

/** 这个项目此刻给的权限 */
export function projectAccessNow(): 'r' | 'rw' | null {
  return projectAccess;
}

/** 只读是因为什么：地址里带 `observe`，还是这个项目只给了只读。都不是就 null */
export function viewOnlyReason(): 'observe' | 'read-only-member' | null {
  if (projectAccess === 'r') return 'read-only-member';
  if (typeof location === "undefined") return null;
  try {
    return new URLSearchParams(location.search).has("observe") ? 'observe' : null;
  } catch {
    return null;
  }
}

export function isViewOnly(): boolean {
  return viewOnlyReason() !== null;
}

/** 改不动时界面上说的那一句。两种只读说法不一样：一种是你自己用只读方式打开的，一种是这个项目没给你写的权限 */
export function viewOnlyText(): string {
  return viewOnlyReason() === 'read-only-member'
    ? '你在这个项目里只能查看，改不了内容。'
    : '这是只读查看模式，改不了这个项目。';
}
