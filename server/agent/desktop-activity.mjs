/**
 * 桌面 APP 会话在 AI 栏里的分组(计划 `docs/plan/agent-workflow-plan.md` A4;语义 `user-workflow.md`「Agent 接入方式」
 * 「进度可见」):打开编辑界面时,每个桌面 APP 会话单独显示,标明厂商和正在进行的操作;它用 `report_progress` 交的
 * 进度条目和 AI 栏里 Agent 的进度条目显示方式相同。
 *
 * 桌面 APP 的文字输出本软件拿不到,这里只记工具调用:谁(会话身份、厂商)、在跑什么、跑过什么、交了哪些进度报告。
 * 编辑器进程(`server/vite-plugin-ai.ts`)在每次桌面会话的工具调用前后调 `begin` / `end`,变了就把整份快照经
 * SSE(`agent.desktop`)推给页面;页面刚连上时 `GET /api/agent/desktop` 取一次。
 *
 * 数字〔裁〕:每个会话留最近 20 次调用、最近 30 份进度报告;最多记 16 个会话,超了丢最久没动的;
 * 2 小时没动静的会话不再显示。只在内存里,编辑器重启就清空(桌面会话下次调用时重新出现)。
 *
 * 不依赖 vite;测试直接调。
 */
import { validateProgressReport } from '../progress-report.mjs';

export const DESKTOP_ACTIVITY_LIMITS = Object.freeze({
  recentCalls: 20,
  reports: 30,
  sessions: 16,
  idleMs: 2 * 60 * 60 * 1000,
});

const REPORT_TOOL = 'report_progress';

/** 调用结果里的一句话错误(拒绝、失败) */
function errorText(out) {
  if (!out || typeof out !== 'object') return null;
  if (out.ok === false) return String(out.error || out.message || '失败').slice(0, 300);
  return null;
}

/**
 * @param {{ now?: () => number, onChange?: () => void, limits?: Partial<typeof DESKTOP_ACTIVITY_LIMITS> }} [o]
 */
export function createDesktopActivity({ now = () => Date.now(), onChange = () => {}, limits: limitsIn = {} } = {}) {
  const L = { ...DESKTOP_ACTIVITY_LIMITS, ...limitsIn };
  /** 会话 key → 记录 */
  const sessions = new Map();
  let seq = 0;

  function entry(key, info = {}) {
    let e = sessions.get(key);
    if (!e) {
      e = {
        id: key,
        vendor: null,
        label: null,
        client: null,
        firstSeen: now(),
        lastSeen: now(),
        calls: 0,
        /** 正在跑的调用:callSeq → { tool, since } */
        running: new Map(),
        recent: [],
        reports: [],
      };
    }
    if (typeof info.vendor === 'string' && info.vendor) e.vendor = info.vendor.slice(0, 64);
    if (typeof info.label === 'string' && info.label) e.label = info.label.slice(0, 64);
    if (info.client && typeof info.client === 'object') e.client = { name: String(info.client.name || '').slice(0, 64), version: String(info.client.version || '').slice(0, 32) };
    e.lastSeen = now();
    // 挪到最后:Map 的顺序就是「最近动过」的顺序,超了从头丢
    sessions.delete(key);
    sessions.set(key, e);
    while (sessions.size > L.sessions) sessions.delete(sessions.keys().next().value);
    return e;
  }

  return {
    /**
     * 一次调用开始。回一个句柄交给 `end`。
     * @param {string} key 会话身份(`desk-…`)
     * @param {{ vendor?: string, label?: string, client?: object }} info
     * @param {string} tool
     * @param {unknown} args
     */
    begin(key, info, tool, args) {
      const e = entry(key, info);
      const id = ++seq;
      e.calls += 1;
      e.running.set(id, { tool: String(tool).slice(0, 64), since: now() });
      // 进度报告不等结果:参数校验过就算交上来了(和 AI 栏一样读调用参数;服务端拒收的这里也不认)
      if (tool === REPORT_TOOL) {
        const checked = validateProgressReport(args);
        if (checked.ok) {
          e.reports.push({ at: now(), report: checked.value });
          if (e.reports.length > L.reports) e.reports.splice(0, e.reports.length - L.reports);
        }
      }
      onChange();
      return { key, id };
    },

    /** 一次调用结束。`out` 是工具结果(`{ ok:false, error }` 算失败),`err` 是抛出来的异常 */
    end(handle, out, err) {
      const e = handle ? sessions.get(handle.key) : null;
      if (!e) return;
      const run = e.running.get(handle.id);
      e.running.delete(handle.id);
      e.lastSeen = now();
      const error = err ? String(err?.message || err).slice(0, 300) : errorText(out);
      e.recent.push({ tool: run?.tool ?? '?', ok: !error, ...(error ? { error } : {}), at: now(), ms: run ? now() - run.since : 0 });
      if (e.recent.length > L.recentCalls) e.recent.splice(0, e.recent.length - L.recentCalls);
      onChange();
    },

    /** 给页面的整份快照:最近动过的在前;太久没动静的不给 */
    snapshot() {
      const t = now();
      return [...sessions.values()]
        .filter((e) => t - e.lastSeen <= L.idleMs || e.running.size > 0)
        .reverse()
        .map((e) => {
          const running = [...e.running.values()];
          const current = running.length ? running[running.length - 1] : null;
          return {
            id: e.id,
            vendor: e.vendor,
            label: e.label,
            client: e.client,
            firstSeen: e.firstSeen,
            lastSeen: e.lastSeen,
            calls: e.calls,
            current: current ? { tool: current.tool, since: current.since } : null,
            last: e.recent.length ? e.recent[e.recent.length - 1] : null,
            recent: e.recent.slice(),
            reports: e.reports.slice(),
          };
        });
    },

    has(key) {
      return sessions.has(key);
    },
  };
}
