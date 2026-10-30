/**
 * API Key 落盘加密。
 *
 * 用的是和分发密文同一套信封(PBKDF2-SHA256 + AES-256-GCM),口令换成本机指纹,
 * AAD 换成落盘专用的那一串——所以分发密文和落盘密文不会互相解错。
 *
 * 两种来源的 Key 各用一套**前缀 + AAD + 口令标签**,互不相通:
 *   - `custom`:用户在「自定义 API」里自己填的 Key,前缀 PCENC1.(老版本就是它,兼容);
 *   - `router`:从「PromptCut Router」分发密文里导入的 Key,前缀 PCRTR1.。
 * 用 router 那套去解 custom 的密文(或反过来)得到的是空串 —— 当成「没设 Key」,
 * 而不是把另一路的 Key 拿来用。两路的密钥文件也分开放(见 ai-config.mjs)。
 *
 * 它挡的是「明文躺在文件里」这一类意外:同步盘、备份、误提交、截屏、别人借用
 * 你电脑时随手打开配置目录。它**挡不住**能在这台机器上以你的身份跑代码的人——
 * 口令是机器自己算出来的,推导逻辑也随软件一起发出去了,他跑一遍就有。
 * 想要更硬的,该上 Windows DPAPI / macOS Keychain 这类由操作系统托管密钥的方案。
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { machineFingerprint } from "./machine-id.mjs";

/** 各路 Key 的标识。换算法就换前缀,老密文照样认得出来 */
const SCHEMES = {
  custom: { prefix: "PCENC1.", aad: Buffer.from("PromptCut-config-at-rest-v1"), label: "PromptCut-at-rest" },
  router: { prefix: "PCRTR1.", aad: Buffer.from("PromptCut-router-at-rest-v1"), label: "PromptCut-router-at-rest" },
  // 配音(voice_generate)的网关令牌。和对话 API 的 Key 不是同一把,也不能当对话来源用
  voice: { prefix: "PCVOC1.", aad: Buffer.from("PromptCut-voice-at-rest-v1"), label: "PromptCut-voice-at-rest" },
};
/**
 * 对话 API 的两路来源(ai.json 的 api.source 只能取这两个)。
 * 写死而不是 Object.keys(SCHEMES):ai-config 拿它当「合法来源」的白名单,
 * voice 那把令牌混进来就成了一个能选的对话来源。
 */
export const KEY_KINDS = ["custom", "router"];

/** 能落盘的全部 Key 种类(对话两路 + 各功能自己的,如配音)。ai-config 的密钥文件按它校验 */
export const SECRET_KINDS = Object.keys(SCHEMES);

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ITERATIONS = 600_000;

function scheme(kind) {
  const s = SCHEMES[kind];
  if (!s) throw new Error(`未知的密钥类型: ${kind}`);
  return s;
}

/**
 * 派生结果按 (标签, salt) 缓存。readConfig() 每次请求都会被调到,
 * 不缓存的话每次都要跑 60 万轮 PBKDF2,接口会明显变慢。
 */
const keyCache = new Map();

function deriveKey(label, salt, iterations) {
  const cacheKey = `${label}:${salt.toString("hex")}:${iterations}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = pbkdf2Sync(`${label}|${machineFingerprint()}`, salt, iterations, 32, "sha256");
    // 只可能有「当前这份配置」和「刚换过的上一份」,不会长
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(cacheKey, key);
  }
  return key;
}

/** 这个值是哪一路的密文;不是密文返回 null */
export function sealedKind(value) {
  if (typeof value !== "string") return null;
  for (const [kind, s] of Object.entries(SCHEMES)) {
    if (value.startsWith(s.prefix)) return kind;
  }
  return null;
}

/** 这个值是不是已经加密过了(任一路) */
export function isSealed(value) {
  return sealedKind(value) !== null;
}

/** 明文 Key → 落盘密文。空值原样返回,不给空串套一层壳 */
export function sealKey(plain, kind = "custom") {
  const s = scheme(kind);
  if (!plain) return "";
  if (sealedKind(plain) === kind) return plain;
  if (isSealed(plain)) throw new Error("另一路的密文不能直接改标签,先解开再封");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(s.label, salt, ITERATIONS), iv);
  cipher.setAAD(s.aad);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(ITERATIONS, 0);
  return s.prefix + Buffer.concat([header, salt, iv, body, cipher.getAuthTag()]).toString("base64url");
}

/**
 * 落盘密文 → 明文 Key。
 *
 * 不是密文就原样返回:老配置里存的是明文,不能因为升级了就把人家的 Key 弄丢;
 * 解不开也返回空串而不是抛错——换了机器、拷贝过来的配置就该表现为「没设 Key」,
 * 让用户重新填,而不是让整个设置接口 500。
 * 是**另一路**的密文也返回空串:custom 和 router 不能混用。
 */
export function openKey(sealed, kind = "custom") {
  const s = scheme(kind);
  if (!sealed) return "";
  const found = sealedKind(sealed);
  if (found === null) return String(sealed);
  if (found !== kind) return "";
  try {
    const raw = Buffer.from(sealed.slice(s.prefix.length), "base64url");
    if (raw.length < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES) return "";
    const iterations = raw.readUInt32BE(0);
    if (iterations < 10_000 || iterations > 5_000_000) return "";
    const salt = raw.subarray(4, 4 + SALT_BYTES);
    const iv = raw.subarray(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
    const body = raw.subarray(4 + SALT_BYTES + IV_BYTES, raw.length - TAG_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(s.label, salt, iterations), iv);
    decipher.setAAD(s.aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
