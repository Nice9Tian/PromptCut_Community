/**
 * Creativity level (`docs/semantics/user-workflow.md` "Creativity level"): determines how deeply an
 * Agent chat can make modifications.
 *
 *   - Low: only use existing cards and effects, only modify parameters; measurement only uses
 *     built-in methods;
 *   - Medium: based on existing cards and effects, can modify their code or expressions, but cannot
 *     create new ones;
 *   - High: can create arbitrary cards and effects, can write custom measurement code.
 *
 * Projects have a default level (`Project.creativity`), chosen in project settings, factory default
 * is "high": when the field is missing (legacy projects), always treat as "high".
 * Each chat in the AI panel defaults to the project's level and can be modified individually
 * (override values only exist in the local tab, plan `agent-workflow-plan.md` section 4 item 3);
 * desktop app sessions follow the project's level.
 *
 * Why `.mjs`: pages (project settings, AI panel) and the server (tool entry gate
 * `server/agent/creativity-gate.mjs`) use the same level definition, and Node cannot import `.ts`
 * directly.
 */

/** From low to high */
export const CREATIVITY_LEVELS = Object.freeze(['low', 'medium', 'high']);

/** Factory level, also the level when the project lacks this field */
export const DEFAULT_CREATIVITY = 'high';

/** The human-readable name */
export const CREATIVITY_LABEL = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High' });

/** Short description on options (dropdown cannot fit full sentences) */
export const CREATIVITY_SHORT = Object.freeze({ low: 'Parameters only', medium: 'Can edit code and expressions', high: 'Can create new cards and effects' });

/** What each tier allows (shared by project settings, AI panel prompts, and gate errors) */
export const CREATIVITY_HINT = Object.freeze({
  low: 'Use only existing cards and effects, change only parameters; measure only with built-in methods',
  medium: 'May change the code or expressions of existing cards and effects, but not create new ones',
  high: 'May create any card and effect, and may write custom measurement code',
});

/** Returns valid levels as is, returns null for others (missing, typos, legacy data) */
export function normalizeCreativity(value) {
  return typeof value === 'string' && CREATIVITY_LEVELS.includes(value) ? value : null;
}

/** Project default level: falls back to factory "high" when field is missing or unrecognized */
export function projectCreativity(project) {
  return normalizeCreativity(project?.creativity) ?? DEFAULT_CREATIVITY;
}

/** Effective level for a chat: chat's own override takes precedence, otherwise follows the project */
export function effectiveCreativity(override, projectLevel) {
  return normalizeCreativity(override) ?? normalizeCreativity(projectLevel) ?? DEFAULT_CREATIVITY;
}

/** Level index (low 0, medium 1, high 2); unrecognized treated as "high" */
export function creativityRank(level) {
  const i = CREATIVITY_LEVELS.indexOf(level);
  return i < 0 ? CREATIVITY_LEVELS.length - 1 : i;
}

/** Whether `current` satisfies `required` */
export function creativityAllows(current, required) {
  return creativityRank(normalizeCreativity(current) ?? DEFAULT_CREATIVITY) >= creativityRank(normalizeCreativity(required) ?? 'low');
}
