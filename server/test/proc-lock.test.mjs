/**
 * Self-check of .proc exclusive lock. Run: node --test server/test/proc-lock.test.mjs
 *
 * This lock has two layers, each with its own failure mode, so both layers must be pinned individually:
 *
 *   Node half (atomic wx + pid fallback): defends against concurrent races, but after holder is
 *     **force-killed**, lock file remains in place, relying solely on pid liveness checks: and
 *     pids can be recycled by the system, leaving room for misjudgment;
 *   Shell half (Windows share mode 0): handle is managed by kernel, **as soon as process dies
 *     kernel immediately reclaims it**, leaving no residual lock.
 *
 * So what is tested here:
 *   1. Only one winner in concurrent races (atomicity of wx, not fake atomicity like "check then write");
 *   2. After holder exits normally, lock can be acquired by the next one;
 *   3. After holder is **force-killed**, kernel layer releases immediately (Node cannot do this alone);
 *   4. While held by kernel, other processes cannot even **delete** it (cannot steal lock);
 *   5. What is locked is the sidecar .lock file, **not .proc itself**: .proc itself must always
 *      remain readable and writable, otherwise our built-in sidecar will be locked out by itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lock-"));
const PROC = path.join(TMP, "x.proc");
const LOCK = PROC + ".lock";
fs.writeFileSync(PROC, JSON.stringify({ format: "promptcut-project", version: 1 }), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Wait for "condition met", do not wait for a fixed duration.
 *
 * Previously this was full of sleep(500) after kill: when running full test suite with dozens
 * of processes in parallel, 500 ms might not be enough (process exit and handle release slowed
 * down by load), while needlessly widening the window for pid recycling by the system: during sleep,
 * the event loop processes child process exit and closes process handle we hold, after which
 * this number can be assigned to another new process, so a "dead pid" is judged alive again.
 *
 * waitUntil checks synchronously once before sleeping: taskkill runs synchronously, so most of
 * the time condition holds on the first check without going through the event loop, our handle
 * stays open and this number cannot be recycled; if not met, check every 50 ms, up to 10 s.
 */
async function waitUntil(cond, what, { timeout = 10000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(every);
  }
}

/** This pid no longer exists in the system (uses the same probe method as acquireLock liveness check) */
const pidGone = (pid) => {
  try { process.kill(pid, 0); return false; } catch { return true; }
};

/** No one holds the lock file with share mode 0 anymore (can open with r+) */
const lockOpenable = () => {
  try { fs.closeSync(fs.openSync(LOCK, "r+")); return true; } catch { return false; }
};

const waitGone = (child) => waitUntil(() => pidGone(child.pid), `process ${child.pid} to exit`);

