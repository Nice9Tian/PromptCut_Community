/**
 * `spawn_agent` preset roles (plan `docs/plan/agent-workflow-plan.md` A3; `user-workflow.md`
 * "Multi-Agent": lead Agent can attach preset roles when spawning other Agents).
 *
 * Role prompts are the .md files under `src/ai/roles/` (page "One-click effects" also reads them,
 * `src/ai/roles/index.ts`), read on server using identical rules: H1 heading is Chinese name, text
 * below heading is prompt, leading frontmatter is stripped. After split-work mode was archived,
 * "Production Manager" (manager.md), which only handled breakdown and scheduling, was deleted along
 * with it; spawnable roles are listed below in `SPAWN_ROLE_IDS`.
 *
 * Subagent role prompt is concatenated into its system prompt on every round (`/api/ai/chat` in
 * `vite-plugin-ai.ts`), not just first message: running multiple rounds makes it most prone to
 * forgetting who it is.
 */
import fs from 'node:fs';

import { SPAWN_ROLE_IDS, SPAWN_ROLE_HINTS } from './spawn-roles.mjs';
import { ROLES_DIR } from './ssr-host.mjs';

export { SPAWN_ROLE_IDS, SPAWN_ROLE_HINTS };

function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length) : raw;
}

/** Reads a role; returns null if file is missing */
export function loadRole(id) {
  if (!SPAWN_ROLE_IDS.includes(id)) return null;
  let raw;
  try {
    raw = fs.readFileSync(new URL(`${id}.md`, ROLES_DIR), 'utf8');
  } catch {
    return null;
  }
  const lines = splitFrontmatter(raw).split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('# '));
  const name = at >= 0 ? lines[at].slice(2).trim() : id;
  const prompt = (at >= 0 ? lines.slice(at + 1) : lines).join('\n').trim();
  return prompt ? { id, name, prompt } : null;
}

/** Role id → Chinese name (used in tab names, prompts); returns unrecognized as-is */
export function roleName(id) {
  return loadRole(id)?.name ?? (typeof id === 'string' ? id : '');
}
