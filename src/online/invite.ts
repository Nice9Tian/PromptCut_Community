/**
 * Invite links and online addresses (C10a contract `docs/plan/c10a-contract.md` sections 2, 4, 5).
 *
 * - Invite link: `<origin>/editor#invite=<invite code>&doc=<document service path>`; invite code
 *   is 43 base64url characters. The invite code is placed only in the `#` fragment, never in the
 *   query string (`?join=` is already reserved for the local second page, section 15).
 * - **Path is written into the link; page does not guess** (user decision, 2026-10-26): document
 *   service on hosted side is at `/hosted/`, while LAN host is at `/docservice`: they differ, and
 *   origin alone is not enough to infer it. Thus the path is written into the link at issuance
 *   time (`inviteLinkOf`), and the page uses it as is (`docBaseOf`). **Legacy links without `doc=`
 *   are all treated as expired**, asking the creator to generate a new one (user decision on the
 *   same day: no need to maintain legacy compatibility).
 * - On startup, page reads `invite=` from `location.hash`: verifies character set and length,
 *   stores it in memory, immediately clears the `#` fragment via `history.replaceState`, and only
 *   then submits to server. Does not write to localStorage, does not log.
 * - Pasting invite link: extracts server origin and invite code from full link (fallback when `#`
 *   fragment is dropped after QR scan).
 * - Hosted side document service is under `/hosted/` on the same origin (nginx reverse proxy,
 *   contract section 2); asset service is under `/media/` (dispatched by document service's
 *   `service.endpoints`, page does not assemble it itself).
 *
 * Does not import `mode.ts`; directly usable in Node unit tests.
 */

export const INVITE_LENGTH = 43;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Path of hosted side document service under the origin (nginx `location /hosted/`) */
export const HOSTED_DOC_PATH = "/hosted/";
/** Path of the online build */
export const EDITOR_PATH = "/editor";

export const isInviteCode = (v: unknown): v is string => typeof v === "string" && CODE_RE.test(v);

export interface InviteFromLink {
  code: string;
  /** Path of document service under this origin (`/hosted/` or `/docservice`); null if missing in legacy links */
  doc: string | null;
}

/**
 * Extracts `invite=` and `doc=` from `#` fragment: fragment can be `#invite=<code>`, or combined
 * with other parameters via `&`.
 * Returns `{ code, doc }` (valid), `{ bad: true }` (`invite=` present but invalid), or null (absent).
 * `doc=` is an encoded path; recorded as null if missing or malformed, leaving callers to decide
 * how to handle it (currently all treated as legacy links).
 */
export function inviteFromHash(hash: string): InviteFromLink | { bad: true } | null {
  const text = String(hash || "").replace(/^#/, "");
  if (!text) return null;
  let value: string | null = null;
  let doc: string | null = null;
  for (const part of text.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i);
    if (key === "invite" && value === null) value = part.slice(i + 1);
    else if (key === "doc" && doc === null) {
      try {
        const raw = decodeURIComponent(part.slice(i + 1));
        doc = raw.startsWith("/") ? raw : null;
      } catch {
        doc = null;
      }
    }
  }
  if (value === null) return null;
  return isInviteCode(value) ? { code: value, doc } : { bad: true };
}

/**
 * Pasted invite link → `{ origin, code, doc }`; returns null if not `http(s)://…#invite=<43 chars>`
 * ("Not a valid invite link.").
 * `doc` being null indicates a legacy link (missing path), treated as expired by callers.
 * Tolerates leading/trailing whitespace, or apps like WeChat wrapping the link in text (extracts
 * from first http(s):// up to whitespace).
 */
export function parseInviteLink(text: string): { origin: string; code: string; doc: string | null } | null {
  const m = /https?:\/\/\S+/i.exec(String(text || "").trim());
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(m[0]);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const found = inviteFromHash(u.hash);
  if (!found || !("code" in found)) return null;
  return { origin: u.origin, code: found.code, doc: found.doc };
}

/**
 * Path of editor page under this origin: hosted side is `/editor` (nginx serves online artifacts
 * there), while LAN hosts (local dev server, desktop app) use root `/`: there is no `/editor`
 * path there.
 * Distinguished by document service path: `/hosted/` is hosted side, all others are local.
 */
export function editorPathFor(docPath: string): string {
  return docPath === HOSTED_DOC_PATH ? EDITOR_PATH : "/";
}

/**
 * Invite link: `<origin><editor page path>#invite=<code>&doc=<document service path>`.
 * Both paths must be correct: hosted side is `/editor` + `/hosted/`, LAN host is `/` +
 * `/docservice`; the page does not guess (see file header).
 */
export function inviteLinkOf(origin: string, code: string, docPath: string, pagePath = editorPathFor(docPath)): string {
  return `${origin.replace(/\/+$/, "")}${pagePath}#invite=${code}&doc=${encodeURIComponent(docPath)}`;
}

/** Origin + path from link → document service HTTP base URL (same format as candidate `base` in route.mjs, preserving trailing slash from the path) */
export function docBaseOf(origin: string, docPath: string): string {
  const path = docPath.startsWith("/") ? docPath : `/${docPath}`;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** Origin → hosted side document service HTTP base URL (`https://h/hosted/`, ending with `/`, same format as candidate `base` in route.mjs) */
export function hostedDocBaseOf(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${HOSTED_DOC_PATH}`;
}

/**
 * Document service HTTP base URL → WebSocket address, **retaining trailing slash**:
 * `https://h/hosted/` → `wss://h/hosted/`.
 * nginx `location /hosted/` returns 301 for `/hosted` without slash, and WebSocket upgrades cannot
 * follow redirects, so connections routed to `/hosted/` by origin must retain the slash (`wsBaseOf`
 * in route.mjs strips it, whereas LAN host `/docservice` expects no trailing slash).
 */
export function hostedWsUrlOf(base: string): string {
  const u = new URL(base);
  const protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  return `${protocol}//${u.host}${u.pathname}`;
}

/* ---------------- Read on startup, cleared immediately after ---------------- */

let captured: InviteFromLink | { bad: true } | null = null;

/**
 * Called once on page startup: reads `invite=` from `location.hash`, stores in memory, then clears
 * the `#` fragment (only clears fragments containing `invite=`).
 * `loc` / `hist` can be injected (testing).
 */
export function captureInviteFromLocation(
  loc: Pick<Location, "hash" | "pathname" | "search"> = location,
  hist: Pick<History, "replaceState" | "state"> = history,
): void {
  const found = inviteFromHash(loc.hash);
  if (!found) return;
  captured = found;
  try {
    hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}`);
  } catch {
    /* Ignore if clearing fails: invite code is only in fragment, fragment is not sent to server */
  }
}

/** Consumes the invite code read at startup (returned only once) */
export function takeCapturedInvite(): InviteFromLink | { bad: true } | null {
  const c = captured;
  captured = null;
  return c;
}

/** Peeks without consuming */
export function peekCapturedInvite(): InviteFromLink | { bad: true } | null {
  return captured;
}
