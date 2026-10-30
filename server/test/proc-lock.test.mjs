/**
 * .proc 独占锁的自检。跑:node --test server/test/proc-lock.test.mjs
 *
 * 这把锁分两层,各有各的失效方式,所以两层都要单独钉:
 *
 *   Node 那半(原子 wx + pid 兜底):挡得住并发抢,但持有者被**强杀**之后锁文件留在
 *     原地,只能靠 pid 判活 —— 而 pid 会被系统回收,有误判的余地;
 *   外壳那半(Windows 共享模式 0):句柄由内核管,**进程一死内核立刻收走**,没有残留锁。
 *
 * 所以这里测的是:
 *   1. 并发抢只有一个赢(wx 的原子性,不是「先查再写」那种假原子);
 *   2. 持有者正常退出后,锁能被下一个拿到;
 *   3. 持有者被**强杀**之后,内核那层立刻放开(这一条是 Node 单独做不到的);
 *   4. 被内核握着时,别的进程连**删**都删不掉(偷不走锁);
 *   5. 锁的是旁路 .lock 文件,**不是 .proc 本体** —— 本体必须始终可读可写,
 *      否则自家 sidecar 会被自己挡在门外。
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
 * 等「条件成立」,不等固定时长。
 *
 * 以前这里到处是 kill 之后 sleep(500):全量测试几十个进程并行时,500 ms 既可能不够
 * (进程退出、句柄释放被负载拖慢),又凭空拉长了 pid 被系统回收的窗口 —— sleep 期间
 * 事件循环会处理子进程的 exit、关掉我们手里的进程句柄,之后这个号就能分给别的新进程,
 * 于是「死 pid」又被判成活的。
 *
 * waitUntil 先同步查一次再睡:taskkill 是同步跑完的,多数时候第一次就成立,中间不经过
 * 事件循环,我们手里的句柄还开着,这个号没法被回收;不成立再每 50 ms 查一次,最多 10 s。
 */
async function waitUntil(cond, what, { timeout = 10000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等了 ${timeout} ms 仍未${what}`);
    await sleep(every);
  }
}

/** 这个 pid 在系统里已经不存在了(和 acquireLock 判活用的是同一个探法) */
const pidGone = (pid) => {
  try { process.kill(pid, 0); return false; } catch { return true; }
};

/** 锁文件没人用共享模式 0 握着了(能以 r+ 打开) */
const lockOpenable = () => {
  try { fs.closeSync(fs.openSync(LOCK, "r+")); return true; } catch { return false; }
};

const waitGone = (child) => waitUntil(() => pidGone(child.pid), `等到进程 ${child.pid} 退出`);

/** 起一个子进程,用共享模式 0 握住锁文件,一直握到被杀 */
function holder() {
  const script = `
    const fs = require('node:fs');
    // Node 没有 share_mode,用 PowerShell 那套开不了;这里用独占创建(wx)代表 Node 那层,
    // 内核那层由下面的 PowerShell 持有者测
    const fd = fs.openSync(${JSON.stringify(LOCK)}, 'wx');
    process.stdout.write('HELD\\n');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
}

/** 用 PowerShell 拿一个共享模式 0 的句柄,模拟外壳那层 */
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
    const timer = setTimeout(() => reject(new Error("持有者没起来")), 15000);
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

test("并发抢锁只有一个赢(wx 是原子的,不是先查再写)", async () => {
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
  assert.equal(results.filter((r) => r === "WON").length, 1, "恰好一个进程该抢到");
  fs.unlinkSync(LOCK);
});

test("持有者正常退出后,锁能被下一个拿到", async () => {
  const h = holder();
  await waitHeld(h);
  assert.throws(() => fs.writeFileSync(LOCK, "me", { flag: "wx" }), /EEXIST/, "持有期间抢不到");
  const exited = new Promise((r) => h.once("exit", r));
  h.kill();
  await exited; // 等它真退出、句柄交还,不猜要多久
  fs.unlinkSync(LOCK); // 正常退出这一路由调用方删锁
  fs.writeFileSync(LOCK, "next", { flag: "wx" });
  fs.unlinkSync(LOCK);
});

test("被内核句柄握着时:打不开、删不掉;强杀之后立刻放开", { skip: process.platform !== "win32" ? "只有 Windows 有共享模式" : false }, async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const h = kernelHolder();
  await waitHeld(h);

  // 1. 别的进程打不开 —— 这就是 Node 那半探测「有没有人握着」用的信号
  assert.throws(() => fs.closeSync(fs.openSync(LOCK, "r+")), (e) => e.code === "EBUSY", "该拿到 EBUSY");
  // 2. 连删都删不掉:锁偷不走
  assert.throws(() => fs.unlinkSync(LOCK), (e) => e.code === "EBUSY" || e.code === "EPERM", "该删不掉");

  // 3. 强杀持有者(进程没有机会做任何清理),内核立刻收走句柄
  kill(h);
  await assert.doesNotReject(
    waitUntil(lockOpenable, "放开句柄"),
    "强杀之后内核该把句柄收走 —— 这正是 Node 那层做不到的",
  );
  fs.unlinkSync(LOCK);
});

