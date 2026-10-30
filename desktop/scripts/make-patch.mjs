/**
 * PromptCut — Build an update patch from the assembled runtime.
 *
 * 绝大多数改动只落在 Node 那一半（源码 + dist，有时加上依赖），Rust 壳和
 * Chrome/ffmpeg/Python 这三个大块一动不动。完整安装包因此接近 1 GB，而这些
 * 改动本身通常只有几 MB。这个脚本把 runtime/app 里真正会变的部分单独打成一个
 * 可以覆盖到已安装目录上的补丁包。
 *
 *   node scripts/make-patch.mjs                # 依赖没变就不带 node_modules
 *   node scripts/make-patch.mjs --with-deps    # 强制带上 node_modules
 *   node scripts/make-patch.mjs --no-deps      # 强制不带（依赖变了会拒绝）
 *   node scripts/make-patch.mjs --base <file>  # 指定比较基准（release 清单）
 *
 * 前提是 runtime/app 已经由 prepare-runtime 组装好。
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
 * Node 这半边最低要求的外壳版本 —— 手动声明,**不要**用「这次顺手一起编的外壳版本」。
 *
 * 这两件事很容易混:发布时一起编出来的外壳版本,和 Node 这半边真正依赖的外壳能力。
 * 拿前者当门槛的话,外壳每动一次(哪怕只是加个菜单项)就会把所有老外壳的用户挡在
 * 补丁外面,逼他们下三百多 MB 的完整包,只为换一个 11 MB 的 exe —— 而那些用户
 * 本来只是想拿 Node 这半边的更新。
 *
 * 什么时候才该抬高它:Node 这半边开始**硬依赖**某个新外壳能力,缺了就报错或整个
 * 功能不可用。「有了更好、没有也能降级」不算 —— 那种留在门槛下面,让老外壳照样能打补丁。
 *
 * 现在是 0.2.0:0.2.x 的任何外壳都跑得起来。0.2.3 新加的原生「外观 → 皮肤…」
 * 属于可降级项(前端读 window.__TAURI__ 走的是可选链,皮肤对话框在顶栏「⋯」里
 * 还有一个入口),所以不抬门槛。
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
 * 安装器那三个文件(apply-patch.ps1 / apply-patch.cmd / patch-installer.nsi)从哪儿取。
 *
 * **默认是 `__dirname`,也就是当前工作区。这对 `--from-head` 是错的。**
 * payload 走的是 `runtime/app`,那是 prepare-runtime 从 HEAD 的临时 worktree 组装出来的;
 * 而这三个文件一直是直接从工作区拷的,于是 `--from-head` 那句「源码取自 HEAD、忽略未提交
 * 改动」对它们不成立 —— 打出来的包可能是「runtime 是已提交的 A 版、安装器是工作区的 B 版」,
 * 对不上任何一个提交。实测撞见过:安装器的改动还没提交就被打进了包,而它依赖的服务端字段
 * (那次是 /api/mcp/status 的 activeRuns)还停在旧版,两半对不上。
 *
 * 所以 build-release 在拆掉 worktree 之前会把这三个文件先拷到一个暂存目录,
 * 再用 `--installer-src` 指过来。单独手跑 make-patch 时不传,行为和以前一样。
 */
const INSTALLER_DIR = option("--installer-src") || __dirname;
/** 三个文件缺一不可:少了任何一个,补丁包要么装不了,要么根本打不出来 */
const INSTALLER_FILES = ["apply-patch.ps1", "apply-patch.cmd", "patch-installer.nsi"];
for (const f of INSTALLER_FILES) {
  if (!fs.existsSync(path.join(INSTALLER_DIR, f))) {
    console.error(`[FAIL] 安装器文件缺失：${path.join(INSTALLER_DIR, f)}`);
    process.exit(1);
  }
}

/**
 * runtime/app 里不属于构建产物的东西：用户跑起来之后自己长出来的目录。
 * 补丁绝不能碰它们 —— 导出的视频和 AI 会话历史都在这里面。
 */
const RUNTIME_STATE = new Set([
  "node_modules",   // 单独处理：依赖变了才随包发出去
  "exports",        // 用户导出的视频
  ".pc-chats",      // AI 会话历史
  ".pc-work",       // 每个会话的附件工作目录
  ".pc-projects",   // 用户草稿 —— 漏了它,补丁会把打包机上的草稿发给所有人
  "out",
  ".vite",
  ".cache",
  ".claude",
]);

/**
 * 单个文件级别的黑名单。目录名挡不住 `.env.local` 这种躺在根上的文件 ——
 * 它里面是诊断服务的提交令牌,跟着补丁发出去等于把密钥交给每一个装了补丁的用户。
 */
