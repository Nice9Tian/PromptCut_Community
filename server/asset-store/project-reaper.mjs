/**
 * 项目删掉之后，把它在素材服务上的字节真的删掉（2026-10-23 claude/guest-fix〔裁〕，审查 REVIEW-guest-identity 的 C）。
 *
 * 为什么要有它：文档服务删项目（创建者点「删项目」、游客项目的三天清理，`server/account/authority.mjs`）只把账本标成
 * 已删除、记一条 `project-access-changed`（`reason: 'delete'`）访问事件；素材服务收到这条事件原先只断流，
 * `project-stores.mjs` 的 `removeProject` 在生产代码里没有调用方，素材字节、两档标记永远留在盘上。
 * 游客「3 天后自动清理」（product/document-service.md「游客」）就名存实亡，而且字节只增不减。
 *
 * 做法：作为素材服务访问事件消费者（`project-revocations.mjs`）的一个参与者，收到删除事件就
 * 1. 先把项目号记进待删清单（落盘，`file`）——事件确认之后进程重启也不会漏删；
 * 2. 当场调 `removeProject(id, { recreatable: true })`（先让这个项目的数据层失效、再删整个项目目录），删成了从清单里划掉，
 *    再回执。**在回执之前删**：素材服务每一次读写核权前都先把访问事件追齐（`project-revocations.mjs` 的 `checkAccess`），
 *    所以删除事件之后的任何写入，都排在这个目录删干净之后——原创建者重用自己删掉的项目号（搬到云端「放弃这次搬迁」后再搬，
 *    `authority.mjs` 的 `createProject` 只放这一种）时，新字节不会写进删了一半的目录、也不会被迟到的删除删掉；
 * 3. 当场删不成（重试几次之后）也照样回执，免得一个删不掉的目录把整个素材服务的事件确认卡死；这时这个项目号在本进程里
 *    一直是 `project-gone`（`removeProject` 先标删除再删目录），后台按退避接着删，删成了才放开；
 * 4. 起服务时把清单里还没删完的先删完（同样删不成就转后台）。
 *
 * 账号项目和游客项目一样删：项目删了就再也进不去（墓碑、`project-gone`），别人也拿不到这个项目号，留着字节只是占盘。
 *
 * 只引 Node 内置模块。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 删不成时的重试间隔（毫秒），用完就一直按最后一个 */
export const REAPER_RETRY_MS = Object.freeze([1_000, 10_000, 60_000, 600_000]);
/** 回执之前当场试几次、每次隔多久（毫秒） */
const INLINE_RETRY_MS = Object.freeze([0, 100, 500]);

const EMPTY_RECEIPT = () => ({ complete: true, closedStreams: [], stoppedRuns: [], rejectedCredentials: [] });

/**
 * @param {object} options
 * @param {{ removeProject: (projectId: string) => Promise<unknown> }} options.projectStores
 * @param {string} options.file 待删清单落盘的位置（JSON）
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {number[]} [options.retryMs]
 */
export function createProjectReaper({ projectStores, file, log = () => {}, retryMs = REAPER_RETRY_MS, inlineRetryMs = INLINE_RETRY_MS }) {
  if (typeof projectStores?.removeProject !== 'function' || !file) throw new TypeError('project reaper needs projectStores.removeProject and file');
  /** @type {Map<string, number>} 项目号 → 已经失败了几次 */
  const pending = new Map();
  const timers = new Map();
  const running = new Set();
  let stopped = false;
  let writing = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify({ v: 1, pending: [...pending.keys()] });
    writing = writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, snapshot);
      try { await fs.rename(tmp, file); } catch (error) { await fs.rm(tmp, { force: true }); throw error; }
    });
    return writing;
  }

  function schedule(projectId, delay) {
    if (stopped || timers.has(projectId) || running.has(projectId)) return;
    const timer = setTimeout(() => { timers.delete(projectId); void reap(projectId); }, delay);
    timer.unref?.();
    timers.set(projectId, timer);
  }

  /** 当场删：试 `inlineRetryMs` 那么多次；删成回 true。删不成转后台退避，回 false */
  async function reapNow(projectId) {
    for (const delay of inlineRetryMs) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (await reap(projectId, { background: false })) return true;
      if (stopped) return false;
    }
    schedule(projectId, retryMs[0]);
    return false;
  }

  async function reap(projectId, { background = true } = {}) {
    if (stopped || running.has(projectId) || !pending.has(projectId)) return !pending.has(projectId);
    running.add(projectId);
    try {
      await projectStores.removeProject(projectId, { recreatable: true });
      pending.delete(projectId);
      log('asset.project-reaped', { projectId });
      await persist().catch(error => log('asset.project-reaper-persist-failed', { code: error?.code ?? 'error' }));
    } catch (error) {
      const failures = (pending.get(projectId) ?? 0) + 1;
      pending.set(projectId, failures);
      log('asset.project-reap-failed', { projectId, failures, code: error?.code ?? 'error' });
      running.delete(projectId);
      if (background) schedule(projectId, retryMs[Math.min(failures - 1, retryMs.length - 1)]);
      return false;
    }
    running.delete(projectId);
    return true;
  }

  return {
    /** 起服务时：把上次没删完的接着删 */
    async start() {
      let saved = null;
      try { saved = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error?.code !== 'ENOENT') log('asset.project-reaper-state-unreadable', { code: error?.code ?? 'invalid' }); }
      for (const id of Array.isArray(saved?.pending) ? saved.pending : []) if (typeof id === 'string' && id) pending.set(id, 0);
      for (const id of [...pending.keys()]) await reapNow(id);
    },
    /** 访问事件参与者：删除事件记进清单、落盘，当场删（删不成转后台），再回执 */
    async handleAccessEvent(event) {
      if (event?.type === 'project-access-changed' && event.reason === 'delete' && typeof event.projectId === 'string' && event.projectId) {
        if (!pending.has(event.projectId)) {
          pending.set(event.projectId, 0);
          await persist();
        }
        await reapNow(event.projectId);
      }
      return EMPTY_RECEIPT();
    },
    unavailable() { /* 删字节不依赖权威在不在线 */ },
    /** 等手上正在删的、排着的都删完（测试用；不等重试） */
    async idle() {
      for (let i = 0; i < 1000 && (running.size || [...timers.keys()].some(id => (pending.get(id) ?? 0) === 0)); i++) await new Promise(r => setTimeout(r, 5));
      await writing.catch(() => {});
    },
    pending: () => [...pending.keys()],
    close() { stopped = true; for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}