/** Spawn a child process to hold the lock file with share mode 0 until killed */
function holder() {
  const script = `
    const fs = require('node:fs');
    // Node has no share_mode, so the PowerShell approach cannot be used; exclusive creation (wx) stands in for the Node layer here,
    // the kernel layer is tested by the PowerShell holder below
    const fd = fs.openSync(${JSON.stringify(LOCK)}, 'wx');
    process.stdout.write('HELD\\n');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
}

/** Use PowerShell to acquire a handle with share mode 0, simulating the shell layer */
function kernelHolder() {
  const ps = [
    "$f = [System.IO.File]::Open(" + JSON.stringify(LOCK) + ", 'OpenOrCreate', 'ReadWrite', 'None')",
    "Write-Output 'HELD'",
    "while ($true) { Start-Sleep -Milliseconds 200 }",
  ].join("; ");
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

const waitHeld = (child) =>
  new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the holder did not start")), 15000);
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("HELD")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

const kill = (child) => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
};

test("when locks are grabbed concurrently only one wins (wx is atomic, not check-then-write)", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const script = `
    const fs = require('node:fs');
    try { fs.writeFileSync(${JSON.stringify(LOCK)}, String(process.pid), { flag: 'wx' }); process.stdout.write('WON'); }
    catch { process.stdout.write('LOST'); }
  `;
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      new Promise((resolve) => {
        let out = "";
        const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
        c.stdout.on("data", (b) => (out += b));
        c.on("exit", () => resolve(out));
      }),
    ),
  );
  assert.equal(results.filter((r) => r === "WON").length, 1, "exactly one process should win");
  fs.unlinkSync(LOCK);
});

test("after the holder exits normally, the next one can take the lock", async () => {
  const h = holder();
  await waitHeld(h);
  assert.throws(() => fs.writeFileSync(LOCK, "me", { flag: "wx" }), /EEXIST/, "cannot be acquired while held");
  const exited = new Promise((r) => h.once("exit", r));
  h.kill();
  await exited; // Wait for it to actually exit and return the handle; do not guess how long it takes
  fs.unlinkSync(LOCK); // On the normal exit path, the caller deletes the lock
  fs.writeFileSync(LOCK, "next", { flag: "wx" });
  fs.unlinkSync(LOCK);
});

test("while held by a kernel handle: cannot be opened or deleted; released immediately after a force kill", { skip: process.platform !== "win32" ? "only Windows has share mode" : false }, async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const h = kernelHolder();
  await waitHeld(h);

  // 1. Other processes cannot open it: this is the signal the Node half uses to probe "is anyone holding it"
  assert.throws(() => fs.closeSync(fs.openSync(LOCK, "r+")), (e) => e.code === "EBUSY", "should get EBUSY");
  // 2. Cannot even delete it: lock cannot be stolen
  assert.throws(() => fs.unlinkSync(LOCK), (e) => e.code === "EBUSY" || e.code === "EPERM", "should not be deletable");

  // 3. Force-kill the holder (process has no chance to clean up), kernel immediately reclaims handle
  kill(h);
  await assert.doesNotReject(
    waitUntil(lockOpenable, "the handle to be released"),
    "the kernel should reclaim the handle after a force kill: exactly what the Node layer cannot do",
  );
  fs.unlinkSync(LOCK);
});

test("the lock is on the sidecar .lock, and the .proc file itself always stays readable and writable", { skip: process.platform !== "win32" ? "only Windows has share mode" : false }, async () => {
  const h = kernelHolder();
  await waitHeld(h);
  // The file itself must always remain readable and writable: it is precisely the file our built-in
  // sidecar operates on, and locking the file itself would lock ourselves out
  assert.doesNotThrow(() => fs.readFileSync(PROC, "utf8"), "the file itself should be readable");
  assert.doesNotThrow(() => fs.appendFileSync(PROC, ""), "the file itself should be writable");
  kill(h);
  // Next test needs to create an empty file on the same .lock; must wait until the kernel
  // actually reclaims the handle
  await waitGone(h);
  await waitUntil(lockOpenable, "the handle to be released");
});


/*
 * The following tests verify the actual Node half: `acquireLock` in `server/vite-plugin-skill-state.ts`,
 * not the primitives above. The two loopholes caught in review are both inside it:
 *   1. Directly overwriting with `writeFileSync` when taking over a dead lock → read pid, check
 *      liveness, and overwrite are three separate steps, allowing two instances to both take over;
 *   2. When lock file is 0 bytes, `JSON.parse` throws and is caught by outermost fallback returning
 *      `ok:true`: neither acquired the lock, and that empty file remains forever, permanently
 *      disabling the pid layer for this project.
 */
const state = await import(new URL("../vite-plugin-skill-state.ts", import.meta.url).href);

/** A pid that is definitely alive and not my own */
function liveOtherPid() {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  return c;
}

test("an empty lock file (0 bytes) must not be treated as \"cannot write\" and silently let through", () => {
  try { fs.unlinkSync(LOCK); } catch {}
  fs.writeFileSync(LOCK, "");                       // The kind left behind by Rust liveness probes
  const r = state.acquireLock(PROC);
  assert.equal(r.ok, true);
  assert.equal(r.stolen, true, "should be a \"takeover\", not a fallback let-through");
  const cur = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  assert.equal(cur.pid, process.pid, "the lock file should contain my pid: I really did get the lock");
  state.releaseLock(PROC);
  assert.equal(fs.existsSync(LOCK), false, "releasing the lock should delete the file");
});

test("holder already dead → take over; still alive → cannot acquire", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const other = liveOtherPid();
  fs.writeFileSync(LOCK, JSON.stringify({ pid: other.pid, at: new Date().toISOString(), host: "promptcut" }));
  const busy = state.acquireLock(PROC);
  assert.equal(busy.ok, false);
  assert.equal(busy.by, "pid");

  kill(other);
  await waitGone(other);
  const took = state.acquireLock(PROC);
  assert.equal(took.ok, true);
  assert.equal(took.stolen, true);
  state.releaseLock(PROC);
});

test("taking over the same stale lock concurrently: exactly one wins (not both believing they have exclusive hold)", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  // A pid that cannot possibly be alive: spawn one first then kill it, using its number as a dead lock
  const dead = liveOtherPid();
  const deadPid = dead.pid;
  kill(dead);
  await waitGone(dead);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid, at: new Date().toISOString(), host: "promptcut" }));

  const child = path.join(TMP, "grab.mjs");
  const release = path.join(TMP, "grab-release");
  fs.writeFileSync(child, [
    `const fs = (await import('node:fs')).default;`,
    `const s = await import(${JSON.stringify(new URL("../vite-plugin-skill-state.ts", import.meta.url).href)});`,
    `const r = s.acquireLock(${JSON.stringify(PROC)});`,
    // Keep the winner alive until every contender has finished attempting. A fixed wait of 2500 ms
    // would terminate the winner early under full load, allowing late-starting contenders to
    // legitimately take over, falsely reporting a double win.
    `process.stdout.write(r.ok ? "WON" : "LOST");`,
    `const deadline = Date.now() + 30000;`,
    `while (r.ok && !fs.existsSync(${JSON.stringify(release)})) {`,
    `  if (Date.now() > deadline) throw new Error('parent did not release lock test');`,
    `  await new Promise((res) => setTimeout(res, 20));`,
    `}`,
  ].join("\n"), "utf8");

  const competitors = Array.from({ length: 12 }, () => {
    const c = spawn(process.execPath, [child], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve, reject) => {
      c.once("error", reject);
      c.once("close", (code) => code === 0 ? resolve() : reject(new Error(`lock competitor exited ${code}`)));
    });
    // Attach both observers immediately, before a fast child can emit/exit.
    const attempted = new Promise((resolve, reject) => {
        let out = "";
        c.stdout.on("data", (b) => {
          out += b;
          if (out === "WON" || out === "LOST") resolve(out);
        });
        c.once("error", reject);
        c.once("close", () => {
          if (out !== "WON" && out !== "LOST") reject(new Error("lock competitor did not report an attempt"));
        });
    });
    c.stderr.resume();
    return { attempted, exited };
  });
  let results;
  try {
    results = await Promise.all(competitors.map((c) => c.attempted));
  } finally {
    fs.writeFileSync(release, "release");
    await Promise.all(competitors.map((c) => c.exited));
  }
  const won = results.filter((r) => r === "WON").length;
  assert.equal(won, 1, `exactly one should win the right to take over the stale lock, actually ${won}`);
  try { fs.unlinkSync(LOCK); } catch {}
});

/*
 * Double win under staggered timing: this is the real hole in version 85cad05, and the "12 concurrent"
 * test above cannot catch it: 12 processes run in lockstep, which happens to mask interleaving like
 * "one has already finished while another just woke up".
 *
 * Repro method: block B at the deleting old lock step (patch fs.unlinkSync to idle for a bit when
 * encountering the lock file for the first time), letting A complete takeover in the meantime. In old
 * code, after B woke up it would unconditionally delete the lock A just created and win again.
 */
function raceChild({ stallMs }) {
  const src = [
    `const fs = (await import('node:fs')).default;`,
    `const LOCK = ${JSON.stringify(LOCK)};`,
    `const STALL = ${stallMs};`,
    `if (STALL > 0) {`,
    `  const real = fs.unlinkSync.bind(fs);`,
    `  let stalled = false;`,
    // Only block that single "delete old lock"; do not block .claim cleanup,
    // otherwise it is not testing the same thing
    `  fs.unlinkSync = (p, ...rest) => {`,
    `    if (!stalled && String(p) === LOCK) { stalled = true; const end = Date.now() + STALL; while (Date.now() < end) {} }`,
    `    return real(p, ...rest);`,
    `  };`,
    `}`,
    `const s = await import(${JSON.stringify(new URL("../vite-plugin-skill-state.ts", import.meta.url).href)});`,
    `const r = s.acquireLock(${JSON.stringify(PROC)});`,
    `process.stdout.write(JSON.stringify({ pid: process.pid, ok: r.ok, stolen: !!r.stolen }));`,
    // Hold onto it once won to expose any case where "both think they won"
    `if (r.ok) await new Promise((res) => setTimeout(res, 2000));`,
  ].join("\n");
  const f = path.join(TMP, `race-${stallMs}.mjs`);
  fs.writeFileSync(f, src, "utf8");
  return new Promise((resolve) => {
    let out = "";
    const c = spawn(process.execPath, [f], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    c.stdout.on("data", (b) => (out += b));
    c.stderr.on("data", (b) => (err += b));
    c.on("exit", () => resolve(out ? JSON.parse(out) : { ok: false, crashed: err.slice(0, 300) }));
  });
}

test("taking over the same stale lock at staggered times: still only one wins (not both believing they have exclusive hold)", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  try { fs.unlinkSync(LOCK + ".claim"); } catch {}
  const dead = liveOtherPid();
  const deadPid = dead.pid;
  kill(dead);
  await waitGone(dead);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid, at: "2020-01-01T00:00:00Z", host: "dead" }));

  // B gets blocked at the "delete old lock" step; A starts later and finishes completely during this time
  const b = raceChild({ stallMs: 1500 });
  await sleep(400);
  const a = raceChild({ stallMs: 0 });
  const [rb, ra] = await Promise.all([b, a]);

  const winners = [ra, rb].filter((r) => r.ok);
  assert.equal(
    winners.length, 1,
    `exactly one should win, actually ${winners.length}. A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`,
  );
  // What is written in the lock file must be exactly that winner
  const held = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  assert.equal(held.pid, winners[0].pid, "the pid in the lock file should be the winner's");
  try { fs.unlinkSync(LOCK); } catch {}
});

test("a leftover claim file for the takeover right (holder was force-killed) does not lock the project up forever", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const dead = liveOtherPid();
  const deadPid = dead.pid;
  kill(dead);
  await waitGone(dead);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid, at: "2020-01-01T00:00:00Z", host: "dead" }));
  // Forge a claim left behind when "force-killed midway through takeover"
  fs.writeFileSync(LOCK + ".claim", JSON.stringify({ pid: deadPid, at: "2020-01-01T00:00:00Z" }));

  const r = state.acquireLock(PROC);
  assert.equal(r.ok, true, `a leftover claim should not block the takeover, actual: ${JSON.stringify(r)}`);
  assert.equal(fs.existsSync(LOCK + ".claim"), false, "after the takeover the claim should be cleared");
  state.releaseLock(PROC);
});

// Put teardown at the end: when running filtered tests (--test-name-pattern), if placed earlier
// it runs first and deletes the temp directory, causing all subsequent test cases to fail with ENOENT:
// it looks like broken functionality, but it is just hook ordering.
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
