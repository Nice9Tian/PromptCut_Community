/**
 * 阿里云资源采样（计划 `docs/plan/m8-plan.md` 第 2.2 节 I1-X「阿里云 RSS、CPU、带宽记进报告」、第 4 节第 1 项）。
 *
 *   sampleRemote({ target, key, dirs })  经 ssh 跑一段只读脚本（`bash -s`，脚本走标准输入），回解析好的一份采样
 *   parseRemoteSample(text)              解析那段脚本的输出（纯函数，单测覆盖）
 *   diffSamples(a, b)                    两次采样之间的网卡流量差与每秒速率
 *   startSampler({ everyMs, … })          定时采样，`stop()` 回全部样本与峰值
 *
 * ssh 目标与密钥同 `cloud/scripts/remote/docservice.mjs`：环境变量 `PROMPTCUT_REMOTE`（user@host）、`PROMPTCUT_REMOTE_KEY`（私钥路径，可选），
 * `BatchMode=yes`（不交互）。远端脚本只读：pm2 进程表只取名字、pid、状态、重启次数、内存、CPU（`pm2 jlist` 带进程环境变量，
 * 在远端用 node 摘掉再传回，不让环境里的东西出服务器）、`/proc/meminfo`、`/proc/net/dev`、`/proc/loadavg`、数据目录的 `du -sb`。
 */
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_DIRS = Object.freeze(['/var/lib/promptcut/hosted', '/var/lib/promptcut/drill']);

/** 远端脚本（经 ssh 标准输入交给 bash）。目录只收白名单字符，免得拼进脚本出事 */
export function remoteSampleScript(dirs = DEFAULT_DIRS) {
  for (const d of dirs) if (!/^\/[A-Za-z0-9._/-]+$/.test(d)) throw new TypeError(`目录只许 [A-Za-z0-9._/-]：${d}`);
  const pick = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let a=[];try{a=JSON.parse(s.slice(s.indexOf('[')))}catch(e){}"
    + "console.log(JSON.stringify(a.map(p=>({name:p.name,pid:p.pid,status:p.pm2_env&&p.pm2_env.status,restarts:p.pm2_env&&p.pm2_env.restart_time,"
    + "uptime:p.pm2_env&&p.pm2_env.pm_uptime,memory:p.monit&&p.monit.memory,cpu:p.monit&&p.monit.cpu}))))})";
  return [
    'echo "##time $(date +%s%3N)"',
    'echo "##pm2"',
    `(command -v pm2 >/dev/null && pm2 jlist 2>/dev/null || echo '[]') | node -e "${pick}" 2>/dev/null || echo '[]'`,
    'echo "##meminfo"',
    "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
    'echo "##netdev"',
    'cat /proc/net/dev',
    'echo "##loadavg"',
    'cat /proc/loadavg',
    'echo "##du"',
    `du -sb ${dirs.join(' ')} 2>/dev/null || true`,
    'echo "##end"',
  ].join('\n');
}

/**
 * 解析远端脚本的输出。
 * @returns {{ at: number | null, pm2: Array<{ name, pid, status, restarts, uptime, memory, cpu }>, mem: { totalKiB, availableKiB, usedKiB, swapTotalKiB, swapFreeKiB },
 *   net: Record<string, { rx: number, tx: number }>, load: [number, number, number] | null, du: Record<string, number>, complete: boolean }}
 */
export function parseRemoteSample(text) {
  const sections = {};
  let cur = null;
  let at = null;
  let complete = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^##(\w+)(?:\s+(.*))?$/.exec(raw.trim());
    if (m) {
      if (m[1] === 'time') { at = Number(m[2]) || null; cur = null; continue; }
      if (m[1] === 'end') { complete = true; cur = null; continue; }
      cur = m[1];
      sections[cur] = [];
      continue;
    }
    if (cur) sections[cur].push(raw);
  }
  let pm2 = [];
  try { pm2 = JSON.parse((sections.pm2 ?? []).join('').trim() || '[]'); } catch { pm2 = []; }
  const kib = {};
  for (const l of sections.meminfo ?? []) {
    const mm = /^(\w+):\s+(\d+)\s*kB/.exec(l.trim());
    if (mm) kib[mm[1]] = Number(mm[2]);
  }
  const mem = {
    totalKiB: kib.MemTotal ?? null, availableKiB: kib.MemAvailable ?? null,
    usedKiB: kib.MemTotal !== undefined && kib.MemAvailable !== undefined ? kib.MemTotal - kib.MemAvailable : null,
    swapTotalKiB: kib.SwapTotal ?? null, swapFreeKiB: kib.SwapFree ?? null,
  };
  const net = {};
  for (const l of sections.netdev ?? []) {
    const mm = /^\s*([^:\s]+):\s*(.*)$/.exec(l);
    if (!mm) continue;
    const f = mm[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9 && f.every(Number.isFinite)) net[mm[1]] = { rx: f[0], tx: f[8] };
  }
  const lf = (sections.loadavg ?? [])[0]?.trim().split(/\s+/).slice(0, 3).map(Number);
  const load = lf && lf.length === 3 && lf.every(Number.isFinite) ? lf : null;
  const du = {};
  for (const l of sections.du ?? []) {
    const mm = /^(\d+)\s+(\S+)$/.exec(l.trim());
    if (mm) du[mm[2]] = Number(mm[1]);
  }
  return { at, pm2, mem, net, load, du, complete };
}

