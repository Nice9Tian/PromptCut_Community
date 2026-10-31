/** One recovery task per page. Dependencies are injected so races and backoff can be verified. */
export class RecoveryCoordinator {
  constructor(hooks) { this.hooks = hooks; this.generation = 0; this.timer = null; this.abort = null; }
  cancel() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.abort?.abort(); this.abort = null;
  }
  start(descriptor, contentId) {
    this.cancel(); const generation = this.generation; const abort = this.abort = new AbortController();
    const current = () => generation === this.generation && !abort.signal.aborted;
    const state = (kind, detail) => { if (current()) this.hooks.state(kind, detail); };
    if (descriptor.version !== 1) { state('unsupported'); return; }
    let delay = 500;
    /*
     * 云端项目「不在了」只认文档服务签发、客户端核对过的证明（`gone-proof.mjs`，由 `hooks.gone` 去问并核对）。
     * 本机凭证被撤（`saved.revoked`）、连到的服务说「没有这个项目」都不是证明：拿到证明才报 `gone`（调用方据此转成本地项目）；
     * 服务明确答了没有墓碑、或没处可问，报 `missing-unconfirmed`；回来的证明核对不过，报 `proof-rejected`；
     * 问不到（断网、超时、服务故障）抛出去，照「等主机」重试。局域网项目没有签发方，照旧报 `deleted`。
     */
    const hosted = descriptor.where === 'hosted' && typeof this.hooks.gone === 'function';
    const missing = async () => {
      if (!hosted) return state('deleted');
      const answer = await this.hooks.gone(descriptor, abort.signal);
      if (!current()) return;
      if (answer?.state === 'gone' && answer.proof) return state('gone', answer);
      return state(answer?.state === 'proof-rejected' ? 'proof-rejected' : 'missing-unconfirmed');
    };
    let asked = false;
    const attempt = async () => {
      if (!current()) return;
      state('recovering');
      try {
        if (hosted && !asked) {
          // 先问一次：项目已被清掉时，这台设备上多半没有还能用的身份，走不到服务端答复那一步。
          // 只有核对过的证明才在这里收场；别的答复、问不到，都照常走恢复。
          let answer = null;
          try { answer = await this.hooks.gone(descriptor, abort.signal); asked = true; } catch { /* 说不清：照常走恢复 */ }
          if (!current()) return;
          if (answer?.state === 'gone' && answer.proof) return state('gone', answer);
        }
        const saved = await this.hooks.identity(descriptor, contentId, abort.signal);
        if (!current()) return;
        if (saved.revoked) return await missing();
        // An explicit handoff can begin while the old host is still reachable.
        // Wait for the protected job to commit before accepting any route.
        if (saved.recoveryMove && saved.recoveryMove.state !== 'complete') {
          const error = new Error('Room relocation pending');
          error.reason = saved.recoveryMove.terminal ? saved.recoveryMove.error === 'auth' ? 'auth'
            : saved.recoveryMove.error === 'deleted' ? 'deleted'
            : ['host-auth', 'host-conflict'].includes(saved.recoveryMove.error) ? 'host-conflict' : 'relocation-damaged' : 'relocating';
          throw error;
        }
        if (!saved.selected) return state(saved.identities?.length > 1 ? 'choose-identity' : 'needs-auth');
        const record = saved.selected;
        let candidate;
        if (saved.host && record.candidate?.where !== 'hosted') {
          try { candidate = await this.hooks.host(descriptor, abort.signal); }
          catch (e) {
            // A durable completed handoff revokes the old local host binding.
            // Discover through the same trusted service; never restore the old snapshot.
            if (!current()) return;
            if (e.reason !== 'relocated') throw e;
            candidate = await this.hooks.discover(descriptor, record, abort.signal);
          }
        } else candidate = await this.hooks.discover(descriptor, record, abort.signal);
        if (!current()) return;
        const result = await this.hooks.enter(candidate, record, current);
        if (!current()) return;
        if (result.ok) { state('connected'); return; }
        const error = new Error(result.error); error.reason = result.error; error.retryAfter = result.retryAfter; throw error;
      } catch (error) {
        if (!current()) return;
        let e = error;
        if (e.reason === 'deleted' || e.reason === 'no-project') {
          try { return await missing(); } catch (unavailable) { if (!current()) return; e = unavailable; }
        }
        const terminal = { auth: 'needs-auth', unauthorized: 'needs-auth', kicked: 'rejected', banned: 'rejected', removed: 'rejected', 'host-conflict': 'host-conflict', 'host-data-missing': 'damaged', 'recovery-storage': 'damaged', 'relocation-damaged': 'damaged' }[e.reason];
        if (terminal) return state(terminal);
        state(e.reason === 'recovery-storage-busy' ? 'waiting-storage' : 'waiting-host');
        const wait = Math.max(delay, Number(e.retryAfter || 0) * 1000);
        delay = Math.min(30000, delay * 2);
        this.timer = setTimeout(() => { this.timer = null; void attempt(); }, wait);
      }
    };
    void attempt();
  }
}
