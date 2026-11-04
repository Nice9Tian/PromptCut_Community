import { tr } from "../i18n/index.ts";
/**
 * The "submit" channel of the diagnostic report.
 *
 * The service that receives reports has not been decided yet, so **no backend is invented here**:
 * the address is read from the build-time variable `VITE_DIAG_SUBMIT_URL`, and if it is not set, it
 * is not set: the button is grayed out with the reason stated clearly, so that the user sends the
 * report over via "Save as file", instead of clicking and having nothing happen.
 *
 * To connect a Cloudflare Worker (the receiving end is in tools/report-worker/), write two lines in
 * .env.local:
 *   VITE_DIAG_SUBMIT_URL=https://xxx.workers.dev
 *   VITE_DIAG_SUBMIT_TOKEN=<the same string as SUBMIT_TOKEN on the Worker side>
 * No code change is needed on this side.
 */

/** Address that receives reports. Empty = not configured yet */
export const SUBMIT_URL: string = (import.meta.env.VITE_DIAG_SUBMIT_URL || "").trim();

/*
 * Submit token. It ships with the frontend bundle, so it is **not** a real secret key: what it
 * blocks is "someone casually curling the address after scanning it", not a determined attacker
 * stuffing data in. To really prevent abuse, add a per-IP Rate limiting rule for that route in the
 * Cloudflare dashboard.
 */
const SUBMIT_TOKEN: string = (import.meta.env.VITE_DIAG_SUBMIT_TOKEN || "").trim();

/**
 * The maximum size that can be submitted.
 *
 * Uploading a body of several MB straight from the browser is slow and easily cut off by
 * intermediaries, and after a failure the user has to start over.
 * Above this number, say plainly "too large, please save it as a file and send that over": that
 * route is a local disk write and does not fail.
 */
export const SUBMIT_LIMIT = 4 * 1024 * 1024;

/**
 * The reason submitting is impossible (for the button's title and disabled state); returns an empty
 * string when it can be submitted
 */
export function submitBlockedReason(text: string): string {
  if (!SUBMIT_URL) return tr("No address is configured for receiving reports (VITE_DIAG_SUBMIT_URL). Please use \"Save as file\" and send the report to us");
  if (text.length > SUBMIT_LIMIT) {
    return tr("Report is {0}KB, over the {1}MB upload limit. Please use \"Save as file\" and send it to us", Math.round(text.length / 1024), SUBMIT_LIMIT / 1024 / 1024);
  }
  return "";
}

/**
 * Submits the report and returns a receipt sentence that can be read out to the user.
 *
 * Sent as text/plain: that makes it a CORS "simple request" that does not trigger a preflight, so
 * the receiving end only needs to reply with an Access-Control-Allow-Origin and does not have to
 * handle OPTIONS separately.
 * The body itself is still JSON, and the receiving side calls JSON.parse as usual.
 */
export async function submitReport(text: string, label: string, extra?: Record<string, unknown>): Promise<string> {
  const blocked = submitBlockedReason(text);
  if (blocked) throw new Error(blocked);
  const res = await fetch(SUBMIT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: SUBMIT_TOKEN, label, at: new Date().toISOString(), ...extra, text }),
  });
  if (!res.ok) throw new Error(tr("Submit failed: HTTP {0}", res.status));
  // The receipt number is for us to match records against; report it to the user if present, and
  // it is not a failure if absent
  const body = await res.text().catch(() => "");
  let id = "";
  try { id = JSON.parse(body)?.id || ""; } catch { id = ""; }
  return id ? tr("Submitted, receipt number {0}", id) : tr("Submitted");
}
