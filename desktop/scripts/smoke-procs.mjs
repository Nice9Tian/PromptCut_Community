/**
 * Process-tree utilities for PromptCut smoke tests.
 *
 * Uses Win32_Process via PowerShell to build a parent-child process tree.
 * Only parent-child relationships are trusted — never match by image name alone,
 * because the machine may have unrelated node.exe / chrome.exe / python.exe
 * processes (including the smoke script itself).
 */
import { execSync } from "child_process";

/**
 * Return a list of all processes: [{pid, ppid, name}].
 */
export function procList() {
  const csv = execSync(
    'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"',
    { windowsHide: true, encoding: "utf-8", timeout: 15_000 }
  );
  const lines = csv.trim().split(/\r?\n/).slice(1); // skip header
  return lines.map((line) => {
    // CSV fields are quoted: "pid","ppid","name"
    const parts = line.split(",").map((s) => s.replace(/^"|"$/g, ""));
    return {
      pid: parseInt(parts[0], 10),
      ppid: parseInt(parts[1], 10),
      name: parts[2] || "",
    };
  }).filter((p) => !isNaN(p.pid));
}

/**
 * Find processes whose name matches (case-insensitive).
 */
export function findByName(name, list) {
  list = list || procList();
  const lower = name.toLowerCase();
  return list.filter((p) => p.name.toLowerCase() === lower);
}

/**
 * Breadth-first collection of all descendant processes of the given root PIDs.
 * Does NOT include the roots themselves.
 */
export function descendants(rootPids, list) {
  list = list || procList();
  const roots = new Set(Array.isArray(rootPids) ? rootPids : [rootPids]);
  const result = [];
  const visited = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const p of list) {
      if (p.ppid === parent && !visited.has(p.pid) && !roots.has(p.pid)) {
        visited.add(p.pid);
        result.push(p);
        queue.push(p.pid);
      }
    }
  }
  return result;
}

/**
 * Check whether a PID is still alive.
 */
export function alive(pid, list) {
  list = list || procList();
  return list.some((p) => p.pid === pid);
}
