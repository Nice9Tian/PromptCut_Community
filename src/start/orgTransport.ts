/**
 * 把账号客户端(`src/account/client.ts` 的 `getStartOrg` / `putStartOrg`)接成同步引擎要的 `OrgTransport`(`orgSync.ts`)。
 * 只做一件事:**服务端没有这条路由(老服务端)就翻成 `OrgUnsupportedError`**,让界面安静地退回只记在本机;
 * 其它错误(连不上、令牌过期、5xx)原样抛,引擎当「待同步」重试。冲突(409)客户端已经当结果回来,这里原样交给引擎。
 * 单测 `orgTransport.test.mjs`。
 */
import { OrgUnsupportedError, type OrgTransport, type PutResult, type RemoteOrg } from "./orgSync.ts";
import type { OrgState } from "./vibeOrg.ts";

/** 账号客户端里用到的两个方法(结构类型,单测里用假的) */
export interface StartOrgApi {
  getStartOrg(): Promise<{ version: number; org: unknown | null }>;
  putStartOrg(baseVersion: number, org: unknown): Promise<PutResult>;
}

/** 这个失败是不是「服务端没有这条路由」:路由不存在(404 / 405 / 501、no-route)、这台部署没配存储(org-unavailable) */
export function isUnsupported(e: unknown): boolean {
  const x = e as { status?: unknown; code?: unknown } | null;
  if (!x || typeof x !== "object") return false;
  return x.status === 404 || x.status === 405 || x.status === 501 || x.code === "no-route" || x.code === "org-unavailable";
}

/** `api` 是取客户端的函数:登录前客户端还没有,返回 null 时抛一个普通错误(引擎当待同步) */
export function accountOrgTransport(api: () => StartOrgApi | null): OrgTransport {
  const need = (): StartOrgApi => {
    const a = api();
    if (!a) throw new Error("账号服务还没就绪");
    return a;
  };
  const wrap = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      throw isUnsupported(e) ? new OrgUnsupportedError() : e;
    }
  };
  return {
    get: (): Promise<RemoteOrg> => wrap(() => need().getStartOrg()),
    put: (baseVersion: number, org: OrgState): Promise<PutResult> => wrap(() => need().putStartOrg(baseVersion, org)),
  };
}
