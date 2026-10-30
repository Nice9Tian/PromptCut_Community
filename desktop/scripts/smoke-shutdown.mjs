/**
 * PromptCut smoke test — shutdown verification.
 *
 * Reads .smoke-state.json (written by smoke-boot), captures the full
 * descendant tree, kills the main process with taskkill /F /T, then
 * confirms every PID in the tree is gone.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { procList, descendants, alive, findByName } from "./smoke-procs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "..", ".smoke-state.json");

async function main() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error("[FAIL] .smoke-state.json not found — run smoke-boot first.");
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  const { mainPids } = state;
  console.log(`[smoke-shutdown] Main PID(s): ${mainPids.join(", ")}`);

  // Capture full tree before kill
  const listBefore = procList();
  const treeBefore = descendants(mainPids, listBefore);
  const allPids = [...mainPids, ...treeBefore.map((p) => p.pid)];
  console.log(`  Tree size before kill: ${allPids.length} (main + ${treeBefore.length} descendants)`);

  // Kill main process tree
  for (const pid of mainPids) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, encoding: "utf-8", timeout: 10_000 });
      console.log(`  taskkill /F /T /PID ${pid} — OK`);
    } catch (e) {
      console.warn(`  taskkill /F /T /PID ${pid} — ${e.message.trim().split("\n")[0]}`);
    }
  }

  // Wait up to 5 seconds for processes to disappear
  console.log("  Waiting 5s for processes to exit…");
  await new Promise((r) => setTimeout(r, 5000));

  // Check for leftovers
  const listAfter = procList();
  const leftover = allPids.filter((pid) => alive(pid, listAfter));

  if (leftover.length > 0) {
    console.error(`[FAIL] ${leftover.length} process(es) still alive: ${leftover.join(", ")}`);
  } else {
    console.log("  All processes terminated successfully.");
  }

  // Informational: other node/chrome/python on the machine (unrelated)
  for (const name of ["node.exe", "chrome.exe", "python.exe"]) {
    const remaining = findByName(name, listAfter);
    if (remaining.length > 0) {
      console.log(`  [info] ${remaining.length} ${name} still running (unrelated to this test)`);
    }
  }

  const result = {
    ok: leftover.length === 0,
    killedMain: mainPids,
    treeSizeBeforeKill: allPids.length,
    leftover,
  };
  console.log(`SHUTDOWN_RESULT_JSON ${JSON.stringify(result)}`);

  if (leftover.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
