import { tr } from "../i18n.mjs";
/**
 * Fetch the available model manifest from the OpenAI-compatible endpoint (`GET {baseUrl}/v1/models`).
 *
 * Why a separate file instead of putting it into vite-plugin-ai: URL construction and response
 * shapes both have gotchas, worthy of unit tests. The plugin only handles reading config and
 * returning JSON.
 *
 * Official openai.com also has this endpoint, but the manifest contains only its own models; what
 * really benefits from this is **relay services**: they list all connected models here, where
 * manually typing model names easily leads to typos or expiration.
 *
 * Regarding "thinking mode": this endpoint returns the standard OpenAI shape (id / object /
 * owned_by) and has **no** fields representing thinking tiers. Relay services list thinking
 * variants as separate model names (with suffixes like `-thinking`), so fetching the manifest
 * brings them along: but those are model names, not "modes". The tier itself goes through
 * `reasoning_effort` in the request body (see harness/providers/openai.mjs).
 */

/**
 * Assemble baseUrl into `/v1/models`.
 * Some addresses entered by users include `/v1` while others do not; keep consistent with the logic
 * in providers/openai.mjs.
 */
export function modelsUrl(baseUrl) {
  let b = String(baseUrl || '').trim();
  while (b.endsWith('/')) b = b.slice(0, -1);
  if (!b) return '';
  return b.endsWith('/v1') ? `${b}/models` : `${b}/v1/models`;
}

/**
 * Extract model names from the response.
 *
 * The standard shape is `{ data: [{ id }] }`, but relay service implementations vary: some return
 * an array directly, others have elements that are plain strings. Recognize what we can, and if
 * unrecognized, return an empty array for the caller to say "not found", without throwing
 * exceptions: fetching the manifest is an optional convenience button and should not crash because
 * the remote end returned something strange.
 */
export function parseModels(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
    : [];
  const out = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id ?? item?.name;
    if (typeof id !== 'string') continue;
    const name = id.trim();
    // Model names allow alphanumeric characters and . : / _ - (relay services often use patterns like
    // `provider/model:tag`)
    if (!name || !/^[\w./:-]+$/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Fetch the manifest once.
 *
 * @param api  The api section in ai.json (uses baseUrl / apiKey)
 * @param deps.fetchImpl Replace with mock for unit tests
 */
export async function listApiModels(api, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const url = modelsUrl(api?.baseUrl);
  if (!url) throw new Error(tr("The endpoint URL is empty"));
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${api?.apiKey || ''}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // 401 is the most common case, explain in plain words; do not paste the entire response body
    // (may echo the key)
    if (res.status === 401 || res.status === 403) throw new Error(tr("The endpoint rejected this key (HTTP {0})", res.status));
    throw new Error(tr("Failed to fetch the model list: HTTP {0}", res.status));
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(tr("Failed to fetch the model list: the response was not JSON"));
  }
  return parseModels(payload);
}
