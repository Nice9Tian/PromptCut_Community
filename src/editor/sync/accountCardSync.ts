/**
 * 账号云端项目里,卡片源码同步向页面要连接票据时怎么答(桌面版;`cardSync.ts` 的 `hooks.ticket`)。
 *
 * 编辑器进程自己没有登录:它每建一个新会话,经 HMR 向页面要一张票据(接续不带票据,由服务端按会话里的身份重新核对)。旧共享项目里页面在自己那条连接上签
 * (`auth.ticket`);账号连接上那条消息一律被拒,所以这里改成凭页面的登录向账号会话接口再取一份会话
 * (`/hosted/shared/account/session`,桌面外壳的账号桥本来就放行这条路径),用其中的连接票据。
 * 票据的角色仍是 page,权限就是这位成员此刻的权限(只读成员拿到的票据写不进内容库),没有新角色,也不自报身份。
 * 连同票据一起交出它的到期时刻:账号连接只能用到那时(访问令牌的寿命,见 `server/account-card-link.mjs`),编辑器进程据此提前换会话。
 *
 * 停:
 * - 本页面已经不在这个项目里(换了项目、退出登录换了账号、连接已判失效)→ 不取票据,解绑;
 * - 会话接口回 401(登录失效)、403(被踢、不在名单)、404(项目没了)→ 解绑。解绑之后编辑器进程回到本机空间,不再重试。
 * - 其它失败(断网、服务暂时不可用)只抛,编辑器进程退避后再要。
 *
 * 本模块不引 `cardSync.ts`(它在卡片的热更新链规矩里有讲究),解绑由调用方给。
 */
export interface AccountCardTicketOptions {
  /** 凭登录取一份新的项目会话(`CloudAccountClient.session`) */
  session: (projectId: string) => Promise<{ connectionTicket: string; expiresAt: number }>;
  /** 本页面此刻还在这个账号项目里、登录的还是进来时那个账号 */
  isCurrent: () => boolean;
  /** 解绑卡片源码同步(编辑器进程回本机空间) */
  stop: () => void;
}

/** 登录失效、没有权限、项目不存在:再试也不会成 */
export function isTerminalAccountFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}

export function accountCardTicket(o: AccountCardTicketOptions): (projectId: string) => Promise<{ ticket: string; expiresAt: number }> {
  const gone = (): never => {
    o.stop();
    throw new Error("本页面已经不在这个云端项目里");
  };
  return async (projectId) => {
    if (!o.isCurrent()) gone();
    let ticket: { ticket: string; expiresAt: number };
    try {
      const session = await o.session(projectId);
      ticket = { ticket: session.connectionTicket, expiresAt: session.expiresAt };
    } catch (error) {
      if (isTerminalAccountFailure(error)) o.stop();
      throw error;
    }
    // 取票据的这一会儿页面可能已经离开:票据不交出去
    if (!o.isCurrent()) gone();
    return ticket;
  };
}
