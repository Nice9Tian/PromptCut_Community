/**
 * This page's side of the pending merge table: local copy + outbound queue, handed to the document service once
 * connected (`server/docservice/modules/pending-merge.mjs`).
 *
 * - **The document service is authoritative**: while connected, the table follows the `merge.state` returned by
 *   the document service (also visible when logging in as the same user on another device);
 * - **Nothing is lost offline**: changes not yet handed to the document service (newly merged-in offline batches,
 *   entries to remove after clicking "Merge" or "Delete selected") are first recorded in the outbound queue of
 *   the local stash (`offlineCache.ts`) and sent in order once connected; after sending, the table is fetched again;
 * - The local copy also keeps the latest table, so the "Merge conflicts" button on the top bar can still be
 *   shown when offline or when the page has just opened and is not yet connected.
 *
 * Pure logic; the connection and storage are injected by the caller (unit tests use fakes).
 */
import { mergeIntoTable, removeFromTable, type MergeThing } from "./mergeItems";
import { cacheKey, type KvStore } from "./offlineCache";

export type MergeOp = { put: MergeThing[] } | { remove: { key: string; props?: string[] }[] };

export interface MergeChannel {
  /** Send one request and wait for the reply; throws if it cannot connect */
  request(msg: { type: string; [k: string]: unknown }): Promise<{ type: string; [k: string]: unknown }>;
}

interface Saved { things: MergeThing[]; outbox: MergeOp[] }

export interface MergeTableOptions {
  projectId: string;
  /** The user in "project × user" (same convention as the document service takes by connection identity: `account:<id>`, `user:<name>`, `local`) */
  user: string;
  kv: KvStore;
  onChange?: (things: MergeThing[]) => void;
}

export class MergeTable {
  readonly projectId: string;
  readonly user: string;
  private kv: KvStore;
  private onChange?: (things: MergeThing[]) => void;
  private table: MergeThing[] = [];
  private outbox: MergeOp[] = [];
  private channel: MergeChannel | null = null;
  private flushing: Promise<void> | null = null;
  private again = false;
  private loaded: Promise<void>;
  /** Whether the most recent save to the local stash succeeded */
  durable = true;
  /** Why the document service did not accept it (old service, over limit, rejected); null if accepted */
  blocked: string | null = null;
  /** Version confirmed by the document service */
  serverVersion: number | null = null;

  constructor(o: MergeTableOptions) {
    this.projectId = o.projectId;
    this.user = o.user;
    this.kv = o.kv;
    this.onChange = o.onChange;
    this.loaded = this.load();
  }

  get key(): string {
    return cacheKey("merge", this.projectId, this.user);
  }

  get things(): MergeThing[] {
    return this.table;
  }

