/**
 * PromptCut: Build an update patch from the assembled runtime.
 *
 * Vast majority of changes affect only the Node half (source + dist, occasionally dependencies),
 * while the Rust shell and three large chunks Chrome/ffmpeg/Python remain untouched. The full
 * installer is therefore nearly 1 GB, whereas these changes themselves are usually only a few MB.
 * This script packages the parts in runtime/app that actually change into a patch package that can
 * overwrite the installed directory.
 *
 *   node scripts/make-patch.mjs                # Do not include node_modules if deps unchanged
 *   node scripts/make-patch.mjs --with-deps    # Force including node_modules
 *   node scripts/make-patch.mjs --no-deps      # Force omitting (rejects if deps changed)
 *   node scripts/make-patch.mjs --base <file>  # Specify comparison baseline (release manifest)
 *
 * Prerequisite is that runtime/app has been assembled by prepare-runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, "..");
const RUNTIME_DIR = path.join(DESKTOP_DIR, "src-tauri", "runtime");
const APP_DIR = path.join(RUNTIME_DIR, "app");

/**
 * Minimum required shell version for the Node side: declare manually, **do not** use "the shell
 * version built alongside this time".
 *
 * These two are easy to conflate: the shell version built together at release time, versus shell
 * capabilities actually relied upon by the Node side. Using the former as the gate means every
 * shell change (even just adding a menu item) blocks all users on older shells from patches,
 * forcing them to download a full package of over 300 MB just to replace an 11 MB exe, when those
 * users originally only wanted updates on the Node side.
 *
 * When to raise it: when the Node side begins to **hard-depend** on a new shell capability, where
 * missing it throws an error or makes the feature entirely unavailable. "Better with it, but
 * downgrades gracefully without" does not count: keep those below the gate so older shells can
 * still apply patches.
 *
 * Currently 0.2.0: any 0.2.x shell can run it. The native "Appearance → Skin…" newly added in 0.2.3
 * is a downgradable item (frontend accesses window.__TAURI__ via optional chaining, and the skin
 * dialog has another entry in "..." on the top bar), so the gate is not raised.
 */
const MIN_SHELL_VERSION = "0.2.0";
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const STAGE_DIR = path.join(DESKTOP_DIR, ".cache", "patch-stage");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

/**
 * Where to fetch those three installer files (apply-patch.ps1 / apply-patch.cmd /
 * patch-installer.nsi).
 *
 * **Default is `__dirname`, namely current workspace. This is wrong for `--from-head`.**
 * payload uses `runtime/app`, which is assembled by prepare-runtime from a temporary HEAD worktree;
 * whereas these three files have always been copied directly from the workspace, so the statement
 * "source taken from HEAD, ignoring uncommitted changes" of `--from-head` does not hold for them:
 * the built package could be "runtime is committed version A, installer is workspace version B",
 * matching no commit at all. Observed in practice: installer changes were packaged before being
 * committed, while the server field it depended on (activeRuns on /api/mcp/status that time)
 * remained on the older version, causing the two halves to mismatch.
 *
 * Therefore, build-release copies these three files to a staging directory first before tearing
 * down the worktree, then points here with `--installer-src`. When running make-patch manually
 * without passing it, behavior remains identical to before.
 */
const INSTALLER_DIR = option("--installer-src") || __dirname;
/** All three files are indispensable: missing any one, the patch package cannot install or build at all */
const INSTALLER_FILES = ["apply-patch.ps1", "apply-patch.cmd", "patch-installer.nsi"];
for (const f of INSTALLER_FILES) {
  if (!fs.existsSync(path.join(INSTALLER_DIR, f))) {
    console.error(`[FAIL] installer file missing: ${path.join(INSTALLER_DIR, f)}`);
    process.exit(1);
  }
}

/**
 * Items in runtime/app that are not build artifacts: directories generated on their own after
 * the user runs the app. The patch must never touch them: exported videos and AI session history
 * are all inside here.
 */
