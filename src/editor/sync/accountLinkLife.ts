/**
 * 账号云端项目里,页面那条文档连接的寿命(`syncManager.ts` 的 `enterAccountProject` 用;在线页面与桌面版同一条路)。
 *
 * 账号连接上的每条消息都要过闸,闸拿建连时那张票据背后的访问令牌去问账号服务;访问令牌到期(120 秒,票据的 `expiresAt` 就是那个时刻)
 * 之后,连接还开着,但每条消息都回「凭证到期」,续令牌也救不回这条连接(`server/account-card-link.mjs` 文件头有实测)。
 * 所以页面要在到期之前换到一个凭新票据建的会话上。本模块只管「什么时候换、换不成怎么办」,怎么换在 `link.ts` 的 `renew()`:
 *
 * - **每张票据都要够用**:取会话时要求背后的访问令牌至少还剩 `MIN_TICKET_LIFE_MS`,不够客户端先续令牌(`client.session` 的 `minRemainingMs`)。
 * - **到期前换**:`tick()`(调用方每几秒调一次,看的是墙上时钟)发现离到期不到 `RENEW_MARGIN_MS` 就换。看墙上时钟而不是定一个长定时器,
 *   是为了电脑睡眠醒来之后第一下就能发现「早就过期了」。两次换之间至少隔 `MIN_RENEW_GAP_MS`。
 * - **换不成**:账号服务一时不通,下一次 `tick()` 再试;试到到期那一刻还没换成,这条连接就是坏的 —— 调 `link.expire()` 按断线处理
 *   (页面转离线、改动进离线队列、照普通断线重连),不让页面显示在线而实际写不进。取票据的请求挂住不回也一样:到期后 `busy` 超过
 *   `BUSY_EXPIRE_MS` 就 `expire()`,不等它。登录失效、被踢(会话接口回 401 / 403)交给 `onTerminal`,由调用方照现有的做法收场。
 * - **已经过期才发现**(睡眠醒来;或文档服务回了「凭证到期」,`authExpired()`):**不换,直接 `expire()`**。过期期间做的改动文档服务没收,
 *   它们得照离线的规矩重新进去 —— 重连后第一条带期望版本,别人在这期间改过就停下来问用户(语义 `product/document-service.md`「冲突」:
 *   暂时离线重入不能静默覆盖)。传输已经脱开(正在接续)时同理,`renew()` 自己不换。
 * - **权限变了**(`accessSeen`):只读改成可写时换一个会话,新连接才写得进去;正忙着就记下、忙完补一轮。
 *
 * **本机时钟不准**:到期时刻是文档服务的钟,这里拿本机的钟去比。取到票据那一刻就算一下它「还剩多久」:我们要的是至少 60 秒,
 * 算出来却不到(`RENEW_MARGIN_MS` + `SKEW_SLACK_MS`),只能是本机的钟快了 —— 这张票据的到期时刻不可信,改成「从现在起按 `MIN_TICKET_LIFE_MS` 算」,
 * 也不凭本机的钟判它过期(过期由文档服务的「凭证到期」说了算)。本机的钟快 90～120 秒时,效果是大约每 30 秒换一次会话(不是每 3 秒),
 * 客户端自己续访问令牌的那一处(`client.ts` 的 `ensureLogin`)仍按本机的钟,会比正常更勤地续令牌;钟慢的一侧,票据实际寿命比算的短,
 * 靠文档服务回「凭证到期」兜住。
 */

/** 离到期不到这么久就换会话 */
export const RENEW_MARGIN_MS = 30_000;
/** 取票据时,背后的访问令牌至少还要剩这么久(比 `RENEW_MARGIN_MS` 大,新会话才不会一建成又到了该换的时候) */
export const MIN_TICKET_LIFE_MS = 60_000;
/** 两次计划内换会话之间至少隔这么久(时钟不准、票据寿命异常短时不至于连着换) */
export const MIN_RENEW_GAP_MS = 20_000;
/** 取到的票据算出来的剩余寿命比 `RENEW_MARGIN_MS` 多不出这么多:本机的钟不可信 */
export const SKEW_SLACK_MS = 10_000;
/** 到期之后,换会话那一步(取票据、建新会话)还没回来超过这么久:不等了,按连接作废处理 */
export const BUSY_EXPIRE_MS = 5_000;

export interface AccountLinkLifeOptions {
  /** 取一份新的项目会话,要求背后的访问令牌至少还剩 `minRemainingMs`(`CloudAccountClient.session`) */
  session: (o: { minRemainingMs: number }) => Promise<{ connectionTicket: string; expiresAt: number }>;
  /** 页面那条连接(`SyncLink` 里用到的部分) */
  link: () => { readonly connected: boolean; renew(): Promise<boolean>; expire(reason?: string): void } | null;
  /** 登录失效、被踢、不在名单:不再试 */
  onTerminal: (error: unknown) => void;
  now?: () => number;
  renewMarginMs?: number;
  minTicketLifeMs?: number;
  minRenewGapMs?: number;
}

