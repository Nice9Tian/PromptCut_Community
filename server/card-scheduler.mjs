export const CARD_PRIORITY = Object.freeze({ required: 0, control: 1, scene: 2 });
const cancelled = () => Object.assign(new Error('Card task cancelled'), { code: 'CARD_CANCELLED', cancelled: true });

/** Work yields a candidate at safe frame/block boundaries. Only the scheduler
 * can publish it, after checking both cancellation and the captured revision.
 * Lower-priority work remains resumable between yields. Foreground rendering
 * owns a separate lane and never waits for this speculative queue.
 */
export class CardTaskScheduler {
  constructor({ concurrency = 1, onEvent = () => {} } = {}) {
    this.concurrency = Math.max(1, Math.min(16, Math.floor(concurrency) || 1));
    this.onEvent = onEvent; this.jobs = new Map(); this.revisions = new Map();
    this.sequence = 0; this.running = 0; this.closed = false; this.waiters = [];
  }
  setRevision(owner, revision) {
    if (this.revisions.get(owner) === revision) return;
    this.revisions.set(owner, revision);
    for (const job of this.jobs.values()) if (job.owner === owner && job.revision !== revision) this.cancel(job.key);
  }
  submit({ key, owner, revision, priority, run, publish = async () => {} }) {
    if (this.closed) return Promise.reject(cancelled());
    if (!Object.values(CARD_PRIORITY).includes(priority)) throw new Error('Invalid card priority');
    if (!this.revisions.has(owner)) this.setRevision(owner, revision);
    if (this.revisions.get(owner) !== revision) return Promise.reject(cancelled());
    const previous = this.jobs.get(key);
    if (previous) {
      if (previous.owner === owner && previous.revision === revision && !previous.controller.signal.aborted) return previous.promise;
      throw new Error('Card task key collision');
    }
    const controller = new AbortController();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { key, owner, revision, priority, run, publish, controller, promise, resolve, reject, iterator: null, busy: false, sequence: this.sequence++ };
    this.jobs.set(key, job); this.emit('queued', job); this.pump();
    return promise;
  }
  emit(event, job) { try { this.onEvent({ event, key: job.key, priority: job.priority, revision: job.revision }); } catch {} }
  valid(job) { return !job.controller.signal.aborted && this.revisions.get(job.owner) === job.revision; }
  cancel(key) {
    const job = this.jobs.get(key);
    if (!job) return false;
    job.controller.abort();
    // `return()` is the async-generator cancellation handshake.  Calling it
    // here (rather than waiting for the next scheduler turn) releases source
    // readers as soon as a revision is superseded.  `step` still owns the
    // promise settlement, which avoids publishing a late yielded value.
    if (job.busy) void job.iterator?.return?.().catch(() => {});
    if (!job.busy) this.finish(job, cancelled());
    return true;
  }
  finish(job, error) {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    if (error) { this.emit(error.cancelled ? 'cancelled' : 'failed', job); job.reject(error); }
    else { this.emit('complete', job); job.resolve(); }
    if (!this.jobs.size && !this.running) this.waiters.splice(0).forEach(resolve => resolve());
  }
  pump() {
    if (this.closed && !this.jobs.size) return;
    while (this.running < this.concurrency) {
      const job = [...this.jobs.values()].filter(value => !value.busy && this.runnable(value)).sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)[0];
      if (!job) break;
      job.busy = true; this.running++;
      void this.step(job);
    }
  }
  runnable(job) {
    // A stateful scene generator only promises a safe interruption boundary at
    // yield.  With a pool wider than one, letting a required control begin on
    // another worker before that boundary produces the same-owner state out of
    // order.  Gate both directions: a required job waits for an in-flight
    // lower stage to yield, and low stages wait behind queued/running required
    // work for their owner. Different owners remain fully concurrent.
    const same = [...this.jobs.values()].filter(other => other !== job && other.owner === job.owner && this.valid(other));
    if (job.priority === CARD_PRIORITY.required) return !same.some(other => other.busy && other.priority > CARD_PRIORITY.required);
    return !same.some(other => other.priority === CARD_PRIORITY.required);
  }
  async step(job) {
    let done = false, failure;
    try {
      if (!this.valid(job)) throw cancelled();
      if (!job.iterator) job.iterator = job.run(job.controller.signal)[Symbol.asyncIterator]();
      this.emit('step', job);
      const value = await job.iterator.next();
      if (!this.valid(job)) throw cancelled();
      if (!value.done) {
        // Publisher receives an explicit guard for asynchronous file staging.
        await job.publish(value.value, () => this.valid(job));
        if (!this.valid(job)) throw cancelled();
        this.emit('published', job);
      }
      done = value.done;
    } catch (error) { failure = error; }
    finally {
      this.running--; job.busy = false;
      if (failure || done) {
        if (failure) { try { await job.iterator?.return?.(); } catch {} }
        this.finish(job, failure);
      } else job.sequence = this.sequence++;
      this.pump();
      if (!this.jobs.size && !this.running) this.waiters.splice(0).forEach(resolve => resolve());
    }
  }
  idle() { return this.jobs.size || this.running ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  async close() { this.closed = true; for (const key of this.jobs.keys()) this.cancel(key); await this.idle(); }
}
