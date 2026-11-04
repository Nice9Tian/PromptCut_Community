import { getState, subscribe } from "../store/project";
import { setAgentProject } from "./agentTabs";

/**
 * Keep the AI panel's tab manifest in sync with the project currently open in the editor
 * (manifests are separated per project, see agentTabs.ts).
 *
 * Watches editor store project id and `projectLoadToken` (incremented each time a project is
 * loaded): when the project changes or the same project is reloaded, notify agentTabs.
 * Kept in a separate file so agentTabs.ts does not depend on store, allowing Node unit tests to
 * load it directly.
 * Importing this file connects them (railStore.ts imports it); reconciled once on module load,
 * so the first time the manifest is read it is already for the current project.
 */
let lastToken = -1;
let lastId = "";

function follow() {
  const s = getState();
  const id = typeof s.project?.id === "string" ? s.project.id : "";
  if (s.projectLoadToken === lastToken && id === lastId) return;
  lastToken = s.projectLoadToken;
  lastId = id;
  setAgentProject(id);
}

follow();
subscribe(follow);
