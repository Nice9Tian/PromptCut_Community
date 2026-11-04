import { useEffect } from "react";
import { subscribeMediaUploadRejected, type MediaUploadRejection } from "../../online/mediaUploadQueue";
import { formatUploadRejectionReason } from "../sync/accountExtensions";
import { tr } from "../../i18n/index.ts";

/**
 * The message shown to the user when an item in the online upload queue is permanently refused by
 * the asset service (guest video count full, file too large, `PERMANENT_REFUSALS` in
 * `mediaUploadQueue.ts`) (claude/guest-fix [ruling], level 2; review D: previously nobody on the
 * upload path used these messages in `accountErrorText`, and the user only saw it present on this
 * machine but missing in the cloud and on other devices). The message itself follows
 * `accountErrorText` in `src/account/client.ts`, with the numbers assembled from `GUEST_LIMITS`.
 */
export function uploadRejectedText(rejection: Pick<MediaUploadRejection, "name" | "code">): string {
  const what = rejection.name ? tr("\"{0}\"", rejection.name) : tr("this media");
  return tr("{0} was not uploaded to the cloud: {1}", what, formatUploadRejectionReason(rejection.code));
}

/** Mount one in the editor (media library section, mobile app editor page): when an item is refused, it says so in its own notice bar */
export function useUploadRejectedNotice(show: (text: string) => void): void {
  useEffect(() => subscribeMediaUploadRejected((rejection) => show(uploadRejectedText(rejection))), [show]);
}
