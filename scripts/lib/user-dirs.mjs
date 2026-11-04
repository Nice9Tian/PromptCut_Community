/**
 * Tests and probes do not write to user directories: strip environment variables that would route
 * artifacts into user directories.
 *
 * Output directories for editor, prerender process, and render host all follow "env var first,
 * falling back to repo `out/`":
 *   - `PROMPTCUT_EXPORT_DIR`: export root directory; frame store is under `frame-library/`
 *     (`server/vite-plugin-frames.ts`), asset content store is in `media/`, and exports are in
 *     `export-<id>/` (`server/vite-plugin-media.ts`, `vite-plugin-export.ts`);
 *   - `PROMPTCUT_DATA_DIR`: cost records, card overlay layers, synced cards, etc.
 *     (`server/costs-store.mjs`, etc.).
 * The desktop shell sets the former to `%USERPROFILE%\Videos\PromptCut` and the latter to the app
 * data directory, passed to the editor process via environment variables; when an Agent in the
 * desktop app, a terminal opened from the desktop app environment, or a machine has both variables
 * set globally, child processes spawned by tests and probes inherit them as is, and artifacts
 * (especially frame stores) get written into the user's Videos directory.
 *
 * The approach here is to **strip** rather than reset to `<repo>/out`: when the two variables are
 * unset, their defaults are the in-repo development layout (export root `<root>/out`; when data
 * directory is unset, card changes directly modify the checkout directory, and synced cards land in
 * `.pc-work/`); setting them to `<root>/out` would instead alter development behavior. Probes
 * needing temporary directories still set them explicitly.
 *
 * Usage:
 *   - Probes, validation scripts: first line `import './lib/no-user-dirs.mjs'` (adjust relative path
 *     by directory) to strip this process's variables; afterwards, all child processes spawned with
 *     `{ ...process.env }` and `FramePipeline` in the same process no longer inherit them;
 *   - `npm test`: `server/test/global-setup.mjs` strips once in the test runner main process, and
 *     child processes of each test file inherit the stripped environment;
 *   - Gatekeeper: `server/test/no-user-dirs.test.mjs`.
 *
 * Production entries (`cloud/scripts/render-host.mjs` sets explicitly via `--data`, and
 * `scripts/prune-prerender-cache.mjs` is originally a maintenance tool to clean the user frame store)
 * do not use it: they specifically want the user directory.
 *
 * The same entry point sets `PROMPTCUT_NO_PORT_FILE=1` (`markNoPortFile`): as soon as the editor
 * starts up, it writes its port to the shared `%TEMP%\promptcut\port.json` (`server/vite-plugin-ai.ts`),
 * and PromptCut MCP services in user sessions (`server/mcp-server.mjs`) locate the editor by it.
 * If editors started by tests and probes write it, user MCP tool calls would be redirected to the probe
 * instance, or conversely a probe's agent would receive user calls. When this variable is set, the
 * editor will not write; editors started by desktop app or the user running `npm run dev` do not have
 * this variable and write as usual. Gatekeeper: `server/test/port-file.test.mjs`.
 */
import os from 'node:os';
import path from 'node:path';

/** Environment variables that direct artifacts to user directories */
export const USER_DIR_ENV_KEYS = Object.freeze(['PROMPTCUT_EXPORT_DIR', 'PROMPTCUT_DATA_DIR', 'PROMPTCUT_ARTIFACT_DIR']);

/** Desktop app export directory: `<home>/Videos/PromptCut` (`desktop/src-tauri/src/lib.rs`) */
export function userExportDir(home = os.homedir()) {
  return path.join(home, 'Videos', 'PromptCut');
}

/** Whether p is the user export directory itself or under it (case-insensitive on Windows) */
export function isUnderUserExportDir(p, home = os.homedir()) {
  if (!p) return false;
  const norm = (x) => {
    const r = path.resolve(String(x));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const base = norm(userExportDir(home));
  const target = norm(p);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Deletes `USER_DIR_ENV_KEYS` from env (in place; defaults to modifying `process.env` of this
 * process).
 * Windows environment variable names are case-insensitive, which `process.env` handles itself;
 * plain objects are deleted by their original names.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ key: string, value: string }[]} Which entries were deleted
 */
export function scrubUserDirEnv(env = process.env) {
  const removed = [];
  for (const key of USER_DIR_ENV_KEYS) {
    if (env[key] !== undefined) {
      removed.push({ key, value: String(env[key]) });
      delete env[key];
    }
  }
  return removed;
}

/**
 * Fallback for callers setting directories explicitly: throws if any of these variables in env
 * points to the user export directory.
 * @param {Record<string, string | undefined>} env
 * @param {string} [who] Who to report in the error
 */
export function assertNoUserExportDir(env, who = 'child process') {
  for (const key of USER_DIR_ENV_KEYS) {
    if (isUnderUserExportDir(env[key])) {
      throw new Error(`${who}'s ${key}=${env[key]} points to the user's ${userExportDir()}, tests and probes must not write there`);
    }
  }
}

/** When set to `1`, the editor does not write the shared `%TEMP%\promptcut\port.json` (`server/vite-plugin-ai.ts`) */
export const NO_PORT_FILE_ENV = 'PROMPTCUT_NO_PORT_FILE';

/**
 * Sets `PROMPTCUT_NO_PORT_FILE=1` in env (in place; defaults to modifying `process.env` of this
 * process); editors started with `{ ...process.env }` afterwards will not write the shared
 * port.json. Returns the value prior to setting.
 * @param {Record<string, string | undefined>} [env]
 */
export function markNoPortFile(env = process.env) {
  const before = env[NO_PORT_FILE_ENV];
  env[NO_PORT_FILE_ENV] = '1';
  return before;
}
