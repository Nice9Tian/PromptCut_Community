/**
 * Starts the local editor in LAN mode (semantics `docs/semantics/mechanism/platforms.md`
 * "The second screen on the LAN").
 *
 *   npm run dev:lan [-- --port 5190 ...]
 *
 * Only two differences from `npm run dev`:
 *   1. Sets `PROMPTCUT_LAN_HOST=1`: the editor binds to `0.0.0.0` (`lanHostPlugin` in `vite.config.ts`),
 *      making document service and asset service mounted on it accessible over LAN; shared projects
 *      hosted locally begin broadcasting once created (`server/vite-plugin-docservice.ts`).
 *   2. Also passes `--host 0.0.0.0` on CLI, lest this command break if `dev` default reverts to
 *      loopback someday.
 *
 * For development and acceptance check only. Packaged desktop apps have the shell launch the editor
 * (passing `--host 127.0.0.1`); whether to bind LAN is handled by the shell.
 *
 * Child processes set `windowsHide` per hard constraints (`docs/semantics/guide_files/constraints.md`);
 * avoid popping terminal windows into the foreground.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rest = process.argv.slice(2);
/** If user provided --port / --host, do not append another, avoiding duplicate args in vite */
const has = (flag) => rest.some((a) => a === flag || a.startsWith(`${flag}=`));
const args = [
  ...(has("--port") ? [] : ["--port", "5190"]),
  ...(has("--strictPort") ? [] : ["--strictPort"]),
  ...(has("--host") ? [] : ["--host", "0.0.0.0"]),
  ...rest,
];

const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [vite, ...args], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, PROMPTCUT_LAN_HOST: "1" },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
