/**
 * "Local" determined by actual initiator (semantics `docs/semantics/product/document-service.md`
 * "Determine local by actual initiator"; contract `docs/plan/http-transport-contract.md` section 10
 * [ruling: 2026-09-27 lead session, HT-a]).
 *
 * Counted as local only when socket peer is loopback and every hop recorded in forwarding headers
 * (`for=` in `Forwarded`, every hop of `X-Forwarded-For`, `X-Real-IP`) of request (HTTP and
 * WebSocket upgrade) is loopback; not local if any single hop is not loopback. Strict only, never
 * relaxed: if peer is not loopback, no forwarding header can make it local; when local trust flag is 0,
 * caller treats it as non-local across the board as before.
 *
 * Placed in `server/auth/`: standalone deployment of document service
 * (`cloud/scripts/remote/docservice.mjs deploy`) includes only docservice, auth, and render-queue
 * directories. Imports only Node built-in modules (none imported here), not used browser-side.
 */

/** Loopback addresses: 127.0.0.0/8, ::1, IPv4-mapped ::ffff:127.x */
export function isLoopbackAddress(address) {
  const a = String(address || "").toLowerCase();
  return a === "::1" || /^127./.test(a) || /^::ffff:127./.test(a);
}

/** Hop in forwarding header → address: strip quotes, strip IPv6 brackets and port, strip IPv4 port; returns null if empty */
export function hopAddress(raw) {
  let v = String(raw ?? "").trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).trim();
  if (v === "") return null;
  const bracket = /^\[([^\]]*)\](?::\d+)?$/.exec(v);
  if (bracket) return bracket[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (v4port) return v4port[1];
  return v;
}

const headerText = (value) => (Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "");

/**
 * Every hop recorded in request forwarding headers (`for=` in `Forwarded`, every hop in `X-Forwarded-For`,
 * `X-Real-IP`), returns [] if no forwarding headers. Unrecognized formats (`for=unknown`, obfuscated name
 * `_abc`, hostnames) are kept as-is; none of them count as loopback when determining local.
 */
export function forwardedHops(req) {
  const headers = req?.headers ?? {};
  const hops = [];
  for (const element of headerText(headers.forwarded).split(",")) {
    for (const pair of element.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0 || pair.slice(0, eq).trim().toLowerCase() !== "for") continue;
      const a = hopAddress(pair.slice(eq + 1));
      if (a !== null) hops.push(a);
    }
  }
  for (const part of headerText(headers["x-forwarded-for"]).split(",")) {
    const a = hopAddress(part);
    if (a !== null) hops.push(a);
  }
  const real = hopAddress(headerText(headers["x-real-ip"]));
  if (real !== null) hops.push(real);
  return hops;
}

/**
 * Whether actual initiator is local (semantics `product/document-service.md`
 * "Determine local by actual initiator"; contract `docs/plan/http-transport-contract.md` section 10):
 * peer address is loopback, **and** every hop in forwarding headers is loopback. Requests forwarded
 * through same-machine reverse proxy do not count as local if forwarding headers record external
 * addresses even though peer is loopback; chains entirely on loopback (local component forwarding
 * to local) still count as local. Strict only, never relaxed: if peer is not loopback, no forwarding
 * header can make it local. `address` defaults to socket peer, but caller may substitute verified
 * real peer (`STAGE_CLIENT_HEADER` written by stage port proxy, see `clientAddressOf`).
 */
export function isLocalOrigin(req, address = req?.socket?.remoteAddress) {
  if (!isLoopbackAddress(address)) return false;
  return forwardedHops(req).every(isLoopbackAddress);
}

/**
 * Origin used for logging and rate limiting: when peer is loopback but forwarding headers indicate it
 * was not forwarded from local, record as `proxied:<peer>` (no longer looks like a loopback address,
 * so places judging local solely by origin address: such as rate limit exemption for creator
 * operations: will not treat it as local); others kept as-is.
 */
export function remoteTagOf(req, address = req?.socket?.remoteAddress ?? null) {
  if (address === null || address === undefined) return null;
  return isLoopbackAddress(address) && !isLocalOrigin(req, address) ? `proxied:${address}` : address;
}
