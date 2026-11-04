/**
 * PromptCut: produce a complete release: installer + update patch.
 *
 * A single release produces two artifacts, placed under desktop/release/:
 *   PromptCut-<version>-setup.exe   Full installer (about 1 GB, use for fresh installs or shell changes)
 *   PromptCut-patch-<version>.zip   Update patch (only the Node half, usually a few MB)
 *
 *   node scripts/build-release.mjs                # Full suite
 *   node scripts/build-release.mjs --from-head    # Source from HEAD, ignoring uncommitted changes
 *   node scripts/build-release.mjs --patch-only   # Patch only, skip Rust compilation
 *   node scripts/build-release.mjs --skip-runtime # runtime already prepared, compile and package directly
 *   node scripts/build-release.mjs --with-deps    # Force patch to include node_modules
 *   node scripts/build-release.mjs --installer-only # Full installer only when shell/Python runtime changes
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const BUNDLE_DIR = path.join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle", "nsis");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
if (has("--installer-only") && has("--patch-only")) throw new Error("--installer-only and --patch-only are mutually exclusive");
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0);

function run(label, cmd, args, opts = {}) {
  console.log(`\n── ${label} ──`);
  const r = spawnSync(cmd, args, { windowsHide: true, cwd: DESKTOP_DIR, stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`[FAIL] ${label} failed (exit code ${r.status})`);
    process.exit(1);
  }
}

const tauriConf = JSON.parse(
  fs.readFileSync(path.join(DESKTOP_DIR, "src-tauri", "tauri.conf.json"), "utf-8")
);
const shellVersion = tauriConf.version;
/** NSIS uses this to name the installer. Read from config, do not write another literal when building filenames below */
const productName = tauriConf.productName || "PromptCut";

console.log("PromptCut build-release");
console.log(`  Shell version: ${shellVersion} (the Rust half, changes only when a rebuild is needed)`);

/**
 * --from-head: Source is taken from a temporary worktree at HEAD, not the current workspace.
 *
 * When several people share a workspace, other people's uncommitted changes just sit there;
 * packaging directly bundles them together into the release, leaving no way afterwards to determine
 * which code version the artifact corresponds to. Taking source from HEAD guarantees the artifact
 * matches a commit.
 *
 * Only source code goes through the worktree: Chrome / ffmpeg / Python / Rust build caches still use
 * the existing copies under desktop/, so no extra download or compilation time is incurred.
 */
let sourceArgs = [];
let worktree = null;
if (has("--from-head")) {
  const dirty = spawnSync("git", ["status", "--porcelain"], { windowsHide: true, cwd: PROJECT_ROOT, encoding: "utf8" }).stdout || "";
  const head = (spawnSync("git", ["rev-parse", "--short", "HEAD"], { windowsHide: true, cwd: PROJECT_ROOT, encoding: "utf8" }).stdout || "").trim();
  worktree = path.join(DESKTOP_DIR, ".cache", "release-src");
  console.log(`\n── Fetching source from HEAD (${head}) ──`);
  const excluded = dirty.split(/\r?\n/).filter((l) => l.trim() && !/^\?\?/.test(l));
  if (excluded.length) {
    console.log(`  ${excluded.length} files in the working tree are uncommitted and are not included in this release:`);
    for (const l of excluded.slice(0, 12)) console.log(`    ${l.trim()}`);
    if (excluded.length > 12) console.log(`    ...and ${excluded.length - 12} more`);
  }
  spawnSync("git", ["worktree", "remove", "--force", worktree], { windowsHide: true, cwd: PROJECT_ROOT, stdio: "ignore" });
  spawnSync("git", ["worktree", "prune"], { windowsHide: true, cwd: PROJECT_ROOT, stdio: "ignore" });
  const add = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { windowsHide: true, cwd: PROJECT_ROOT, stdio: "inherit" });
  if (add.status !== 0) {
    console.error("[FAIL] Cannot create worktree");
    process.exit(1);
  }
  sourceArgs = ["--source", worktree];
}

function cleanupWorktree() {
  if (!worktree) return;
  spawnSync("git", ["worktree", "remove", "--force", worktree], { windowsHide: true, cwd: PROJECT_ROOT, stdio: "ignore" });
  spawnSync("git", ["worktree", "prune"], { windowsHide: true, cwd: PROJECT_ROOT, stdio: "ignore" });
  worktree = null;
}
process.on("exit", cleanupWorktree);