const RUNTIME_STATE = new Set([
  "node_modules",   // Handled separately: only shipped with the package when dependencies change
  "exports",        // User-exported videos
  ".pc-chats",      // AI session history
  ".pc-work",       // Attachment working directory for each session
  ".pc-projects",   // User drafts: if missed, the patch will ship drafts from the build machine to everyone
  "out",
  ".vite",
  ".cache",
  ".claude",
]);

/**
 * Single-file-level blocklist. Directory names cannot block files like `.env.local` sitting
 * at the root: it contains submission tokens for diagnostic services; shipping it with the patch
 * is equivalent to handing the key to every user who installed the patch.
 */
const RUNTIME_STATE_FILES = [
  /^\.env($|\.)/,
  /^\.dev\.vars($|\.)/, // Local key file for wrangler; not named .env, but holds the same kind of content
  /^\.npmrc$/,
  /^\.pc-last-.*\.txt$/,
  /\.lock$/,
];

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function sha256File(p) {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Relative paths (forward slashes) of all build artifact files in the app directory, excluding runtime state and dependencies. */
function listPayloadFiles(dir = APP_DIR, base = "") {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (base === "" && RUNTIME_STATE.has(ent.name)) continue;
    // `.git` (a pointer file in a worktree, a directory in a normal checkout) never enters patches at
    // any level or in any form. prepare-runtime already skips copying it; this adds another check
    // because runtime/app might be left from an older version, and make-patch can directly consume
    // the existing runtime/app via --skip-runtime.
    if (ent.name === ".git") continue;
    // The file-level blocklist is checked at **every level**: .env.local and similar files do not
    // only appear at the root
    if (!ent.isDirectory() && RUNTIME_STATE_FILES.some((re) => re.test(ent.name))) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listPayloadFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Copies the entire directory tree. With tens of thousands of deeply nested files in node_modules,
 * robocopy on Windows is much faster than calling copyFileSync one by one, and avoids hitting
 * the 260-character path limit.
 */
function copyTree(src, dest) {
  const r = spawnSync("robocopy.exe", [src, dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"], { windowsHide: true,
    stdio: "inherit", timeout: 1_800_000,
  });
  // robocopy uses exit codes to indicate what it did; 0–7 all count as success, only ≥8 is a real error.
  if (r.error || r.status === null || r.status >= 8) {
    fail(`Failed to copy ${src} (robocopy code ${r.status}${r.error ? `, ${r.error.message}` : ""})`);
  }
}

function countTree(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else { files++; try { bytes += fs.statSync(full).size; } catch { /* skip */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

/**
 * Manifest from the previous release, used to determine whether dependencies changed and which
 * files were deleted.
 *
 * Must exclude "the manifest for this version itself": when re-running make-patch, it is already
 * sitting in release/, so using it as a baseline compares against itself: dependencies will
 * naturally match, producing a patch without node_modules. When installed on the real previous
 * version, it either gets blocked by lock verification or (if somehow bypassed) fails to run due
 * to missing packages.
 */
function findBaseManifest(appVersion) {
  const explicit = option("--base");
  if (explicit) {
    if (!fs.existsSync(explicit)) fail(`manifest given by --base does not exist: ${explicit}`);
    return { path: explicit, data: JSON.parse(fs.readFileSync(explicit, "utf-8")) };
  }
  if (!fs.existsSync(RELEASE_DIR)) return null;
  const candidates = fs.readdirSync(RELEASE_DIR)
    .filter((n) => /^manifest-.*\.json$/.test(n))
    .map((n) => path.join(RELEASE_DIR, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const p of candidates) {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.appVersion === appVersion) continue; // Itself; cannot be used as a baseline
    return { path: p, data };
  }
  return null;
}

/**
 * Hashes only the **dependency content** in package-lock, skipping the app's own version number.
 *
 * Previously, the entire file was hashed, so every minor release (which only changed the version
 * field) was judged as "dependencies changed", forcibly stuffing 196 MB of node_modules into the
 * patch: turning what should have been a few-MB patch into 48 MB. And the whole reason this patch
 * layer exists is that it is small.
 *
 * Real dependency changes are still caught: they are all in packages, and not a single byte of
 * that section was skipped.
 */
function hashLockDeps(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  delete raw.version;
  if (raw.packages && raw.packages[""]) delete raw.packages[""].version;
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

function main() {
  console.log("PromptCut make-patch");

  if (!fs.existsSync(APP_DIR)) fail(`runtime/app does not exist, run npm run prepare-runtime first`);
  const distIndex = path.join(APP_DIR, "dist", "index.html");
  if (!fs.existsSync(distIndex)) fail(`runtime/app/dist/index.html does not exist, run npm run prepare-runtime first`);

  const appPkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf-8"));
  // Guards against "forgetting to rerun prepare-runtime after changing source code and patching with
  // an old app".
  // Releases with --from-head just assembled runtime/app in the same invocation; source code comes
  // from HEAD rather than the working tree, so comparing with the working tree would cause false
  // alarms, and that path skips this check.
  if (!flag("--skip-source-check")) {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    if (appPkg.version !== rootPkg.version) {
      fail(`runtime/app is behind the source (app ${appPkg.version} ≠ source ${rootPkg.version}), rerun prepare-runtime first`);
    }
  }
  const appVersion = appPkg.version;
  const shellVersion = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_DIR, "src-tauri", "tauri.conf.json"), "utf-8")
  ).version;

  // The gate must match the generation of this shell; otherwise the manifest is contradictory:
  // generation verification passes first, but the gate points to a different generation
  const gen = (v) => v.split(".").slice(0, 2).join(".");
  if (gen(MIN_SHELL_VERSION) !== gen(shellVersion)) {
    fail(
      `MIN_SHELL_VERSION(${MIN_SHELL_VERSION}) and this shell (${shellVersion}) are not the same generation.` +
        ` When the shell generation changes, move it to the start of the new generation too.`
    );
  }

  const lockPath = path.join(APP_DIR, "package-lock.json");
  const lockHash = sha256File(lockPath);
  const lockDepsHash = hashLockDeps(lockPath);
  const base = findBaseManifest(appVersion);
  if (base) console.log(`  baseline manifest: ${path.basename(base.path)} (app ${base.data.appVersion})`);
  else console.log("  no manifest from the previous release found");

  // Whether dependencies should be shipped with the package. If the lock matches, omit them;
  // this is the common case of "only changing Node code".
  let includesDeps;
  let depsReason;
  if (flag("--with-deps")) {
    includesDeps = true; depsReason = "--with-deps given on the command line";
  } else if (flag("--no-deps")) {
    includesDeps = false; depsReason = "--no-deps given on the command line";
  } else if (!base) {
    includesDeps = true; depsReason = "no baseline manifest to compare, including dependencies to be safe";
  } else if (!base.data.lockDepsHash) {
    // The old manifest only recorded the full file hash, making it impossible to determine whether
    // dependencies changed; conservatively include them
    includesDeps = true; depsReason = "baseline manifest is from an old version, cannot compare dependencies only";
  } else if (base.data.lockDepsHash !== lockDepsHash) {
    includesDeps = true; depsReason = "dependencies differ from baseline";
  } else {
    includesDeps = false; depsReason = "dependencies match baseline";
  }
  console.log(`  dependencies: ${includesDeps ? "shipped in package" : "not shipped"} (${depsReason})`);
  if (!includesDeps && base && base.data.lockDepsHash && base.data.lockDepsHash !== lockDepsHash) {
    fail("dependencies changed, --no-deps would produce a patch that will not run once installed");
  }

  // ── Collect payload ──────────────────────────────────────────────────────
  const files = listPayloadFiles();
  const hashes = {};
  let payloadBytes = 0;
  for (const rel of files) {
    const full = path.join(APP_DIR, rel);
    hashes[rel] = sha256File(full);
    payloadBytes += fs.statSync(full).size;
  }
  console.log(`  build output: ${files.length} files, ${mb(payloadBytes)} MB`);

  // Files present in the previous version but absent in this version. Only deletes build artifacts;
  // user data is not in this set.
  const removed = base?.data?.files
    ? Object.keys(base.data.files).filter((rel) => !(rel in hashes))
    : [];
  if (removed.length) console.log(`  old files to delete: ${removed.length}`);

  // ── Assemble patch directory ───────────────────────────────────────────
  const stem = `PromptCut-patch-${appVersion}`;
  rmrf(STAGE_DIR);
  const root = path.join(STAGE_DIR, stem);
  const payloadDir = path.join(root, "payload");
  mkdirp(payloadDir);

  for (const rel of files) {
    const dest = path.join(payloadDir, rel);
    mkdirp(path.dirname(dest));
    fs.copyFileSync(path.join(APP_DIR, rel), dest);
  }

  let deps = null;
  if (includesDeps) {
    const src = path.join(APP_DIR, "node_modules");
    if (!fs.existsSync(src)) fail("dependencies are required, but runtime/app/node_modules does not exist");
    console.log("  copying node_modules…");
    copyTree(src, path.join(payloadDir, "node_modules"));
    deps = countTree(path.join(payloadDir, "node_modules"));
    console.log(`  dependencies: ${deps.files} files, ${mb(deps.bytes)} MB`);
  }

  const manifest = {
    format: "promptcut-patch/1",
    appVersion,
    // The patch only replaces the Node half. If the core generation (the first two segments of the shell
    // version) differs, installation will definitely fail: Chrome / ffmpeg / Python / Rust shells are
    // all in the full installer, which the patch cannot touch.
    shellGeneration: shellVersion.split(".").slice(0, 2).join("."),
    minShellVersion: MIN_SHELL_VERSION,
    builtAt: new Date().toISOString(),
    includesDeps,
    depsReason,
    lockHash,
    // The next release relies on this to determine whether dependencies actually changed (lockHash
    // gets skewed by the version number)
    lockDepsHash,
    baseAppVersion: base?.data?.appVersion ?? null,
    baseLockHash: base?.data?.lockHash ?? null,
    payloadFiles: files.length,
    payloadBytes,
    depsFiles: deps?.files ?? 0,
    depsBytes: deps?.bytes ?? 0,
    removed,
    files: hashes,
  };
  fs.writeFileSync(path.join(root, "patch.json"), JSON.stringify(manifest, null, 2));

  fs.copyFileSync(path.join(INSTALLER_DIR, "apply-patch.ps1"), path.join(root, "apply-patch.ps1"));
  fs.copyFileSync(path.join(INSTALLER_DIR, "apply-patch.cmd"), path.join(root, "Install update.cmd"));
  fs.writeFileSync(path.join(root, "README.txt"), readmeText(manifest));

  // ── Packaging ──────────────────────────────────────────────────────────
  mkdirp(RELEASE_DIR);
  const zipPath = path.join(RELEASE_DIR, `${stem}.zip`);
  rmrf(zipPath);
  // Verify the staging directory before packaging: only proceed to compression once everything that
  // should be inside is present.
  const mustHave = ["patch.json", "apply-patch.ps1", "Install update.cmd", "README.txt",
    ...files.map((rel) => `payload/${rel}`)];
  const missing = mustHave.filter((p) => !fs.existsSync(path.join(root, p)));
  if (missing.length) fail(`patch is missing ${missing.length} items, for example ${missing[0]}`);
  console.log(`  content check passed: ${mustHave.length} items`);

  // The main artifact is an exe: users double-click to install without extracting first, and no one
  // will mistakenly click cmd inside an archive.
  const exePath = path.join(RELEASE_DIR, `${stem}.exe`);
  rmrf(exePath);
  console.log("  Packaging into an exe with NSIS…");
  const nsis = findMakensis();
  const build = spawnSync(nsis, [
    `-DVERSION=${appVersion}`,
    `-DSRCDIR=${root}`,
    `-DOUTFILE=${exePath}`,
    `-DICON=${path.join(DESKTOP_DIR, "src-tauri", "icons", "icon.ico")}`,
    path.join(INSTALLER_DIR, "patch-installer.nsi"),
  ], { windowsHide: true, encoding: "utf8", timeout: 1_800_000 });
  if (build.status !== 0 || !fs.existsSync(exePath)) {
    fail(`NSIS packaging failed (exit code ${build.status})\n${(build.stdout || "").slice(-2000)}${build.stderr || ""}`);
  }

  // Add --zip if you want to inspect what is inside the patch; not needed for routine releases.
  if (flag("--zip")) {
    console.log("  also building a zip…");
    // hdrcharset=UTF-8 cannot be omitted: by default filenames are stored in CP437, so
    // "Install Update.cmd" will be dropped directly, leaving only a single warning line on stderr.
    const tarExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const zip = spawnSync(fs.existsSync(tarExe) ? tarExe : "tar",
      ["-a", "-c", "--options", "hdrcharset=UTF-8", "-f", zipPath, stem], { windowsHide: true,
        cwd: STAGE_DIR, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8", timeout: 1_800_000,
      });
    if (zip.status !== 0) fail(`zip packaging failed (exit code ${zip.status})${zip.stderr || ""}`);
    if (zip.stderr && zip.stderr.trim()) fail(`some files were skipped in the zip:\n${zip.stderr.trim()}`);
  }

  // Keep a separate copy of the manifest; the next build uses it as a baseline to calculate diffs
  fs.writeFileSync(path.join(RELEASE_DIR, `manifest-${appVersion}.json`), JSON.stringify(manifest, null, 2));
  rmrf(STAGE_DIR);

  console.log(`\n  patch: ${exePath} (${mb(fs.statSync(exePath).size)} MB)`);
  return { exePath, manifest };
}

/** The NSIS copy installed by Tauri itself; falls back to PATH if absent. */
function findMakensis() {
  const bundled = path.join(process.env.LOCALAPPDATA || "", "tauri", "NSIS", "Bin", "makensis.exe");
  if (fs.existsSync(bundled)) return bundled;
  const probe = spawnSync("makensis", ["/VERSION"], { windowsHide: true, encoding: "utf8" });
  if (probe.status === 0 || probe.stdout) return "makensis";
  fail("makensis not found. Run npm run build once to let Tauri install NSIS, or install NSIS yourself and add it to PATH.");
}

function readmeText(m) {
  return [
    `PromptCut update patch ${m.appVersion}`,
    ``,
    `This patch only updates the Node part of the app (UI and backend logic)${m.includesDeps ? " and dependencies" : ""},`,
    `It does not touch Chrome, ffmpeg, Python or the shell, so it is much smaller than the full installer.`,
    ``,
    `Usage: double-click "Install update.cmd".`,
    ``,
    `It will do the following:`,
    `  1. Find the installed PromptCut (default %LOCALAPPDATA%\\PromptCut)`,
    `  2. Check that versions match (shell needs ${m.minShellVersion} or newer)`,
    `  3. Ask you to close the running PromptCut`,
    `  4. Back up the current version, then overwrite it with the update`,
    `  5. Roll back to the backup automatically if anything goes wrong`,
    ``,
    `Left untouched: exported videos (exports), AI session history (.pc-chats), `,
    `settings and keys (%LOCALAPPDATA%\\promptcut), downloaded speech models.`,
    ``,
    `If the patch cannot be installed, install the full installer over it instead; the result is the same.`,
  ].join("\r\n");
}

main();
