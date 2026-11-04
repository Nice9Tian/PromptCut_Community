/**
 * Shared sound/AV WAV ingest. Bytes go through the ordinary asset-service media protocol.
 *
 * Where the write ticket comes from: an old shared project signs it on the page's document connection
 * (`auth.ticket { kind: 'asset', access: 'rw' }`); in an account cloud project that message is rejected, so use the
 * asset ticket issued by the account session (already set up when entering the project, `remoteAssetTicketInfo` in
 * `assetTiers.ts`, one ticket for both read and write; a read-only member writing with it is rejected by the asset
 * service). Requests of an account project do not carry the website's login cookie (the asset service rejects
 * a request as soon as it sees the cookie).
 */
import { getState } from "../../store/project";
import { createSnapUploader, sha256Hex } from "../../online/snapUploader";
import { docRequest, hasDocLink, remoteAccountProjectId, remoteAssetBase, remoteAssetTicketInfo } from "../media/assetTiers";
import { onlinePage } from "../../online/pageFlag";
import { tr } from "../../i18n/index.ts";

function generatedAudioService(signal: AbortSignal) {
  const projectId = getState().project.id;
  const remoteBase = remoteAssetBase();
  const accountProject = remoteBase ? remoteAccountProjectId() : null;
  const base = remoteBase ?? (onlinePage() ? null : "/api/asset");
  if (!base) throw new Error(tr("The asset service is not connected yet, connect a project and try again"));
  if (hasDocLink() && !remoteBase) throw new Error(tr("The shared project asset service is not ready yet, try again later"));
  const stillCurrent = () => {
    signal.throwIfAborted();
    if (getState().project.id !== projectId || remoteAssetBase() !== remoteBase || (remoteBase ? remoteAccountProjectId() : null) !== accountProject) throw new Error(tr("The asset service or project has changed, upload canceled"));
  };
  const uploader = createSnapUploader({
    base: () => base,
    ticket: async (force) => {
      stillCurrent();
      if (!remoteBase) return null;
      if (accountProject) {
        const info = await remoteAssetTicketInfo(force === true);
        stillCurrent();
        if (!info?.ticket) throw new Error(tr("Cannot get the asset write ticket"));
        return info.ticket;
      }
      const response = await docRequest({ type: "auth.ticket", kind: "asset", access: "rw" });
      stillCurrent();
      if (response.type !== "auth.ticket.ok" || typeof response.ticket !== "string") throw new Error(tr("Cannot get the asset write ticket"));
      return response.ticket;
    },
    fetch: (url, init) => { stillCurrent(); return fetch(url, { ...init, signal, ...(accountProject ? { credentials: "omit" as const } : {}) }); },
  });
  return { uploader, stillCurrent };
}

/** A cache hit must also check the bytes in the current asset service, not just trust the old reference in the project. */
export async function hasGeneratedAudio(hash: string, signal: AbortSignal): Promise<boolean> {
  const { uploader, stillCurrent } = generatedAudioService(signal);
  const exists = await uploader.has("media", hash);
  stillCurrent();
  return exists;
}

export async function uploadGeneratedAudio(wav: Uint8Array, signal: AbortSignal): Promise<{ hash: string; bytes: number }> {
  const { uploader, stillCurrent } = generatedAudioService(signal);
  const hash = await sha256Hex(wav);
  stillCurrent();
  await uploader.put("media", hash, wav, "wav");
  stillCurrent();
  return { hash, bytes: wav.byteLength };
}
