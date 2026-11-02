/**
 * Side-effect module: strips `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR` inherited by this process
 * as soon as imported, so that child processes started later (editor, prerender process, hosted
 * suite, export) and `FramePipeline` in the same process land in the repository `out/` or a temporary
 * directory explicitly set by caller, rather than the desktop app's `%USERPROFILE%\Videos\PromptCut`.
 * See `user-dirs.mjs` for reasons and usage.
 *
 * Must be the **first** import in an entry script: ES modules are evaluated in import order; if a
 * module preceding it reads these two variables at top level, it will still read external values.
 * Prints a line to stderr reporting what was stripped for troubleshooting.
 *
 * Also sets `PROMPTCUT_NO_PORT_FILE=1`: editors started afterwards will not write to the shared
 * `%TEMP%\promptcut\port.json` (see `user-dirs.mjs` for reason).
 */
import { scrubUserDirEnv, markNoPortFile } from './user-dirs.mjs';

markNoPortFile(process.env);

for (const { key, value } of scrubUserDirEnv(process.env)) {
  console.error(`[no-user-dirs] not inheriting external ${key}=${value} (tests and probes do not write to user directories, see scripts/lib/user-dirs.mjs)`);
}
