/**
 * The three kinds of things in the sidebar that can be right-clicked and dragged.
 *
 * Kept in a file of its own: both `RowMenu.tsx` and `ProjectSidebar.tsx` need it, and whichever imports
 * the other would create an import cycle.
 */
export type TreeKind = "group" | "project" | "chat";
