/**
 * 在线页面算一张同步卡的代码身份(`docs/plan/online-card-exec-contract.md` 第 5 节):与桌面 `cardCodeIdentity`
 * (`server/vite-plugin-cards.ts`)同一算法(共用 `src/render/cardCodeIdentity.mjs`),算出同一个值。
 * 任务的 `requires.cardSources` 写的是它,节点报的 `cardSourceVersions` 也是它。
 *
 * 闭包里的文件两个来源:
 *   - 内容库同步来的(`src/cards/user/` 下):内容哈希直接用内容库给的(与桌面 `sourceHash` 同一算法);
 *   - 页面自带的内置卡片 / 部件文件:页面有它们的原文(`builtinCardSourceFiles`),这里现算
 *     `sha256(JSON.stringify(换行统一成 LF 的原文))`。
 * 桌面端改过、页面自带的又是没改的那种内置文件,两端的哈希不同,身份就不同:浏览器节点不认领那张卡的任务
 * (范围说明见契约第 2 节)。
 */
import { CARD_CODE_ID_HEX, cardCodePreimage, importClosureOf } from "../../render/cardCodeIdentity.mjs";

export interface CodeIdentityFiles {
  /** 内容库同步来的:键 → 正文与哈希 */
  synced: (key: string) => { body: string; hash: string } | null;
  /** 页面自带的内置源码原文(仓库相对路径,不带开头的 `/`);没有回 null */
  builtin: (path: string) => string | null;
}

type Sha256Hex = (text: string) => Promise<string>;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const subtleSha256: Sha256Hex = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** 与内容库、桌面 `sourceHash` 同一算法 */
export async function sourceHashOf(source: string, sha256: Sha256Hex = subtleSha256): Promise<string> {
  return sha256(JSON.stringify(String(source).replace(/\r\n/g, "\n")));
}

/**
 * 一张卡的代码身份与闭包。`entry` 是入口文件的键。入口读不到回 null。
 * `builtinHashes` 是内置文件哈希的缓存(路径 → 哈希),调用方跨卡复用。
 */
export async function cardCodeIdentityOf(
  entry: string, files: CodeIdentityFiles, { sha256 = subtleSha256, builtinHashes = new Map<string, string>() }: { sha256?: Sha256Hex; builtinHashes?: Map<string, string> } = {},
): Promise<{ version: string; files: string[] } | null> {
  if (!files.synced(entry)) return null;
  const read = (rel: string) => files.synced(rel)?.body ?? files.builtin(rel);
  const closure = importClosureOf(entry, { read, isFile: (rel: string) => read(rel) != null });
  const hashes = new Map<string, string | null>();
  for (const rel of closure) {
    const s = files.synced(rel);
    if (s) { hashes.set(rel, s.hash || await sourceHashOf(s.body, sha256)); continue; }
    const text = files.builtin(rel);
    if (text == null) { hashes.set(rel, null); continue; }
    let h = builtinHashes.get(rel);
    if (!h) { h = await sourceHashOf(text, sha256); builtinHashes.set(rel, h); }
    hashes.set(rel, h);
  }
  const digest = await sha256(cardCodePreimage(closure, (rel: string) => hashes.get(rel) ?? null));
  return { version: digest.slice(0, CARD_CODE_ID_HEX), files: closure };
}
