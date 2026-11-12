/**
 * PromptCut skill catalog binding: exposes PromptCut's bundled `BUILTIN_SKILLS_DIR`
 * alongside the generic `SKILL.md` parser, catalog loader, prompt builder, and `load_skill` tool
 * from `server/harness/skills.mjs`.
 */
import { fileURLToPath } from 'node:url';

/** Skills bundled with the software */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('../agent-skills/', import.meta.url));

export * from '../harness/skills.mjs';
