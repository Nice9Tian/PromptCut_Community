/**
 * Agent 服务端的项目副本绑在哪个项目上(编辑器进程里,`server/agent/service/instance.mjs` 的 `/api/agent/bind`、`/api/agent/unbind`)。
 * 原来写在 `syncManager.ts` 里,搬出来是为了能单独测;规则没变,只多了「进账号云端项目时解绑」这一条。
 *
 * - 页面挂上文档服务之后告诉 Agent 服务端「我在编辑哪个项目、连的是哪个文档服务」(c65-integ2 接线;
 *   接口见 docs/archive/agent-reports/AGENT-c65-agent.md 第 7 节):绑上之后 side: "agent" 的工具在服务端的项目副本上执行,
 *   写入以 Agent 对话的身份直接进文档服务(D1)。本机项目用 local(回环 + 本机信任);旧共享项目用 ticket:
 *   Agent 服务端每开一条对话连接,经 SSE 向本页面要一张连接票据(`syncManager.ts` 的 `issueAgentTicket`)。同样的绑定不重发。
 * - **账号云端项目不绑**(账号连接上签不出 agent 角色的票据;正式的绑定等用户定),本机 Agent 走「页面代做」的老路。
 *   但进去的那一刻必须**解绑**:服务端的绑定是编辑器进程里的状态,不跟页面走 —— 页面整页重载之后自己不记得绑过什么,
 *   服务端却还绑着重载前那个本机项目。不解的话,账号项目里 side: "agent" 的工具会去读写那个本机项目。
 *   所以解绑不看页面记不记得,每次进账号项目都发。
 * - 绑与解排在同一条队里,先发的先到:解绑不会被一条还在路上的旧绑定盖回去。
 */
let boundKey: string | null = null;
let writes: Promise<unknown> = Promise.resolve();

const post = (path: string, body: string) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });

export function bindAgentSide(kind: "local" | "shared", docProjectId: string, url: string): void {
  const body = kind === "local" ? { projectId: docProjectId, mode: "local" } : { projectId: docProjectId, mode: "ticket", url };
  const key = JSON.stringify(body);
  if (key === boundKey) return;
  boundKey = key;
  writes = writes.catch(() => undefined).then(() => post("/api/agent/bind", key))
    .then((r) => r.json().catch(() => null))
    .then((j) => {
      if (!j?.ok) {
        if (boundKey === key) boundKey = null;
        console.warn("[sync] Agent 服务端没绑上项目副本:", j?.error ?? "无回包");
      }
    })
    .catch(() => {
      if (boundKey === key) boundKey = null;
    });
}

/** 解掉服务端的绑定(离开文档服务、进账号云端项目)。不管本页面记不记得绑过,都发 */
export function releaseAgentSide(): void {
  boundKey = null;
  writes = writes.catch(() => undefined).then(() => post("/api/agent/unbind", "{}")).catch(() => undefined);
}

/** 排着的绑定 / 解绑都发完(测试用) */
export function agentSideSettled(): Promise<void> {
  return writes.then(() => undefined, () => undefined);
}
