import type { Project } from "../../kernel/project";

/**
 * `.procp` —— 「编排 + 素材」的打包件。
 *
 * 结构:一个 zip,**第一个条目一定是 `project.proc`**(不解压也能 head 出编排),
 * 其余是 `media/<hash>.<原扩展名>` —— 名字就是内容哈希,所以同一份内容在包里只有一份,
 * 装包和拆包都天然去重。
 *
 * 为什么自己写 zip:项目里没有 zip 依赖(package.json 里一个都没有),而这里要的东西
 * 很小 —— 素材(mp4 / jpg / mp3)本来就是压过的,再 deflate 一遍只费 CPU 不省字节,
 * 所以写的时候一律 store(method 0),只有编排那一条文本也 store(几十 KB)。
 * 读的时候连别人用普通 zip 工具压出来的 deflate 条目一起认(DecompressionStream)。
 *
 * 全程走 Blob 不走 ArrayBuffer:几 GB 的素材由浏览器托管(可以落在磁盘上),
 * 页面只按块流过去算 CRC / 传给服务端,主线程不持有整份字节。
 *
 * **这个文件顶上只有类型 import**:zip 读写和装拆包都只用 Blob / fetch / DecompressionStream,
 * 编辑器那一侧(store、proc.ts 里的 React 依赖)只在最外面那两个薄包装里动态 import。
 * 于是 `node --test` 能直接加载它,zip 的字节格式有单测兜着(见 procp.test.mjs)。
 */

export const PROCP_EXT = ".procp";
const PROC_ENTRY = "project.proc";
const MEDIA_PREFIX = "media/";

/**
 * 包里某个条目的内容校验不通过时,给用户看的那句话(一级文字,用户尚未定稿)。
 * 任务书和设计里没有这句的原文,句式沿用读包失败的那一类(「这不是一个 .procp 包(…)」),
 * 草稿见 docs/reports/AGENT-v18-fixes.md「要用户定的事」。
 */
export const PROCP_DAMAGED_MESSAGE = ".procp 包已损坏(里面有条目的内容校验不通过),没有打开它";

/**
 * 这个文件是不是 .procp 包。
 *
 * 名字对不上也再看一眼头四个字节(`PK\x03\x04`)—— 用户可能把包改了名,
 * 而拿 `.text()` 去读一个几 GB 的 zip 只会把页面读死,所以必须在 read 之前就分流。
 */