// Only --skip-runtime skips assembly.
//
// --patch-only previously took the "check-only" branch, which was wrong: the patch content **is**
// runtime/app; if not assembled from the new source, validation inevitably reports "runtime/app lags
// behind source", so --from-head --patch-only, the most common minor release path, fails completely.
// --patch-only means "skip Rust compilation", not "skip assembling the Node half".
if (!has("--skip-runtime")) {
  // --require-vite-env: fails immediately if VITE_ variables are missing. This path is for **release**,
  // not a manual test run: if those values are missing, diagnostic submissions in the built package are
  // dead, and no other step in the workflow will error out because of it.
  run("Assemble runtime", "node", ["scripts/prepare-runtime.mjs", "--require-vite-env", ...sourceArgs]);
} else {
  run("Check runtime", "node", ["scripts/prepare-runtime.mjs", "--check", ...sourceArgs]);
}
/**
 * **Before tearing down the worktree, rescue those three installer files first.**
 *
 * Originally this stated "the worktree's mission is complete; subsequent steps will no longer read
 * source code": that statement was wrong. make-patch still needs to read three files:
 * `apply-patch.ps1`, `apply-patch.cmd`, and `patch-installer.nsi`, and it takes them from **its own
 * workspace directory**, not this HEAD worktree. Consequently, the `--from-head` promise that
 * "source is taken from HEAD, ignoring uncommitted changes" did not hold for these three files:
 * runtime was committed version A, while the installer was workspace version B, producing a package
 * that matched no commit.
 *
 * Seen once in practice: installer changes were packaged before being committed, while the server field
 * it needed to read (activeRuns in /api/mcp/status) was still on the old version: the two halves were
 * talking past each other without throwing errors.
 *
 * The reason the worktree is not kept until after make-patch is that `tauri build` sits in between;
 * leaving a worktree sitting under desktop/.cache during Rust compilation is asking for trouble.
 * Rescuing the three files is much cheaper.
 */
let installerSrc = null;
if (worktree) {
  installerSrc = path.join(DESKTOP_DIR, ".cache", "release-installer");
  fs.rmSync(installerSrc, { recursive: true, force: true });
  fs.mkdirSync(installerSrc, { recursive: true });
  for (const f of ["apply-patch.ps1", "apply-patch.cmd", "patch-installer.nsi"]) {
    const from = path.join(worktree, "desktop", "scripts", f);
    if (!fs.existsSync(from)) {
      console.error(`[FAIL] HEAD has no desktop/scripts/${f}`);
      process.exit(1);
    }
    fs.copyFileSync(from, path.join(installerSrc, f));
  }
  console.log(`  Installer taken from HEAD: ${installerSrc}`);
}
cleanupWorktree();

// The version number in runtime/app takes precedence: it is the source actually packaged into the artifact.
const appVersion = JSON.parse(
  fs.readFileSync(path.join(DESKTOP_DIR, "src-tauri", "runtime", "app", "package.json"), "utf-8")
).version;
console.log(`\n  App version: ${appVersion}`);

if (!has("--patch-only")) {
  run("Build installer (Rust compile + NSIS)", "npx", ["tauri", "build"]);
}

// Patches must be built after the installer: both use the same runtime/app; reversing the order causes a mismatch.
const patchArgs = ["scripts/make-patch.mjs"];
if (has("--with-deps")) patchArgs.push("--with-deps");
if (has("--no-deps")) patchArgs.push("--no-deps");
if (has("--from-head")) patchArgs.push("--skip-source-check");
// Those three installer files must also come from HEAD, not the current workspace state (see file rescue section above)
if (installerSrc) patchArgs.push("--installer-src", installerSrc);
if (has("--zip")) patchArgs.push("--zip");
if (!has("--installer-only")) run("Build update patch", "node", patchArgs);

// ── Collect artifacts ─────────────────────────────────────────────────
fs.mkdirSync(RELEASE_DIR, { recursive: true });
const results = [];

if (!has("--patch-only")) {
  // tauri names by shell version; here we save a copy by app version to prevent two installers with
  // different contents from sharing the same name (which happens when shell is unchanged but app upgrades).
  //
  // Product name is taken from tauri.conf.json and architecture uses a wildcard: previously this line
  // hardcoded both `PromptCut` and `x64`. When changing product name or target architecture,
  // `tauri build` succeeded, yet this step reported "installer not found", while the error message
  // pointed to a filename that was never supposed to exist, obscuring the real cause.
  const setupName = `${productName}_${shellVersion}_*-setup.exe`;
  const src = fs.existsSync(BUNDLE_DIR)
    ? fs.readdirSync(BUNDLE_DIR)
        .filter((f) => f.startsWith(`${productName}_${shellVersion}_`) && f.endsWith("-setup.exe"))
        .map((f) => path.join(BUNDLE_DIR, f))[0]
    : undefined;
  if (!src) {
    console.error(`[FAIL] Installer not found: ${path.join(BUNDLE_DIR, setupName)}`);
    process.exit(1);
  }
  const dest = path.join(RELEASE_DIR, `PromptCut-${appVersion}-setup.exe`);
  fs.copyFileSync(src, dest);
  results.push(dest);
}

for (const ext of has("--installer-only") ? [] : ["exe", "zip"]) {
  const p = path.join(RELEASE_DIR, `PromptCut-patch-${appVersion}.${ext}`);
  if (fs.existsSync(p)) results.push(p);
}

const manifest = has("--installer-only") ? null : JSON.parse(
  fs.readFileSync(path.join(RELEASE_DIR, `manifest-${appVersion}.json`), "utf-8")
);

console.log(`\n══ Done (${elapsed()}s) ══`);
for (const f of results) {
  console.log(`  ${(fs.statSync(f).size / 1048576).toFixed(1).padStart(8)} MB  ${path.basename(f)}`);
}
if (manifest) {
  console.log(`\n  Patch includes dependencies: ${manifest.includesDeps ? "yes" : "no"} (${manifest.depsReason})`);
  console.log(`  Patch applies to: shell ${manifest.minShellVersion} or newer`);
}
console.log(`  Output directory: ${RELEASE_DIR}`);
