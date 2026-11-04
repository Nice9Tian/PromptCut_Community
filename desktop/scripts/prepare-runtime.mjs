/**
 * PromptCut — Assemble the desktop runtime directory.
 *
 * Copies Node sidecar, app source, Chrome for Testing, and ffmpeg into
 * desktop/src-tauri/runtime/ so that `tauri build` can bundle them.
 *
 * Usage:
 *   node scripts/prepare-runtime.mjs          # full assembly
 *   node scripts/prepare-runtime.mjs --check  # verify only, no copy
 */
import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
/**
 * Where the source code comes from. Defaults to this repo workspace; during release, build-release
 * passes --source pointing to a HEAD worktree, so the artifact corresponds to a committed state,
 * rather than bundling uncommitted changes left by others in the workspace.
 *
 * Only the source code is swapped here: Chrome / ffmpeg / Python / Rust build caches still use
 * the existing copies under desktop/, without needing to re-download or recompile for a release.
 */
const SOURCE_ARG = process.argv.indexOf("--source");
const PROJECT_ROOT = SOURCE_ARG >= 0
  ? path.resolve(process.argv[SOURCE_ARG + 1])
  : path.resolve(DESKTOP_DIR, "..");
const RUNTIME_DIR = path.resolve(DESKTOP_DIR, "src-tauri", "runtime");
const BINARIES_DIR = path.resolve(DESKTOP_DIR, "src-tauri", "binaries");

const CHECK_ONLY = process.argv.includes("--check");
/** Pass for release builds: fail immediately if no VITE_ variables are found, instead of silently producing a broken package */
const REQUIRE_VITE_ENV = process.argv.includes("--require-vite-env");
const t0 = Date.now();

// ── Utilities ───────────────────────────────────────────────────────────

function elapsed() {
  return ((Date.now() - t0) / 1000).toFixed(1);
}

function dirSizeMB(dir) {
  let total = 0;
  try {
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else {
          try { total += fs.statSync(full).size; } catch { /* skip */ }
        }
      }
    };
    walk(dir);
  } catch { /* dir may not exist */ }
  return (total / 1048576).toFixed(1);
}

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
}

