/**
 * 本机识别码。
 *
 * 分发 API 配置时,接收方先把这串码发给分发方,分发方拿它当口令加密;
 * 接收方的软件再在本机算出同一串码解密。于是密文只在那台机器上解得开,
 * 转发给别人也没用。
 *
 * 只用机器级标识,不掺用户名——换个账号登录还是同一台机器,码不该变。
 * 原始指纹永远不出这个模块,对外只给摘要后的码。
 */
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/** Crockford Base32:去掉了 I L O U,不会把 0/O、1/I/L 抄混 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 码里有多少个字符(每 5 个一组)。20 个 = 100 位,够抗碰撞和猜测 */
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

/** 网卡 MAC 兜底用:排掉回环和全零,排序后拼起来,枚举顺序变了也不影响 */
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
 * 取这台机器最稳定的那个标识。取不到就退回「主机名 + 平台 + 架构 + 网卡」,
 * 稳定性差一些(换网卡会变),但至少不会算不出来。
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
 * 对外的本机识别码,形如 PCM-4K7QX-…(4 组 5 位)。
 *
 * 这串码就是加密口令。归一化(去分隔符、纠形近字)在浏览器侧的
 * src/ai/configShare.ts 里做——加密和解密都走那一份,不会两边算法跑偏。
 */
export function machineCode(fingerprint = machineFingerprint()) {
  const digest = createHash("sha256").update(`PromptCut-machine-v1|${fingerprint}`).digest();
  const code = base32(digest).slice(0, CODE_LEN);
  return `PCM-${code.match(/.{1,5}/g).join("-")}`;
}

/**
 * 脱敏后的识别码,形如 PCM-4K7QX-…。
 *
 * 诊断报告要发给我们,而这串码**就是**配置分发的解密口令,整串写进去等于
 * 附赠一把钥匙。首组 5 位 = 25 位熵,够在几十台机器里认出是哪一台,
 * 又远不足以反推出完整口令。
 */
export function redactMachineCode(code = machineCode()) {
  const head = String(code).split("-").slice(0, 2).join("-");
  return `${head}-…`;
}
