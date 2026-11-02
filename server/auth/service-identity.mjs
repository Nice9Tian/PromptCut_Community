/**
 * Host service identity (contract `docs/plan/hosted-render-contract.md` Section 1).
 *
 * Services run by the host on cloud nodes (render service; future Agent service) each have an
 * Ed25519 keypair:
 * - **Registry** (read by document service): `<hosted-data-dir>/secrets/services.json`, contains
 *   only public keys, and connection roles obtainable by services are also written here;
 *   `{ v: 1, services: { <service-name>: { role, actsFor?, keys: [{ kid, alg: 'ed25519', pub, addedAt }] } } }`;
 *   `actsFor`: `'self'` (default; service enters project under its own identity, not a member,
 *   e.g. render service) or `'member'` (service enters project on behalf of a member; ticket's
 *   `u` and `ug` belong to member, handshake checks member list and ban list, e.g. Cloud Agent
 *   service). Handshake branches on this property without hardcoding service names;
 * - **Private key file** (read by service itself): `<private-key-dir>/service-key.json`,
 *   `{ v: 1, service, kid, alg: 'ed25519', priv: <PKCS#8 DER base64url>, instanceId, instanceName }`.
 *
 * This module provides: key generation and signature verification, reading of registry (with
 * reload based on file modification time) and modification (adding/revoking public keys, atomic
 * write), reading and writing of private key files, server-side determination of "whether this
 * service can be in this project at this moment" via `serviceAdmission`, and assembling handshake
 * subprotocols on the service side via `buildServiceProtocols`.
 *
 * Private keys, signatures, and `nonce` do not enter any logs or error messages. Uses only Node
 * built-in modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import {
  PROTOCOL, SERVICE_PREFIX, ROLES, b64urlDecode, isServiceName, isDeviceId, isDeviceName, servicePurpose,
} from './protocol.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';

export const SERVICES_FILE = 'services.json';
export const SERVICE_KEY_FILE = 'service-key.json';
export const SERVICE_ALG = 'ed25519';
/** Number of bytes in Ed25519 signature */
export const SERVICE_SIG_BYTES = 64;
/** Whose identity the service uses when entering the project */
export const ACTS_FOR = Object.freeze(['self', 'member']);
/** Services with project-level toggles (project record `hosted: { <service-name>: { enabled } }`, missing counts as enabled). Other services can exist in registry; they have no toggles */
export const HOSTED_SERVICES = Object.freeze(['render', 'agent']);
/**
 * Sub-options under a service (project record `hosted.<service-name>.<option-name>`, boolean,
 * missing counts as disabled, only counts as enabled when explicitly `true`; contract
 * `docs/plan/hosted-render-contract.md` Section 3.1). Currently only `streams` for render nodes
 * (generates track streams for this project). This only records and notifies; whether the render
 * service checks it when claiming tasks is not managed here.
 */
export const HOSTED_OPTIONS = Object.freeze({ render: Object.freeze(['streams']), agent: Object.freeze([]) });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KID_RE = /^[A-Za-z0-9_-]{8}$/;

function bad(code, detail) {
  const err = new Error(detail ?? code);
  err.code = code;
  return err;
}

/** Public key id: first 8 base64url characters of raw 32-byte sha256 */
export const kidOfPublic = (pub) => createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('base64url').slice(0, 8);

