/** Sealed hand-off of probe secrets between task-owned machines.
 * The receiver publishes an X25519 public key; the sender returns ciphertext only, so
 * cross-session messages and the mailbox carry public keys and sealed text, never a password.
 * A sealed text proves nothing about its sender; it only keeps the content from the relays.
 *
 *   node scripts/probes/reopen-sealed.mjs keygen --dir <owned dir>     private key stays in <dir>/seal-private.key
 *   node scripts/probes/reopen-sealed.mjs member-secret --dir <owned dir> --to <receiver public key> --username <name>
 *     generates a member password, keeps it in <dir>/member-secret.json and prints only the sealed text
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

const KIND = 'promptcut-reopen-sealed-v1', PREFIX = 'pcs1.';
const text = bytes => Buffer.from(bytes).toString('base64url');
const bytes = value => Buffer.from(String(value), 'base64url');
const publicKeyOf = value => createPublicKey({ key: bytes(value), format: 'der', type: 'spki' });
const sharedKey = (privateKey, publicKey, salt) =>
  Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), salt, Buffer.from(KIND), 32));

export function generateSealKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: text(publicKey.export({ format: 'der', type: 'spki' })), privateKey: text(privateKey.export({ format: 'der', type: 'pkcs8' })) };
}

/** @returns one line of text that is safe to relay */
export function seal(receiverPublicKey, value) {
  const ephemeral = generateKeyPairSync('x25519'), salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sharedKey(ephemeral.privateKey, publicKeyOf(receiverPublicKey), salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const blob = { kind: KIND, ephemeral: text(ephemeral.publicKey.export({ format: 'der', type: 'spki' })), salt: text(salt), iv: text(iv), tag: text(cipher.getAuthTag()), data: text(data) };
  return PREFIX + text(JSON.stringify(blob));
}

export function unseal(receiverPrivateKey, sealed) {
  if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) throw new Error('unsupported sealed text');
  let blob;
  try { blob = JSON.parse(bytes(sealed.slice(PREFIX.length)).toString('utf8')); } catch { throw new Error('unsupported sealed text'); }
  if (blob?.kind !== KIND) throw new Error('unsupported sealed text');
  try {
    const privateKey = createPrivateKey({ key: bytes(receiverPrivateKey), format: 'der', type: 'pkcs8' });
    const decipher = createDecipheriv('aes-256-gcm', sharedKey(privateKey, publicKeyOf(blob.ephemeral), bytes(blob.salt)), bytes(blob.iv));
    decipher.setAuthTag(bytes(blob.tag));
    return JSON.parse(Buffer.concat([decipher.update(bytes(blob.data)), decipher.final()]).toString('utf8'));
  } catch { throw new Error('sealed text could not be opened; contents withheld'); }
}

const ownedFile = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); return path.join(dir, name); };
/** Private material stays in the caller's owned directory; only the public half is returned. */
export function ownedSealKeys(dir) {
  const file = ownedFile(dir, 'seal-private.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, generateSealKeys().privateKey, { mode: 0o600, flag: 'wx' });
  const privateKey = fs.readFileSync(file, 'utf8').trim();
  const publicKey = text(createPublicKey(createPrivateKey({ key: bytes(privateKey), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }));
  return { publicKey, privateKey };
}
/** A member chooses its own password, keeps it locally and hands the host a sealed copy. */
export function ownedMemberSecret(dir, username) {
  const file = ownedFile(dir, 'member-secret.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ username, password: randomBytes(32).toString('base64url') }), { mode: 0o600, flag: 'wx' });
  const secret = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (secret.username !== username) throw new Error('owned member secret belongs to another username');
  return secret;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const dir = arg('--dir');
  if (!dir) throw new Error('--dir <owned directory> is required');
  if (process.argv[2] === 'keygen') console.log(JSON.stringify({ publicKey: ownedSealKeys(dir).publicKey }));
  else if (process.argv[2] === 'member-secret') {
    const username = arg('--username'), to = arg('--to');
    if (!username || !to) throw new Error('--username and --to <receiver public key> are required');
    console.log(JSON.stringify({ username, sealed: seal(to, ownedMemberSecret(dir, username)) }));
  } else throw new Error('usage: reopen-sealed.mjs keygen|member-secret --dir <owned directory>');
}
