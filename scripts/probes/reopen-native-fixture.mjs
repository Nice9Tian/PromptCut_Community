/** Build a test-only native shell. No installer, registry/file association, or existing runtime writes.
 * Usage: node scripts/probes/reopen-native-fixture.mjs --build
 * Add --standalone-launch to allow a file-association launch with a private launch.json.
 * This only builds the shell; it never changes an association or launches an app.
 * Source must be committed and clean. All executable outputs stay in a fresh OS temp fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
function within(root, target) {
  const rel = path.relative(root, target);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'fixture output must remain inside its root');
}
function copyTree(src, dest, root) {
  within(root, dest);
  const stat = fs.lstatSync(src);
  assert(!stat.isSymbolicLink(), 'native fixture refuses linked input');
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name), root);
  } else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); }
}
function replaceExact(text, before, after, count = 1) {
  assert.equal(text.split(before).length - 1, count, 'native source isolation patch no longer matches');
  return text.split(before).join(after);
}
export function nativeTestEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(PROMPTCUT_|PC_REOPEN_|VITE_)/i.test(k) && !/(?:TOKEN|KEY|PASSWORD|SECRET)/i.test(k)));
  return { ...env, ...extra };
}
export function loadNativeFixture(file) {
  const root = fs.realpathSync(path.dirname(path.resolve(file)));
  assert(path.basename(root).startsWith('pc-reopen-native-') && path.dirname(root) === fs.realpathSync(os.tmpdir()), 'own OS temp fixture required');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.kind, 'promptcut-isolated-native-v1');
  assert.equal(result.root, root);
  assert.match(result.identifier, /^com\.promptcut\.reopen\.[a-f0-9]{16}$/);
  for (const c of result.copies) {
    within(root, c.exe); within(root, c.runtime);
    assert.equal(digest(c.exe), result.exeSha256, 'native executable provenance changed');
    assert.equal(fs.realpathSync(c.exe), c.exe);
  }
  assert.equal(result.copies.length, 2);
  return result;
}

async function build() {
  assert.equal(process.platform, 'win32', 'Windows native fixture only');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'commit source before building the native fixture');
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const primary = path.dirname(path.resolve(repo, git(['rev-parse', '--git-common-dir'])));
  const resources = path.join(primary, 'desktop/src-tauri/runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-native-'));
  const identifier = `com.promptcut.reopen.${randomBytes(8).toString('hex')}`;
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repo, windowsHide: true }).toString().split('\0').filter(Boolean);
  const crate = path.join(root, 'desktop/src-tauri');
  const appA = path.join(root, 'copy-A/runtime/app');
  for (const name of files) {
    // Copy only tracked source. Never read ignored .env, accounts, data, or work files.
    if (name.startsWith('desktop/src-tauri/') || name.startsWith('desktop/ui/')) copyTree(path.join(repo, name), path.join(root, name), root);
    else if (!/^(?:desktop|docs|\.claude|\.github)\//.test(name) && !/^\.(?:env|dev\.vars|npmrc)/.test(name)) copyTree(path.join(repo, name), path.join(appA, name), root);
  }
  const lib = path.join(crate, 'src/lib.rs'), agent = path.join(crate, 'src/agent_webview.rs');
  const patches = [];
  let source = fs.readFileSync(lib, 'utf8').replace(/\r\n/g, '\n');
  function patch(before, after, count, purpose) { source = replaceExact(source, before, after, count); patches.push(purpose); }
  patch('const EDITOR_URL: &str = "http://127.0.0.1:5210/";', 'const EDITOR_URL: &str = "http://127.0.0.1:5203/";', 1, 'test editor URL');
  patch('const EDITOR_PORT: u16 = 5210;', 'const EDITOR_PORT: u16 = 5203;', 1, 'test port with unchanged +1/+2 stage derivation');
  // 原先这里还有一条补丁，把边车参数里写死的 5210 换成 5203：lib.rs 现在写的是
  // `"--port", &editor_port.to_string(),`（第 574 行），而 editor_port 由 account_editor_port() 从 EDITOR_PORT 推出（第 96～97、363 行），
  // 上一条补丁已经把 EDITOR_PORT 改成 5203，边车端口自动跟着走，这条补丁多余了。
  // 它的目标串在今天的 lib.rs 上一次都不命中，replaceExact 会抛「native source isolation patch no longer matches」，
  // 把整条隔离原生壳测试链（reopen-native、reopen-native-upgrade、reopen-installed --rehearse-fixture）卡在夹具构建这一步。
  // 2026-10-23 探针总审删（报告 docs/reports/AGENT-claude-probe-audit.md）。
  patch('if body.contains("PromptCut") {', 'if false {', 1, 'never reuse an existing editor service');
  patch('let mut existing_instance = false;', `for port in [EDITOR_PORT, EDITOR_PORT + 1, EDITOR_PORT + 2] {
                if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() { std::process::exit(73); }
            }
            let mut existing_instance = false;`, 1, 'strict refusal before any occupied test port is contacted');
  patch('dirs_home().join("Videos").join("PromptCut")', 'PathBuf::from(env::var("PC_REOPEN_NATIVE_ROOT").expect("test fixture root required")).join("export")', 2, 'test export directory, including menu commands');
  patch(`let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let app_log_dir = handle
                .path()
                .app_log_dir()
                .expect("failed to resolve app log dir");`, `let fixture_root = PathBuf::from(env::var("PC_REOPEN_NATIVE_ROOT").expect("test fixture root required"));
            let app_data_dir = fixture_root.join("data");
            let app_log_dir = fixture_root.join("logs");`, 1, 'stable test Node data and sidecar logs');
  patch('.title("PromptCut")\n                .inner_size', '.data_directory(PathBuf::from(env::var("PC_REOPEN_NATIVE_BROWSER_DIR").expect("test browser directory required")))\n                .title("PromptCut recovery test")\n                .inner_size', 1, 'isolated main WebView2 profile');
  fs.writeFileSync(lib, source);
  const standaloneLaunch = process.argv.includes('--standalone-launch');
  if (standaloneLaunch) {
    // Explorer does not inherit the probe's private environment. This bootstrap
    // belongs only to the generated fixture and leaves product opening/IPC intact.
    const literal = value => 'r#"' + value + '"#';
    const bootstrap = `
fn recovery_fixture_launch() {
    if env::var("PC_REOPEN_NATIVE_ROOT").is_ok() { return; }
    let fixture = PathBuf::from(${literal(root)});
    let read = std::fs::read(fixture.join("launch.json")).expect("owned launch configuration required");
    let cfg: serde_json::Value = serde_json::from_slice(&read).expect("valid launch configuration required");
    assert_eq!(cfg["kind"].as_str(), Some("promptcut-fixture-launch-v1"));
    let run = PathBuf::from(cfg["env"]["PC_REOPEN_NATIVE_ROOT"].as_str().expect("run root required"));
    assert!(run.starts_with(&fixture) && run != fixture && run.is_dir());
    let real_run = std::fs::canonicalize(&run).unwrap();
    let real_fixture = std::fs::canonicalize(&fixture).unwrap();
    assert!(real_run.starts_with(&real_fixture) && real_run != real_fixture);
    let file = proc_arg(env::args().skip(1)).expect("owned proc argument required");
    let opened = std::fs::canonicalize(&file).expect("owned proc file must exist");
    assert!(opened.starts_with(&real_run));
    let exe = env::current_exe().unwrap();
    assert!(exe.starts_with(&fixture));
    let runtime = exe.parent().unwrap().join("runtime");
    for (key, _) in env::vars() {
        let k = key.to_uppercase();
        if k.starts_with("PROMPTCUT_") || k.starts_with("PC_REOPEN_") || k.starts_with("VITE_") ||
            k.starts_with("PUPPETEER_") || k == "NODE_OPTIONS" ||
            ["KEY", "TOKEN", "PASSWORD", "SECRET"].iter().any(|part| k.contains(part)) { env::remove_var(key); }
    }
    for (key, value) in cfg["env"].as_object().expect("private environment required") {
        let value = value.as_str().expect("string environment values required");
        match key.as_str() {
            "PC_REOPEN_NATIVE_ROOT" | "PC_REOPEN_NATIVE_BROWSER_DIR" | "PROMPTCUT_AI_CONFIG" |
            "PROMPTCUT_CLI_HOME" | "PROMPTCUT_AGY_SETTINGS" | "PROMPTCUT_CLAUDE_CONFIG" |
            "PROMPTCUT_CODEX_CONFIG" | "PROMPTCUT_SKILL_DIR" | "PROMPTCUT_PROJECTS_DIR" => {
                let p = PathBuf::from(value);
                assert!(p.starts_with(&run) && !p.components().any(|c| matches!(c, std::path::Component::ParentDir)));
            }
            "PROMPTCUT_RUNTIME_DIR" => assert_eq!(PathBuf::from(value), runtime),
            "PROMPTCUT_AGENT_CDP" => assert!(value.parse::<u16>().unwrap() > 0),
            "PROMPTCUT_NO_PORT_FILE" => assert_eq!(value, "1"),
            "PROMPTCUT_AUTO_RENDER_NODE" | "PROMPTCUT_PUSH" | "PROMPTCUT_QUEUE_NODE" | "PROMPTCUT_LAN_HOST" => assert_eq!(value, "0"),
            _ => panic!("unsupported fixture environment key"),
        }
        env::set_var(key, value);
    }
    let preload = runtime.join("app/scripts/lib/test-silent-processes.mjs");
    assert!(preload.is_file());
    env::set_var("NODE_OPTIONS", format!("--import={}", tauri::Url::from_file_path(preload).unwrap()));
    let launch_id = cfg["launchId"].as_str().expect("launch identity required");
    assert!(launch_id.len() == 32 && launch_id.bytes().all(|b| b.is_ascii_hexdigit()));
    let receipt = serde_json::json!({ "kind": "promptcut-fixture-launched-v1", "launchId": launch_id,
        "pid": std::process::id(), "exe": exe, "file": opened });
    std::fs::write(fixture.join("launch-receipt.json"), serde_json::to_vec(&receipt).unwrap()).unwrap();
}
`;
    source = replaceExact(source, 'pub fn run() {', bootstrap + '\npub fn run() {\n    recovery_fixture_launch();');
    fs.writeFileSync(lib, source);
    patches.push('test-only Explorer environment bootstrap; only owned proc files and fixed private directories');
  }
  const agentSource = replaceExact(fs.readFileSync(agent, 'utf8').replace(/\r\n/g, '\n'), '.additional_browser_args(&browser_args(port))', '.data_directory(std::path::PathBuf::from(std::env::var("PC_REOPEN_NATIVE_BROWSER_DIR").expect("test browser directory required")))\n    .additional_browser_args(&browser_args(port))');
  fs.writeFileSync(agent, agentSource); patches.push('matching isolated agent WebView2 profile');
  const remoteFile = path.join(crate, 'capabilities/remote.json');
  const remote = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
  remote.remote.urls = ['http://127.0.0.1:5203/*', 'http://localhost:5203/*'];
  fs.writeFileSync(remoteFile, JSON.stringify(remote, null, 2));
  const configFile = path.join(crate, 'tauri.conf.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.identifier = identifier; config.productName = 'PromptCut recovery test';
  config.bundle.active = false; config.bundle.targets = []; config.bundle.resources = {}; config.bundle.fileAssociations = [];
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  patches.push('unique single-instance and plugin storage identity; no bundle or file associations; test origin capability');
  copyTree(process.execPath, path.join(crate, 'binaries/node-x86_64-pc-windows-msvc.exe'), root);
  console.log(JSON.stringify({ phase: 'copy-dependencies', sourceCommit, fixtureDirectory: root }));
  // A worktree may have only a partial node_modules and resolve Vite in the parent checkout.
  // Copy the actual locked dependency tree used by this branch; never create a junction to it.
  const require = createRequire(import.meta.url);
  const dependencyRoot = path.dirname(path.dirname(require.resolve('vite/package.json')));
  assert.equal(path.basename(dependencyRoot), 'node_modules');
  copyTree(dependencyRoot, path.join(appA, 'node_modules'), root);
  for (const name of ['chrome', 'ffmpeg', 'python']) copyTree(path.join(resources, name), path.join(root, 'copy-A/runtime', name), root);
  console.log(JSON.stringify({ phase: 'compile-isolated-native', sourceCommit }));
  const cargo = path.join(os.homedir(), '.cargo/bin/cargo.exe');
  const buildLog = fs.createWriteStream(path.join(root, 'build.log'));
  const child = spawn(cargo, ['build', '--locked', '--offline'], { cwd: crate, windowsHide: true,
    env: nativeTestEnv({ CARGO_TARGET_DIR: path.join(root, 'target') }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(buildLog, { end: false }); child.stderr.pipe(buildLog, { end: false });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await new Promise(resolve => buildLog.end(resolve));
  assert.equal(code, 0, 'isolated native compile failed; inspect fixture build.log');
  const exe = path.join(root, 'target/debug/promptcut.exe');
  const copies = [];
  for (const name of ['copy-A', 'copy-B']) {
    const dir = path.join(root, name);
    if (name === 'copy-B') copyTree(path.join(root, 'copy-A/runtime'), path.join(dir, 'runtime'), root);
    copyTree(exe, path.join(dir, 'promptcut-recovery-test.exe'), root);
    copyTree(process.execPath, path.join(dir, 'node.exe'), root);
    copies.push({ exe: path.join(dir, 'promptcut-recovery-test.exe'), runtime: path.join(dir, 'runtime') });
  }
  const fixture = { kind: 'promptcut-isolated-native-v1', root, sourceCommit, identifier, port: 5203, exeSha256: digest(exe), patches, copies, standaloneLaunch,
    installerProduced: false, fileAssociationsChanged: false, existingRuntimeModified: false };
  const file = path.join(root, 'fixture.json'); fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
  loadNativeFixture(file);
  console.log(JSON.stringify({ phase: 'ready', fixtureFile: file, sourceCommit, exeSha256: fixture.exeSha256, patches }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.includes('--build'), 'explicit --build required; this command never launches a native app');
  await build();
}