export async function isProcpFile(file: Blob & { name?: string }): Promise<boolean> {
  if (typeof file?.name === "string" && file.name.toLowerCase().endsWith(PROCP_EXT)) return true;
  if (!file || file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/* ------------------------------ zip 基本件 ------------------------------ */

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

/** 流着算 CRC32:整份字节不进 JS 堆 */
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

/** store-only zip。条目顺序就是写进去的顺序 —— project.proc 排第一。单测直接用它验字节格式 */
export async function writeZip(entries: PackEntry[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const { time, date } = dosTime(new Date());
  let offset = 0;

  for (const entry of entries) {
    // 拷一份到自己的 ArrayBuffer:TextEncoder 给的视图类型上不保证不是 SharedArrayBuffer,Blob 不收
    const encoded = new TextEncoder().encode(entry.name);
    const name = new Uint8Array(encoded.length);
    name.set(encoded);
    const size = entry.blob.size;
    const crc = await crc32OfBlob(entry.blob);

    const local = bytes(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);   // version needed
    local.view.setUint16(6, 0x0800, true); // UTF-8 名字
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

/** 读中央目录。条目数据按 Blob 切出来,不整份读进内存。单测直接用它验字节格式 */
export async function readZip(file: Blob): Promise<ReadEntry[]> {
  const tailLen = Math.min(file.size, 66560); // 64 KiB + EOCD:够覆盖带注释的包
  const tail = new Uint8Array(await file.slice(file.size - tailLen, file.size).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("这不是一个 .procp 包(没找到 zip 目录)");
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
 * 条目的原始字节,并按中央目录里登记的 CRC32 核对。store 直接用,deflate 走浏览器自带的解压流
 * (别人用普通 zip 工具压的包也认)。内容对不上就抛 PROCP_DAMAGED_MESSAGE,不把改坏的字节交出去。
 * 解压流本身报错(deflate 数据坏)同样按包损坏处理。
 */
export async function inflate(entry: ReadEntry): Promise<Blob> {
  let body: Blob;
  if (entry.method === 0) body = entry.blob;
  else if (entry.method !== 8) throw new Error(`.procp 里有不认识的压缩方式(${entry.method}):${entry.name}`);
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

/* ------------------------------ 装包 / 拆包 ------------------------------ */

/** 进不了包的一条素材(补入库之后仍没有哈希,或内容库里取不到它的字节):调用方据此把名字列给用户 */
export interface PackMissing { id: string; name: string }

/**
 * 项目里每条素材的 <hash>.<ext>(按哈希去重),以及**没有合法哈希、因此装不进包的条目**。
 * 没哈希的不许悄悄跳过:它们一律出现在 `unhashed` 里,由装包的返回值带给调用方(打包结束时提示用户)。
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
  /** 包里缺的素材(文件真的不在了):打包结束时把名字列给用户 */
  missing: PackMissing[];
}

/**
 * 当前项目 → .procp 包。
 *
 * 先把没有哈希、本机还取得到字节的老素材补入库(`ingestUnhashedMedia`,写回素材表),再序列化编排 ——
 * 包里的 `project.proc` 因此也带哈希,对面按哈希还原。素材从本地内容库按 /@media/<hash> 取回来装进去;
 * 取不到的那条不让它毁掉整次打包,但一定出现在返回值的 `missing` 里。
 */
export async function packProcp(): Promise<PackResult> {
  await (await import("../sync/syncManager")).whenSaved();
  const { ingestUnhashedMedia } = await import("./mediaUpload.ts");
  await ingestUnhashedMedia();
  await (await import("../sync/syncManager")).whenSaved();
  const { serializeProc } = await import("./proc.ts");
  const { getState } = await import("../../store/project.ts");
  // 桌面:本地内容库的 /@media/<hash>;在线页面:远程素材服务上的原尺寸(带只读票据),还没就绪给 ""(跳过)
  const { originalMediaUrl } = await import("../../render/mediaTier");
  return packProcpFrom(serializeProc(), getState().project, (hash) => originalMediaUrl({ url: `/@media/${hash}`, hash }));
}

/**
 * 装包本体。和 store 分开是为了能单测(见 procp.test.mjs)—— 它只认一份编排文本
 * 和一份 Project,素材从 /@media/<hash> 取。
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
      if (!url) console.warn(`[procp] 素材服务还没就绪,跳过 ${hash}`);
      else {
        const res = await fetch(url);
        if (!res.ok) console.warn(`[procp] 本地内容库里没有 ${hash},跳过`);
        else { entries.push({ name: MEDIA_PREFIX + file, blob: await res.blob() }); ok = true; }
      }
    } catch (err) {
      console.warn(`[procp] 取素材失败 ${hash}`, err);
    }
    if (!ok) for (const id of ids) missing.push({ id, name: nameOf.get(id) ?? "" });
  }
  if (missing.length) console.warn("[procp] 这些素材没进包:", missing.map((m) => m.name));
  return { blob: await writeZip(entries), missing };
}

/** 打包结束时给用户的那句话:包里缺哪些素材(名字去重,太多时只列前面若干条) */
export function packMissingMessage(missing: readonly PackMissing[], limit = 12): string {
  const names = [...new Set(missing.map((m) => (m.name || m.id).replace(/^\(缺失\) /, "")))];
  if (!names.length) return "";
  const shown = names.slice(0, limit).map((n) => `· ${n}`).join("\n");
  const more = names.length > limit ? `\n……另有 ${names.length - limit} 条` : "";
  return `包已保存，但下面 ${names.length} 条素材本机找不到文件，没有装进包里（换台机器打开这个包，这些素材放不出来）：\n${shown}${more}`;
}

/** 这些哈希里哪些已经在本地内容库(拆包时用来跳过已有素材) */
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
  /** 这次真正写进内容库的素材数 */
  stored: number;
  /** 库里已经有、跳过的素材数 */
  deduped: number;
  /** 这个包带来的、现在确实在本地内容库里的素材哈希(新写的 + 本来就有的) */
  landed: string[];
}

/**
 * 拆包:素材落进本地内容库(按哈希去重,库里已有的一份字节都不传),编排原样返回。
 *
 * 落库走的还是 `/api/media/upload/<名字>` —— 服务端照样边落盘边算哈希,所以包里
 * 条目名写错了也污染不了内容库(它会落在自己**真正**的哈希下)。
 */
export async function unpackProcp(file: Blob): Promise<UnpackResult> {
  const entries = await readZip(file);
  const proc = entries.find((e) => e.name === PROC_ENTRY) || entries[0];
  if (!proc) throw new Error("这不是一个 .procp 包(里面是空的)");
  // 先把每个条目都核一遍 CRC,再碰编排和素材:有一条坏就整个包不读,不落任何素材
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
      if (!res.ok) { console.warn(`[procp] 素材落库失败: ${name}`); continue; }
      const data = await res.json();
      if (data?.deduped) deduped += 1; else stored += 1;
      if (typeof data?.hash === "string") landed.add(data.hash.toLowerCase());
    } catch (err) {
      console.warn(`[procp] 素材落库异常: ${name}`, err);
    }
  }
  return { procText, stored, deduped, landed: [...landed] };
}

/**
 * 包里带着字节的素材,去掉打包那台机器上的 `path`。
 *
 * `path` 是素材在**打包方**本地内容库里的绝对路径,换一台机器就指不到东西;而导出那一侧
 * (`server/vite-plugin-export.ts`)见到 `path` 就把地址改写成 `/api/media/file?path=…`,
 * 于是在另一台机器上打开包、导出,会去读一个不存在的文件(视频解码失败、配音静音)。
 * 字节既然已经按哈希落进本机内容库,这些素材只认 `/@media/<hash>` 就够了。
 * 不在包里的素材(打包时就缺的)原样留着,由 restoreMediaUrls 照老规矩处理。
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

/** 拆包并载入(和打开 .proc 走同一条路,素材地址由 restoreMediaUrls 按 hash 还原) */
export async function loadProcpFile(file: Blob): Promise<Project> {
  const { procText, landed } = await unpackProcp(file);
  const { loadProc } = await import("./proc.ts");
  return dropPackedPaths(loadProc(procText), landed);
}
