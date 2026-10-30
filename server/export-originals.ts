/**
 * 预渲染进程 `/api/export` 的导出拦截(C6.6 设计稿 `docs/plan/c66-design.md` 第 9 节第 3 条〔裁〕)。
 *
 * 导出只用素材原尺寸(`docs/semantics/product/asset-service.md`「两档素材」):被片段引用的素材原尺寸在
 * **当前素材服务**上还没 `complete` 的,导出前拦下,回 409 `awaiting-uploader` 并列出缺的素材。
 * 页面上的两处拦截(顶栏、`exportVideo` 开头)保留;这一道是给 Agent 或脚本直接打 `/api/export` 的。
 *
 * 「当前素材服务」由编辑器进程知道(页面进入共享项目时登记的远程素材服务,见 `server/media-pull.mjs`),
 * 所以这里问编辑器进程的 `POST /api/media/originals { hashes }`(回 `{ missing }`);编辑器进程的源取
 * `assetServiceOrigin()`(预渲染进程里是 `PROMPTCUT_EDITOR_URL`,单进程形态是本进程)。
 * 问不到(没有源、网络错、非 2xx)按全部没到齐算 —— 宁可拦下,不拿不确定的素材出片。
 * 被片段引用的素材一个带哈希的都没有时不发请求,直接放行(没有哈希的老素材只可能在本机,不拦)。
 */
import { checkExportOriginals, missingOriginals, type ExportGateResult } from "../src/render/mediaTier";
import { assetServiceOrigin } from "./asset-client";
import { withoutConfirmedMissing } from "../src/audio/missingMaterialRecord";

export async function exportOriginalsGate(
  project: any,
  { origin = assetServiceOrigin(), fetchImpl = globalThis.fetch, timeoutMs = 10_000 }: { origin?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ExportGateResult> {
  if (!project || !Array.isArray(project.media) || !Array.isArray(project.tracks)) return { ok: true, missing: [] };
  // 认定过「确认缺失」的素材不会再到齐:不拦,导出时照原位置出占位(src/audio/missingMaterialRecord.ts)
  project = withoutConfirmedMissing(project);
  const candidates = missingOriginals(project, []).map((m) => m.hash);
  if (!candidates.length) return { ok: true, missing: [] };
  let incomplete: Set<string> | null = null;
  if (origin) {
    try {
      const res = await fetchImpl(`${origin.replace(/\/+$/, "")}/api/media/originals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: candidates }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const body = await res.json() as { missing?: unknown };
        if (Array.isArray(body?.missing)) incomplete = new Set(body.missing.map((h) => String(h).toLowerCase()));
      }
    } catch { /* 问不到:下面按全部没到齐算 */ }
  }
  return checkExportOriginals({ project, has: (hash) => incomplete !== null && !incomplete.has(hash.toLowerCase()) });
}
