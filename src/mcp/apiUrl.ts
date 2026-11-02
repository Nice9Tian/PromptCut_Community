/**
 * Address used in tool implementations to call editor APIs (`/api/...`).
 *
 * In the page, it is a same-origin relative address, returned as is. Starting from C6.5, some
 * tools run in the Agent server (editor vite process) via `ssrLoadModule` (`server/agent/`);
 * Node's fetch does not accept relative addresses, so after loading these modules the server
 * calls `setApiBase("http://127.0.0.1:<port>")`. Only affects consumers of this module
 * without modifying the global fetch.
 */
let base = "";

export function setApiBase(next: string): void {
  base = String(next || "").replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  return base ? base + path : path;
}
