/**
 * 纯 JS 的 SHA-256、HMAC-SHA256、PBKDF2-HMAC-SHA256（契约 `docs/plan/auth-contract.md` 第 2 节）。
 *
 * 给没有 `crypto.subtle` 的页面兜底：明文 http 打开的远端页面不是安全上下文（C10 才会遇到）。
 * 有 WebCrypto 或 `node:crypto` 的地方不用它。正确性以 `node:crypto` 对拍（`server/test/auth-impl-crypto.test.mjs`）。
 *
 * 不引任何模块。输入输出都是 `Uint8Array`。
 * PBKDF2 的每一轮只做两次压缩：HMAC 的内外两层在 ipad / opad 那一块之后的状态预先算好，
 * 每轮的输入恰好 32 字节，补位后正好一块。
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

/** 一块（16 个大端字，放在 w[0..15]）压缩进 state；w 要有 64 个字的空间 */
function compress(state, w) {
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = state[0]; let b = state[1]; let c = state[2]; let d = state[3];
  let e = state[4]; let f = state[5]; let g = state[6]; let h = state[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0; state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0; state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
}

function loadBlock(w, bytes, offset) {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
  }
}

function stateBytes(state) {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = state[i] >>> 24;
    out[i * 4 + 1] = (state[i] >>> 16) & 255;
    out[i * 4 + 2] = (state[i] >>> 8) & 255;
    out[i * 4 + 3] = state[i] & 255;
  }
  return out;
}

/**
 * 从给定状态继续哈希 `data`，此前已处理了 `prefixBytes` 个字节（必须是 64 的倍数）。回 32 字节摘要。
 */
function finish(startState, data, prefixBytes) {
  const state = new Int32Array(startState);
  const w = new Int32Array(64);
  const total = prefixBytes + data.length;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const bits = total * 8;
  // 长度写在最后 8 字节；安全整数范围内高位用除法取
  const hi = Math.floor(bits / 0x100000000);
  const lo = bits >>> 0;
  const end = padded.length;
  padded[end - 8] = hi >>> 24; padded[end - 7] = (hi >>> 16) & 255; padded[end - 6] = (hi >>> 8) & 255; padded[end - 5] = hi & 255;
  padded[end - 4] = lo >>> 24; padded[end - 3] = (lo >>> 16) & 255; padded[end - 2] = (lo >>> 8) & 255; padded[end - 1] = lo & 255;
  for (let off = 0; off < padded.length; off += 64) {
    loadBlock(w, padded, off);
    compress(state, w);
  }
  return stateBytes(state);
}

/** SHA-256 */
export function sha256(data) {
  return finish(IV, toBytes(data), 0);
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError('要 Uint8Array');
}

/** HMAC 的内外两层在 ipad / opad 那一块之后的状态 */
function hmacStates(key) {
  let k = toBytes(key);
  if (k.length > 64) k = sha256(k);
  const block = new Uint8Array(64);
  const w = new Int32Array(64);
  const inner = new Int32Array(IV);
  const outer = new Int32Array(IV);
  for (let i = 0; i < 64; i++) block[i] = (k[i] ?? 0) ^ 0x36;
  loadBlock(w, block, 0);
  compress(inner, w);
  for (let i = 0; i < 64; i++) block[i] = (k[i] ?? 0) ^ 0x5c;
  loadBlock(w, block, 0);
  compress(outer, w);
  return { inner, outer };
}

/** HMAC-SHA256 */
export function hmacSha256(key, data) {
  const { inner, outer } = hmacStates(key);
  return finish(outer, finish(inner, toBytes(data), 64), 64);
}

/**
 * PBKDF2-HMAC-SHA256。
 * @param {Uint8Array} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @param {number} length 输出字节数
 */
export function pbkdf2Sha256(password, salt, iterations, length) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new RangeError('iterations 必须是正整数');
  if (!Number.isSafeInteger(length) || length < 1) throw new RangeError('length 必须是正整数');
  const { inner, outer } = hmacStates(password);
  const s = toBytes(salt);
  const out = new Uint8Array(length);
  const blocks = Math.ceil(length / 32);
  // 每轮的输入是 32 字节的上一轮输出：补位后一块，长度 (64 + 32) × 8 = 768 位
  const w = new Int32Array(64);
  const st = new Int32Array(8);
  const u = new Int32Array(8);
  const acc = new Int32Array(8);
  for (let b = 1; b <= blocks; b++) {
    const first = new Uint8Array(s.length + 4);
    first.set(s);
    first[s.length] = b >>> 24; first[s.length + 1] = (b >>> 16) & 255; first[s.length + 2] = (b >>> 8) & 255; first[s.length + 3] = b & 255;
    const u1 = finish(outer, finish(inner, first, 64), 64);
    for (let i = 0; i < 8; i++) {
      u[i] = (u1[i * 4] << 24) | (u1[i * 4 + 1] << 16) | (u1[i * 4 + 2] << 8) | u1[i * 4 + 3];
      acc[i] = u[i];
    }
    for (let it = 1; it < iterations; it++) {
      // 内层：inner 状态 + (u ‖ 0x80 ‖ 0… ‖ 768)
      st.set(inner);
      for (let i = 0; i < 8; i++) w[i] = u[i];
      w[8] = 0x80000000; w[9] = 0; w[10] = 0; w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = 768;
      compress(st, w);
      // 外层：outer 状态 + (内层摘要 ‖ 补位)
      for (let i = 0; i < 8; i++) w[i] = st[i];
      st.set(outer);
      w[8] = 0x80000000; w[9] = 0; w[10] = 0; w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = 768;
      compress(st, w);
      for (let i = 0; i < 8; i++) {
        u[i] = st[i];
        acc[i] ^= st[i];
      }
    }
    const bytes = stateBytes(acc);
    out.set(bytes.subarray(0, Math.min(32, length - (b - 1) * 32)), (b - 1) * 32);
  }
  return out;
}