  /** There are still changes not handed to the document service */
  get pendingOps(): number {
    return this.outbox.length;
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  private async load() {
    try {
      const s = (await this.kv.get(this.key)) as Saved | undefined;
      if (s && Array.isArray(s.things)) {
        // Some were newly merged in before loading (rare: an offline batch was handed over right after creation); layer them on the local copy
        this.table = mergeIntoTable(s.things, this.table);
        this.outbox = [...(Array.isArray(s.outbox) ? s.outbox : []), ...this.outbox];
        this.changed();
      }
    } catch { /* Local stash cannot be read: the document service is authoritative */ }
  }

  private async save(): Promise<boolean> {
    try {
      if (!this.table.length && !this.outbox.length) await this.kv.delete(this.key);
      else await this.kv.put(this.key, { things: this.table, outbox: this.outbox } satisfies Saved);
      this.durable = true;
    } catch {
      this.durable = false;
    }
    return this.durable;
  }

  private changed() {
    this.onChange?.(this.table);
  }

  /** Merge a new batch (an offline batch, 0.7.20 undo conflicts) into the table; returns "whether the local stash saved it" */
  async add(incoming: MergeThing[]): Promise<boolean> {
    await this.loaded;
    if (!incoming.length) return true;
    const before = new Map(this.table.map((t) => [t.key, JSON.stringify(t)]));
    this.table = mergeIntoTable(this.table, incoming);
    const changed = this.table.filter((t) => before.get(t.key) !== JSON.stringify(t));
    this.outbox.push({ put: changed });
    this.changed();
    const ok = await this.save();
    void this.flush();
    return ok;
  }

  /** Remove these level-2 entries from the table (merged, delete selected) */
  async remove(list: { key: string; props: string[] }[]): Promise<void> {
    await this.loaded;
    if (!list.length) return;
    this.table = removeFromTable(this.table, list);
    // Also remove these entries from the not-yet-sent "records": otherwise a rejected (over limit) one waits first, the "remove" goes out first, and on resend it records them again
    this.outbox = this.outbox
      .map((op) => ("put" in op ? { put: removeFromTable(op.put, list) } : op))
      .filter((op) => !("put" in op) || op.put.length > 0);
    this.outbox.push({ remove: list.map((r) => ({ key: r.key, props: r.props })) });
    this.changed();
    await this.save();
    void this.flush();
  }

  /** Attach (or swap in) a connection; null = disconnected. On attach, send what is queued, then fetch the table again */
  attach(channel: MergeChannel | null): Promise<void> {
    this.channel = channel;
    return channel ? this.flush() : Promise.resolve();
  }

  /** Pushed by the document service (another device of the same user changed the table) */
  receive(msg: { projectId?: unknown; things?: unknown; version?: unknown }): void {
    if (msg.projectId !== this.projectId || !Array.isArray(msg.things)) return;
    if (this.outbox.length || this.flushing) return; // After sending our own, the document service is authoritative again (it fetches again after sending)
    this.adopt(msg.things as MergeThing[], msg.version);
  }

  private adopt(things: MergeThing[], version: unknown) {
    this.table = things;
    this.serverVersion = typeof version === "number" ? version : this.serverVersion;
    this.changed();
    void this.save();
  }

  /** Send what is queued in order, then fetch the table again; stop if sending fails and retry on the next connect */
  flush(): Promise<void> {
    // Another send is requested while one is in progress (newly merged in, just connected): run another round after this one, and waiters get the result of both rounds
    if (this.flushing) { this.again = true; return this.flushing; }
    const run = async () => {
      await this.loaded;
      while (this.channel) {
        const ch = this.channel;
        const op = this.outbox[0];
        try {
          if (!op) {
            const st = await ch.request({ type: "merge.list", projectId: this.projectId });
            if (st.type === "merge.state" && !this.outbox.length) this.adopt(st.things as MergeThing[], st.version);
            return;
          }
          const reply = "put" in op
            ? await ch.request({ type: "merge.put", projectId: this.projectId, things: op.put })
            : await ch.request({ type: "merge.remove", projectId: this.projectId, remove: op.remove });
          if (reply.type === "error") {
            const reason = String(reply.reason ?? "error");
            // Over the count or size limit (too-many / too-large): the document service rejects the whole entry and loses nothing. First send the
            // "remove" entries queued behind it (they can only shrink the table), then retry this one; stop if it is still rejected.
            // It is tried again after the user merges or deletes some in the window (`remove` triggers flush)
            if ("put" in op && (reason === "too-many" || reason === "too-large")) {
              const removes = this.outbox.filter((o): o is Extract<MergeOp, { remove: unknown }> => "remove" in o);
              if (removes.length) {
                for (const r of removes) {
                  const rr = await ch.request({ type: "merge.remove", projectId: this.projectId, remove: r.remove });
                  if (rr.type === "error") break;
                  this.outbox = this.outbox.filter((o) => o !== r);
                }
                await this.save();
                const again = await ch.request({ type: "merge.put", projectId: this.projectId, things: op.put });
                if (again.type !== "error") { this.blocked = null; this.outbox.shift(); await this.save(); continue; }
              }
            }
            // Old document service lacks this module (unsupported), over limit, rejected: keep locally, the table follows the local copy, and do not fetch
            // the document service's table (fetching would overwrite these entries). The UI explains the reason ("Only stored on this device for now")
            this.blocked = reason;
            this.changed();
            return;
          }
          this.blocked = null;
          this.outbox.shift();
          await this.save();
        } catch {
          return; // Cannot connect: keep for next time
        }
      }
    };
    const loop = async () => {
      do { this.again = false; await run(); } while (this.again && this.channel);
    };
    this.flushing = loop().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
