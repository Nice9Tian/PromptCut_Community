/**
 * PromptCut smoke test — full cycle.
 *
 * Usage: node scripts/smoke-all.mjs [exe-absolute-path]
 *   Default: src-tauri/target/release/promptcut.exe
 *
 * Launches the exe as a child process, runs boot and shutdown smoke tests,
 * and ensures cleanup via process.on('exit') fallback.
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");

const defaultExe = path.resolve(desktopDir, "src-tauri", "target", "release", "promptcut.exe");
const exePath = process.argv[2] || defaultExe;
const exeDir = path.dirname(exePath);
const exeName = path.basename(exePath);

async function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, scriptName), exeName], { windowsHide: true,
      stdio: "inherit",
      cwd: desktopDir,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

let appPid = null;

// Fallback cleanup: if this script exits for any reason, kill the app.
process.on("exit", () => {
  if (appPid != null) {
    try {
      execSync(`taskkill /F /T /PID ${appPid}`, { windowsHide: true, timeout: 10_000 });
    } catch { /* best-effort */ }
  }
});

async function main() {
  // Ensure sidecar node.exe exists next to the exe (cargo build does not
  // place it there; tauri build does).
  const nodeExeTarget = path.join(exeDir, "node.exe");
  if (!fs.existsSync(nodeExeTarget)) {
    const sidecarSource = path.resolve(
      desktopDir, "src-tauri", "binaries", "node-x86_64-pc-windows-msvc.exe"
    );
    if (!fs.existsSync(sidecarSource)) {
      console.error(
        `[FAIL] Sidecar source not found at ${sidecarSource}\n` +
        `       Run "npm run prepare-runtime" first to copy node.exe.`
      );
      process.exit(1);
    }
    console.log(`[smoke-all] Copying sidecar: ${sidecarSource} → ${nodeExeTarget}`);
    fs.copyFileSync(sidecarSource, nodeExeTarget);
  }

  if (!fs.existsSync(exePath)) {
    console.error(`[FAIL] Exe not found: ${exePath}`);
    process.exit(1);
  }

  console.log(`[smoke-all] Launching ${exePath}`);
  const app = spawn(exePath, [], { windowsHide: true,
    detached: false,
    stdio: "ignore",
  });
  appPid = app.pid;
  console.log(`  App PID: ${appPid}`);

  app.on("error", (e) => {
    console.error(`[FAIL] Failed to launch: ${e.message}`);
    process.exit(1);
  });

  // Give the app a moment to start
  await new Promise((r) => setTimeout(r, 2000));

  let bootOk = false;
  let shutdownOk = false;

  try {
    await runScript("smoke-boot.mjs");
    bootOk = true;
  } catch (e) {
    console.error(`[FAIL] Boot smoke failed: ${e.message}`);
  }

  try {
    await runScript("smoke-shutdown.mjs");
    shutdownOk = true;
    appPid = null; // cleanup already done by shutdown
  } catch (e) {
    console.error(`[FAIL] Shutdown smoke failed: ${e.message}`);
  }

  const result = {
    ok: bootOk && shutdownOk,
    boot: bootOk,
    shutdown: shutdownOk,
    export: "not-implemented",
  };
  console.log(`ALL_RESULT_JSON ${JSON.stringify(result)}`);

  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
