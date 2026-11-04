/**
 * QR code encoder (QR Code, ISO/IEC 18004), zero dependencies.
 *
 * Only implements the subset needed for media collection QR code login: byte mode, error
 * correction L / M, versions 1~15 (up to ~400 bytes; Bilibili login links are ~130 characters,
 * around version 7). Does not support numeric / alphanumeric / kanji modes: those are for saving
 * space, which is not an issue here.
 *
 * Structure follows the standard: data encoding → block partitioning + Reed-Solomon error correction →
 * interleaving → matrix placement → test 8 mask patterns and pick the lowest penalty score → write
 * format / version information. Algorithmic parts rewritten referencing Project Nayuki's public
 * implementation approach.
 *
 * Two exports: encodeQr(text) yields a boolean matrix, qrSvg(text) directly outputs an SVG string.
 */

/** Error correction level → two bits in format information */
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Block partitioning table (columns L / M of standard Table 9, versions 1~15):
 *   ec  number of error correction codewords per block
 *   g   groups of [number of blocks, data codewords per block]; each block in the second group
 *       has one more data codeword than the first group
 */
const BLOCKS = {
  L: [
    null,
    { ec: 7, g: [[1, 19]] }, { ec: 10, g: [[1, 34]] }, { ec: 15, g: [[1, 55]] },
    { ec: 20, g: [[1, 80]] }, { ec: 26, g: [[1, 108]] }, { ec: 18, g: [[2, 68]] },
    { ec: 20, g: [[2, 78]] }, { ec: 24, g: [[2, 97]] }, { ec: 30, g: [[2, 116]] },
    { ec: 18, g: [[2, 68], [2, 69]] }, { ec: 20, g: [[4, 81]] }, { ec: 24, g: [[2, 92], [2, 93]] },
    { ec: 26, g: [[4, 107]] }, { ec: 30, g: [[3, 115], [1, 116]] }, { ec: 22, g: [[5, 87], [1, 88]] },
  ],
  M: [
    null,
    { ec: 10, g: [[1, 16]] }, { ec: 16, g: [[1, 28]] }, { ec: 26, g: [[1, 44]] },
    { ec: 18, g: [[2, 32]] }, { ec: 24, g: [[2, 43]] }, { ec: 16, g: [[4, 27]] },
    { ec: 18, g: [[4, 31]] }, { ec: 22, g: [[2, 38], [2, 39]] }, { ec: 22, g: [[3, 36], [2, 37]] },
    { ec: 26, g: [[4, 43], [1, 44]] }, { ec: 30, g: [[1, 50], [4, 51]] }, { ec: 22, g: [[6, 36], [2, 37]] },
    { ec: 22, g: [[8, 37], [1, 38]] }, { ec: 24, g: [[4, 40], [5, 41]] }, { ec: 24, g: [[5, 41], [5, 42]] },
  ],
};

/** Alignment pattern center coordinates (versions 2~15; not present in version 1) */
const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 52], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];

export const MAX_VERSION = 15;

function dataCodewords(version, ec) {
  return BLOCKS[ec][version].g.reduce((n, [blocks, cw]) => n + blocks * cw, 0);
}

/** Selects the smallest version that can accommodate the data */
function pickVersion(byteLen, ec) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    const need = 4 + ccBits + byteLen * 8;
    if (need <= dataCodewords(v, ec) * 8) return v;
  }
  throw new Error(`Content too long (${byteLen} bytes), exceeds the capacity of version ${MAX_VERSION}`);
}

// ── GF(256) and Reed-Solomon ──────────────────────────────────────────
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    // Check most significant bit then shift left: overflowing bit is reduced by 0x11D, keeping z at 8 bits
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsGenerator(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data, generator) {
  const result = new Array(generator.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let j = 0; j < generator.length; j++) result[j] ^= gfMul(generator[j], factor);
  }
  return result;
}

// ── Data encoding ─────────────────────────────────────────────────────
function encodeData(bytes, version, ec) {
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);                       // Byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version, ec) * 8;
  push(0, Math.min(4, capacity - bits.length)); // Terminator
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
}

