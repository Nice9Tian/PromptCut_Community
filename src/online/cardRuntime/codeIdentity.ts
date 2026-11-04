/**
 * The online page computes the code identity of a synced card (`docs/plan/online-card-exec-contract.md`
 * section 5): it uses the same algorithm as the desktop `cardCodeIdentity` (`server/vite-plugin-cards.ts`)
 * (shared via `src/render/cardCodeIdentity.mjs`) and produces the same value.
 * The task's `requires.cardSources` carries it, and so does the `cardSourceVersions` reported by the node.
 *
 * The files in the closure come from two sources:
 *   - synced from the content store (under `src/cards/user/`): the content hash is the one the content
 *     store provides (the same algorithm as the desktop `sourceHash`);
 *   - built-in card / part files bundled with the page: the page has their original text
 *     (`builtinCardSourceFiles`), so the hash is computed here as
 *     `sha256(JSON.stringify(original text with newlines normalized to LF))`.
 * For a built-in file that was modified on the desktop but is unmodified in the page, the hashes on the
 * two sides differ, so the identities differ: the browser node does not claim tasks for that card
 * (see section 2 of the contract for the scope).
 */
import { CARD_CODE_ID_HEX, cardCodePreimage, importClosureOf } from "../../render/cardCodeIdentity.mjs";

export interface CodeIdentityFiles {
  /** Synced from the content store: key → text and hash */
  synced: (key: string) => { body: string; hash: string } | null;
  /** Original text of built-in source bundled with the page (repo-relative path, without the leading `/`); null if none */
  builtin: (path: string) => string | null;
}

type Sha256Hex = (text: string) => Promise<string>;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const subtleSha256: Sha256Hex = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** Same algorithm as the content store and the desktop `sourceHash` */
export async function sourceHashOf(source: string, sha256: Sha256Hex = subtleSha256): Promise<string> {
  return sha256(JSON.stringify(String(source).replace(/\r\n/g, "\n")));
}

/**
 * Code identity and closure of a card. `entry` is the entry file key; returns null if unreadable.
 * `builtinHashes` is a cache of built-in file hashes (path → hash), reused by callers across cards.
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
