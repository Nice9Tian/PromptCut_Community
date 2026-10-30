/**
 * 页面到文档服务的一条**会话**,外加这条会话上的一个 DocSync(c65-design.md 第 4 节「页面一侧」;
 * 会话见 `docs/plan/http-transport-contract.md` 第 3、4、9 节)。
 *
 * - 会话:`server/render-node/session-link.mjs` 的 `createDocEndpoint`,本阶段(HT-a)只走 WebSocket。
 *   一个端点只跑一个会话(`renew: false`):传输断了(换网、代理掐断、休眠)在会话层里接续,未确认的提交与请求
 *   按序补发,这里和 DocSync 都看不见;会话结束(服务端关、保留期内没接续上)才算断线。
 * - 断线与重连:子协议每次建会话之前现取(共享项目的证明里 nonce 只能用一次);断线后按退避重建会话
 *   (0.5 s 起、翻倍、最长 5 s)。建成调 `ds.connect()`(重新 `project.open`、补发没确认的提交),断线调 `ds.disconnect()`。
 * - 分发:`project.*` 交给 DocSync;带 `reqId` 的回包交给等它的 `request()`;其余(`shared.*`、`events.*`、
 *   `error` 等)交给 `onMessage`。
 * - 关闭码 4003(`kicked` / `removed`)、4004(`deleted`)是创建者操作的结果(契约 `auth-contract.md` 第 7 节),
 *   不再重连,由 `onClosed` 告诉界面弹阻断弹窗。传输脱开期间会话因这两个码结束的,会话层把接续得到的 4410
 *   还原成原关闭码报上来(`session-link.mjs` 的 `FINAL_CLOSE`,与本文件的 `FATAL_CLOSE` 一致),界面照样弹。
 *
 * - 计划内换会话(`renew()`,账号云端项目用):账号连接只能用到票据背后的访问令牌到期,到期前先凭新票据把新会话建好,
 *   建成的那一刻切过去(`ds.handover()`:不记离线,未确认的提交在新会话上补发)。旧会话上没有在等回包的请求就当场关掉
 *   (文档服务按连接记选区、在场这些状态,两条连接并存久了会被当成两个页面),有就留到回包收完、最多 `RENEW_RETIRE_MS`。
 *   只在旧会话还好用时这么换;旧会话已经作废或传输已经脱开时不换,调用方 `expire()`:按断线处理、走上面的重连
 *   (那条路带离线批次的版本核对)。文档服务回「凭证到期」的 `error` 时经 `onAuthExpired` 告诉调用方。
 *
 * 不认识 store,也不认识界面:浏览器与 Node(测试)通用,WebSocket 可以注入。
 */
import { DocSync, type LocalBackup, type ServerMsg } from "../../store/docsync";
import type { Project } from "../../kernel/project";
// @ts-expect-error 无类型声明的 .mjs(浏览器与 Node 通用,只用 WebSocket 与计时器)
import { createDocEndpoint as createDocEndpointUntyped } from "../../../server/render-node/session-link.mjs";

/** 文档服务发来的任意一条消息 */
export type AnyMsg = { type: string; reqId?: string | number; [k: string]: unknown };

export interface CloseInfo {
  code: number;
  reason: string;
  /** 4003 / 4004:不再重连 */
  fatal: boolean;
  /** 这条连接一次都没连上过(共享项目的握手被拒在浏览器里只看得到这个) */
  neverOpened: boolean;
}

type WsLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (ev: unknown) => void): void;
};
type WsCtor = new (url: string, protocols?: string | string[]) => WsLike;

/** 端点的诊断(`createDocEndpoint` 的 `stats()` 里页面用到的部分) */
export interface LinkStats {
  transport: "ws" | "http" | null;
  resumes: number;
  pendingBytes: number;
  legacy: boolean;
  detached: boolean;
  [k: string]: unknown;
}