/** Raw 32-byte public key (base64url) → KeyObject */
export function publicKeyOf(pub) {
  const raw = b64urlDecode(pub);
  if (!raw || raw.length !== 32) throw bad('bad-service-key', 'The public key must be 32 bytes base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

/** Newly generated pair: `{ kid, pub, priv }`, `pub` is raw 32 bytes, `priv` is PKCS#8 DER, both base64url */
export function generateServiceKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  return { kid: kidOfPublic(pub), pub, priv };
}

/** Service handshake signature (base64url) */
export function signServiceProof(priv, { service, deviceId, nonce }) {
  const key = createPrivateKey({ key: Buffer.from(priv, 'base64url'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(servicePurpose({ service, deviceId, nonce })), key).toString('base64url');
}

/** Verifies service handshake signature; returns false on any format issue */
export function verifyServiceProof(pub, { service, deviceId, nonce }, m) {
  try {
    const sig = b64urlDecode(m);
    if (!sig || sig.length !== SERVICE_SIG_BYTES) return false;
    return verify(null, Buffer.from(servicePurpose({ service, deviceId, nonce })), publicKeyOf(pub), Buffer.from(sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Registry

/** Validates and normalizes registry content; throws `code: 'bad-services-file'` if invalid */
export function parseRegistry(json) {
  if (!isObj(json) || json.v !== 1 || !isObj(json.services)) throw bad('bad-services-file', 'The registry must be { v: 1, services: {…} }');
  const services = {};
  for (const [name, entry] of Object.entries(json.services)) {
    if (!isServiceName(name)) throw bad('bad-services-file', `Invalid service name: ${name}`);
    if (!isObj(entry) || !ROLES.includes(entry.role) || !Array.isArray(entry.keys)) throw bad('bad-services-file', `Service ${name} needs { role, keys: […] }`);
    const actsFor = entry.actsFor ?? 'self';
    if (!ACTS_FOR.includes(actsFor)) throw bad('bad-services-file', `actsFor of service ${name} must be one of ${ACTS_FOR.join(' / ')}`);
    const keys = [];
    for (const k of entry.keys) {
      if (!isObj(k) || k.alg !== SERVICE_ALG || typeof k.pub !== 'string' || typeof k.kid !== 'string' || !KID_RE.test(k.kid)) {
        throw bad('bad-services-file', `Invalid public key entry for service ${name}`);
      }
      const raw = b64urlDecode(k.pub);
      if (!raw || raw.length !== 32 || kidOfPublic(k.pub) !== k.kid) throw bad('bad-services-file', `Public key of service ${name} does not match its kid`);
      if (keys.some((x) => x.kid === k.kid)) throw bad('bad-services-file', `Duplicate kid for service ${name}`);
      keys.push({ kid: k.kid, alg: SERVICE_ALG, pub: k.pub, addedAt: Number.isFinite(k.addedAt) ? k.addedAt : 0 });
    }
    services[name] = { role: entry.role, actsFor, keys };
  }
  return { v: 1, services };
}

/** Strictly reads registry file: returns empty table if absent; throws if unreadable or invalid */
export function readRegistryFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { v: 1, services: {} };
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw bad('bad-services-file', 'The registry is not valid JSON');
  }
  return parseRegistry(json);
}

let tmpSeq = 0;
function writeAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${(tmpSeq += 1)}`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* Not created */ }
    throw err;
  }
}

/** Adds a public key to the registry (creates service if absent); throws `code: 'role-conflict'` if role or `actsFor` differs from existing. Returns whether newly added */
export function addServiceKey(file, { service, role, actsFor = 'self', kid, pub, at = Date.now() }) {
  if (!isServiceName(service)) throw bad('bad-service-name', 'Service name must be 1-32 characters of [a-z0-9-]');
  if (!ROLES.includes(role)) throw bad('bad-role', `role must be one of ${ROLES.join(' / ')}`);
  if (kidOfPublic(pub) !== kid) throw bad('bad-service-key', 'Public key does not match kid');
  const reg = readRegistryFile(file);
  if (!ACTS_FOR.includes(actsFor)) throw bad('bad-acts-for', `actsFor must be one of ${ACTS_FOR.join(' / ')}`);
  const entry = reg.services[service] ?? { role, actsFor, keys: [] };
  if (entry.role !== role || entry.actsFor !== actsFor) throw bad('role-conflict', `Service ${service} is already registered as ${entry.role} / ${entry.actsFor}`);
  if (entry.keys.some((k) => k.kid === kid)) return false;
  entry.keys.push({ kid, alg: SERVICE_ALG, pub, addedAt: at });
  reg.services[service] = entry;
  writeAtomic(file, `${JSON.stringify(reg, null, 2)}\n`);
  return true;
}

/** Revokes a public key; removes entire service entry when no keys remain. Returns whether revoked */
export function retireServiceKey(file, { service, kid }) {
  const reg = readRegistryFile(file);
  const entry = reg.services[service];
  if (!entry || !entry.keys.some((k) => k.kid === kid)) return false;
  entry.keys = entry.keys.filter((k) => k.kid !== kid);
  if (entry.keys.length === 0) delete reg.services[service];
  writeAtomic(file, `${JSON.stringify(reg, null, 2)}\n`);
  return true;
}

/**
 * Registry on the document service side: reads from memory, reloads based on file modification
 * time (rotating or revoking keys does not require restarting the document service). Returns empty
 * table if file does not exist; treated as empty table if unreadable or invalid (fail-closed:
 * nobody can enter), logging a `services.registry-error`.
 * @param {object} options
 * @param {string} options.file
 * @param {() => number} [options.now]
 * @param {number} [options.minCheckMs] Minimum interval between checking file modification time,
 *   defaults to 1 s
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createServiceRegistry({ file, now = Date.now, minCheckMs = 1000, log = () => {} } = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createServiceRegistry: file must be a non-empty string');
  let services = {};
  let stamp = null;
  let checkedAt = -Infinity;
  let version = 0;

  const stampOf = () => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return 'absent';
    }
  };

  function load() {
    const next = stampOf();
    if (next === stamp) return false;
    stamp = next;
    let parsed = { services: {} };
    try {
      parsed = readRegistryFile(file);
    } catch (err) {
      log('services.registry-error', { reason: String(err?.code ?? 'read') });
    }
    services = parsed.services;
    version += 1;
    log('services.registry', { services: Object.fromEntries(Object.entries(services).map(([n, e]) => [n, { role: e.role, actsFor: e.actsFor, kids: e.keys.map((k) => k.kid) }])) });
    return true;
  }
  load();

  /** Checks the file when it is time to check; returns true if changed */
  function refresh({ force = false } = {}) {
    const at = now();
    if (!force && at - checkedAt < minCheckMs) return false;
    checkedAt = at;
    return load();
  }

  return {
    file,
    refresh,
    /** Registry entry for this service `{ role, keys }`; returns null if absent */
    get(name) {
      refresh();
      return Object.hasOwn(services, name) ? services[name] : null;
    },
    /** Whether this public key for this service still exists */
    has(name, kid) {
      const entry = this.get(name);
      return !!entry && entry.keys.some((k) => k.kid === kid);
    },
    /** Entry for this public key; returns null if absent */
    keyOf(name, kid) {
      const entry = this.get(name);
      return entry?.keys.find((k) => k.kid === kid) ?? null;
    },
    names: () => Object.keys(services),
    get version() { return version; },
  };
}

// ---------------------------------------------------------------- Project admission

/** Project toggle for this service: project record's `hosted.<service-name>.enabled`, missing counts as enabled */
export function serviceEnabled(record, service) {
  return record?.hosted?.[service]?.enabled !== false;
}

/**
 * A sub-option for this project: project record's `hosted.<service-name>.<option-name>`, **missing
 * counts as disabled**, only counts as enabled when explicitly `true` (opposite of the service's own
 * toggle: missing service toggle counts as enabled. (user decision, 2026-10-12): track streams are
 * not generated by default to save cloud resources; creators who want them must enable them).
 */
export function hostedOptionEnabled(record, service, option) {
  return record?.hosted?.[service]?.[option] === true;
}

/**
 * `hosted` at top level of member lists and in catalog entries: one `{ available, enabled }` entry
 * for each service with a toggle. `available`: service exists in registry; `enabled`: toggle for
 * this project. Render nodes additionally carry `streams` (sub-option "generate track streams",
 * default off).
 */
export function hostedStateOf(registry, record) {
  const out = {};
  for (const name of HOSTED_SERVICES) {
    out[name] = { available: !!registry?.get(name), enabled: serviceEnabled(record, name) };
    for (const option of HOSTED_OPTIONS[name]) out[name][option] = hostedOptionEnabled(record, name, option);
  }
  return out;
}

/**
 * Whether this service can be in this project at this moment (queried during handshake, resume,
 * per-message, ticket acquisition, and asset ticket verification). Returns null if permitted, or
 * reason if not: `service-revoked` (this public key is no longer in the registry, or role has
 * changed), `no-project`, `relocating` / `relocated`, `service-disabled`.
 */
export function serviceAdmission({ registry, record, service, kid, role }) {
  const entry = registry ? registry.get(service) : null;
  if (!entry || !entry.keys.some((k) => k.kid === kid)) return 'service-revoked';
  if (role !== undefined && role !== null && entry.role !== role) return 'service-revoked';
  if (!record) return 'no-project';
  const unavailable = roomUnavailableReason(record);
  if (unavailable) return unavailable;
  if (!serviceEnabled(record, service)) return 'service-disabled';
  return null;
}

// ---------------------------------------------------------------- Private key file (service side)

/** New instanceId: 22 base64url characters */
export const newInstanceId = () => randomBytes(16).toString('base64url');

/** Writes private key file `<dir>/service-key.json` (directory 0700, file 0600). Returns file path */
export function writeServiceKeyFile(dir, { service, kid, priv, instanceId, instanceName }) {
  if (!isServiceName(service) || !isDeviceId(instanceId) || !isDeviceName(instanceName)) throw bad('bad-service-key', 'Invalid fields in the private key file');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const file = path.join(dir, SERVICE_KEY_FILE);
  writeAtomic(file, `${JSON.stringify({ v: 1, service, kid, alg: SERVICE_ALG, priv, instanceId, instanceName }, null, 2)}\n`);
  return file;
}

/**
 * Reads private key file (accepts either the file or its directory). Throws `code: 'service-key'`
 * if missing, invalid format, or permissions wider than 0600 (checked on POSIX only); the error
 * message does not contain the private key.
 */
export function readServiceKeyFile(fileOrDir) {
  let file = fileOrDir;
  try {
    if (fs.statSync(fileOrDir).isDirectory()) file = path.join(fileOrDir, SERVICE_KEY_FILE);
  } catch { /* Reported when reading below */ }
  let json;
  try {
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) throw bad('service-key', 'Private key file permissions are wider than 0600');
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'service-key') throw err;
    throw bad('service-key', `Cannot read the private key file (${err?.code ?? 'bad-json'})`);
  }
  if (!isObj(json) || json.v !== 1 || json.alg !== SERVICE_ALG || !isServiceName(json.service) || typeof json.kid !== 'string'
    || typeof json.priv !== 'string' || !isDeviceId(json.instanceId) || !isDeviceName(json.instanceName)) {
    throw bad('service-key', 'Invalid private key file format');
  }
  return { service: json.service, kid: json.kid, priv: json.priv, instanceId: json.instanceId, instanceName: json.instanceName };
}

/** `ws(s)://…` / `http(s)://…` → http base URL of the shared endpoint (strip trailing `/`) */
function httpBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Service side: fetch a challenge and construct handshake subprotocols
 * `[promptcut.v1, promptcut.service.<…>]`. Called once for each new session (`nonce` is single-use).
 * @param {object} options
 * @param {string} options.base Document service address (`ws://127.0.0.1:8787`)
 * @param {{ service, kid, priv, instanceId, instanceName }} options.key Result of `readServiceKeyFile`
 * @param {typeof globalThis.fetch} [options.fetch]
 */
export async function buildServiceProtocols({ base, key, fetch: fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${httpBaseOf(base)}/shared/service-challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: key.service, deviceId: key.instanceId }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || typeof body?.nonce !== 'string') throw bad('service-challenge', `Failed to get the service challenge (${res.status})`);
  const m = signServiceProof(key.priv, { service: key.service, deviceId: key.instanceId, nonce: body.nonce });
  const json = { v: 1, s: key.service, kid: key.kid, d: key.instanceId, dn: key.instanceName, nonce: body.nonce, m };
  return [PROTOCOL, SERVICE_PREFIX + Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')];
}
