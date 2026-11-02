/**
 * Machine code.
 *
 * When distributing API configs, the receiver first sends this code to the distributor, who
 * encrypts using it as a passphrase; the receiver's software then computes the same code locally to
 * decrypt. Thus ciphertext can only be decrypted on that machine, and forwarding it to others is
 * useless.
 *
 * Uses only machine-level identifiers without mixing in usernames: logging in with a different
 * account is still the same machine, and the code should not change. The raw fingerprint never
 * leaves this module; only the digested code is provided externally.
 */
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/** Crockford Base32: removes I, L, O, U, avoiding copying mixups between 0/O and 1/I/L */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Number of characters in the code (groups of 5). 20 chars = 100 bits, enough to resist
 * collisions and guessing
 */
const CODE_LEN = 20;

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * Network card MAC fallback: exclude loopback and all-zeros, sort and concatenate so changes in
 * enumeration order do not affect it
 */
function macAddresses() {
  const macs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (!net.internal && net.mac && net.mac !== "00:00:00:00:00:00") macs.push(net.mac);
    }
  }
  return [...new Set(macs)].sort().join(",");
}

/**
 * Get the most stable identifier for this machine. If unavailable, fall back to
 * "hostname + platform + arch + NIC", which is less stable (changes when replacing NIC), but at
 * least will not fail to compute.
 */
export function machineFingerprint() {
  if (process.platform === "win32") {
    const out = run("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
      "/reg:64",
    ]);
    const hit = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    if (hit) return `win:${hit[1]}`;
  } else if (process.platform === "darwin") {
    const out = run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const hit = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (hit) return `mac:${hit[1]}`;
  } else {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = fs.readFileSync(path, "utf8").trim();
        if (id) return `linux:${id}`;
      } catch {}
    }
  }
  return `fallback:${os.hostname()}|${process.platform}|${os.arch()}|${macAddresses()}`;
}

/**
 * External machine code, formatted like PCM-4K7QX-… (4 groups of 5 chars).
 *
 * This code string is the encryption passphrase. Normalization (stripping delimiters, correcting
 * lookalike characters) is done browser-side in src/ai/configShare.ts: both encryption and
 * decryption use that same logic, preventing algorithms on the two sides from diverging.
 */
export function machineCode(fingerprint = machineFingerprint()) {
  const digest = createHash("sha256").update(`PromptCut-machine-v1|${fingerprint}`).digest();
  const code = base32(digest).slice(0, CODE_LEN);
  return `PCM-${code.match(/.{1,5}/g).join("-")}`;
}

/**
 * Redacted identifier, shaped like PCM-4K7QX-….
 *
 * Diagnostic reports are sent to us, and this string **is** the decryption passphrase for
 * configuration distribution; writing the whole string in would be equivalent to giving away a key.
 * The first group of 5 characters = 25 bits of entropy, which is enough to identify which machine
 * it is among dozens of machines, yet far from enough to reverse-engineer the full passphrase.
 */
export function redactMachineCode(code = machineCode()) {
  const head = String(code).split("-").slice(0, 2).join("-");
  return `${head}-…`;
}
