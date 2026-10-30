/**
 * 工具实现里打编辑器接口(`/api/...`)用的地址。
 *
 * 页面里是同源相对地址,原样返回。C6.5 起一部分工具在 Agent 服务端(编辑器 vite 进程)里经 `ssrLoadModule`
 * 执行(`server/agent/`),Node 的 fetch 不认相对地址,服务端载入这些模块后调 `setApiBase("http://127.0.0.1:<端口>")`。
 * 只影响本模块的使用方,不改全局 fetch。
 */
let base = "";

export function setApiBase(next: string): void {
  base = String(next || "").replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  return base ? base + path : path;
}
