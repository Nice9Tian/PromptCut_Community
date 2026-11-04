/**
 * Which project the Agent server's project copy is bound to (in the editor process, `/api/agent/bind` and `/api/agent/unbind` of `server/agent/service/instance.mjs`).
 * It used to live in `syncManager.ts`; it was moved out so it can be tested on its own; the rules are unchanged, with one addition: "unbind when entering an account cloud project".
 *
 * - After the page attaches to the document service it tells the Agent server "which project I am editing and which document service I am connected to" (wired in c65-integ2;
 *   for the interface see section 7 of docs/archive/agent-reports/AGENT-c65-agent.md): once bound, tools with side: "agent" run on the server's project copy,
 *   and writes go straight into the document service as the Agent chat's identity (D1). A local project uses local (loopback + local trust); an old shared project uses ticket:
 *   each time the Agent server opens a chat connection, it asks this page over SSE for a connection ticket (`issueAgentTicket` in `syncManager.ts`). An identical binding is not resent.
 * - **Account cloud projects are not bound** (an account connection cannot sign a ticket with the agent role; the proper binding awaits a user decision), and the local Agent takes the old "page does it on its behalf" route.
 *   But at the moment of entering it must **unbind**: the server's binding is state in the editor process and does not follow the page -- after a full page reload the page does not remember what it bound,
 *   yet the server is still bound to the local project from before the reload. If not unbound, tools with side: "agent" in the account project would read and write that local project.
 *   So unbinding does not depend on whether the page remembers; it is sent every time an account project is entered.
 * - Bind and unbind are queued in the same queue, first sent first arrived: an unbind cannot be overwritten by an old binding still in flight.
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
        console.warn("[sync] Agent server failed to bind the project copy:", j?.error ?? "no response");
      }
    })
    .catch(() => {
      if (boundKey === key) boundKey = null;
    });
}

/** Remove the server's binding (leaving the document service, entering an account cloud project). Sent whether or not this page remembers binding */
export function releaseAgentSide(): void {
  boundKey = null;
  writes = writes.catch(() => undefined).then(() => post("/api/agent/unbind", "{}")).catch(() => undefined);
}

/** Wait until the queued bind / unbind requests have all been sent (for tests) */
export function agentSideSettled(): Promise<void> {
  return writes.then(() => undefined, () => undefined);
}
