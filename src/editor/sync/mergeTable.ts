/**
 * 页面这一侧的待合并表:本机副本 + 待发队列,连上文档服务就交给它(`server/docservice/modules/pending-merge.mjs`)。
 *
 * - **文档服务为准**:连着的时候,表以文档服务回的 `merge.state` 为准(换设备登录同一用户也看得到);
 * - **断网也不丢**:还没交到文档服务的改动(新并进来的离线批次、点了「合并」或「删除选中」之后要拿掉的项)
 *   先记进本机暂存(`offlineCache.ts`)的待发队列,连上后按顺序发;发完再取一次表;
 * - 本机副本另外留着最近一次的表,断网、刚打开页面还没连上时顶栏的「冲突合并」按钮照样能显示。
 *
 * 纯逻辑,连接与存储都由调用方注入(单测用假件)。
 */
import { mergeIntoTable, removeFromTable, type MergeThing } from "./mergeItems";
import { cacheKey, type KvStore } from "./offlineCache";

export type MergeOp = { put: MergeThing[] } | { remove: { key: string; props?: string[] }[] };

export interface MergeChannel {
  /** 发一条请求等回包;连不上就抛 */
  request(msg: { type: string; [k: string]: unknown }): Promise<{ type: string; [k: string]: unknown }>;
}

interface Saved { things: MergeThing[]; outbox: MergeOp[] }

export interface MergeTableOptions {
  projectId: string;
  /** 「项目 × 用户」里的用户(与文档服务按连接身份取的同一口径:`account:<号>`、`user:<名>`、`local`) */
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
  /** 最近一次存本机暂存成功了没有 */
  durable = true;
  /** 文档服务不收(旧服务、超限、被拒)的原因;收了是 null */
  blocked: string | null = null;
  /** 文档服务确认过的版本 */
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

  /** 还有没交到文档服务的改动 */
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
        // 载入之前已经有新并进来的(极少:刚建好就转了离线批次),叠在本机副本上
        this.table = mergeIntoTable(s.things, this.table);
        this.outbox = [...(Array.isArray(s.outbox) ? s.outbox : []), ...this.outbox];
        this.changed();
      }
    } catch { /* 本机暂存读不出来:以文档服务为准 */ }
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

  /** 新的一批(离线批次、0.7.20 的撤销冲突)并进表;回「本机暂存存下了没有」 */
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

  /** 从表里拿掉这些二级项(合并成了、删除选中) */
  async remove(list: { key: string; props: string[] }[]): Promise<void> {
    await this.loaded;
    if (!list.length) return;
    this.table = removeFromTable(this.table, list);
    // 还没交出去的「记下」里也拿掉这几项:不然被拒(超限)的那条先等着、「拿掉」先发出去后,重发时又把它们记回去
    this.outbox = this.outbox
      .map((op) => ("put" in op ? { put: removeFromTable(op.put, list) } : op))
      .filter((op) => !("put" in op) || op.put.length > 0);
    this.outbox.push({ remove: list.map((r) => ({ key: r.key, props: r.props })) });
    this.changed();
    await this.save();
    void this.flush();
  }

  /** 接上(或换上)连接;null = 断开。接上就把待发的发出去、再取一次表 */
  attach(channel: MergeChannel | null): Promise<void> {
    this.channel = channel;
    return channel ? this.flush() : Promise.resolve();
  }

  /** 文档服务推来的(同一用户别的设备改了表) */
  receive(msg: { projectId?: unknown; things?: unknown; version?: unknown }): void {
    if (msg.projectId !== this.projectId || !Array.isArray(msg.things)) return;
    if (this.outbox.length || this.flushing) return; // 发完自己的再以文档服务为准(发完会再取一次)
    this.adopt(msg.things as MergeThing[], msg.version);
  }

  private adopt(things: MergeThing[], version: unknown) {
    this.table = things;
    this.serverVersion = typeof version === "number" ? version : this.serverVersion;
    this.changed();
    void this.save();
  }

  /** 把待发的按顺序发出去,再取一次表;发不出去就停,下次连上再发 */
  flush(): Promise<void> {
    // 正在发的时候又要发(新并进来、刚连上):这一轮发完再跑一轮,等的人拿到的是跑完两轮的结果
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
            // 超过条数或大小(too-many / too-large):文档服务整条不收、什么都不丢。先把排在后面的「拿掉」发出去(只会让表变小),
            // 再重试这一条;还是不收就停。用户在窗口里合并或删掉一些之后会再试(`remove` 触发 flush)
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
            // 旧文档服务没有这个模块(unsupported)、超限、被拒:留在本机,表以本机为准,不去取文档服务的表(取了会盖掉这几条)。
            // 原因交给界面说(「暂时只存在这台设备上」)
            this.blocked = reason;
            this.changed();
            return;
          }
          this.blocked = null;
          this.outbox.shift();
          await this.save();
        } catch {
          return; // 连不上:留着下次
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