export type TickResult = "idle" | "busy" | "renewed" | "retry" | "expired" | "terminal";

const isTerminal = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
};

export function createAccountLinkLife(o: AccountLinkLifeOptions) {
  const now = o.now ?? Date.now;
  const margin = o.renewMarginMs ?? RENEW_MARGIN_MS;
  const minLife = o.minTicketLifeMs ?? MIN_TICKET_LIFE_MS;
  const minGap = o.minRenewGapMs ?? MIN_RENEW_GAP_MS;
  /** 最近一次取到的票据:到什么时候(本机的钟)、这个时刻可不可信;连接建成(或换成)时记成当前连接的 */
  let issued: { at: number; trusted: boolean } | null = null;
  let active: { at: number; trusted: boolean } | null = null;
  let busySince: number | null = null;
  let lastRenewAt = -Infinity;
  let renews = 0;
  let expires = 0;
  let knownAccess: string | null = null;
  /** 权限每变一次加一;`handledSeq` 是取票据时已经算进去的那一次。两者不等 = 还欠一轮换会话(变的时候正忙着) */
  let accessSeq = 0;
  let handledSeq = 0;

  function expire(link: { expire(reason?: string): void }): "expired" {
    expires += 1;
    active = null;
    link.expire();
    return "expired";
  }

  /** 换一次。回:换成了 / 没换成(可再试) / 终局 */
  async function swap(): Promise<"renewed" | "retry" | "terminal"> {
    const link = o.link();
    if (!link) return "retry";
    busySince = now();
    const seq = accessSeq;
    try {
      if (await link.renew()) { renews += 1; lastRenewAt = now(); handledSeq = seq; return "renewed"; }
      return "retry";
    } catch (error) {
      if (isTerminal(error)) { o.onTerminal(error); return "terminal"; }
      return "retry";
    } finally { busySince = null; }
  }

  return {
    /** `SyncLink` 的 `protocols`:每次建会话(含换会话)现取票据。`first` 给了就用它(进项目时已经取到的那份会话) */
    async ticket(first?: { connectionTicket: string; expiresAt: number } | null): Promise<string> {
      const s = first && first.expiresAt - now() >= minLife ? first : await o.session({ minRemainingMs: minLife });
      const life = s.expiresAt - now();
      // 要的是至少 minLife;算出来连「该换的提前量」都不够,是本机的钟快了:到期时刻不可信,按从现在起 minLife 算
      issued = life >= margin + SKEW_SLACK_MS ? { at: s.expiresAt, trusted: true } : { at: now() + minLife, trusted: false };
      return s.connectionTicket;
    },
    /** 会话建成了(新建或换成):当前连接能用到刚才那张票据到期 */
    opened(): void {
      active = issued;
    },
    /** 调用方每几秒调一次。按 2026-10-14 用户定：已经建好的连接不再按时间失效，也不轮询；失效一律由账号服务主动通知。 */
    async tick(): Promise<TickResult> {
      const link = o.link();
      if (busySince !== null) return "busy";
      // 没有会话(正在断线重连)时不管:重连那条路本来就凭新票据建会话
      if (!link || !link.connected || active === null) return "idle";
      // 只有权限变更（如只读改可写）需要换会话
      if (accessSeq !== handledSeq && now() - lastRenewAt >= minGap) {
        return swap();
      }
      return "idle";
    },
    /** 文档服务回了「凭证到期」:这条连接已经写不进去。不换(理由同上),按断线处理 */
    async authExpired(): Promise<TickResult> {
      const link = o.link();
      if (!link || !link.connected) return "idle";
      return expire(link);
    },
    /**
     * 调用方每次读到会话里的权限(`r` / `rw`)都报一下。连接的权限是建连时那张票据上的,文档服务改项目时照它判:
     * 权限被提高(只读改可写)时服务端不关旧连接,旧连接一直是只读 —— 所以发现权限变了就换一个会话。
     * (权限被降低时服务端自己会关掉旧连接,页面照断线重连。)正忙着就记下,下一次 `tick()` 补换。
     */
    async accessSeen(access: string): Promise<TickResult> {
      const before = knownAccess;
      knownAccess = access;
      if (before === null || before === access) return "idle";
      const link = o.link();
      if (!link || !link.connected) return "idle";
      accessSeq += 1;
      if (busySince !== null) return "busy";
      return swap();
    },
    /** 诊断 */
    describe: () => ({ expiresAt: active?.at ?? null, trusted: active?.trusted ?? null, renews, expires, busy: busySince !== null }),
  };
}

export type AccountLinkLife = ReturnType<typeof createAccountLinkLife>;