/** 两次采样之间：各网卡收发字节差与每秒速率（字节/秒），各 pm2 进程的重启次数差 */
export function diffSamples(a, b) {
  const secs = a?.at && b?.at && b.at > a.at ? (b.at - a.at) / 1000 : null;
  const net = {};
  for (const [iface, v] of Object.entries(b?.net ?? {})) {
    const p = a?.net?.[iface];
    if (!p) continue;
    const rx = v.rx - p.rx;
    const tx = v.tx - p.tx;
    net[iface] = { rx, tx, rxPerSec: secs ? Math.round(rx / secs) : null, txPerSec: secs ? Math.round(tx / secs) : null };
  }
  const restarts = {};
  for (const p of b?.pm2 ?? []) {
    const q = (a?.pm2 ?? []).find((x) => x.name === p.name);
    if (q && Number.isFinite(p.restarts) && Number.isFinite(q.restarts)) restarts[p.name] = p.restarts - q.restarts;
  }
  return { secs, net, restarts };
}

/**
 * 经 ssh 采一次。ssh 不通、超时回 { ok: false, error }（暂时性故障，调用方可重试）。
 * @param {{ target?: string, key?: string, dirs?: string[], timeoutMs?: number }} [o]
 */
export function sampleRemote({ target = process.env.PROMPTCUT_REMOTE, key = process.env.PROMPTCUT_REMOTE_KEY, dirs = DEFAULT_DIRS, timeoutMs = 30_000 } = {}) {
  if (!target) return { ok: false, error: '没设 PROMPTCUT_REMOTE（user@host）' };
  const opts = [...(key ? ['-i', key, '-o', 'IdentitiesOnly=yes'] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
  const r = spawnSync('ssh', [...opts, target, 'bash -s'], { input: remoteSampleScript(dirs), encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (r.status !== 0) return { ok: false, error: `ssh 退出码 ${r.status}${r.error ? `：${r.error.code ?? r.error.message}` : ''}：${String(r.stderr ?? '').trim().slice(0, 200)}` };
  const sample = parseRemoteSample(r.stdout);
  return sample.complete ? { ok: true, sample } : { ok: false, error: '输出不完整', sample };
}

/**
 * 定时采样（每 everyMs 一次，ssh 失败只记一条错误、下一拍再试）。
 * @returns {{ samples: object[], errors: string[], stop: () => Promise<{ samples, errors, peak: { memUsedKiB, pm2MemoryBytes: Record<string, number>, pm2Cpu: Record<string, number> }, span: object | null }> }}
 */
export function startSampler({ everyMs = 15_000, sample = sampleRemote, ...o } = {}) {
  const samples = [];
  const errors = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const r = sample(o);
      if (r.ok) samples.push(r.sample); else errors.push(r.error);
      const until = Date.now() + everyMs;
      while (running && Date.now() < until) await delay(Math.min(500, until - Date.now()));
    }
  })();
  return {
    samples, errors,
    async stop() {
      running = false;
      await loop;
      const peak = { memUsedKiB: null, pm2MemoryBytes: {}, pm2Cpu: {} };
      for (const s of samples) {
        if (s.mem.usedKiB !== null) peak.memUsedKiB = Math.max(peak.memUsedKiB ?? 0, s.mem.usedKiB);
        for (const p of s.pm2) {
          if (Number.isFinite(p.memory)) peak.pm2MemoryBytes[p.name] = Math.max(peak.pm2MemoryBytes[p.name] ?? 0, p.memory);
          if (Number.isFinite(p.cpu)) peak.pm2Cpu[p.name] = Math.max(peak.pm2Cpu[p.name] ?? 0, p.cpu);
        }
      }
      return { samples, errors, peak, span: samples.length >= 2 ? diffSamples(samples[0], samples.at(-1)) : null };
    },
  };
}
