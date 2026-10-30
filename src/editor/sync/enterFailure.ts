/**
 * 进入共享项目时 WebSocket 没建成,判是哪一种失败(`claude/join-error`)。
 *
 * 浏览器里握手被服务端 401 拒,与证书不对、代理挡了升级、网络不通看起来一样:都是「打开前就断、关闭码 1006」。
 * 以前一律判成 auth,页面于是说「用户名或密码不对」,把连不上的人引去改密码。现在进不去时拿一份新证明
 * 问一次 `shared/verify`〔裁〕(与握手同一个鉴权):
 * - 服务端明确说不认(401)→ auth(被踢过的仍报 kicked);
 * - 服务端认这份证明 → 账号密码没问题,是连接没建成 → unreachable;
 * - 取新证明或问的时候限速 → rate-limited;项目没了 → no-project;问不到(网络错误、5xx)→ unreachable;
 * - 服务端没有这个端点(404,还没升级的旧服务)→ 照旧判 auth / kicked,不比以前差。
 * 超时(15 s 没连上也没断)照旧是 unreachable;打开前就收到 4004 是项目没了。
 *
 * 纯逻辑,不认识 store 与界面,单测见 `enterFailure.test.mjs`。
 */
import type { CloseInfo } from "./link";

export type EnterFailure =
  | { error: "auth" | "kicked" | "unreachable" | "no-project" }
  | { error: "rate-limited"; retryAfter: number | null };

export interface EnterFailureDeps {
  /** 再取一份新证明(子协议列表);失败抛共享端点的错误(带 status) */
  fresh: () => Promise<string[]>;
  /** 问服务端认不认这份证明:认回 true,401 回 false,别的抛(带 status;网络错误不带) */
  verify: (protocols: string[]) => Promise<boolean>;
  /** 这个用户名在这个项目上被踢过(本机记的) */
  wasKicked: () => boolean;
}

function statusOf(e: unknown): { status: number | null; retryAfter: number | null } {
  const err = e as { status?: unknown; retryAfter?: unknown };
  return {
    status: typeof err?.status === "number" ? err.status : null,
    retryAfter: typeof err?.retryAfter === "number" && err.retryAfter > 0 ? err.retryAfter : null,
  };
}

/** 可信挑战/发现接口已明确拒绝，不能把它当普通网络断线无限重连。 */
export function classifyProtocolError(e: unknown): "auth" | "kicked" | "no-project" | null {
  const { status } = statusOf(e);
  const reason = (e as { reason?: unknown })?.reason;
  if (status === 404 || status === 410 || reason === "deleted" || reason === "no-project") return "no-project";
  if (status === 403 || reason === "banned" || reason === "kicked" || reason === "removed") return "kicked";
  if (status === 401 || reason === "auth" || reason === "unauthorized") return "auth";
  return null;
}

export async function classifyEnterFailure(outcome: CloseInfo, deps: EnterFailureDeps): Promise<EnterFailure> {
  const denied = (): EnterFailure => ({ error: deps.wasKicked() ? "kicked" : "auth" });
  if (outcome.reason === "timeout") return { error: "unreachable" };
  if (outcome.code === 4004) return { error: "no-project" };
  let protocols: string[];
  try {
    protocols = await deps.fresh();
  } catch (e) {
    const { status, retryAfter } = statusOf(e);
    if (status === 429) return { error: "rate-limited", retryAfter };
    const terminal = classifyProtocolError(e);
    if (terminal) return { error: terminal };
    return { error: "unreachable" };
  }
  try {
    return (await deps.verify(protocols)) ? { error: "unreachable" } : denied();
  } catch (e) {
    const { status, retryAfter } = statusOf(e);
    if (status === 429) return { error: "rate-limited", retryAfter };
    if (status === 404 || status === 405) return denied();
    return { error: "unreachable" };
  }
}
