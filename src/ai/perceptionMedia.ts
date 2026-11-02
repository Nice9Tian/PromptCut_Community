/**
 * The asset identifiers that perception tools (shot detection, motion tracking, subject detection)
 * send to the server.
 *
 * The server fetches the bytes through the asset service's interface (`server/perception-source.mjs`;
 * semantics `docs/semantics/product/agent.md` "Media and outputs"), so here **only identifiers are
 * sent**: id, name, kind, url (`/@media/<hash>` or, during the migration period,
 * `/@media/<file name>`), and content hash.
 * `path` is not sent: it is a disk path on one particular machine, other devices in a shared
 * project do not have it, and the server no longer reads from disk by it.
 */
import type { MediaAsset } from "../kernel/project";

export interface PerceptionMediaRef {
  id: string;
  name?: string;
  kind?: string;
  url?: string;
  hash?: string;
}

export function perceptionMediaRef(m: Pick<MediaAsset, "id" | "name" | "kind" | "url" | "hash">): PerceptionMediaRef {
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : null),
    ...(m.kind ? { kind: m.kind } : null),
    ...(m.url ? { url: m.url } : null),
    ...(m.hash ? { hash: m.hash } : null),
  };
}

/**
 * Whether the server can find this asset through the asset service: it has finished being stored
 * (not pending), and has a content hash or an address the asset service recognizes.
 * `blob:` / `data:` are private to this page and do not exist on the asset service.
 */
export function mediaReadyForServer(m: Pick<MediaAsset, "url" | "hash" | "pending">): boolean {
  if (m.pending) return false;
  if (m.hash) return true;
  const url = m.url || "";
  return !!url && !/^(blob|data):/i.test(url);
}
