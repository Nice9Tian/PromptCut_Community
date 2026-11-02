/**
 * Two things to attach to the background backfill after a project is opened (`startTierBackfill` in `io/mediaUpload.ts`), passed in by `Preview`:
 *
 * - `shared`: in a shared project, media is not marked "(missing)" -- whether this machine can fetch it is this machine's business, and the mark would sync through the document service to other members;
 * - `afterIngest`: when the project is already "put in the cloud", media whose hash was backfilled in the background is handed to the upload queue, and media that cannot be backfilled is listed to the user in a sync bubble
 *   (same sentence and same kind of notice as `queueExistingMedia` in `collab.ts` when putting in the cloud is turned on);
 * - `afterImport`: in a shared project, media whose import finished is handed to the upload queue by hash; anything imported after the project opens but before the upload target is ready is recorded first and handed over once ready
 *   (queueImportedMedia in `media/assetTiers.ts`), and anything missing from the local content store is likewise listed to the user.
 *
 * Kept in a separate file: `mediaUpload.ts` cannot import the sync layer (`syncManager` cannot be loaded in Node unit tests, and io should not depend on sync the other way round).
 */
import type { BackfillHooks } from "../io/mediaUpload";
import { getState } from "../../store/project";
import { queueBackfilledMedia, queueImportedMedia } from "../media/assetTiers";
import { getSyncView, pushToast } from "./syncManager";
import { postEnqueue, uploadMissingMessage } from "./collab";

const shared = () => !!getSyncView().shared;
/**
 * This file still carries a collaboration link (a cloud or LAN project, whether connected or not; it is gone only after being proven converted to a local project).
 * When not connected (offline, authentication needed, waiting for the host) `shared` is empty, but it is still not a local project: media that exists only remotely must not be judged missing at this point.
 */
const associated = () => !!getSyncView().association;

const notify = (names: string[]) => {
  console.warn("[collab] These assets could not be uploaded:", names);
  pushToast(uploadMissingMessage(names), "warn", Infinity);
};

export const backfillHooks: BackfillHooks = {
  shared,
  associated,
  afterIngest: (r) => queueBackfilledMedia(r, getState().project.media ?? [], { post: postEnqueue, shared, notify }),
  afterImport: (media) => queueImportedMedia(media, { post: postEnqueue, shared, notify }),
};