const RUNTIME_STATE_FILES = [
  /^\.env($|\.)/,
  /^\.dev\.vars($|\.)/, // wrangler 的本地密钥文件,不叫 .env 但装的是同一类东西
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

/** app 目录里所有构建产物文件的相对路径（正斜杠），不含运行期状态和依赖。 */
function listPayloadFiles(dir = APP_DIR, base = "") {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (base === "" && RUNTIME_STATE.has(ent.name)) continue;
    // `.git`(worktree 里是指针文件,普通检出里是目录)任何层、任何形态都不进补丁。
    // prepare-runtime 已经不拷它了;这里再挡一道,是因为 runtime/app 可能是旧版本留下的,
    // 而 make-patch 可以 --skip-runtime 直接吃现成的 runtime/app。
    if (ent.name === ".git") continue;
    // 文件级黑名单在**每一层**都查:.env.local 之类不是只会出现在根上
    if (!ent.isDirectory() && RUNTIME_STATE_FILES.some((re) => re.test(ent.name))) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listPayloadFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * 复制整棵目录树。node_modules 有几万个文件、嵌套很深，Windows 上用 robocopy
 * 比逐个 copyFileSync 快得多，也不会撞上 260 字符的路径上限。
 */
function copyTree(src, dest) {
  const r = spawnSync("robocopy.exe", [src, dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"], { windowsHide: true,
    stdio: "inherit", timeout: 1_800_000,
  });
  // robocopy 用退出码表示做了什么，0–7 都算成功，≥8 才是真出错。
  if (r.error || r.status === null || r.status >= 8) {
    fail(`复制 ${src} 失败（robocopy 代码 ${r.status}${r.error ? `，${r.error.message}` : ""}）`);
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
 * 上一次发布的清单，用来判断依赖有没有变、哪些文件被删了。
 *
 * 必须排掉「本次这个版本自己的清单」：重跑一遍 make-patch 时它已经躺在
 * release/ 里了，拿它当基准就是和自己比——依赖当然一致，于是产出一个不带
 * node_modules 的补丁，装到真正的上一版上要么被 lock 校验拦下，要么(万一
 * 绕过了)缺包跑不起来。
 */
function findBaseManifest(appVersion) {
  const explicit = option("--base");
  if (explicit) {
    if (!fs.existsSync(explicit)) fail(`--base 指定的清单不存在：${explicit}`);
    return { path: explicit, data: JSON.parse(fs.readFileSync(explicit, "utf-8")) };
  }
  if (!fs.existsSync(RELEASE_DIR)) return null;
  const candidates = fs.readdirSync(RELEASE_DIR)
    .filter((n) => /^manifest-.*\.json$/.test(n))
    .map((n) => path.join(RELEASE_DIR, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const p of candidates) {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.appVersion === appVersion) continue; // 自己，不能当基准
    return { path: p, data };
  }
  return null;
}

/**
 * 只哈希 package-lock 里的**依赖内容**，跳过应用自己的版本号。
 *
 * 原先哈希的是整份文件，于是每次小版本发布（只改了 version 字段）都会被判成
 * 「依赖变了」，硬把 196 MB 的 node_modules 塞进补丁 —— 一个本该几 MB 的补丁
 * 变成 48 MB。而补丁这一层存在的理由就是它小。
 *
 * 真正的依赖变化仍然抓得住：它们全在 packages 里，那部分一个字节都没跳过。
 */
function hashLockDeps(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  delete raw.version;
  if (raw.packages && raw.packages[""]) delete raw.packages[""].version;
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

function main() {
  console.log("PromptCut make-patch");

  if (!fs.existsSync(APP_DIR)) fail(`runtime/app 不存在，先跑 npm run prepare-runtime`);
  const distIndex = path.join(APP_DIR, "dist", "index.html");
  if (!fs.existsSync(distIndex)) fail(`runtime/app/dist/index.html 不存在，先跑 npm run prepare-runtime`);

  const appPkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf-8"));
  // 防的是「改完源码忘了重跑 prepare-runtime，拿旧的 app 打补丁」。
  // --from-head 的发布刚刚在同一次调用里组装过 runtime/app，源码来自 HEAD 而不是
  // 工作区，跟工作区比反而会误报，所以那条路径跳过这一检查。
  if (!flag("--skip-source-check")) {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    if (appPkg.version !== rootPkg.version) {
      fail(`runtime/app 落后于源码（app ${appPkg.version} ≠ 源码 ${rootPkg.version}），先重跑 prepare-runtime`);
    }
  }
  const appVersion = appPkg.version;
  const shellVersion = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_DIR, "src-tauri", "tauri.conf.json"), "utf-8")
  ).version;

  // 门槛必须和这次外壳同一代次,否则清单自相矛盾:代次校验先过、门槛却指向另一代
  const gen = (v) => v.split(".").slice(0, 2).join(".");
  if (gen(MIN_SHELL_VERSION) !== gen(shellVersion)) {
    fail(
      `MIN_SHELL_VERSION(${MIN_SHELL_VERSION})和本次外壳(${shellVersion})不是同一代次。` +
        `外壳换代时要把它一起挪到新代次的起点。`
    );
  }

  const lockPath = path.join(APP_DIR, "package-lock.json");
  const lockHash = sha256File(lockPath);
  const lockDepsHash = hashLockDeps(lockPath);
  const base = findBaseManifest(appVersion);
  if (base) console.log(`  基准清单：${path.basename(base.path)}（app ${base.data.appVersion}）`);
  else console.log("  没有找到上一次发布的清单");

  // 依赖是否要随包发出去。lock 一样就不带，这才是「只改 Node 代码」的常见情形。
  let includesDeps;
  let depsReason;
  if (flag("--with-deps")) {
    includesDeps = true; depsReason = "命令行指定 --with-deps";
  } else if (flag("--no-deps")) {
    includesDeps = false; depsReason = "命令行指定 --no-deps";
  } else if (!base) {
    includesDeps = true; depsReason = "没有基准清单可比，保守起见带上依赖";
  } else if (!base.data.lockDepsHash) {
    // 老清单只记了整份文件的哈希，没法判断变的是不是依赖，保守带上
    includesDeps = true; depsReason = "基准清单来自旧版本，无法只比依赖";
  } else if (base.data.lockDepsHash !== lockDepsHash) {
    includesDeps = true; depsReason = "依赖与基准不同";
  } else {
    includesDeps = false; depsReason = "依赖与基准一致";
  }
  console.log(`  依赖：${includesDeps ? "随包发出" : "不发"}（${depsReason}）`);
  if (!includesDeps && base && base.data.lockDepsHash && base.data.lockDepsHash !== lockDepsHash) {
    fail("依赖有变化，--no-deps 会产出一个装上去就跑不起来的补丁");
  }

  // ── 收集载荷 ──────────────────────────────────────────────────────
  const files = listPayloadFiles();
  const hashes = {};
  let payloadBytes = 0;
  for (const rel of files) {
    const full = path.join(APP_DIR, rel);
    hashes[rel] = sha256File(full);
    payloadBytes += fs.statSync(full).size;
  }
  console.log(`  构建产物：${files.length} 个文件，${mb(payloadBytes)} MB`);

  // 上一版有、这一版没有的文件。只删构建产物，用户数据不在这个集合里。
  const removed = base?.data?.files
    ? Object.keys(base.data.files).filter((rel) => !(rel in hashes))
    : [];
  if (removed.length) console.log(`  需要删除的旧文件：${removed.length} 个`);

  // ── 组装补丁目录 ──────────────────────────────────────────────────
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
    if (!fs.existsSync(src)) fail("要带依赖，但 runtime/app/node_modules 不存在");
    console.log("  复制 node_modules…");
    copyTree(src, path.join(payloadDir, "node_modules"));
    deps = countTree(path.join(payloadDir, "node_modules"));
    console.log(`  依赖：${deps.files} 个文件，${mb(deps.bytes)} MB`);
  }

  const manifest = {
    format: "promptcut-patch/1",
    appVersion,
    // 补丁只换 Node 那一半。内核代次（外壳版本的前两段）不同就一定装不了 ——
    // Chrome / ffmpeg / Python / Rust 外壳都在完整安装包里，补丁碰不到。
    shellGeneration: shellVersion.split(".").slice(0, 2).join("."),
    minShellVersion: MIN_SHELL_VERSION,
    builtAt: new Date().toISOString(),
    includesDeps,
    depsReason,
    lockHash,
    // 下一次发布靠它判断依赖到底变没变（lockHash 会被版本号一起带偏）
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
  fs.copyFileSync(path.join(INSTALLER_DIR, "apply-patch.cmd"), path.join(root, "安装更新.cmd"));
  fs.writeFileSync(path.join(root, "README.txt"), readmeText(manifest));

  // ── 打包 ──────────────────────────────────────────────────────────
  mkdirp(RELEASE_DIR);
  const zipPath = path.join(RELEASE_DIR, `${stem}.zip`);
  rmrf(zipPath);
  // 打包前先核对暂存目录：该进去的都在，才轮得到压缩。
  const mustHave = ["patch.json", "apply-patch.ps1", "安装更新.cmd", "README.txt",
    ...files.map((rel) => `payload/${rel}`)];
  const missing = mustHave.filter((p) => !fs.existsSync(path.join(root, p)));
  if (missing.length) fail(`补丁内容少了 ${missing.length} 项，例如 ${missing[0]}`);
  console.log(`  内容核对通过：${mustHave.length} 项`);

  // 主产物是 exe：用户双击就装，不用先解压、也不会有人误在压缩包里点 cmd。
  const exePath = path.join(RELEASE_DIR, `${stem}.exe`);
  rmrf(exePath);
  console.log("  用 NSIS 打成 exe…");
  const nsis = findMakensis();
  const build = spawnSync(nsis, [
    `-DVERSION=${appVersion}`,
    `-DSRCDIR=${root}`,
    `-DOUTFILE=${exePath}`,
    `-DICON=${path.join(DESKTOP_DIR, "src-tauri", "icons", "icon.ico")}`,
    path.join(INSTALLER_DIR, "patch-installer.nsi"),
  ], { windowsHide: true, encoding: "utf8", timeout: 1_800_000 });
  if (build.status !== 0 || !fs.existsSync(exePath)) {
    fail(`NSIS 打包失败（退出码 ${build.status}）\n${(build.stdout || "").slice(-2000)}${build.stderr || ""}`);
  }

  // 想看看补丁里到底有什么就加 --zip，日常发布用不到。
  if (flag("--zip")) {
    console.log("  额外打一份 zip…");
    // hdrcharset=UTF-8 不能省：默认按 CP437 存文件名，「安装更新.cmd」会被
    // 直接丢掉，只在 stderr 留一行警告。
    const tarExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const zip = spawnSync(fs.existsSync(tarExe) ? tarExe : "tar",
      ["-a", "-c", "--options", "hdrcharset=UTF-8", "-f", zipPath, stem], { windowsHide: true,
        cwd: STAGE_DIR, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8", timeout: 1_800_000,
      });
    if (zip.status !== 0) fail(`zip 打包失败（退出码 ${zip.status}）${zip.stderr || ""}`);
    if (zip.stderr && zip.stderr.trim()) fail(`zip 里有文件被跳过：\n${zip.stderr.trim()}`);
  }

  // 清单单独放一份，下一次构建拿它当基准算差异
  fs.writeFileSync(path.join(RELEASE_DIR, `manifest-${appVersion}.json`), JSON.stringify(manifest, null, 2));
  rmrf(STAGE_DIR);

  console.log(`\n  补丁：${exePath}（${mb(fs.statSync(exePath).size)} MB）`);
  return { exePath, manifest };
}

/** Tauri 自己装的那份 NSIS；没有就退回 PATH。 */
function findMakensis() {
  const bundled = path.join(process.env.LOCALAPPDATA || "", "tauri", "NSIS", "Bin", "makensis.exe");
  if (fs.existsSync(bundled)) return bundled;
  const probe = spawnSync("makensis", ["/VERSION"], { windowsHide: true, encoding: "utf8" });
  if (probe.status === 0 || probe.stdout) return "makensis";
  fail("找不到 makensis。跑一次 npm run build 让 Tauri 把 NSIS 装下来，或者自己装 NSIS 并加进 PATH。");
}

function readmeText(m) {
  return [
    `PromptCut 更新补丁 ${m.appVersion}`,
    ``,
    `这个补丁只更新程序里 Node 那一部分（界面和后端逻辑）${m.includesDeps ? "以及依赖" : ""}，`,
    `不动 Chrome、ffmpeg、Python 和外壳，所以比完整安装包小很多。`,
    ``,
    `用法：双击「安装更新.cmd」。`,
    ``,
    `它会做这些事：`,
    `  1. 找到已安装的 PromptCut（默认 %LOCALAPPDATA%\\PromptCut）`,
    `  2. 确认版本对得上（外壳需要 ${m.minShellVersion} 或更新）`,
    `  3. 请你关掉正在运行的 PromptCut`,
    `  4. 备份当前版本，然后覆盖更新`,
    `  5. 出任何问题都会自动回滚到备份`,
    ``,
    `不会动的东西：导出的视频（exports）、AI 会话历史（.pc-chats）、`,
    `设置和密钥（%LOCALAPPDATA%\\promptcut）、下载的语音模型。`,
    ``,
    `如果补丁装不上，用完整安装包覆盖安装即可，效果一样。`,
  ].join("\r\n");
}

main();
