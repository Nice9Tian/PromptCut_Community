import type { ApiVendor } from "./types";

/**
 * LLM API 配置的加密分发。
 *
 * 分发方在本机填好 baseUrl / key / model,用接收方的「本机识别码」当口令加密,
 * 得到一段以 PCAI1. 开头的长文本;接收方粘进来,软件在本机算出同一串识别码,
 * 自动解开并写进配置。
 *
 * 能防什么:密文在邮件、聊天里传的时候是密的;转发给第三个人,他的机器码不同,
 * 解不开。
 * 不能防什么:接收方自己。他的软件必须拿到明文 key 才能调 API,所以他有心的话
 * 一定拿得到。这套东西是「绑定到指定机器 + 传输途中不裸奔」,不是对接收方保密。
 */

/** 密文文本的前缀,兼作版本号。换算法就换前缀,老密文照样认得出来 */
const PREFIX = "PCAI1.";

/** 绑进 AES-GCM 的附加数据:密文被挪去别的用途时会解不开 */
const AAD = "PromptCut-api-share-v1";

const SALT_BYTES = 16;
const IV_BYTES = 12;

/** PBKDF2 轮数。识别码只有 100 位熵,靠轮数把暴力破解的成本抬上去 */
const DEFAULT_ITERATIONS = 600_000;

export interface SharedApiConfig {
  vendor: ApiVendor;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  /** 分发方留给接收方的一句话,导入时显示出来 */
  note?: string;
  /** 可选的失效时间(毫秒时间戳),过期后拒绝导入 */
  expiresAt?: number;
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 口令归一化。
 *
 * 识别码是人从聊天窗口抄过来的,所以对 PCM- 开头的输入做纠错:去掉分隔符、
 * 统一大写,再把手抄常见的形近字纠正过来(O→0、I/L→1、U→V,这几个字母本来
 * 就不在 Crockford Base32 表里,出现了必然是抄错)。
 *
 * 自定义口令(不以 PCM 开头)原样使用——里面的大小写和符号都是有意义的。
 */
export function normalizePassword(input: string): string {
  const text = String(input ?? "").trim();
  if (!/^PCM/i.test(text)) return text;
  return text
    .toUpperCase()
    .replace(/^PCM/, "")
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 把配置加密成一段可以直接发给对方的长文本 */
export async function encryptConfig(
  config: SharedApiConfig,
  password: string,
  { iterations = DEFAULT_ITERATIONS }: { iterations?: number } = {},
): Promise<string> {
  const pass = normalizePassword(password);
  if (!pass) throw new Error("请填加密口令(对方的本机识别码,或你们约定的口令)");
  if (!config.apiKey?.trim()) throw new Error("请填 API Key");

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(pass, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(config));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: new TextEncoder().encode(AAD) },
      key,
      plaintext,
    ),
  );

  // 轮数写进头里:以后调大默认值,老密文仍然按自己那时的轮数解得开
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, iterations, false);
  const blob = new Uint8Array(header.length + salt.length + iv.length + cipher.length);
  blob.set(header, 0);
  blob.set(salt, header.length);
  blob.set(iv, header.length + salt.length);
  blob.set(cipher, header.length + salt.length + iv.length);
  return PREFIX + base64urlEncode(blob);
}

/** 看一段文本像不像我们的密文(粘贴框用它决定要不要自动导入) */
export function looksLikeShareBlob(text: string): boolean {
  return text.replace(/\s+/g, "").startsWith(PREFIX);
}

/** 解开密文。口令不对、内容被改过、粘贴不全,都会走到同一句「解不开」 */
export async function decryptConfig(blob: string, password: string): Promise<SharedApiConfig> {
  // 聊天软件会给长文本插换行和空格,先全去掉
  const text = String(blob ?? "").replace(/\s+/g, "");
  if (!text.startsWith(PREFIX)) throw new Error("这段文本不是 PromptCut 的配置密文(应以 PCAI1. 开头)");

  let raw: Uint8Array;
  try {
    raw = base64urlDecode(text.slice(PREFIX.length));
  } catch {
    throw new Error("密文格式不对,可能没复制全");
  }
  const minimum = 4 + SALT_BYTES + IV_BYTES + 16; // 16 = GCM 校验标签
  if (raw.length < minimum) throw new Error("密文被截断了,请让对方重发完整内容");

  const iterations = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, false);
  // 别拿密文里的轮数去跑一个能把浏览器卡死的数
  if (iterations < 10_000 || iterations > 5_000_000) throw new Error("密文头部异常,拒绝解析");

  const salt = raw.slice(4, 4 + SALT_BYTES);
  const iv = raw.slice(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
  const cipher = raw.slice(4 + SALT_BYTES + IV_BYTES);

  const key = await deriveKey(normalizePassword(password), salt, iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: new TextEncoder().encode(AAD) },
      key,
      cipher as BufferSource,
    );
  } catch {
    throw new Error("解不开:口令(本机识别码)对不上,或者密文被改过");
  }

  let parsed: SharedApiConfig;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("密文解开了,但内容不是有效的配置");
  }
  if (!parsed || typeof parsed !== "object" || !parsed.apiKey) {
    throw new Error("密文解开了,但里面没有 API Key");
  }
  if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
    throw new Error(`这份配置已于 ${new Date(parsed.expiresAt).toLocaleDateString()} 过期,请向分发方索要新的`);
  }
  return parsed;
}
