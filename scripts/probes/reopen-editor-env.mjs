/** Environment for task-owned editors; provider configuration and credentials stay isolated. */
import '../lib/no-user-dirs.mjs';
import path from 'node:path';

export function reopenEditorEnv(dataDir, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(PROMPTCUT_|PC_REOPEN_|VITE_)/i.test(key) && !/(?:TOKEN|KEY|PASSWORD|SECRET)/i.test(key)));
  return { ...env,
    PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_DOCSERVICE_DATA: path.join(dataDir, 'docservice'),
    PROMPTCUT_EXPORT_DIR: path.join(dataDir, 'export'), PROMPTCUT_ARTIFACT_DIR: path.join(dataDir, 'artifacts'),
    PROMPTCUT_PROJECTS_DIR: path.join(dataDir, 'drafts'), PROMPTCUT_AI_CONFIG: path.join(dataDir, 'settings/ai.json'),
    PROMPTCUT_CLI_HOME: path.join(dataDir, 'settings/cli'), PROMPTCUT_AGY_SETTINGS: path.join(dataDir, 'settings/agy.json'),
    PROMPTCUT_CLAUDE_CONFIG: path.join(dataDir, 'settings/claude.json'), PROMPTCUT_CODEX_CONFIG: path.join(dataDir, 'settings/codex.toml'),
    PROMPTCUT_SKILL_DIR: path.join(dataDir, 'skills'), PROMPTCUT_NO_PORT_FILE: '1', ...overrides };
}