test("锁的是旁路 .lock,.proc 本体始终可读可写", { skip: process.platform !== "win32" ? "只有 Windows 有共享模式" : false }, async () => {
  const h = kernelHolder();
  await waitHeld(h);
  // 本体必须一直能读能写:它正是自家 sidecar 要操作的文件,锁住本体等于把自己挡在门外
  assert.doesNotThrow(() => fs.readFileSync(PROC, "utf8"), "本体该能读");
  assert.doesNotThrow(() => fs.appendFileSync(PROC, ""), "本体该能写");
  kill(h);
  // 下一条要在同一个 .lock 上建空文件,得等内核真把句柄收走
  await waitGone(h);
  await waitUntil(lockOpenable, "放开句柄");
});


/*
 * 下面几条测的是 Node 那半的真身 —— server/vite-plugin-skill-state.ts 里的 acquireLock,
 * 不是上面那些原语。评审抓到的两个洞都在它里面:
 *   1. 接管死锁时直接 writeFileSync 覆写 → 读 pid / 判活 / 覆写三步分离,两个实例能双双接管;
 *   2. 锁文件是 0 字节时 JSON.parse 抛出去,被最外层兜底接住返回 ok:true —— 谁都没拿到锁,
 *      而且那个空文件永远留着,pid 这层对该项目永久失效。
 */
const state = await import(new URL("../vite-plugin-skill-state.ts", import.meta.url).href);

/** 一个确实活着、又不是我自己的 pid */
function liveOtherPid() {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  return c;
}

test("空壳锁(0 字节)不该被当成「写不出来」而静默放行", () => {
  try { fs.unlinkSync(LOCK); } catch {}
  fs.writeFileSync(LOCK, "");                       // Rust 探活留下的那种
  const r = state.acquireLock(PROC);
  assert.equal(r.ok, true);
  assert.equal(r.stolen, true, "该是「接管」,不是兜底放行");
  const cur = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  assert.equal(cur.pid, process.pid, "锁文件里该写着我的 pid —— 我是真拿到了锁");
  state.releaseLock(PROC);
  assert.equal(fs.existsSync(LOCK), false, "放锁该把文件删掉");
});