/** Partitions into blocks, computes error correction, and interleaves into final codeword sequence */
function interleave(data, version, ec) {
  const { ec: ecLen, g } = BLOCKS[ec][version];
  const generator = rsGenerator(ecLen);
  const blocks = [];
  let offset = 0;
  for (const [count, cw] of g) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(offset, offset + cw);
      offset += cw;
      blocks.push({ d, e: rsRemainder(d, generator) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// ── Matrix ────────────────────────────────────────────────────
class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  setFn(x, y, dark) {
    this.m[y][x] = dark;
    this.fn[y][x] = true;
  }

  drawFunctionPatterns(ec) {
    const n = this.size;
    // Timing patterns
    for (let i = 0; i < n; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    // Three finder patterns (including separators)
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);
    // Alignment patterns: avoid the three corners
    const pos = ALIGN[this.version];
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.drawAlign(pos[i], pos[j]);
      }
    }
    // Reserve space first, write actual values once mask is determined
    this.drawFormat(ec, 0);
    this.drawVersion();
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlign(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormat(ec, mask) {
    const data = (EC_BITS[ec] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(i));
    this.setFn(8, 7, bit(6));
    this.setFn(8, 8, bit(7));
    this.setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFn(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFn(8, n - 15 + i, bit(i));
    this.setFn(8, n - 8, true); // Fixed dark module
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFn(a, b, dark);
      this.setFn(b, a, dark);
    }
  }

  /** Places codewords into non-function areas in a zigzag pattern */
  drawCodewords(codewords) {
    const n = this.size;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.fn[y][x] && i < total) {
            this.m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
          // Remaining bits stay false, standard requires padding with 0
        }
      }
    }
  }

  applyMask(mask) {
    const f = MASKS[mask];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.fn[y][x] && f(x, y)) this.m[y][x] = !this.m[y][x];
      }
    }
  }

  /** Standard four penalty rules; lower score means easier to scan */
  penalty() {
    const n = this.size, m = this.m;
    let score = 0;
    // Rule 1: ≥5 consecutive same color in a row / column
    for (let y = 0; y < n; y++) {
      let runX = 1, runY = 1;
      for (let x = 1; x < n; x++) {
        if (m[y][x] === m[y][x - 1]) { runX++; if (runX === 5) score += 3; else if (runX > 5) score += 1; } else runX = 1;
        if (m[x][y] === m[x - 1][y]) { runY++; if (runY === 5) score += 3; else if (runY > 5) score += 1; } else runY = 1;
      }
    }
    // Rule 2: 2×2 same color
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    // Rule 3: 1011101 with 4 light modules on one side (resembling finder pattern)
    const PAT = [true, false, true, true, true, false, true];
    const hasPat = (get, start) => PAT.every((v, k) => get(start + k) === v);
    const lightRun = (get, start, len) => { for (let k = 0; k < len; k++) { const v = get(start + k); if (v !== false) return false; } return true; };
    for (let y = 0; y < n; y++) {
      const row = (x) => (x >= 0 && x < n ? m[y][x] : null);
      const col = (yy) => (yy >= 0 && yy < n ? m[yy][y] : null);
      for (let x = 0; x <= n - 7; x++) {
        if (hasPat(row, x) && (lightRun(row, x - 4, 4) || lightRun(row, x + 7, 4))) score += 40;
        if (hasPat(col, x) && (lightRun(col, x - 4, 4) || lightRun(col, x + 7, 4))) score += 40;
      }
    }
    // Rule 4: Proportion of dark modules deviates from 50%
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const pct = (dark * 100) / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Encodes. Returns { version, size, mask, modules }: modules[y][x] is true for dark modules.
 * Passing mask pins the mask pattern (for testing); omitting it selects based on penalty scores.
 */
export function encodeQr(text, { ec = "M", mask = null } = {}) {
  if (!(ec in BLOCKS)) throw new Error(`Error correction level only supports L / M, got ${ec}`);
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const version = pickVersion(bytes.length, ec);
  const codewords = interleave(encodeData(bytes, version, ec), version, ec);

  let best = null;
  const candidates = mask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask];
  for (const k of candidates) {
    const mx = new Matrix(version);
    mx.drawFunctionPatterns(ec);
    mx.drawCodewords(codewords);
    mx.drawFormat(ec, k);
    mx.applyMask(k);
    const p = mx.penalty();
    if (!best || p < best.p) best = { p, k, mx };
  }
  return { version, size: best.mx.size, mask: best.k, ec, modules: best.mx.m };
}

/**
 * Directly outputs SVG. quiet is the number of margin modules around the border (standard
 * requires 4), scale only affects width/height attributes, and viewBox is calculated from module
 * count, so scaling arbitrarily in CSS will not blur.
 */
export function qrSvg(text, { ec = "M", quiet = 4, scale = 6, dark = "#000", light = "#fff" } = {}) {
  const { size, modules } = encodeQr(text, { ec });
  const total = size + quiet * 2;
  const parts = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * scale}" height="${total * scale}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="${light}"/>`
    + `<path d="${parts.join("")}" fill="${dark}"/></svg>`;
}

/** Computes codewords only (data + error correction, after interleaving), for testing and cross-checking */
export function encodeCodewords(text, { ec = "M" } = {}) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const version = pickVersion(bytes.length, ec);
  return { version, data: encodeData(bytes, version, ec), codewords: interleave(encodeData(bytes, version, ec), version, ec) };
}
