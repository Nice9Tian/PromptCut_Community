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
 * 源码从哪里来。默认是本仓库工作区；发布时由 build-release 传 --source 指向
 * 一棵 HEAD 的 worktree,好让产物对应一个已提交的状态,而不是把工作区里
 * 别人没提交完的改动一起打进去。
 *
 * 只换源码这一处:Chrome / ffmpeg / Python / Rust 编译缓存仍然用 desktop/ 下
 * 原来那份,不必为一次发布重下重编。
 */
const SOURCE_ARG = process.argv.indexOf("--source");
const PROJECT_ROOT = SOURCE_ARG >= 0
  ? path.resolve(process.argv[SOURCE_ARG + 1])
  : path.resolve(DESKTOP_DIR, "..");
const RUNTIME_DIR = path.resolve(DESKTOP_DIR, "src-tauri", "runtime");
const BINARIES_DIR = path.resolve(DESKTOP_DIR, "src-tauri", "binaries");

const CHECK_ONLY = process.argv.includes("--check");
/** 发布构建带这个:VITE_ 变量一个都找不到时当场失败,而不是默默出一个功能残废的包 */
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
 * 这是**黑名单**:没列到的一律拷进 runtime/app,然后进安装包发给所有用户。
 * 所以少列一条不是「打包大了点」,是把开发机上的东西发出去。
 *
 * 除了构建产物,这里必须挡住三类:
 *   - `.env*` —— 里面有诊断服务的提交令牌之类的密钥;
 *   - `.pc-*` —— 用户/开发者的草稿、AI 会话历史、Skill 任务目录,全是个人数据;
 *   - tools 下各 crate 的 `target`、`.cache` —— Rust 编译产物,单是 tools 下面就有 2.7 GB。
 *     (这一行别写成 `tools/<星号>/target` 的字面形式:那里面的 `<星号>/` 会当场
 *     把这段块注释关掉,整个文件从下一行起被当代码解析,直接 SyntaxError。
 *     c0a66b8 就是这么把 prepare-runtime 打瘫的,连 --check 都跑不起来。)
 * `--from-head` 只在用它的时候才干净;有人手跑 `npm run prepare-runtime` 就全靠这份名单。
 */
const SKIP_DIRS = new Set([
  "node_modules", "out", "dist", ".git", ".vite", "desktop",
  "target",            // Rust 编译产物(tools/*/target,2.7 GB)
  ".cache",
  ".pc-projects",      // 本机草稿
  ".pc-chats",         // AI 会话历史
  ".pc-work",          // 会话附件 / 打开 .proc 时的副本
  ".pc-projects-headless",
  ".claude",           // 本机的 agent 配置和权限
  ".wrangler",         // wrangler dev 的本地缓存(诊断 Worker 那套)
  /*
   * 各任务的 git worktree。少这一条就是把**每一条分支的整份源码**打进安装包发给用户 ——
   * 2026-10-24 出 0.7.25 时撞上:`runtime/app` 从 378 MB 涨到 11 GB(光 `_export-baseline`
   * 那份像素基线就 7.9 GB),makensis 直接 `error mmapping datablock` 挂掉,连着两次。
   * 注意 `out` / `node_modules` 这些是按**名字**挡的、任何层级都挡,所以挡不住 worktree 本身,
   * 只能单列这一条。
   */
  ".worktrees",
  "release",
  // AI harness 的文本工具就往这儿落文件(server/harness/tools/textEditor.mjs、
  // server/vite-plugin-cards.ts)。开发机上跑过 AI 面板就有模型写的 .md/.txt/.json/.png,
  // 上面那份文件名黑名单只挡 .mp4/.mov/.webm/.log,一个都拦不住 —— 不挡就随安装包发出去,
  // 并且装完躺在用户自己的导出目录里。make-patch.mjs 的 RUNTIME_STATE 早把它算作
  // 「用户状态」了,两处口径得一致。
  "exports",
  "work",             // Local agent reviews, fixtures and acceptance evidence.
  "__pycache__",
]);
/**
 * 不论是目录还是**文件**都按名字跳过的名字。
 *
 * `.git` 必须在这里:它在普通检出里是目录,但在 git worktree(`build-release --from-head`
 * 开的 desktop/.cache/release-src 就是一棵)和子模块里是一个 `gitdir: …` 指针**文件**。
 * 只对目录生效的 SKIP_DIRS 拦不住它,这个指向打包机路径的文件就进了 runtime/app、
 * 补丁清单和安装包(0.7.13 的 manifest 里第一个键就是 ".git")。
 *
 * SKIP_DIRS 里其它名字没有同样处理:它们(node_modules、out、dist、target、release、work、
 * exports、desktop 等)都是普通英文词,只在「目录」形态下才是构建产物/本机状态;
 * 同名的**源码文件**理应拷贝,不能按名字一刀切。`git ls-files` 里也没有任何一个同名文件。
 * 往这里加名字之前先想清楚这一点。
 */