test("持有者已经死了 → 接管;还活着 → 拿不到", async () => {
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

test("并发接管同一个死锁:恰好一个赢(不是两个都以为自己独占)", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  // 一个绝不可能活着的 pid:先起一个再杀掉,拿它的号当死锁
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
    // 保持赢家存活直到每个竞争者都完成尝试。固定等待 2500 ms 会在全量
    // 负载下先结束赢家,让晚启动的竞争者合法接管,误报为同时双赢。
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
  assert.equal(won, 1, `恰好一个该抢到死锁的接管权,实际 ${won} 个`);
  try { fs.unlinkSync(LOCK); } catch {}
});

/*
 * 错开时序下的双赢 —— 这是 85cad05 那一版真正的洞,而且上面那条「12 个并发」抓不到它:
 * 12 个进程是齐步走的,恰好掩盖了「一个已经跑完、另一个才刚醒过来」这种交错。
 *
 * 复现手法:把 B 卡在删旧锁那一步(patch 掉 fs.unlinkSync,第一次遇到锁文件就空转一会儿),
 * 让 A 在这期间完整跑完接管。老代码里 B 醒来之后会无条件把 A 刚建好的锁删掉、自己再赢一次。
 */
function raceChild({ stallMs }) {
  const src = [
    `const fs = (await import('node:fs')).default;`,
    `const LOCK = ${JSON.stringify(LOCK)};`,
    `const STALL = ${stallMs};`,
    `if (STALL > 0) {`,
    `  const real = fs.unlinkSync.bind(fs);`,
    `  let stalled = false;`,
    // 只卡「删旧锁」那一次;.claim 的清理不卡,否则测的就不是同一件事了
    `  fs.unlinkSync = (p, ...rest) => {`,
    `    if (!stalled && String(p) === LOCK) { stalled = true; const end = Date.now() + STALL; while (Date.now() < end) {} }`,
    `    return real(p, ...rest);`,
    `  };`,
    `}`,
    `const s = await import(${JSON.stringify(new URL("../vite-plugin-skill-state.ts", import.meta.url).href)});`,
    `const r = s.acquireLock(${JSON.stringify(PROC)});`,
    `process.stdout.write(JSON.stringify({ pid: process.pid, ok: r.ok, stolen: !!r.stolen }));`,
    // 赢了就一直握着,让「两个都以为自己赢了」暴露出来
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

test("错开时序接管同一个死锁:仍然只有一个赢(不是两个都以为自己独占)", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  try { fs.unlinkSync(LOCK + ".claim"); } catch {}
  const dead = liveOtherPid();
  const deadPid = dead.pid;
  kill(dead);
  await waitGone(dead);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid, at: "2020-01-01T00:00:00Z", host: "dead" }));

  // B 卡在「删旧锁」那一步;A 稍后启动,在这期间完整跑完
  const b = raceChild({ stallMs: 1500 });
  await sleep(400);
  const a = raceChild({ stallMs: 0 });
  const [rb, ra] = await Promise.all([b, a]);

  const winners = [ra, rb].filter((r) => r.ok);
  assert.equal(
    winners.length, 1,
    `恰好一个该赢,实际 ${winners.length} 个。A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`,
  );
  // 锁文件里写的必须就是那个赢家
  const held = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  assert.equal(held.pid, winners[0].pid, "锁文件里的 pid 应该是赢家的");
  try { fs.unlinkSync(LOCK); } catch {}
});

test("接管权的 claim 文件残留了(持有者被强杀)不会把项目永久锁死", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const dead = liveOtherPid();
  const deadPid = dead.pid;
  kill(dead);
  await waitGone(dead);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid, at: "2020-01-01T00:00:00Z", host: "dead" }));
  // 伪造一个「接管到一半被强杀」留下的 claim
  fs.writeFileSync(LOCK + ".claim", JSON.stringify({ pid: deadPid, at: "2020-01-01T00:00:00Z" }));

  const r = state.acquireLock(PROC);
  assert.equal(r.ok, true, `残留 claim 不该挡住接管,实际:${JSON.stringify(r)}`);
  assert.equal(fs.existsSync(LOCK + ".claim"), false, "接管完该把 claim 清掉");
  state.releaseLock(PROC);
});

// 收尾放在最后:过滤运行(--test-name-pattern)时,它若排在前面会先跑掉、把临时目录删了,
// 后面的用例全部 ENOENT —— 看起来像功能坏了,其实是钩子顺序。
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
