import type { Project } from "../../kernel/project";
import { tr } from "../../i18n/index.ts";

/**
 * `.procp`: the bundle of "arrangement + media".
 *
 * Structure: a zip whose **first entry is always `project.proc`** (so the arrangement can be read
 * with head without unpacking), and the rest are `media/<hash>.<original extension>`. The name is
 * the content hash, so the same content appears only once in the bundle, and packing and unpacking
 * both deduplicate naturally.
 *
 * Why we write our own zip: the project has no zip dependency (package.json lists none), and what is
 * needed here is small. Media (mp4 / jpg / mp3) is already compressed, so deflating it again only
 * costs CPU without saving bytes, so writing always uses store (method 0), and the single text entry
 * for the arrangement is also stored (a few dozen KB). Reading also accepts deflate entries produced
 * by ordinary zip tools (DecompressionStream).
 *
 * Everything goes through Blob, not ArrayBuffer: several GB of media is hosted by the browser (it can
 * live on disk), and the page only streams it chunk by chunk to compute CRC / send to the server;
 * the main thread never holds the whole byte content.
 *
 * **This file has only type imports at the top**: zip reading/writing and packing/unpacking use only
 * Blob / fetch / DecompressionStream, and the editor side (the store, the React dependencies in
 * proc.ts) is dynamically imported only in the two thin outermost wrappers. So `node --test` can
 * load it directly, and the zip byte format is covered by unit tests (see procp.test.mjs).
 */

export const PROCP_EXT = ".procp";
const PROC_ENTRY = "project.proc";
const MEDIA_PREFIX = "media/";

/**
 * Message shown to the user when an entry's content check fails (primary UI text, not yet
 * finalized by the user).
 * Neither the task brief nor the design has the original wording; the phrasing follows the kind used
 * for bundle read failures ("This is not a .procp bundle (…)"). For the draft, see
 * docs/reports/AGENT-v18-fixes.md, "Items needing a user decision".
 */
export const PROCP_DAMAGED_MESSAGE = tr(".procp package is damaged (an entry inside failed its content check), it was not opened");

/**
 * Whether this file is a .procp bundle.
 *
 * Even if the name does not match, look at the first four bytes (`PK\x03\x04`): the user may have
 * renamed the bundle, and calling `.text()` on a multi-GB zip would only hang the page, so it must
 * be routed before any read.
 */
