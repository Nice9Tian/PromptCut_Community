/**
 * 侧栏里能右键、能拖的三种东西。
 *
 * 单放一个文件:`RowMenu.tsx` 和 `ProjectSidebar.tsx` 都要它,谁 import 谁都会绕成环。
 */
export type TreeKind = "group" | "project" | "chat";
