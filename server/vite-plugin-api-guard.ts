import type { Plugin, ViteDevServer } from "vite";
import { originOk, jsonContentType, apiPath, isAssetServicePath, fromLocalClient, lanApiAllowed } from "./http-guard.mjs";
import { tr } from "./i18n.mjs";

/**
 * Same-origin guard for `/api/**`. **One checkpoint, not twelve.**
 *
 * # Why it is needed
 *
 * The sidecar listens on 127.0.0.1, making it easy to assume "only our own side can access it".
 * Wrong: **any webpage** in the user's browser can send requests to 127.0.0.1. It cannot read
 * cross-origin responses (Same-Origin Policy blocks "reading"), but requests are still sent, and
 * **side effects still happen**: as long as it is a "simple request" (GET/HEAD, or POST with
 * Content-Type in text/plain, application/x-www-form-urlencoded, or multipart/form-data),
 * the browser does not even send a preflight, leaving the server no chance to reject it.
 *
 * One breach actually demonstrated during the 0.3.0 review: a malicious page sends a `text/plain`
 * POST to `/api/ai/config` with body `{"api":{"baseUrl":"https://attacker"}}`. writeConfig
 * performs a partial merge; if payload has no apiKey, it keeps the old one: the user's real Key
 * remains intact, and the next chat sends the Key straight to the attacker's server. The attacker
 * never needs to read any response. Similar issues include arbitrary file read
 * (`/api/chats/attach/import`, `/api/skill/open-path`), arbitrary write (`/api/media/upload/`),
 * forced File Explorer popup (`/api/ai/diagnostics/save`), recursive directory deletion (the
 * deletion endpoint for Skill task directories back then, now archived), and modifying user-level
 * MCP configuration (`/api/skill/desktop-register`).
 * (Note: do not write the path on the line above as a star wildcard: that would create a `*`
 * followed by `/` inside the block comment, closing the comment early.)
 *
 * # Why put it in one middleware rather than adding a line at the start of each handler
 *
 * Across the repository's 14 plugins and dozens of routes, relying on "everyone remembers to add it"
 * has already failed once: before this change, only 2 places in the entire repo called originOk.
 * Putting the checkpoint at the very front ensures new routes are **protected by default**, never
 * forgotten.
 *
 * # Two criteria
 *
 * 1. **Origin**: browsers always include Origin on cross-origin POSTs; if it does not match this site,
 *    return 403. Same-origin GET and curl / sidecar / MCP scripts omit Origin: pass them through;
 *    CSRF is about "requests sent by the browser on the user's behalf".
 * 2. **Must be application/json if it has a body**: reject all three "simple types". This check is
 *    stricter than rule 1 because it does not depend on the Origin header being present: an attacking
 *    page wanting to send a body must declare Content-Type, and declaring json triggers a preflight;
 *    since we return no CORS headers, the preflight fails.
 *    Requests without Content-Type (bodyless POSTs such as `/api/shots/install`) are exempt from this
 *    check: that is how our own UI sends them: they are caught by rule 1.
 *
 * The two routes uploading raw bytes are exempt from rule 2: their body is a File, and Content-Type
 * is set by the browser based on file type (uploading .txt happens to be text/plain). They remain
 * protected by rule 1.
 */

/** Route prefixes where body is raw bytes and Content-Type is determined by file type */
// The "+" upload for chat attachments also sends the File as-is as body (Content-Type is filled
// based on file type, e.g. video/mp4 for video). The consequence of missing this rule is that no
// attachments can be uploaded at all, with the UI only saying "Import failed".
// Speech-to-text (transcribe_media) also first POSTs the asset as-is to
// /api/stt/upload/<job>/<name>, by the same reasoning.
// The export mix page POSTs the rendered mix.wav back as-is (/api/export/audio-mix/<id>, see
// src/AudioMixView.tsx), also with a raw body.
// These five routes are all the raw body routes: only they on the server pour req directly into
// files (see api-guard.test.mjs).
const RAW_BODY_PREFIXES = ["/api/media/upload/", "/api/export/media/", "/api/chats/attach/upload", "/api/stt/upload/", "/api/export/audio-mix/"];

export function apiGuardPlugin(): Plugin {
  return {
    name: "promptcut-api-guard",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        // Must go through apiPath normalization (lowercase + collapsed slashes). connect matches routes
        // case-insensitively; if judged with case-sensitive startsWith, a single `/aPi/ai/config` could
        // bypass the entire checkpoint: testing confirmed baseUrl in ai.json was actually modified.
        // See explanation of apiPath in http-guard.mjs for details.
        const url = apiPath(req.url);
        if (!url.startsWith("/api/")) return next();
        // Asset service routes allow cross-origin (other devices on the LAN must have direct access);
        // it returns its own CORS headers and preflight responses.
        // Only exempts strictly matched paths; see criteria in isAssetServicePath in http-guard.mjs.
        if (isAssetServicePath(req.url)) return next();

        const deny = (error: string) => {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ ok: false, error }));
        };

        // After LAN listen, "missing Origin treated as internal" holds only for the local machine;
        // see fromLocalClient in http-guard.mjs for the rationale
        if (!lanApiAllowed() && !fromLocalClient(req)) {
          return deny(tr("LAN devices can only access the asset service; to open up other endpoints, set PROMPTCUT_LAN_API=1 at startup"));
        }

        if (!originOk(req)) {
          return deny(tr("Cross-origin request rejected (Origin: {0})", req.headers.origin));
        }

        const method = String(req.method || "GET").toUpperCase();
        const hasCt = !!req.headers["content-type"];
        // url is already lowercased, and the prefix table is all lowercase to begin with
        const rawBody = RAW_BODY_PREFIXES.some((p) => url.startsWith(p));
        if (method !== "GET" && method !== "HEAD" && hasCt && !rawBody && !jsonContentType(req)) {
          return deny("This endpoint only accepts Content-Type: application/json");
        }

        next();
      });
    },
  };
}

export default apiGuardPlugin;
