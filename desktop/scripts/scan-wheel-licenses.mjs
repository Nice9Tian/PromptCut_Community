/**
 * PromptCut — 扫拓展包里各个 wheel 的许可证。
 *
 * 为什么要有它：拓展包把几十个 wheel 发给用户（full 档实测 34 个），其中绝大多数是
 * pip 自己拉进来的传递依赖，没人一个个看过。混进一个 GPL/AGPL/SSPL 或者
 * CC-BY-NC 的包，就是我们在无证分发 —— 而且是发在一个双击就装的 exe 里。
 * THIRD-PARTY-LICENSES.md 的分发前检查清单有「核实拓展包内各 wheel 的许可证」
 * 这一条，这个脚本就是那条清单的执行方式，不必再靠人肉翻 34 个 METADATA。
 *
 * 数据从哪来：读 release/extensions/ 下打包时落的 manifest（ext-<名字>-<版本>.json）
 * 的 wheels 字段拿到「包名==版本」，再逐个查 PyPI 的 JSON API 取
 * license_expression / license / classifiers。查的是**发布元数据**，不是 wheel 内的
 * LICENSE 正文 —— 元数据够用来发现「这里有个 GPL」，但拿不准的那几个仍要打开 wheel
 * 看 METADATA，脚本会把可疑的行标出来让人去看。
 *
 * 跑法（不带参数就扫 release/extensions 下所有 manifest）：
 *   node desktop/scripts/scan-wheel-licenses.mjs
 *   node desktop/scripts/scan-wheel-licenses.mjs <manifest.json> [<manifest.json> …]
 *   node desktop/scripts/scan-wheel-licenses.mjs --json      # 机器可读，给 CI 用
 *
 * 退出码：0 = 没有可疑的；1 = 有可疑的或者有查不到的（要人来看）。
 * 需要联网（api 走 pypi.org）。
 *
 * 前身是 2026-09-07 那轮许可证校验用的一次性脚本，固化到这里免得下次又从头写。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const EXT_DIR = path.join(DESKTOP_DIR, "release", "extensions");

/**
 * 不能随包发的许可证。命中就是红灯，要么换依赖，要么这个包不能发。
 * 注意 LGPL 也在里面：静态/打包分发时它的义务不比 GPL 轻多少，宁可拿出来单独看。
 * MPL-2.0 **不在**这里 —— 它是文件级 copyleft，随包发是允许的，只要告知源码获取途径
 * （certifi / tqdm 就属于这一类，见 THIRD-PARTY-LICENSES.md 第 9 节）。
 */
const BAD = /\b(GPL|GPLv2|GPLv3|AGPL|LGPL|non-?commercial|NonCommercial|CC[- ]BY[- ]NC|SSPL|proprietary|EUPL)\b/i;

/** wheel 文件名 → { name, version }。PEP 427：<名字>-<版本>-<python 标签>-… */
export function parseWheelName(file) {
  const parts = path.basename(file, ".whl").split("-");
  if (parts.length < 2) return null;
  // 包名里的下划线在 PyPI 上是连字符（typing_extensions → typing-extensions）
  return { name: parts[0].replace(/_/g, "-").toLowerCase(), version: parts[1] };
}

/**
 * 把若干份 manifest 合并成「包名==版本 → { name, version, tiers }」。
 * 键里带版本：同一个包在不同拓展里可能是不同版本（实测 tokenizers 在 stt 是 0.23.2、
 * 在 full 是 0.22.2），许可证也可能随版本变，按版本分开查才不会张冠李戴。
 */
export function collectWheels(manifests) {
  const out = new Map();
  for (const { label, wheels } of manifests) {
    for (const w of wheels || []) {
      const parsed = parseWheelName(w);
      if (!parsed) continue;
      const key = `${parsed.name}==${parsed.version}`;
      const cur = out.get(key);
      if (cur) {
        if (!cur.tiers.includes(label)) cur.tiers.push(label);
      } else {
        out.set(key, { name: parsed.name, version: parsed.version, tiers: [label] });
      }
    }
  }
  return out;
}

/** 一行的判定：许可证表达式或分类器里出现 BAD 就算可疑 */
export function isSuspicious(row) {
  return row.license === "(查不到)" || BAD.test(row.license) || BAD.test(row.classifiers);
}

async function fetchLicense(name, version) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { license: "(查不到)", classifiers: `HTTP ${res.status}` };
    const info = (await res.json()).info || {};
    // license_expression 是 PEP 639 的新字段，比自由文本的 license 可靠；都没有就看分类器
    let license = info.license_expression || info.license || "";
    if (license.length > 120) license = `${license.slice(0, 120).replace(/\s+/g, " ")}…`;
    const classifiers = (info.classifiers || []).filter((c) => c.startsWith("License")).join(" | ");
    return { license: license.replace(/\s+/g, " ").trim() || "(空)", classifiers };
  } catch (e) {
    return { license: "(查不到)", classifiers: String(e.message || e) };
  }
}

/** 找 release/extensions 下所有 manifest（两档在 _light/_full 子目录里，单项包平铺） */
function findManifests(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findManifests(full));
    else if (/^ext-.+\.json$/.test(ent.name)) out.push(full);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const given = argv.filter((a) => !a.startsWith("-"));
  const files = given.length ? given : findManifests(EXT_DIR);

  if (!files.length) {
    console.error(`[FAIL] 没找到 manifest。先打一次拓展包（node desktop/scripts/make-extension.mjs light …），`
      + `或者把 ext-*.json 的路径当参数传进来。找过的位置：${EXT_DIR}`);
    process.exit(1);
  }

  const manifests = files.map((f) => {
    const m = JSON.parse(fs.readFileSync(f, "utf-8"));
    return { label: m.tier || m.name, wheels: m.wheels, file: f };
  });
  if (!asJson) {
    for (const m of manifests) console.log(`manifest：${m.file}（${m.label}，${(m.wheels || []).length} 个 wheel）`);
    console.log("");
  }

  const wheels = collectWheels(manifests);
  const rows = [];
  for (const info of wheels.values()) {
    const lic = await fetchLicense(info.name, info.version);
    rows.push({ name: info.name, version: info.version, tiers: info.tiers, ...lic });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  for (const r of rows) r.suspicious = isSuspicious(r);

  const flagged = rows.filter((r) => r.suspicious);
  if (asJson) {
    console.log(JSON.stringify({ scannedAt: new Date().toISOString(), files, rows }, null, 2));
  } else {
    for (const r of rows) {
      console.log(`${r.suspicious ? "!!" : "  "} ${r.name}==${r.version}  [${r.tiers.join(",")}]`);
      console.log(`     license: ${r.license}`);
      if (r.classifiers) console.log(`     classifiers: ${r.classifiers}`);
    }
    console.log(`\n共 ${rows.length} 个包，可疑 ${flagged.length} 个。`);
    if (flagged.length) {
      console.log("可疑的逐个打开 wheel 看 METADATA / LICENSE 再定；确认能发的话，"
        + "在 desktop/THIRD-PARTY-LICENSES.md 第 9 节写明理由。");
    } else {
      console.log("没有 GPL / AGPL / LGPL / SSPL / 非商用 授权的包。"
        + "MPL-2.0（certifi、tqdm）不算可疑，但要按 MPL §3.2 告知源码获取途径，已写在包内的 THIRD-PARTY-LICENSES.txt。");
    }
  }
  process.exit(flagged.length ? 1 : 0);
}

// 被 import 时（测试）不跑主流程
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
