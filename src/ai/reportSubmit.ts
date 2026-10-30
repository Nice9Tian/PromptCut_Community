/**
 * 诊断报告的「提交」通道。
 *
 * 收报告的服务还没定,所以这里**不发明一个后端**:地址从构建期变量
 * `VITE_DIAG_SUBMIT_URL` 读,没配就是没配 —— 按钮灰掉并说清楚原因,
 * 让用户走「保存为文件」把报告发过来,而不是点一下什么也没发生。
 *
 * 接 Cloudflare Worker(收报告端在 tools/report-worker/)时,在 .env.local 里写两行:
 *   VITE_DIAG_SUBMIT_URL=https://xxx.workers.dev
 *   VITE_DIAG_SUBMIT_TOKEN=<和 Worker 那边 SUBMIT_TOKEN 一样的串>
 * 这边不用改代码。
 */

/** 收报告的地址。空 = 还没配 */
export const SUBMIT_URL: string = (import.meta.env.VITE_DIAG_SUBMIT_URL || "").trim();

/*
 * 提交令牌。它跟着前端打包一起发出去,所以**不是**真正的密钥 —— 它挡的是
 * 「地址被扫到之后随手 curl 一下」,不是铁了心要灌数据的人。真要防滥用,
 * 在 Cloudflare 后台给那条路由加一条按 IP 的 Rate limiting 规则。
 */
const SUBMIT_TOKEN: string = (import.meta.env.VITE_DIAG_SUBMIT_TOKEN || "").trim();

/**
 * 能提交的最大体积。
 *
 * 浏览器直传一个几 MB 的 body,慢、容易被中间层掐断,失败了用户还得重来一遍。
 * 超过这个数就明说「太大了,请存成文件发过来」——那条路是本地写盘,不会失败。
 */
export const SUBMIT_LIMIT = 4 * 1024 * 1024;

/** 没法提交时的原因(给按钮的 title 和禁用态用);能提交就返回空串 */
export function submitBlockedReason(text: string): string {
  if (!SUBMIT_URL) return "还没配收报告的地址(VITE_DIAG_SUBMIT_URL)。请用「保存为文件」把报告发给我们";
  if (text.length > SUBMIT_LIMIT) {
    return `报告 ${Math.round(text.length / 1024)}KB,超过 ${SUBMIT_LIMIT / 1024 / 1024}MB 上传上限。请用「保存为文件」发给我们`;
  }
  return "";
}

/**
 * 提交报告,返回一句可以念给用户听的回执。
 *
 * 用 text/plain 发:这样它是 CORS 的「简单请求」,不触发预检 —— 收报告的那头
 * 只要回一个 Access-Control-Allow-Origin 就够了,不用额外处理 OPTIONS。
 * 正文本身还是 JSON,收的一侧照常 JSON.parse。
 */
export async function submitReport(text: string, label: string, extra?: Record<string, unknown>): Promise<string> {
  const blocked = submitBlockedReason(text);
  if (blocked) throw new Error(blocked);
  const res = await fetch(SUBMIT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: SUBMIT_TOKEN, label, at: new Date().toISOString(), ...extra, text }),
  });
  if (!res.ok) throw new Error(`提交失败 HTTP ${res.status}`);
  // 回执编号是给我们对单用的,有就报给用户,没有也不算失败
  const body = await res.text().catch(() => "");
  let id = "";
  try { id = JSON.parse(body)?.id || ""; } catch { id = ""; }
  return id ? `已提交，回执编号 ${id}` : "已提交";
}
