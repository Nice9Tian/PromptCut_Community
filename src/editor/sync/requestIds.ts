/** 没收到回包(网络断了、超时、对端没应答):页面的账号请求这时抛的错 `status` 为 0(`client.ts` 的 `AccountFailure(0, 'network')`) */
const noReply = (error: unknown) => (error as { status?: unknown } | null)?.status === 0;

/**
 * 「同一次操作没收到回包时再点,沿用原来的请求号」的小账本(服务端按请求号认出是同一次,不会多记一笔、不会多耗一次申请次数)。
 *
 * 按操作键(例如 `approve-join:<申请号>`、`send:<项目号>`)取请求号:
 *   - 没收到回包(网络错,`status` 为 0)就留着,再点就是重试,请求号不变。
 *   - 其余一律丢掉,下次点算新的一次:成功;服务端明确回了错(已处理过、次数用完……);别的错(请求没发出去,或回包对不上协议)。
 *
 * 共用这一份的地方:成员浮层与成员面板的「通过」「拒绝」(桌面 `AccountMembersPanel.tsx`、手机 `src/mobile/sheets.tsx`)、
 * 开始页的「发送申请」(`useAccountProjects.ts`)、重开文件那条提示的「发送申请」(`src/editor/sync/recoveryAssociation.ts`)。
 * 测试直接测这一份(`joinRequest.test.mjs` 的 JRC-3、`reopenJoinRequest.test.mjs` 的 RJR-2),不在测试里另写一套。
 */
export function createRequestIds(newId: () => string = () => crypto.randomUUID()) {
  const ids = new Map<string, string>();
  return {
    /** 这个操作手里留着的请求号(没收到回包、等着重试的那一个);没有就是 undefined */
    pending(key: string): string | undefined { return ids.get(key); },
    /** 用这个操作该用的请求号去做:没有就新起一个;按上面的规则决定丢掉还是留着 */
    async run<T>(key: string, operation: (requestId: string) => Promise<T>): Promise<T> {
      let requestId = ids.get(key);
      if (!requestId) { requestId = newId(); ids.set(key, requestId); }
      try {
        const value = await operation(requestId);
        if (ids.get(key) === requestId) ids.delete(key);
        return value;
      } catch (error) {
        if (!noReply(error) && ids.get(key) === requestId) ids.delete(key);
        throw error;
      }
    },
    /** 丢掉一个(不给键就是全部),例如换了项目链接、退出登录 */
    forget(key?: string) { if (key === undefined) ids.clear(); else ids.delete(key); },
  };
}
export type RequestIds = ReturnType<typeof createRequestIds>;