export function copyRecursive(src, dest, filter) {
  mkdirp(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, ent.name);
    const destPath = path.join(dest, ent.name);
    if (filter && !filter(ent.name, srcPath, ent.isDirectory())) continue;
    if (ent.isDirectory()) {
      copyRecursive(srcPath, destPath, filter);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

// ── Step 1: Sidecar (node) ──────────────────────────────────────────────

function stepSidecar() {
  const stepT = Date.now();
  console.log("\n── Step 1: Sidecar (node) ──");
  const dest = path.join(BINARIES_DIR, "node-x86_64-pc-windows-msvc.exe");
  if (CHECK_ONLY) {
    assert(fs.existsSync(dest), `Sidecar not found: ${dest}`);
    console.log(`  ✓ Sidecar exists (${dirSizeMB(BINARIES_DIR)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return;
  }
  mkdirp(BINARIES_DIR);
  console.log(`  Copying ${process.execPath} → ${dest}`);
  fs.copyFileSync(process.execPath, dest);
  console.log(`  Done (${dirSizeMB(BINARIES_DIR)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
}

// ── Step 2: App ─────────────────────────────────────────────────────────

/** Names/patterns to skip when copying the app. */
/*
 * This is a **blocklist**: anything not listed is copied into runtime/app and then packaged
 * into the installer distributed to all users.
 * So missing an entry is not just "a slightly larger package", but shipping things from the dev machine.
 *
 * Aside from build artifacts, three categories must be blocked here:
 *   - `.env*`: keys such as submission tokens for the diagnostic service;
 *   - `.pc-*`: user/developer drafts, AI session histories, and Skill task directories, all personal data;
 *   - `target`, `.cache` across crates under tools: Rust build artifacts, 2.7 GB under tools alone.
 *     (Do not write this line literally as `tools/<asterisk>/target`: the `<asterisk>/` in it will
 *     immediately close this block comment, causing the rest of the file from the next line onwards
 *     to be parsed as code, resulting in a direct SyntaxError.
 *     That was how c0a66b8 broke prepare-runtime, preventing even --check from running.)
 * `--from-head` is only clean when used; when someone manually runs `npm run prepare-runtime`,
 * it relies entirely on this list.
 */
const SKIP_DIRS = new Set([
  "node_modules", "out", "dist", ".git", ".vite", "desktop",
  "target",            // Rust build artifacts (tools/*/target, 2.7 GB)
  ".cache",
  ".pc-projects",      // Local drafts
  ".pc-chats",         // AI session history
  ".pc-work",          // Session attachments / replicas when opening .proc
  ".pc-projects-headless",
  ".claude",           // Local agent configuration and permissions
  ".wrangler",         // Local cache for wrangler dev (diagnostic Worker setup)
  /*
   * git worktrees for tasks. Missing this entry means bundling the **entire source code of every branch**
   * into the installer and shipping it to users:
   * hit on 2026-10-24 when releasing 0.7.25: `runtime/app` surged from 378 MB to 11 GB (the
   * `_export-baseline` pixel baseline alone was 7.9 GB), and makensis crashed twice in a row with
   * `error mmapping datablock`.
   * Note that entries like `out` / `node_modules` are blocked by **name** at any level, so they cannot
   * block the worktree itself; this entry must be listed separately.
   */
  ".worktrees",
  "release",
  // Text tools from the AI harness drop files here (server/harness/tools/textEditor.mjs,
  // server/vite-plugin-cards.ts). Running the AI panel on dev machines leaves .md/.txt/.json/.png
  // written by models. The filename blocklist above only blocks .mp4/.mov/.webm/.log and misses these:
  // unblocked, they ship in the installer and land in the user's export directory after installation.
  // RUNTIME_STATE in make-patch.mjs already treats this as "user state", so both places must align.
  "exports",
  "work",             // Local agent reviews, fixtures and acceptance evidence.
  "__pycache__",
]);
/**
 * Names that are skipped by name whether they are directories or **files**.
 *
 * `.git` must be here: it is a directory in regular checkouts, but in a git worktree
 * (desktop/.cache/release-src created by `build-release --from-head` is one) and submodules,
 * it is a `gitdir: …` pointer **file**. SKIP_DIRS, which only takes effect on directories,
 * cannot block it, so this file pointing to a packager machine path entered runtime/app,
 * the patch manifest, and the installer (the first key in the 0.7.13 manifest was ".git").
 *
 * Other names in SKIP_DIRS are not treated the same way: they (node_modules, out, dist, target,
 * release, work, exports, desktop, etc.) are ordinary English words and are only build
 * artifacts/local state in "directory" form; **source files** with the same name should be copied
 * and not blanket-filtered by name. There are no files with the same name in `git ls-files`.
 * Think this through before adding names here.
 */
const SKIP_ANY_KIND = new Set([".git"]);
const SKIP_FILE_PATTERNS = [
  /^\.env($|\.)/,      // .env / .env.local / .env.production: contain keys
  // wrangler uses this fixed filename to read local keys, which contains ADMIN_KEY / FEISHU_WEBHOOK / SUBMIT_TOKEN.
  // It is not named .env, so the rule above cannot match it: listed separately.
  /^\.dev\.vars($|\.)/,
  /^\.npmrc$/,         // May contain auth tokens for private registries
  /^\.pc-last-.*\.txt$/,
  /\.lock$/,           // Exclusive lock for .proc, leftovers from dev machines
  /^AGY-TASK-.*\.md$/,
  /^left-probe\.html$/,
  /^probe-data\.html$/,
  /^probe-timeline\.html$/,
  /^proto\.html$/,
  /\.log$/,
  /\.mp4$/,
  /\.mov$/,
  /\.webm$/,
];
const SKIP_PATH_PATTERNS = [
  /[/\\]src[/\\]__probe-/,
  /[/\\]scripts[/\\]_mgr-/,
  /[/\\]scripts[/\\]_tmp-/,
  /[/\\]scripts[/\\]__tmp-/,
];

/**
 * Resolve the right-hand side of a `.env` line following dotenv rules: **preserve inside quotes,
 * `#` outside quotes starts a comment**.
 *
 * Why we cannot just trim and use it: during development, vite reads the same file via dotenv,
 * so `A=x  # online` resolves to `x`; if `  # online` were injected as part of the value here,
 * we would get "the same .env.local works fine in development but produces a broken package,
 * without reporting errors anywhere": the frontend receives a URL trailing with a comment,
 * and requests fail to send.
 */
function parseEnvValue(raw) {
  const s = String(raw).trim();
  const quoted = s.match(/^(['"])([\s\S]*?)\1/);
  if (quoted) return quoted[2];          // # inside quotes is part of the value, not a comment
  return s.replace(/\s+#.*$/, "").trim(); // Bare value: whitespace + # onwards is a comment
}

/**
 * Extract `VITE_` variables from `.env*` at the repo root and **pass them to vite build as env vars**.
 *
 * Why this detour is needed: variables prefixed with `VITE_` are **inlined into frontend artifacts**
 * at build time (`import.meta.env.VITE_DIAG_SUBMIT_URL`, etc.). But the blocklist above excluded `.env*`
 * from being copied: keeping files out of the package is right, but vite build runs in `runtime/app`
 * where this file does not exist, so those values disappear: **the diagnostic submission feature in
 * the built package is dead**, with the button grayed out saying "Report receiving address not
 * configured yet". Found only after making the first full package; unit tests and --check miss it.
 *
 * vite's loadEnv reads .env files and also gathers prefixed variables from process.env,
 * so passing them this way is enough without needing to copy the file over and delete it later.
 *
 * Only pick those starting with `VITE_`: they are originally meant "to be shipped to users"
 * (diagnostic service address and submission token: the token is public, and worker.js states that
 * it only blocks casual scanners). Real server keys (ADMIN_KEY, etc.) live in `.dev.vars` and
 * wrangler secret without the VITE_ prefix; they cannot and should not be retrieved.
 */
function viteEnvFromDotEnv() {
  /*
   * Check two locations, **real repository first, source root second (the latter overrides the former)**:
   *
   *   path.resolve(DESKTOP_DIR, "..")  Real repository. `.env*` are gitignored local developer files,
   *                                    existing only here;
   *   PROJECT_ROOT                     Source root. When pointed via `--source`, it is a **temporary worktree**
   *                                    without .env* (gitignored files do not enter worktrees).
   *
   * Checking only PROJECT_ROOT is not enough: that was exactly the bug in the first version. When creating
   * a worktree manually, I copied .env.local into it, so it passed testing; but the real release path
   * `build-release --from-head` creates desktop/.cache/release-src on its own, which never contains
   * this file, so VITE_ variables were still lost and diagnostic submission in the built package was dead.
   * Adding this fallback to the real repository truly fixed it.
   */
  const roots = [path.resolve(DESKTOP_DIR, ".."), PROJECT_ROOT];
  const out = {};
  const seen = new Set();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      const p = path.join(root, name);
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
        const m = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        out[m[1]] = parseEnvValue(m[2]);
      }
    }
  }
  const keys = Object.keys(out);
  if (keys.length) {
    console.log(`  Injected build-time variables: ${keys.join(", ")}`);
    return out;
  }
  /*
   * None found. When running manually (e.g. someone clones this repo), this is not an error,
   * just log a warning; **for formal releases, it must fail immediately**.
   *
   * This trap was fixed twice (d4d1a00 passed to vite build, ca46dd3 added real repo fallback),
   * and both times were discovered only after release, because no step in the pipeline fails:
   * vite build succeeds as usual, --check cannot tell, unit tests cannot test it, and the installed
   * package looks completely normal, except the "Submit diagnostic report" button is grayed out.
   * Missing values are easy to fix; the hard part is **nobody knows**.
   * Therefore build-release passes --require-vite-env to abort right here.
   */
  console.log("  ⚠ No VITE_ variables found (checked .env* in the real repo and the source root)");
  console.log("    Consequence: in the built package, \"Submit diagnostic report\" will be greyed out, leaving only \"Save as file\".");
  if (REQUIRE_VITE_ENV) {
    console.error("[FAIL] Release build requires VITE_ variables to be in place, but none were found.");
    console.error(`       Create .env.local in the repo root, fill in VITE_DIAG_*, and try again;`);
    console.error(`       if you really want to ship a package without diagnostic submission, drop --require-vite-env.`);
    process.exit(1);
  }
  return out;
}

/**
 * Write those `VITE_` variables **into another `.env.local` inside the package**.
 *
 * The step above "passing to vite build" only feeds `dist/`, but **the installed app never reads dist**:
 * the shell (desktop/src-tauri/src/lib.rs) uses the sidecar node to spin up a `vite --port 5210`
 * dev server in `runtime/app`, compiling and serving the frontend on the fly. That process is launched
 * via `env_clear()`, receiving only the few PROMPTCUT_* variables explicitly injected by the shell,
 * so `import.meta.env.VITE_DIAG_SUBMIT_URL` is always empty on user machines: "Submit" in the diagnostic
 * subwindow is permanently grayed out, saying "Report receiving address not configured yet".
 * Every version before 0.2.12 was like this; even though inlined in dist, nobody loaded that artifact.
 *
 * So here, **after** copying, generate a copy ourselves: containing only VITE_ variables, rewritten
 * rather than copying the dev machine's `.env.local` verbatim (which might contain other things).
 * SKIP_FILE_PATTERNS blocks "verbatim copying", which is correct; this file is the result of
 * allowlist filtering and belongs in the package.
 *
 * The values themselves are public: the address is meant to be distributed to users, and worker.js
 * states that the submission token only blocks casual scanners.
 */
function writeRuntimeEnv(appDir, viteEnv) {
  const keys = Object.keys(viteEnv);
  const target = path.join(appDir, ".env.local");
  if (keys.length === 0) {
    // If there are no values, don't leave an empty dummy file, or someone troubleshooting later will assume this path works
    if (fs.existsSync(target)) fs.rmSync(target);
    return;
  }
  const body = [
    "# Generated by desktop/scripts/prepare-runtime.mjs, do not edit by hand.",
    "# The app runs vite dev in this directory; the frontend's import.meta.env comes from here.",
    ...keys.map((k) => `${k}=${viteEnv[k]}`),
    "",
  ].join("\n");
  fs.writeFileSync(target, body);
  console.log(`  Wrote runtime .env.local: ${keys.join(", ")}`);
}

export function shouldCopyApp(name, fullPath, isDir) {
  if (SKIP_ANY_KIND.has(name)) return false;
  if (isDir && SKIP_DIRS.has(name)) return false;
  if (!isDir) {
    for (const re of SKIP_FILE_PATTERNS) {
      if (re.test(name)) return false;
    }
    for (const re of SKIP_PATH_PATTERNS) {
      if (re.test(fullPath)) return false;
    }
  }
  return true;
}

function stepApp() {
  const stepT = Date.now();
  console.log("\n── Step 2: App ──");
  const appDir = path.join(RUNTIME_DIR, "app");

  if (CHECK_ONLY) {
    // Verify dist exists
    const distIndex = path.join(appDir, "dist", "index.html");
    assert(fs.existsSync(distIndex), `dist/index.html not found: ${distIndex}`);
    // Verify node_modules essentials
    const viteJs = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
    assert(fs.existsSync(viteJs), `vite.js not found: ${viteJs}`);
    const rolldown = path.join(appDir, "node_modules", "@rolldown", "binding-win32-x64-msvc");
    assert(fs.existsSync(rolldown), `rolldown binding not found: ${rolldown}`);
    /*
     * This .env.local is the sole source of the address for "Submit diagnostic report" in the app
     * (see writeRuntimeEnv). Having values on the dev machine without generating it means the packaging
     * step missed it: it only disables a button in the package and shouldn't fail the whole --check,
     * but it must shout out: last time no one alerted, and it went unnoticed for over a dozen releases.
     */
    if (Object.keys(viteEnvFromDotEnv()).length > 0 && !fs.existsSync(path.join(appDir, ".env.local"))) {
      console.log("  ⚠ runtime/app/.env.local is missing: \"Submit diagnostic report\" in the package will be greyed out. Re-run the packaging without --check");
    }
    console.log(`  ✓ App exists (${dirSizeMB(appDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return { appDir };
  }

  // Clean and copy
  rmrf(appDir);
  console.log(`  Copying source from ${PROJECT_ROOT} → ${appDir}`);
  copyRecursive(PROJECT_ROOT, appDir, shouldCopyApp);

  // npm ci
  console.log("  Running npm ci…");
  const ciResult = spawnSync("npm", ["ci"], { windowsHide: true,
    cwd: appDir,
    shell: true,
    stdio: "inherit",
    timeout: 300_000,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
  });
  if (ciResult.status !== 0) {
    console.error(`[FAIL] npm ci exited with code ${ciResult.status}`);
    process.exit(1);
  }

  // Assert critical paths
  const viteJs = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
  const rolldown = path.join(appDir, "node_modules", "@rolldown", "binding-win32-x64-msvc");
  if (!fs.existsSync(viteJs) || !fs.existsSync(rolldown)) {
    console.error(
      `[FAIL] Critical paths missing after npm ci.\n` +
      `       vite.js: ${fs.existsSync(viteJs)}\n` +
      `       rolldown: ${fs.existsSync(rolldown)}\n` +
      `       This usually means npm blocked install scripts.\n` +
      `       Run "npm approve-scripts" in ${appDir} then re-run this script.`
    );
    process.exit(1);
  }

  // vite build (not npm run build — skip tsc)
  const ptyCheck = spawnSync(process.execPath, [path.join(appDir, 'server', 'runners', 'agy-login.mjs'), '--self-test'], {
    cwd: appDir, windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  assert(ptyCheck.status === 0 && ptyCheck.stdout.includes('PROMPTCUT_PTY_OK'),
    `Background CLI login component failed verification: ${ptyCheck.stderr || ptyCheck.error || ptyCheck.status}`);
  console.log("  Running vite build…");
  const viteEnv = viteEnvFromDotEnv();
  const buildResult = spawnSync("npx.cmd", ["vite", "build"], { windowsHide: true,
    cwd: appDir,
    shell: true,
    stdio: "inherit",
    timeout: 300_000,
    env: { ...process.env, ...viteEnv },
  });
  if (buildResult.status !== 0) {
    console.error(`[FAIL] vite build exited with code ${buildResult.status}`);
    process.exit(1);
  }
  const distIndex = path.join(appDir, "dist", "index.html");
  assert(fs.existsSync(distIndex), `dist/index.html not found after vite build: ${distIndex}`);

  writeRuntimeEnv(appDir, viteEnv);

  console.log(`  Done (${dirSizeMB(appDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return { appDir };
}

// ── Step 3: Chrome ──────────────────────────────────────────────────────

function parseChromeVersion(appDir) {
  // Look for chrome revision in puppeteer-core's revisions.js
  const candidates = [
    path.join(appDir, "node_modules", "puppeteer-core", "lib", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer-core", "lib", "esm", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer-core", "lib", "cjs", "puppeteer", "revisions.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      const m = content.match(/chrome:\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
  }
  // Fallback: also check puppeteer (non-core)
  const fallbacks = [
    path.join(appDir, "node_modules", "puppeteer", "lib", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer", "lib", "esm", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer", "lib", "cjs", "puppeteer", "revisions.js"),
  ];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      const m = content.match(/chrome:\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
  }
  return null;
}

function stepChrome(appDir) {
  const stepT = Date.now();
  console.log("\n── Step 3: Chrome ──");
  const effectiveAppDir = appDir || path.join(RUNTIME_DIR, "app");
  const version = parseChromeVersion(effectiveAppDir);
  assert(version, "Could not parse Chrome version from puppeteer-core revisions.js");
  console.log(`  Chrome for Testing version: ${version}`);

  const chromeDir = path.join(RUNTIME_DIR, "chrome");
  const destVersionDir = path.join(chromeDir, "chrome", `win64-${version}`);
  const chromeExe = path.join(destVersionDir, "chrome-win64", "chrome.exe");

  /*
   * If this version is already in place, do not copy it again.
   *
   * The directory name includes the version (win64-<version>), so "files exist" means "it is exactly
   * the desired version": changing versions will use another directory, and the cleanup logic at the end
   * will delete old versions, so there is no possibility of using an outdated Chrome.
   *
   * Not skipping causes issues: dev machines very likely have something running this Chrome (the dev
   * server web tool keeps a resident instance, with user-data-dir in out/web-profile); overwriting
   * chrome.dll yields EBUSY, aborting the entire release immediately. Tested once in practice: the
   * 428 MB copied over is identical to what is already there, a complete waste. If you really need to
   * redo it, delete runtime/chrome first.
   */
  /*
   * Both browsers are required:
   *   chrome                : Full Chrome, used for web tools / media collection (server/web/browser.mjs)
   *   chrome-headless-shell : Used for export and prerender. Since 0.4, the render backend uses
   *                            HeadlessExperimental.beginFrame; this CDP domain only exists in
   *                            headless-shell (see header of server/bakery/chrome.mjs).
   *                            Previously omitted to save ~200 MB, but now without it, export fails to start.
   * puppeteer looks for them under <browser>/win64-<version> in PUPPETEER_CACHE_DIR (= runtime/chrome, set in lib.rs).
   */
  const BROWSERS = [
    { name: "chrome", exe: path.join("chrome-win64", "chrome.exe") },
    { name: "chrome-headless-shell", exe: path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe") },
  ];
  const exeOf = (b) => path.join(chromeDir, b.name, `win64-${version}`, b.exe);

  if (CHECK_ONLY) {
    for (const b of BROWSERS) assert(fs.existsSync(exeOf(b)), `${b.name} exe not found: ${exeOf(b)}`);
    console.log(`  ✓ Chrome + headless-shell exist (${dirSizeMB(chromeDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return version;
  }

  const userProfile = process.env.USERPROFILE || "";
  for (const b of BROWSERS) {
    const dest = path.join(chromeDir, b.name, `win64-${version}`);
    const cacheDir = path.join(userProfile, ".cache", "puppeteer", b.name, `win64-${version}`);
    // Don't recopy if this version is in place (reason in "already" above: running Chrome causes overwrite to fail with EBUSY)
    if (fs.existsSync(exeOf(b))) {
      console.log(`  ${b.name}: already the same version, skipping copy (the old-version cleanup below still runs)`);
    } else if (fs.existsSync(cacheDir)) {
      console.log(`  ${b.name}:Copying from cache: ${cacheDir}`);
      mkdirp(dest);
      copyRecursive(cacheDir, dest);
    } else {
      console.log(`  ${b.name}:Cache not found, downloading via puppeteer…`);
      const dlResult = spawnSync("npx.cmd", [
        "puppeteer", "browsers", "install", `${b.name}@${version}`,
        "--path", chromeDir,
      ], { windowsHide: true,
        cwd: effectiveAppDir,
        shell: true,
        stdio: "inherit",
        timeout: 600_000,
      });
      if (dlResult.status !== 0) {
        console.error(`[FAIL] puppeteer browsers install ${b.name} failed (code ${dlResult.status})`);
        process.exit(1);
      }
    }

    // Remove other versions of this browser
    const parent = path.join(chromeDir, b.name);
    if (fs.existsSync(parent)) {
      for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
        if (ent.isDirectory() && ent.name !== `win64-${version}`) {
          console.log(`  Removing old ${b.name} version: ${ent.name}`);
          rmrf(path.join(parent, ent.name));
        }
      }
    }
    assert(fs.existsSync(exeOf(b)), `${b.name} exe not found after install: ${exeOf(b)}`);
  }

  console.log(`  Done (${dirSizeMB(chromeDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return version;
}

// ── Step 4: FFmpeg ──────────────────────────────────────────────────────

function findFfmpegDir() {
  // Try PATH first
  try {
    const which = execSync("where ffmpeg", { windowsHide: true, encoding: "utf-8", timeout: 5000 }).trim().split(/\r?\n/)[0];
    if (which) {
      const binDir = path.dirname(which);
      if (fs.existsSync(path.join(binDir, "ffprobe.exe"))) {
        return binDir;
      }
    }
  } catch { /* not in PATH */ }

  // Scan WinGet packages
  const localAppData = process.env.LOCALAPPDATA || "";
  const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(packagesDir)) {
    for (const ent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.startsWith("Gyan.FFmpeg_")) {
        const pkgDir = path.join(packagesDir, ent.name);
        // Look for ffmpeg-*/bin
        for (const sub of fs.readdirSync(pkgDir, { withFileTypes: true })) {
          if (sub.isDirectory() && sub.name.startsWith("ffmpeg-")) {
            const binDir = path.join(pkgDir, sub.name, "bin");
            if (fs.existsSync(path.join(binDir, "ffmpeg.exe")) &&
                fs.existsSync(path.join(binDir, "ffprobe.exe"))) {
              return binDir;
            }
          }
        }
      }
    }
  }
  return null;
}

function stepFfmpeg() {
  const stepT = Date.now();
  console.log("\n── Step 4: FFmpeg ──");
  const ffmpegDest = path.join(RUNTIME_DIR, "ffmpeg");

  if (CHECK_ONLY) {
    assert(
      fs.existsSync(path.join(ffmpegDest, "ffmpeg.exe")),
      `ffmpeg.exe not found in ${ffmpegDest}`
    );
    assert(
      fs.existsSync(path.join(ffmpegDest, "ffprobe.exe")),
      `ffprobe.exe not found in ${ffmpegDest}`
    );
    // Get version
    let ver = "unknown";
    try {
      const out = execSync(`"${path.join(ffmpegDest, "ffmpeg.exe")}" -version`, { windowsHide: true,
        encoding: "utf-8", timeout: 5000,
      });
      ver = out.split(/\r?\n/)[0];
    } catch { /* ignore */ }
    console.log(`  ✓ FFmpeg exists: ${ver} (${dirSizeMB(ffmpegDest)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return ver;
  }

  const binDir = findFfmpegDir();
  if (!binDir) {
    console.error(
      "[FAIL] ffmpeg not found.\n" +
      "       Please install it: winget install --id Gyan.FFmpeg -e"
    );
    process.exit(1);
  }
  console.log(`  Source: ${binDir}`);

  mkdirp(ffmpegDest);
  fs.copyFileSync(path.join(binDir, "ffmpeg.exe"), path.join(ffmpegDest, "ffmpeg.exe"));
  fs.copyFileSync(path.join(binDir, "ffprobe.exe"), path.join(ffmpegDest, "ffprobe.exe"));

  // Copy LICENSE/README from parent dir
  const parentDir = path.dirname(binDir);
  for (const ent of fs.readdirSync(parentDir)) {
    if (/^(LICENSE|README)/i.test(ent)) {
      fs.copyFileSync(path.join(parentDir, ent), path.join(ffmpegDest, ent));
    }
  }

  let ver = "unknown";
  try {
    const out = execSync(`"${path.join(ffmpegDest, "ffmpeg.exe")}" -version`, { windowsHide: true,
      encoding: "utf-8", timeout: 5000,
    });
    ver = out.split(/\r?\n/)[0];
  } catch { /* ignore */ }

  console.log(`  FFmpeg version: ${ver}`);
  console.log(`  Done (${dirSizeMB(ffmpegDest)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return ver;
}

// ── Step 5: Python ──────────────────────────────────────────────────────

/**
 * Embedded Python, like Node, is a **mandatory requirement**; packaging is forbidden if missing.
 *
 * This used to be "detect only": if not found, it only logged a WARN and proceeded, claiming
 * "speech-to-text feature unavailable": that was written when Python only served STT. Now it hosts
 * four packages: transition detection, subject detection, and motion tracking; the README also lists
 * it alongside Node / Chrome / ffmpeg under "All Runtimes", so allowing it means producing an installer
 * where half the features are dead upon installation.
 *
 * This step only detects, not assembles: assembly belongs to prepare-python.mjs (which downloads the
 * embeddable zip and pip from the network), a multi-minute job that should not run stealthily inside
 * every prepare-runtime run.
 */
function stepPython() {
  const stepT = Date.now();
  console.log("\n── Step 5: Python ──");
  const pythonExe = path.join(RUNTIME_DIR, "python", "python.exe");

  assert(
    fs.existsSync(pythonExe),
    `Bundled Python missing: ${pythonExe}\n` +
    "         It is required (transition detection / subject detection / motion tracking / speech recognition all run on it).\n" +
    "         Run npm run prepare-python to assemble it first, then re-run this script."
  );

  let ver;
  try {
    ver = execSync(`"${pythonExe}" -V`, { windowsHide: true, encoding: "utf-8", timeout: 5000 }).trim(); // "Python 3.11.x"
  } catch (e) {
    assert(false, `Bundled Python exists but fails to run: ${e.message}\n         Reinstall with npm run prepare-python -- --force.`);
  }
  console.log(`  Python found: ${ver} [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return ver;
}

// ── Step 6: VERSIONS.json ───────────────────────────────────────────────

/*
 * Source fingerprint: relative path + size, **excluding mtime**.
 *
 * `Math.floor(st.mtimeMs)` was once included, which inevitably broke `--from-head`: at that time,
 * the source root was a freshly checked-out worktree (desktop/.cache/release-src), and git set every
 * file's mtime to the checkout timestamp; without a single byte changing, the fingerprint changed
 * completely: `--check` reported "runtime/app is behind source", and `--from-head --skip-runtime`
 * failed directly. The reverse was also true: after releasing once with `--from-head`, VERSIONS.json
 * recorded worktree mtimes, causing subsequent regular `--check` runs to falsely report being behind.
 *
 * Switched to **content hashes** instead of falling back to "path + size": the latter misses edits
 * where "content changed but byte count stayed the same" (changing a constant, replacing a char),
 * whereas this check specifically prevents "forgot to reassemble after editing". Reading the entire
 * app source tree (already filtered via shouldCopyApp, excluding node_modules / dist / .git) takes
 * only seconds and is well worth the cost.
 */
function computeAppSrcHash(appDir) {
  const entries = [];
  const walk = (dir, base) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of items) {
      const fullPath = path.join(dir, ent.name);
      const rel = path.join(base, ent.name);
      if (ent.isDirectory()) {
        if (!shouldCopyApp(ent.name, fullPath, true)) continue;
        walk(fullPath, rel);
      } else {
        if (!shouldCopyApp(ent.name, fullPath, false)) continue;
        try {
          const sha = createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
          entries.push(`${rel}|${sha}`);
        } catch { /* skip */ }
      }
    }
  };
  walk(PROJECT_ROOT, "");
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function stepVersions(nodeVer, chromeVer, ffmpegVer, pythonVer) {
  console.log("\n── Step 6: VERSIONS.json ──");
  const versionsPath = path.join(RUNTIME_DIR, "VERSIONS.json");

  // Read root package.json for app version
  let appVer = "0.0.1";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    appVer = pkg.version || appVer;
  } catch { /* ignore */ }

  const appSrcHash = computeAppSrcHash(path.join(RUNTIME_DIR, "app"));

  if (CHECK_ONLY) {
    // Verify hash matches
    if (fs.existsSync(versionsPath)) {
      const existing = JSON.parse(fs.readFileSync(versionsPath, "utf-8"));
      if (existing.appSrcHash !== appSrcHash) {
        console.error(
          `[FAIL] runtime/app is behind the source, please re-run npm run prepare-runtime
` +
          `       Expected hash: ${appSrcHash}\n` +
          `       Got: ${existing.appSrcHash}`
        );
        process.exit(1);
      }
      console.log("  ✓ VERSIONS.json hash matches");
    } else {
      console.error(`[FAIL] VERSIONS.json not found: ${versionsPath}`);
      process.exit(1);
    }
    return;
  }

  const data = {
    node: nodeVer,
    chrome: chromeVer,
    ffmpeg: ffmpegVer,
    python: pythonVer,
    app: appVer,
    appSrcHash,
    builtAt: new Date().toISOString(),
  };

  mkdirp(RUNTIME_DIR);
  fs.writeFileSync(versionsPath, JSON.stringify(data, null, 2));
  console.log(`  Written: ${versionsPath}`);
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  console.log(`PromptCut prepare-runtime ${CHECK_ONLY ? "(--check)" : ""}`);
  console.log(`  Project root: ${PROJECT_ROOT}`);
  console.log(`  Runtime dir:  ${RUNTIME_DIR}`);

  stepSidecar();
  const { appDir } = stepApp() || { appDir: path.join(RUNTIME_DIR, "app") };
  const chromeVer = stepChrome(appDir);
  const ffmpegVer = stepFfmpeg();
  const pythonVer = stepPython();

  // Node version
  let nodeVer = "unknown";
  try {
    nodeVer = execSync(`"${process.execPath}" --version`, { windowsHide: true, encoding: "utf-8", timeout: 5000 }).trim();
  } catch { /* ignore */ }

  stepVersions(nodeVer, chromeVer, ffmpegVer, pythonVer);

  const sizes = {
    sidecar: dirSizeMB(BINARIES_DIR),
    app: dirSizeMB(path.join(RUNTIME_DIR, "app")),
    chrome: dirSizeMB(path.join(RUNTIME_DIR, "chrome")),
    ffmpeg: dirSizeMB(path.join(RUNTIME_DIR, "ffmpeg")),
    python: dirSizeMB(path.join(RUNTIME_DIR, "python")),
    total: dirSizeMB(RUNTIME_DIR),
  };

  console.log(`\n── Done in ${elapsed()}s ──`);
  console.log(`PREPARE_RESULT_JSON ${JSON.stringify({
    node: nodeVer, chrome: chromeVer, ffmpeg: ffmpegVer, python: pythonVer,
    sizes,
  })}`);
}

/**
 * Whether this file is executed directly as the entry point (rather than imported by unit tests).
 *
 * Cannot compare URLs built from `import.meta.url` and `argv[1]` verbatim: Node resolves the entry point
 * to a real path, while argv[1] preserves what the user typed: if the path has directory junctions /
 * symlinks, or drive letter / directory casing differs, they will not match, main() will not run,
 * and prepare-runtime will silently do nothing, making it very hard to spot during packaging.
 * Therefore, get real paths on both sides (fall back to path.resolve if unavailable), and compare
 * case-insensitively on win32.
 */
export function isDirectRun(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (p) => {
    try { return fs.realpathSync.native(p); } catch { /* Fall back below */ }
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(real(fileURLToPath(metaUrl))) === norm(real(argv1));
}

// Only run when executed directly as a script; do nothing when imported by unit tests (desktop/test/prepare-runtime-filter.test.mjs)
if (isDirectRun()) {
  main();
}