export async function isProcpFile(file: Blob & { name?: string }): Promise<boolean> {
  if (typeof file?.name === "string" && file.name.toLowerCase().endsWith(PROCP_EXT)) return true;
  if (!file || file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/* ------------------------------ zip basics ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** Compute CRC32 as a stream: the whole byte content never enters the JS heap */
async function crc32OfBlob(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    crc = crc32Update(crc, value as Uint8Array);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

function bytes(len: number) {
  const buf = new Uint8Array(new ArrayBuffer(len));
  const view = new DataView(buf.buffer);
  return { buf, view };
}

interface PackEntry { name: string; blob: Blob }

/** Store-only zip. Entry order is the order written: project.proc comes first. Unit tests use it directly to verify the byte format */
export async function writeZip(entries: PackEntry[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const { time, date } = dosTime(new Date());
  let offset = 0;

  for (const entry of entries) {
    // Copy into our own ArrayBuffer: the view type from TextEncoder does not guarantee it is not a SharedArrayBuffer, which Blob does not accept
    const encoded = new TextEncoder().encode(entry.name);
    const name = new Uint8Array(encoded.length);
    name.set(encoded);
    const size = entry.blob.size;
    const crc = await crc32OfBlob(entry.blob);

    const local = bytes(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);   // version needed
    local.view.setUint16(6, 0x0800, true); // UTF-8 name
    local.view.setUint16(8, 0, true);    // method: store
    local.view.setUint16(10, time, true);
    local.view.setUint16(12, date, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, size, true);
    local.view.setUint32(22, size, true);
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, 0, true);
    parts.push(local.buf, name, entry.blob);

    const dir = bytes(46);
    dir.view.setUint32(0, 0x02014b50, true);
    dir.view.setUint16(4, 20, true);
    dir.view.setUint16(6, 20, true);
    dir.view.setUint16(8, 0x0800, true);
    dir.view.setUint16(10, 0, true);
    dir.view.setUint16(12, time, true);
    dir.view.setUint16(14, date, true);
    dir.view.setUint32(16, crc, true);
    dir.view.setUint32(20, size, true);
    dir.view.setUint32(24, size, true);
    dir.view.setUint16(28, name.length, true);
    dir.view.setUint32(42, offset, true);
    const dirEntry = new Uint8Array(46 + name.length);
    dirEntry.set(dir.buf, 0);
    dirEntry.set(name, 46);
    central.push(dirEntry);

    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((n, e) => n + e.length, 0);
  const end = bytes(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buf], { type: "application/zip" });
}

interface ReadEntry { name: string; method: number; size: number; crc: number; blob: Blob }

async function sliceView(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** Read the central directory. Entry data is sliced out as Blobs, not read whole into memory. Unit tests use it directly to verify the byte format */
export async function readZip(file: Blob): Promise<ReadEntry[]> {
  const tailLen = Math.min(file.size, 66560); // 64 KiB + EOCD: enough to cover a bundle with a comment
  const tail = new Uint8Array(await file.slice(file.size - tailLen, file.size).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(tr("This is not a .procp package (zip directory not found)"));
  const end = new DataView(tail.buffer, tail.byteOffset + eocd, 22);
  const count = end.getUint16(10, true);
  const cdOffset = end.getUint32(16, true);
  const cdSize = end.getUint32(12, true);

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const out: ReadEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    const size = cd.getUint32(p + 24, true);
    const csize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    const head = await sliceView(file, local, local + 30);
    const dataStart = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    out.push({ name, method, size, crc, blob: file.slice(dataStart, dataStart + csize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * The raw bytes of an entry, checked against the CRC32 registered in the central directory. Store
 * entries are used directly; deflate goes through the browser's built-in decompression stream
 * (bundles compressed by ordinary zip tools are accepted too). If the content does not match, throw
 * PROCP_DAMAGED_MESSAGE and never hand out corrupted bytes.
 * An error from the decompression stream itself (corrupt deflate data) is likewise treated as a
 * damaged bundle.
 */
export async function inflate(entry: ReadEntry): Promise<Blob> {
  let body: Blob;
  if (entry.method === 0) body = entry.blob;
  else if (entry.method !== 8) throw new Error(tr(".procp contains an unknown compression method ({0}): {1}", entry.method, entry.name));
  else {
    try {
      body = await new Response(entry.blob.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    } catch {
      throw new Error(PROCP_DAMAGED_MESSAGE);
    }
  }
  if (body.size !== entry.size || (await crc32OfBlob(body)) !== entry.crc) throw new Error(PROCP_DAMAGED_MESSAGE);
  return body;
}

/* ------------------------------ pack / unpack ------------------------------ */

/** A media item that cannot go into the bundle (still has no hash after being added to the library, or its bytes cannot be fetched from the content store): the caller uses it to list the names to the user */
export interface PackMissing { id: string; name: string }

/**
 * The <hash>.<ext> of every media item in the project (deduplicated by hash), plus the **entries
 * with no valid hash, which therefore cannot be packed**.
 * Entries without a hash must not be skipped silently: they always appear in `unhashed`, which the
 * return value of packing hands to the caller (to tell the user when packing finishes).
 */
export function mediaEntries(project: Project): { entries: { hash: string; file: string; ids: string[] }[]; unhashed: PackMissing[] } {
  const seen = new Map<string, { file: string; ids: string[] }>();
  const unhashed: PackMissing[] = [];
  for (const m of project.media || []) {
    const hash = String(m.hash || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) { unhashed.push({ id: m.id, name: m.name }); continue; }
    const hit = seen.get(hash);
    if (hit) { hit.ids.push(m.id); continue; }
    const ext = (m.ext || (m.name || "").split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    seen.set(hash, { file: ext ? `${hash}.${ext}` : hash, ids: [m.id] });
  }
  return { entries: [...seen].map(([hash, v]) => ({ hash, file: v.file, ids: v.ids })), unhashed };
}

export interface PackResult {
  blob: Blob;
  /** Media missing from the bundle (the file is really gone): the names are listed to the user when packing finishes */
  missing: PackMissing[];
}

/**
 * Current project → .procp bundle.
 *
 * First add the old media that has no hash but whose bytes this machine can still fetch to the
 * library (`ingestUnhashedMedia`, written back to the media table), then serialize the arrangement.
 * So `project.proc` in the bundle carries hashes too, and the other side restores by hash. Media is
 * fetched from the local content store via /@media/<hash> and packed in; an item that cannot be
 * fetched does not ruin the whole packing, but always appears in `missing` in the return value.
 */
export async function packProcp(): Promise<PackResult> {
  await (await import("../sync/syncManager")).whenSaved();
  const { ingestUnhashedMedia } = await import("./mediaUpload.ts");
  await ingestUnhashedMedia();
  await (await import("../sync/syncManager")).whenSaved();
  const { serializeProc } = await import("./proc.ts");
  const { getState } = await import("../../store/project.ts");
  // Desktop: /@media/<hash> from the local content store; online page: the original size on the remote asset service (with a read-only ticket), and "" (skip) if it is not ready yet
  const { originalMediaUrl } = await import("../../render/mediaTier");
  return packProcpFrom(serializeProc(), getState().project, (hash) => originalMediaUrl({ url: `/@media/${hash}`, hash }));
}

/**
 * The packing itself. Kept separate from the store so it can be unit tested (see procp.test.mjs).
 * It only takes an arrangement text and a Project, and fetches media from /@media/<hash>.
 */
export async function packProcpFrom(procText: string, project: Project, urlOf: (hash: string) => string = (hash) => `/@media/${hash}`): Promise<PackResult> {
  const entries: PackEntry[] = [{ name: PROC_ENTRY, blob: new Blob([procText], { type: "application/json" }) }];
  const { entries: media, unhashed } = mediaEntries(project);
  const missing: PackMissing[] = [...unhashed];
  const nameOf = new Map((project.media || []).map((m) => [m.id, m.name]));
  for (const { hash, file, ids } of media) {
    let ok = false;
    try {
      const url = urlOf(hash);
      if (!url) console.warn(`[procp] Asset service is not ready yet, skipping ${hash}`);
      else {
        const res = await fetch(url);
        if (!res.ok) console.warn(`[procp] ${hash} is not in the local content store, skipping`);
        else { entries.push({ name: MEDIA_PREFIX + file, blob: await res.blob() }); ok = true; }
      }
    } catch (err) {
      console.warn(`[procp] Failed to fetch asset ${hash}`, err);
    }
    if (!ok) for (const id of ids) missing.push({ id, name: nameOf.get(id) ?? "" });
  }
  if (missing.length) console.warn("[procp] These assets were not included in the package:", missing.map((m) => m.name));
  return { blob: await writeZip(entries), missing };
}

/** The message shown to the user when packing finishes: which media is missing from the bundle (names deduplicated; when there are too many, only the first several are listed) */
export function packMissingMessage(missing: readonly PackMissing[], limit = 12): string {
// i18n-allow: names in older projects carry the Chinese marker
  const names = [...new Set(missing.map((m) => (m.name || m.id).replace(/^\((?:missing|缺失)\) /, "")))];
  if (!names.length) return "";
  const shown = names.slice(0, limit).map((n) => `· ${n}`).join("\n");
  const more = names.length > limit ? tr("\n…and {0} more", names.length - limit) : "";
  return tr("Package saved, but {0} media items below have no file on this machine and were not included in the package (if you open this package on another machine, they won't play):\n{1}{2}", names.length, shown, more);
}

/** Which of these hashes are already in the local content store (used when unpacking to skip media that already exists) */
async function alreadyLocal(hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  try {
    const res = await fetch(`/api/media/local?hashes=${hashes.join(",")}`);
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set<string>(Array.isArray(data?.hashes) ? data.hashes : []);
  } catch {
    return new Set();
  }
}

export interface UnpackResult {
  procText: string;
  /** Number of media items actually written into the content store this time */
  stored: number;
  /** Number of media items skipped because the store already has them */
  deduped: number;
  /** Hashes of the media this bundle brought that are now really in the local content store (newly written + already there) */
  landed: string[];
}

/**
 * Unpack: media lands in the local content store (deduplicated by hash; not a single byte is
 * transferred for what the store already has), and the arrangement is returned as is.
 *
 * Storing still goes through `/api/media/upload/<name>`: the server computes the hash while writing
 * to disk as before, so even a wrongly named entry in the bundle cannot pollute the content store
 * (it lands under its own **real** hash).
 */
export async function unpackProcp(file: Blob): Promise<UnpackResult> {
  const entries = await readZip(file);
  const proc = entries.find((e) => e.name === PROC_ENTRY) || entries[0];
  if (!proc) throw new Error(tr("This is not a .procp package (it is empty)"));
  // Check the CRC of every entry first, then touch the arrangement and media: if one is bad, the whole bundle is not read and no media is stored
  const bodies = new Map<ReadEntry, Blob>();
  for (const e of entries) {
    if (e === proc || e.name.startsWith(MEDIA_PREFIX)) bodies.set(e, await inflate(e));
  }
  const procText = await bodies.get(proc)!.text();

  const media = entries.filter((e) => e.name.startsWith(MEDIA_PREFIX) && e !== proc);
  const hashOf = (name: string) => name.slice(MEDIA_PREFIX.length).split(".")[0].toLowerCase();
  const have = await alreadyLocal(media.map((e) => hashOf(e.name)).filter((h) => /^[0-9a-f]{64}$/.test(h)));

  let stored = 0;
  let deduped = 0;
  const landed = new Set<string>();
  for (const entry of media) {
    const hash = hashOf(entry.name);
    if (have.has(hash)) { deduped += 1; landed.add(hash); continue; }
    const name = entry.name.slice(MEDIA_PREFIX.length);
    try {
      const body = bodies.get(entry)!;
      const res = await fetch(`/api/media/upload/${encodeURIComponent(name)}`, { method: "POST", body });
      if (!res.ok) { console.warn(`[procp] Failed to store asset: ${name}`); continue; }
      const data = await res.json();
      if (data?.deduped) deduped += 1; else stored += 1;
      if (typeof data?.hash === "string") landed.add(data.hash.toLowerCase());
    } catch (err) {
      console.warn(`[procp] Error storing asset: ${name}`, err);
    }
  }
  return { procText, stored, deduped, landed: [...landed] };
}

/**
 * For media that has bytes in the bundle, drop the `path` from the machine that did the packing.
 *
 * `path` is the absolute path of the media in the **packer's** local content store and points to
 * nothing on another machine; and on the export side (`server/vite-plugin-export.ts`), on seeing
 * `path` the address is rewritten to `/api/media/file?path=…`, so opening the bundle and exporting
 * on another machine would read a file that does not exist (video decode fails, voiceover is
 * silent). Since the bytes have already landed in this machine's content store by hash, this media
 * only needs `/@media/<hash>`.
 * Media not in the bundle (already missing at packing time) is left as is, and restoreMediaUrls
 * handles it the usual way.
 */
export function dropPackedPaths(project: Project, landed: Iterable<string>): Project {
  const have = new Set([...landed].map((h) => String(h).toLowerCase()));
  if (!have.size || !project.media?.length) return project;
  let changed = false;
  const media = project.media.map((m) => {
    if (!m.path || !have.has(String(m.hash || "").toLowerCase())) return m;
    changed = true;
    const { path: _drop, ...rest } = m;
    void _drop;
    return rest as typeof m;
  });
  return changed ? { ...project, media } : project;
}

/** Unpack and load (same path as opening a .proc; media addresses are restored by hash via restoreMediaUrls) */
export async function loadProcpFile(file: Blob): Promise<Project> {
  const { procText, landed } = await unpackProcp(file);
  const { loadProc } = await import("./proc.ts");
  return dropPackedPaths(loadProc(procText), landed);
}