/** `createDocEndpoint` 返回值里页面用到的部分 */
interface DocEndpoint {
  send(message: object): boolean;
  onMessage(handler: (message: AnyMsg) => void): void;
  onOpen(handler: () => void): void;
  onResume(handler: () => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onConnectFail(handler: (info: { code: number; reason: string }) => void): void;
  close(): void;
  dropTransport(): boolean;
  readonly connected: boolean;
  readonly closed: boolean;
  stats(): LinkStats;
}
const createDocEndpoint = createDocEndpointUntyped as (options: {
  url: string;
  protocols: () => string[];
  resumeProtocols?: () => Promise<string[]> | string[];
  WebSocket?: WsCtor;
  transport: "ws";
  renew: false;
  backoff: { baseMs: number; factor: number; maxMs: number; jitter: number };
  maxPendingBytes: number;
}) => DocEndpoint;

/**
 * 页面未确认出站的上限。契约第 3.4 节给的是 1 MiB;页面的根替换分片上传(`project.upload`,最多 64 片 ×
 * 128 Ki 字符)一口气就发出好几 MiB,第一条确认回来之前就会超过 1 MiB,会话被自己以 1013 结束、重建后重发、
 * 又超 —— 所以页面放宽到 32 MiB(报告 `docs/archive/agent-reports/AGENT-ht-client.md` 写明,待契约定)。
 */
export const PAGE_MAX_PENDING_BYTES = 32 * 1024 * 1024;

export interface LinkOptions {
  docSync?: DocSync;
  initialize?: boolean;
  url: string;
  protocols: () => Promise<string[]> | string[];
  resumeProtocols?: () => Promise<string[]> | string[];
  projectId: string;
  session: string;
  initial: Project;
  saveBackup?: (b: LocalBackup) => void;
  onMessage?: (msg: AnyMsg) => void;
  /** Validate delegated tickets before a caller can use them through a relay. */
  onResponse?: (msg: AnyMsg) => Promise<void>;
  onOpen?: () => void;
  /** 传输断过、在保留期内接续上了(会话没断,不用重新订阅) */
  onResume?: () => void;
  onClosed?: (info: CloseInfo) => void;
  /** 重新取认证证明时接口明确拒绝；返回 true 终止此连接，不再盲目重试。 */
  onProtocolError?: (error: unknown) => boolean;
  /**
   * 文档服务对这条连接上的消息回了「凭证到期」(`error`,原因 `credential-revoked` / `authorization-expired`):
   * 这条连接背后的访问令牌到期了,之后发什么都被拒。调用方据此换会话(`renew()`),换不成就 `expire()`。
   */
  onAuthExpired?: (reason: string) => void;
  /**
   * 这个关闭码是不是「不再重连」。缺省:4003(被踢、被移出)、4004(项目被删)。
   * 账号云端项目给 `() => false`:那里 4003 也用在「权限变了,请重新进来」(可写改只读时服务端关掉旧连接),
   * 该不该再连由取票据的接口说了算(被踢 403、登录失效 401、项目没了 404 → `onProtocolError` 终止),不凭关闭码。
   */
  isFatalClose?: (code: number, reason: string) => boolean;
  WebSocketImpl?: WsCtor;
  reconnect?: { minMs: number; maxMs: number };
}

export const FATAL_CLOSE = new Set([4003, 4004]);
/** 闸回这两个原因:连接背后的访问令牌到期(或登录被收回),这条连接再也写不进去 */
export const AUTH_EXPIRED_REASONS = new Set(["credential-revoked", "authorization-expired"]);
/** 换会话:新会话多久建不成算这次没换成 */
export const RENEW_OPEN_TIMEOUT_MS = 15_000;
/** 换会话:新会话建好之后,最多等多久让旧会话上没确认的提交先落定(落定了再切最干净;等不到也切,没确认的在新会话上补发) */
export const RENEW_SETTLE_MS = 8_000;
/** 换会话:旧会话上还有在等回包的请求时,最多再留多久 */
export const RENEW_RETIRE_MS = 5_000;
/** `expire()` 报给 `onClosed` 的关闭码(本端判定连接作废;不是文档服务发的) */
export const CLOSE_EXPIRED = 4401;

let reqSeq = 0;

export class SyncLink {
  readonly ds: DocSync;
  private readonly o: LinkOptions;
  private ep: DocEndpoint | null = null;
  private dialing = false;
  private open = false;
  private everOpened = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private waiting = new Map<string, { resolve: (m: AnyMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** 换下来的旧会话:只为收完换之前已发请求的回包(`left`),收完就关,最多留 `RENEW_RETIRE_MS` */
  private retiring: { ep: DocEndpoint; timer: ReturnType<typeof setTimeout>; left: Set<string> } | null = null;
  /**
   * 这条连接上报到过的发布方(`publisher.hello`,预渲染任务的发布方登记是跟着连接走的):换会话后在新会话上原样再报一次,
   * 免得旧会话一关、文档服务按「发布方掉线」过了宽限期把它的订阅撤掉(发布方自己要到下一次发布被拒才会重新报到)。
   */
  private publisherHello: AnyMsg | null = null;
  private renewing: Promise<boolean> | null = null;

  constructor(o: LinkOptions) {
    this.o = o;
    this.delay = o.reconnect?.minMs ?? 500;
    this.ds = o.docSync ?? new DocSync(o.initial, {
      projectId: o.projectId,
      session: o.session,
      send: (msg) => this.send(msg as unknown as AnyMsg),
      saveBackup: o.saveBackup,
      initialize: o.initialize,
    });
  }

  /** 会话在(传输脱开、正在接续时也算:这时发的消息接续后补发) */
  get connected(): boolean {
    return this.open;
  }

  get hasOpened(): boolean {
    return this.everOpened;
  }

  /** 诊断:实际用的传输(脱开时为 null)、接续次数、未确认的字节数、是否对着没有会话层的旧服务端 */
  stats(): LinkStats | null {
    return this.ep?.stats() ?? null;
  }

  start() {
    if (this.stopped || this.ep || this.dialing) return;
    void this.dial();
  }

  /** 结束会话、不再重连;等待中的请求全部失败 */
  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ep = this.ep;
    this.ep = null;
    if (this.open) {
      this.open = false;
      this.ds.disconnect();
    }
    try {
      ep?.close();
    } catch {
      /* 已经关了 */
    }
    this.dropRetiring();
    this.failWaiting("连接已关闭");
  }

  private dropRetiring() {
    const r = this.retiring;
    if (!r) return;
    this.retiring = null;
    clearTimeout(r.timer);
    try { r.ep.close(); } catch { /* 已经关了 */ }
  }

  /**
   * 计划内换会话:现取子协议(新票据)建一个新会话,建成的那一刻切过去。回 true = 换成了。
   * - 新会话建成之前旧会话照常用;建不成(握手被拒、网络不通、`RENEW_OPEN_TIMEOUT_MS` 内没建成)回 false,旧会话不动;
   * - 取子协议抛错原样抛给调用方(由它分辨是登录失效还是一时不通);
   * - 切换:`ds.handover()`(不记离线;未确认的提交在新会话上补发、文档服务按 opId 去重),然后照建成会话调 `onOpen`(调用方重新订阅);
   *   切换之前发出、还在等回包的请求由旧会话收完(没有就当场关旧会话)。
   * 没有会话(正在断线重连)、或传输已经脱开(正在接续)时不做,回 false:前者那条路本来就会凭新票据建会话;
   * 后者脱开期间的改动要按离线的规矩核对版本,由调用方等接续上再换,或到期后 `expire()`。
   */
  renew(): Promise<boolean> {
    if (this.renewing) return this.renewing;
    if (this.stopped || !this.ep || !this.open || this.ep.stats().detached) return Promise.resolve(false);
    const task = this.renewOnce().finally(() => { if (this.renewing === task) this.renewing = null; });
    this.renewing = task;
    return task;
  }

  private async renewOnce(): Promise<boolean> {
    const old = this.ep;
    const protocols = await this.o.protocols();
    if (this.stopped || this.ep !== old || !old || !this.open) return false;
    let next: DocEndpoint;
    try { next = this.createEndpoint(protocols, () => next); } catch { return false; }
    // 新会话从建起就盯着它的死活:建成之后、切过去之前(等旧会话上的提交落定的那几秒)被服务端关掉的,不能切过去
    let nextDead = false;
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), RENEW_OPEN_TIMEOUT_MS);
      const done = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
      next.onOpen(() => done(true));
      next.onClose(() => { nextDead = true; done(false); });
      next.onConnectFail(() => { nextDead = true; done(false); });
    });
    const usable = () => !this.stopped && this.ep === old && this.open && !old.stats().detached && !nextDead && !next.closed;
    // 等旧会话上没确认的提交落定再切(这一刻两边都没有在途的提交,切换不需要补发);等不到照样切
    if (opened && usable()) await this.ds.whenSettled({ timeoutMs: RENEW_SETTLE_MS }).catch(() => undefined);
    if (!opened || !usable()) {
      try { next.close(); } catch { /* 已经关了 */ }
      return false;
    }
    // 切过去。旧会话:还有在等回包的请求就留着收完,没有就当场关
    this.dropRetiring();
    const left = new Set(this.waiting.keys());
    if (left.size) this.retiring = { ep: old, left, timer: setTimeout(() => { if (this.retiring?.ep === old) this.dropRetiring(); }, RENEW_RETIRE_MS) };
    this.ep = next;
    this.attach(next);
    if (!left.size) { try { old.close(); } catch { /* 已经关了 */ } }
    if (this.publisherHello) { try { next.send(this.publisherHello); } catch { /* 发不出去:发布方下次发布被拒时自己会重新报到 */ } }
    this.ds.handover();
    this.o.onOpen?.();
    return true;
  }

  /**
   * 这条连接已经作废(访问令牌到期了还没换成新会话):按断线处理 —— DocSync 转离线(改动照常进队列),
   * 然后照普通断线退避着凭新票据重建会话。`onClosed` 收到 `CLOSE_EXPIRED`。
   */
  expire(reason = "credential-expired") {
    const ep = this.ep;
    if (!ep || this.stopped) return;
    // 先按断线收场(之后这个端点的事件都不认),再关它
    this.gone(ep, CLOSE_EXPIRED, reason);
    try { ep.close(); } catch { /* 已经关了 */ }
  }

  /** 发一条;会话不在就丢(DocSync 自己会在重连后补发它的提交) */
  send(msg: AnyMsg): boolean {
    if (!this.ep || !this.open) return false;
    if (msg.type === "publisher.hello" && typeof msg.publisherId === "string") this.publisherHello = { type: "publisher.hello", publisherId: msg.publisherId };
    try {
      return this.ep.send(msg) !== false;
    } catch {
      return false;
    }
  }

  /** 发一条带 reqId 的请求,等同一 reqId 的回包(`error` 也算回包) */
  request(msg: AnyMsg, timeoutMs = 10_000): Promise<AnyMsg> {
    const reqId = `r${++reqSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.open) return reject(new Error("没连上文档服务"));
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error("文档服务没有回应"));
      }, timeoutMs);
      this.waiting.set(reqId, { resolve, reject, timer });
      if (!this.send({ ...msg, reqId })) {
        clearTimeout(timer);
        this.waiting.delete(reqId);
        reject(new Error("没连上文档服务"));
      }
    });
  }

  /**
   * 测试与演示用:结束当前会话,`ms` 之内不重建(模拟长时间断网:会话没了、DocSync 离线;离线对话框的验收用它)。
   * 只断传输、会话接续的情形用 `cutTransport()`。
   */
  private holdUntil = 0;
  dropFor(ms: number) {
    this.holdUntil = Date.now() + ms;
    const ep = this.ep;
    if (!ep) return;
    try {
      ep.close();
    } catch {
      /* 已经关了 */
    }
    // 会话还没建成时 close() 不报 onClose:这里补上断线处理
    if (this.ep === ep) this.gone(ep, 1000, "drop");
  }

  /** 测试与演示用:只断当前传输(模拟换网、代理掐断),会话在保留期内接续,页面不该丢改动也不该重放。回有没有断 */
  cutTransport(): boolean {
    return this.ep?.dropTransport() ?? false;
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const wait = Math.max(this.delay, this.holdUntil - Date.now());
    this.delay = Math.min(this.o.reconnect?.maxMs ?? 5000, this.delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.dial();
    }, wait);
  }

  private failWaiting(message: string) {
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
    this.waiting.clear();
  }

  /** 会话结束,或这一次没建成 */
  private gone(ep: DocEndpoint, code: number, reason: string) {
    if (this.ep !== ep) return;
    this.ep = null;
    if (this.open) {
      this.open = false;
      this.ds.disconnect();
    }
    this.failWaiting("连接断了");
    const fatal = this.o.isFatalClose ? this.o.isFatalClose(code, reason) : FATAL_CLOSE.has(code);
    this.o.onClosed?.({ code, reason, fatal, neverOpened: !this.everOpened });
    if (!fatal) this.scheduleRetry();
    else this.stopped = true;
  }

  private async dial() {
    if (this.stopped || this.ep || this.dialing) return;
    this.dialing = true;
    let protocols: string[];
    try {
      protocols = await this.o.protocols();
    } catch (error) {
      this.dialing = false;
      if (this.stopped) return;
      if (this.o.onProtocolError?.(error)) { this.stop(); return; }
      this.o.onClosed?.({ code: 0, reason: "protocols", fatal: false, neverOpened: !this.everOpened });
      this.scheduleRetry();
      return;
    }
    this.dialing = false;
    if (this.stopped) return;
    let ep: DocEndpoint;
    try {
      ep = this.createEndpoint(protocols, () => ep);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ep = ep;
    ep.onOpen(() => {
      if (this.ep !== ep || this.stopped) return;
      this.open = true;
      this.everOpened = true;
      this.delay = this.o.reconnect?.minMs ?? 500;
      this.ds.connect();
      this.o.onOpen?.();
    });
    this.attach(ep);
  }

  private createEndpoint(protocols: string[], self: () => DocEndpoint): DocEndpoint {
    return createDocEndpoint({
      url: this.o.url,
      protocols: () => protocols,
      resumeProtocols: this.o.resumeProtocols ? async () => {
        try { return await this.o.resumeProtocols!(); }
        catch (error) {
          if (!this.stopped && this.ep === self() && this.o.onProtocolError?.(error)) this.stop();
          throw error;
        }
      } : undefined,
      ...(this.o.WebSocketImpl ? { WebSocket: this.o.WebSocketImpl } : {}),
      transport: "ws",
      renew: false,
      // 同一会话接续的退避;建新会话的退避在本类的 scheduleRetry
      backoff: { baseMs: this.o.reconnect?.minMs ?? 500, factor: 2, maxMs: this.o.reconnect?.maxMs ?? 5000, jitter: 0.2 },
      maxPendingBytes: PAGE_MAX_PENDING_BYTES,
    });
  }

  /** 当前会话的事件(建成之外的):接续、消息、结束 */
  private attach(ep: DocEndpoint) {
    ep.onResume(() => {
      if (this.ep !== ep) return;
      this.o.onResume?.();
    });
    ep.onMessage((msg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (this.ep !== ep) {
        // 换下来的旧会话:只认换之前已发请求的回包;收完就关
        const r = this.retiring;
        if (r?.ep === ep && msg.reqId !== undefined && !msg.type.startsWith("project.") && r.left.has(String(msg.reqId))) {
          r.left.delete(String(msg.reqId));
          if (this.waiting.has(String(msg.reqId))) this.dispatch(msg);
          if (!r.left.size) this.dropRetiring();
        }
        return;
      }
      if ((msg.type === "error" || msg.type === "project.op.rejected") && typeof msg.reason === "string" && AUTH_EXPIRED_REASONS.has(msg.reason)) {
        if (msg.type === "error") this.dispatch(msg);
        if (this.ep === ep && !this.stopped) this.o.onAuthExpired?.(msg.reason);
        return;
      }
      this.dispatch(msg);
    });
    ep.onClose((info) => this.gone(ep, info.code, info.reason));
    // 建不成(握手被拒、网络不通、取不到子协议):浏览器里分不出前两种,按「一次都没连上过」报给调用方
    ep.onConnectFail((info) => this.gone(ep, info.code === 0 ? 1006 : info.code, info.reason));
  }

  private dispatch(msg: AnyMsg) {
    if (msg.reqId !== undefined) {
      const w = this.waiting.get(String(msg.reqId));
      if (w) {
        this.waiting.delete(String(msg.reqId));
        clearTimeout(w.timer);
        if (this.o.onResponse) void this.o.onResponse(msg).then(() => w.resolve(msg), w.reject);
        else w.resolve(msg);
        // project.* 的回包也要交给 DocSync(它不带 reqId 发,正常不会走到这里)
        if (!msg.type.startsWith("project.")) return;
      }
    }
    if (msg.type.startsWith("project.")) {
      this.ds.receive(msg as unknown as ServerMsg);
      return;
    }
    this.o.onMessage?.(msg);
  }
}