const SKIP_ANY_KIND = new Set([".git"]);
const SKIP_FILE_PATTERNS = [
  /^\.env($|\.)/,      // .env / .env.local / .env.production —— 里面是密钥
  // wrangler 读本地密钥就用这个固定文件名,里面正是 ADMIN_KEY / FEISHU_WEBHOOK / SUBMIT_TOKEN。
  // 它不叫 .env,所以上面那条匹配不到 —— 单列一条。
  /^\.dev\.vars($|\.)/,
  /^\.npmrc$/,         // 可能带私有 registry 的认证 token
  /^\.pc-last-.*\.txt$/,
  /\.lock$/,           // .proc 的独占锁,开发机上的残留
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
 * `.env` 一行右边那串东西按 dotenv 的规矩解出来:**引号内原样,引号外的 `#` 起注释**。
 *
 * 为什么不能只 trim 一下就用:开发期 vite 读同一个文件走的是 dotenv,`A=x  # 线上` 解出来是 `x`;
 * 这里要是把 `  # 线上` 一起当成值注入,就成了「同一份 .env.local,开发跑得好好的、打出来的包
 * 是坏的,而且哪儿都不报错」—— 前端拿到的 URL 尾巴上挂着一段注释,请求发不出去。
 */
function parseEnvValue(raw) {
  const s = String(raw).trim();
  const quoted = s.match(/^(['"])([\s\S]*?)\1/);
  if (quoted) return quoted[2];          // 引号里的 # 是值的一部分,不是注释
  return s.replace(/\s+#.*$/, "").trim(); // 裸值:空白 + # 之后是注释
}

/**
 * 把仓库根 `.env*` 里的 `VITE_` 变量取出来,**交给 vite build 当环境变量**。
 *
 * 为什么要绕这一道:`VITE_` 前缀的变量是在构建时**内联进前端产物**的
 * (`import.meta.env.VITE_DIAG_SUBMIT_URL` 之类)。而上面的黑名单把 `.env*` 挡在了
 * 拷贝之外 —— 文件不进包是对的,但 vite build 是在 `runtime/app` 里跑的,那里没有这个
 * 文件,于是那些值也一起没了:**打出来的包里诊断提交功能是死的**,按钮灰掉说
 * 「还没配收报告的地址」。是打完第一个完整包才发现的,靠单测和 --check 都看不出来。
 *
 * vite 的 loadEnv 除了读 .env 文件,也会把 process.env 里带前缀的变量收进去,
 * 所以这样传就够了,不用把文件拷过去再删。
 *
 * 只取 `VITE_` 开头的:那些本来就是「要发给用户」的值(诊断服务的地址和提交令牌 ——
 * 令牌是公开可得的,worker.js 里写明了它只挡随手扫到的人)。真正的服务端密钥
 * (ADMIN_KEY 之类)放在 `.dev.vars` 和 wrangler secret 里,不带 VITE_ 前缀,取不到也不该取。
 */
function viteEnvFromDotEnv() {
  /*
   * 找两个地方,**真仓库在前、源码根在后(后者覆盖前者)**:
   *
   *   path.resolve(DESKTOP_DIR, "..")  真仓库。`.env*` 是 gitignore 的开发者本地文件,
   *                                    只存在于这里;
   *   PROJECT_ROOT                     源码根。`--source` 指过来时是一棵**临时 worktree**,
   *                                    那里面没有 .env*(gitignore 的东西不会进 worktree)。
   *
   * 只看 PROJECT_ROOT 是不够的 —— 那正是第一版的毛病:手动建 worktree 时我把 .env.local
   * 拷进去了,所以验过;而真正的发布路径 `build-release --from-head` 会自己开一棵
   * desktop/.cache/release-src,那里面永远没有这个文件,于是 VITE_ 变量照样丢,
   * 装出来的包诊断提交还是死的。加上真仓库这条回退才算真修好。
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
    console.log(`  注入构建期变量:${keys.join(", ")}`);
    return out;
  }
  /*
   * 一个都没找到。手跑(比如别人克隆这个仓库)时这不算错,警告一句就行;
   * **正经发布时必须当场失败**。
   *
   * 这个坑修过两回(d4d1a00 传给 vite build、ca46dd3 加真仓库回退),两回都是发出去才发现的,
   * 因为流程里没有任何一步会因此失败:vite build 照常成功、--check 看不出来、单测更测不到,
   * 装出来的包一切正常,只有「提交诊断报告」那个按钮是灰的。缺值本身好修,难的是**没人知道**。
   * 所以 build-release 会带上 --require-vite-env,让它在这里就断掉。
   */
  console.log("  ⚠ 没找到任何 VITE_ 变量(查过真仓库和源码根的 .env*)");
  console.log("    后果:装出来的包里「提交诊断报告」会灰掉,只能「保存为文件」。");
  if (REQUIRE_VITE_ENV) {
    console.error("[FAIL] 发布构建要求 VITE_ 变量就位,但一个都没找到。");
    console.error(`       在仓库根建 .env.local 并填上 VITE_DIAG_* 再重来;`);
    console.error(`       确实要发一个没有诊断提交功能的包,就去掉 --require-vite-env。`);
    process.exit(1);
  }
  return out;
}

/**
 * 把那些 `VITE_` 变量**再落一份 `.env.local` 进包里**。
 *
 * 上面那道「传给 vite build」只喂饱了 `dist/`,而**装出来的应用根本不读 dist** ——
 * 壳(desktop/src-tauri/src/lib.rs)是拿 sidecar 的 node 在 `runtime/app` 里起一个
 * `vite --port 5210` 的 dev server,前端是现编译现送的。那个进程还是 `env_clear()`
 * 起的,只拿到壳显式塞进去的几个 PROMPTCUT_*,于是 `import.meta.env.VITE_DIAG_SUBMIT_URL`
 * 在用户机器上恒为空:诊断子窗口的「提交」永远灰着,写着「还没配收报告的地址」。
 * 0.2.12 之前每一个版本都是这样,dist 里明明内联好了也没用 —— 那份产物没人加载。
 *
 * 所以这里在拷贝**之后**自己生成一份:内容只有 VITE_ 变量,是重新写的,不是把开发机的
 * `.env.local` 原样拷进来(那里面可能有别的东西)。SKIP_FILE_PATTERNS 挡的是「原样拷贝」,
 * 挡的对;这份是白名单过滤后的结果,该进包。
 *
 * 值本身是公开的:地址就是要发给用户的,提交令牌 worker.js 里写明了只挡随手扫到的人。
 */
function writeRuntimeEnv(appDir, viteEnv) {
  const keys = Object.keys(viteEnv);
  const target = path.join(appDir, ".env.local");
  if (keys.length === 0) {
    // 没有值就别留个空文件在那儿装样子,不然下次排查时看见文件在会以为这条路通了
    if (fs.existsSync(target)) fs.rmSync(target);
    return;
  }
  const body = [
    "# 由 desktop/scripts/prepare-runtime.mjs 生成,不要手改。",
    "# 应用是在这个目录里跑 vite dev 的,前端的 import.meta.env 从这里来。",
    ...keys.map((k) => `${k}=${viteEnv[k]}`),
    "",
  ].join("\n");
  fs.writeFileSync(target, body);
  console.log(`  写入 runtime .env.local:${keys.join(", ")}`);
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
     * 这份 .env.local 是应用里「提交诊断报告」唯一的地址来源(见 writeRuntimeEnv)。
     * 开发机上有值却没生成,说明打包那步漏了 —— 只是包里少了个按钮,不该让整个 --check
     * 挂掉,但一定要吼一声:上一次就是没人吼,一连发了十几个版本才发现。
     */
    if (Object.keys(viteEnvFromDotEnv()).length > 0 && !fs.existsSync(path.join(appDir, ".env.local"))) {
      console.log("  ⚠ runtime/app/.env.local 不在:包里的「提交诊断报告」会是灰的。重跑一次不带 --check 的打包");
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
   * 这一版已经在位就别再拷一遍。
   *
   * 目录名里带版本号(win64-<version>),所以「文件在」就等于「正是要的这一版」——
   * 换版本会走另一个目录,末尾那段清理逻辑会把旧版删掉,不存在拿到陈旧 Chrome 的可能。
   *
   * 不跳会出事:开发机上很可能有东西正开着这份 Chrome(dev server 的网页工具就常驻一个,
   * user-data-dir 落在 out/web-profile),覆盖 chrome.dll 会拿到 EBUSY,整个发布当场中断。
   * 实测过一次 —— 而那 428 MB 拷过去的内容和已经在的一模一样,纯属白费。
   * 真要重来就先把 runtime/chrome 删掉。
   */
  /*
   * 两个浏览器都要:
   *   chrome                —— 完整 Chrome,给网页工具 / 采集用(server/web/browser.mjs)
   *   chrome-headless-shell —— 导出和预渲染用。0.4 起渲染后端是 HeadlessExperimental.beginFrame,
   *                            这个 CDP 域只在 headless-shell 里有(见 server/bakery/chrome.mjs 文件头)。
   *                            以前为了省约 200 MB 专门不拷它,现在少了它导出直接起不来。
   * puppeteer 按 PUPPETEER_CACHE_DIR(= runtime/chrome,lib.rs 里设)下的 <browser>/win64-<版本> 找它们。
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
    // 这一版已经在位就别再拷(理由见上面 already 那段:开着的 Chrome 会让覆盖拿到 EBUSY)
    if (fs.existsSync(exeOf(b))) {
      console.log(`  ${b.name}:已是同一版本,跳过拷贝(下面的旧版本清理照跑)`);
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
 * 内置 Python 和 Node 一样是**必须件**,缺了就不许出包。
 *
 * 这里以前是「detect only」:找不到只打一条 WARN 就往下走,理由是「语音识别功能
 * 不可用」——那是 Python 还只喂 STT 时的写法。现在它下面挂着转场识别、主体检测、
 * 运动追踪四个包,README 也把它和 Node / Chrome / ffmpeg 并列写进「全部运行时」,
 * 放行等于打出一个装上去才发现半边功能是死的安装包。
 *
 * 这一步只做检测、不做组装:组装归 prepare-python.mjs(要联网下 embeddable zip
 * 和 pip),那是个几分钟的活儿,不该埋在每次 prepare-runtime 里偷偷触发。
 */
function stepPython() {
  const stepT = Date.now();
  console.log("\n── Step 5: Python ──");
  const pythonExe = path.join(RUNTIME_DIR, "python", "python.exe");

  assert(
    fs.existsSync(pythonExe),
    `内置 Python 缺失: ${pythonExe}\n` +
    "         它是必须件(转场识别 / 主体检测 / 运动追踪 / 语音识别都跑在它上面)。\n" +
    "         先跑 npm run prepare-python 组装,再重跑本脚本。"
  );

  let ver;
  try {
    ver = execSync(`"${pythonExe}" -V`, { windowsHide: true, encoding: "utf-8", timeout: 5000 }).trim(); // "Python 3.11.x"
  } catch (e) {
    assert(false, `内置 Python 存在但跑不起来: ${e.message}\n         用 npm run prepare-python -- --force 重装。`);
  }
  console.log(`  Python found: ${ver} [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return ver;
}

// ── Step 6: VERSIONS.json ───────────────────────────────────────────────

/*
 * 源码指纹:相对路径 + 大小,**不算 mtime**。
 *
 * 曾经把 `Math.floor(st.mtimeMs)` 也算进来,于是 `--from-head` 那条路必然对不上:
 * 那时源码根是一棵新检出的 worktree(desktop/.cache/release-src),git 把每个文件的
 * mtime 都置成检出那一刻,内容一个字节没变、指纹却全变了 —— `--check` 报「runtime/app
 * 落后于源码」,`--from-head --skip-runtime` 直接跑不通。反过来也一样:发过一次
 * `--from-head` 之后,VERSIONS.json 里记的是 worktree 的 mtime,之后每次普通
 * `--check` 都会误报落后。
 *
 * 换成**内容哈希**而不是退回「路径 + 大小」:后者漏掉「改了内容但字节数没变」的编辑
 * (改个常量、换个字符),而这道校验正是拿来挡「改完忘了重新组装」的。整棵 app 源码
 * (已按 shouldCopyApp 过滤,不含 node_modules / dist / .git)读一遍是秒级的,值这个钱。
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
          `[FAIL] runtime/app 落后于源码，请重跑 npm run prepare-runtime\n` +
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
 * 本文件是不是被当入口直接执行的(而不是被单测 import)。
 *
 * 不能拿 `import.meta.url` 和 `argv[1]` 拼出来的 URL 逐字比:Node 会把入口解析成真实路径,
 * 而 argv[1] 保持用户敲的样子 —— 路径里有目录联接 / 符号链接,或者盘符、目录大小写不同,
 * 就对不上,main() 不跑,prepare-runtime 悄无声息地什么也不做,出包时很难发现。
 * 所以两边都取真实路径(取不到就退回 path.resolve),win32 上不分大小写比。
 */
export function isDirectRun(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (p) => {
    try { return fs.realpathSync.native(p); } catch { /* 退回下面 */ }
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(real(fileURLToPath(metaUrl))) === norm(real(argv1));
}

// 只有被当脚本直接执行时才跑;被单测 import 时(desktop/test/prepare-runtime-filter.test.mjs)不动手
if (isDirectRun()) {
  main();
}
