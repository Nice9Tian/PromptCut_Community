import { loadProc } from "./proc";
import { forgetSaveTarget } from "./proc";
import { setActiveDraftId } from "./drafts";
import { actions } from "../../store/project";
import type { Project } from "../../kernel/project";
import { tr } from "../../i18n/index.ts";

/**
 * Open a .proc by disk path (double-clicking a file, the desktop shell's launch arguments, and Skill
 * result links all go through here).
 *
 * The browser cannot read arbitrary paths, so the server does it: it **first copies** the file under
 * .pc-work/opened/ in the project root, then returns the copy's contents. The original file is never
 * locked or modified from start to finish: double-clicking a .proc that someone else is editing
 * will not cause a collision; saving goes through "Save as", where the user picks the target.
 */
export async function openProcPath(filePath: string): Promise<{ project: Project; copy: string }> {
  const res = await fetch("/api/skill/open-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || tr("Cannot open this file ({0})", res.status));
  const project = loadProc(data.text);
  actions.loadProject(project, data.name);
  // The copy belongs to no draft: saving does Save as, so it never overwrites someone else's file
  setActiveDraftId(null);
  forgetSaveTarget();
  return { project, copy: data.copy };
}
