/**
 * PromptCut — 打「拓展库包」。
 *
 * 三层发布的第三层：
 *   完整安装包（内核换代时发） / 更新补丁（改 Node 那半边） / 拓展库包（可选能力）
 *
 * 为什么要有它：语音识别、镜头识别、主体检测的依赖现在是运行时 pip install 现下载，
 * 断网、内网、或者国内网络不通就装不上，而且每台机器都要重下一遍。拓展库包
 * 把 wheel 和模型预先打好，离线也能装。
 *
 * 给用户的两档（发布时只发这两个，用户不必弄懂里面有几个模型）：
 *   node scripts/make-extension.mjs light --transnet <t.onnx> --yunet <y.onnx> --rtdetr <r.onnx>
 *   node scripts/make-extension.mjs full  --transnet … --yunet … --rtdetr … \
 *                                         --bootstapir <b.pt> --dino <grounding-dino-tiny 目录>
 *
 * 给开发者的单项包（老名字，继续能用，用于单独重打某一项）：
 *   node scripts/make-extension.mjs shots --model <transnetv2.onnx>
 *   node scripts/make-extension.mjs track --model <bootstapir_v2.pt>
 *   node scripts/make-extension.mjs stt
 *
 * 产物：release/extensions/_light|_full/PromptCut-ext-<名字>-<版本>.exe，双击即装。
 * 单独一个目录：拓展包按自己的节奏出版本，和安装包/补丁不是一批东西，
 * 混在一起时 release/ 里一眼看不出「这次发布该给用户哪几个文件」。
 * 两档再各自分一个子目录：_light 和 _full 里的 exe 名字只差一个词，平铺在一起
 * 很容易发错文件给用户。
 *
 * 纯逻辑（拓展表、许可证硬闸、manifest）都是导出的函数，见 desktop/test/make-extension.test.mjs。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
/** 拓展包单独放，别和安装包、补丁混在一个目录里 */
const EXT_DIR = path.join(RELEASE_DIR, "extensions");
const STAGE_DIR = path.join(DESKTOP_DIR, ".cache", "ext-stage");

/** 拓展依赖的是应用里那半边代码(promptcut_shots / promptcut_subject / …),太旧的版本没有它,
 *  所以每个拓展都要声明最低应用版本，装之前就拦住，而不是装完才自检失败。*/
export const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
).version;

const PY = path.join(PROJECT_ROOT, "python");
/** 各能力的依赖清单。light/full 是把这些拼起来，不另写一份，免得两处漂移。 */
const REQ = {
  shots: path.join(PY, "promptcut_shots", "requirements-shots.txt"),
  track: path.join(PY, "promptcut_track", "requirements-track.txt"),
  stt: path.join(PY, "requirements-faster-whisper.txt"),
  subjectLight: path.join(PY, "promptcut_subject", "requirements-subject-light.txt"),
  subjectFull: path.join(PY, "promptcut_subject", "requirements-subject-full.txt"),
};

/**
 * 三份许可证全文放在 scripts/licenses/ 下，文件名就是 SPDX 标识符。
 * 全文是共用的（一份 MIT 管两个模型），版权行是逐模型的，所以全文单独存文件、
 * 版权行留在 MODEL_META 里，由 buildLicenseText 把两者拼起来。
 * 来源和与 SPDX 官方文本的比对结果见 scripts/licenses/README.md。
 */
const LICENSE_DIR = path.join(__dirname, "licenses");

/**
 * 认得的许可证标识符 = licenses/ 目录里有全文的那几个。
 * 用目录内容当白名单，而不是另写一张表：写了个 "Apache 2.0"（少个连字符）这种
 * 拼法，出包时就没有全文可附，硬闸必须在这一步拦住而不是等到用户拿到包。
 */
export const KNOWN_LICENSES = fs.existsSync(LICENSE_DIR)
  ? fs.readdirSync(LICENSE_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)).sort()
  : [];

/** 读一份许可证全文；缺文件就抛，让 CLI 转成 [FAIL]，绝不出一个没有全文的包。 */
export function licenseFullText(spdxId) {
  const p = path.join(LICENSE_DIR, `${spdxId}.txt`);
  if (!fs.existsSync(p)) {
    throw new Error(`No full license text for ${spdxId} (cannot find ${p}):`
      + ` MIT / Apache-2.0 / BSD-3-Clause all require the full text to ship with the distribution; naming the license is not enough.`
      + ` When adding a license, name the full text by its SPDX identifier and put it in desktop/scripts/licenses/.`);
  }
  return fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * 随包分发的模型权重。除了 file 之外的字段全是许可证信息 —— 少一项就打不出包
 * （见 assertModelMeta），并且要和 desktop/THIRD-PARTY-LICENSES.md 第 9 节对得上。
 * from（本地路径）由命令行给，不写进 manifest。
 *
 * copyright 是**可选**的，而且宁缺毋编：上游没有版权声明时（Apache-2.0 §4(c) 要求
 * 保留的是「Source form 里已有的」声明），就把这个事实写进 note，不要造一行。
 * 下面每条 copyright 都是 2026-09-07 用 curl 从上游 LICENSE / 源码文件头逐字抄回来的。
 */
export const MODEL_META = {
  transnet: {
    file: "transnetv2.onnx",
    // 没有官方 ONNX，这份是从官方 TF 权重自己转的，见 tools/transnetv2/README.md
    title: "TransNet V2",
    license: "MIT",
    source: "https://github.com/soCzech/TransNetV2",
    // 上游 LICENSE 只有 Souček 一个人（原来这里还写了 Jakub Lokoč，是论文作者不是版权行）
    copyright: "Copyright (c) 2020 Tomáš Souček",
    note: "Weights were converted from the official TensorFlow checkpoint to PyTorch with the official convert_weights.py, then exported to ONNX; not retrained.",
  },
  bootstapir: {
    // 注意这里是 .pt 不是 .onnx：TAPIR 里有 4 处 5 维 grid_sample，torch 的四条
    // 导出路径全都导不出 ONNX，所以这个模型直接带 PyTorch 跑原始权重。
    // 也因此带它的包比 light 档大得多（torch 194 MB + 权重 208 MB）。
    file: "bootstapir_v2.pt",
    title: "BootsTAPIR (TAP-Net)",
    license: "Apache-2.0",
    source: "https://github.com/google-deepmind/tapnet",
    // 上游 LICENSE 是未填写的 Apache-2.0 模板，版权行只出现在源码文件头，逐字如此
    copyright: "Copyright 2026 Google LLC",
    note: "The official checkpoint is included as is, with no conversion or retraining. The official statement says the checkpoints are under Apache 2.0, same as the code."
      + " (CoTracker3 was considered, but its whole repository is CC-BY-NC, which forbids commercial use and so cannot ship with the package; this model was used instead.)",
  },
  yunet: {
    file: "yunet.onnx",
    title: "YuNet (libfacedetection)",
    // MIT 不是 Apache-2.0：opencv_zoo 根仓库确实是 Apache-2.0，但 README 明写
    // 「Please refer to licenses of different models」，而该模型目录下自带一份
    // MIT LICENSE，以目录内的为准。2026-09-07 curl 该目录的 LICENSE 核对过。
    license: "MIT",
    // source 精确到模型目录，指到根仓库会读成 Apache-2.0
    source: "https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet",
    copyright: "Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>",
    // 权重的训练上游是另一个仓库、另一个许可证，全文也要一并附上
    alsoLicenses: [{
      id: "BSD-3-Clause",
      why: "Training upstream of the weights: ShiqiYu/libfacedetection.train (https://github.com/ShiqiYu/libfacedetection.train)",
      copyright: "Copyright (c) 2022-2026, Shiqi Yu <shiqi.yu@gmail.com>",
    }],
    note: "The official ONNX (face_detection_yunet_2023mar.onnx) is included as is, with no conversion or retraining."
      + " The license is the LICENSE inside the model directory = MIT; the training upstream of the weights, ShiqiYu/libfacedetection.train, is BSD-3-Clause,"
      + "and the full text of both ships with the package. The terms of the WIDER FACE training dataset are non-commercial; the industry generally still distributes under the model's own license, so please assess this yourself before distributing.",
  },
  rtdetr: {
    file: "rtdetr_r18vd.onnx",
    title: "RT-DETR-R18vd",
    license: "Apache-2.0",
    source: "https://huggingface.co/PekingU/rtdetr_r18vd",
    // 没有 copyright 字段：上游没有可保留的版权声明，见下面 note，不编一行
    note: "Exported from HF weights via torch.onnx.export; not retrained; training set COCO."
      + "Upstream declares no copyright line: the LICENSE of lyuwenyu/RT-DETR is an unfilled Apache-2.0 template (it still ends with the"
      + "\"Copyright [yyyy] [name of copyright owner]\" placeholder), and the HF repository PekingU/rtdetr_r18vd has no LICENSE file,"
      + "so no copyright line is written here. Original release: https://github.com/lyuwenyu/RT-DETR , the HF mirror is labeled apache-2.0.",
  },
  dino: {
    // 唯一一个目录型模型：HF snapshot 是 config + safetensors + tokenizer 一整套，
    // 拆开没有意义，原样进 models/grounding-dino-tiny/。
    file: "grounding-dino-tiny",
    dir: true,
    title: "Grounding DINO Tiny",
    license: "Apache-2.0",
    source: "https://huggingface.co/IDEA-Research/grounding-dino-tiny",
    // 上游 GroundingDINO 仓库 LICENSE 附录里填好的那一行，逐字如此
    copyright: "Copyright 2023 - present, IDEA Research.",
    note: "HF snapshot is included as is (safetensors); versions 1.5/1.6 are not open source, and this package uses the open-source 1.0.",
  },
};

const model = (key, from) => ({ ...MODEL_META[key], from: from || null });

/**
 * 每个拓展要装什么。
 * requirements 走 pip download 抓成 wheel（可以给多份，pip 支持多个 -r）；
 * models 是直接随包带的文件或目录。
 * provides 是这个包让哪几个 promptcut_* 模块变得可用 —— 安装器拿它逐个自检。
 *
 * @param {{model?:string, transnet?:string, bootstapir?:string,
 *          yunet?:string, rtdetr?:string, dino?:string}} src 各模型文件的本地路径
 */
export function makeExtensions(src = {}) {
  const light = {
    label: "Light tier",
    tier: "light",
    version: "1.0.0",
    // 主体检测（promptcut_subject）是这一版加进去的；镜头识别更早（0.2.5），取大的那个
    requiresApp: "0.2.8",
    provides: ["shots", "subject"],
    requirements: [REQ.shots, REQ.subjectLight],
    models: [
      model("transnet", src.transnet ?? src.model),
      model("yunet", src.yunet),
      model("rtdetr", src.rtdetr),
    ],
    note: "After install: shot-cut detection uses TransNetV2 (recognizes both hard cuts and dissolves); subject detection uses YuNet + RT-DETR,"
      + "which can tell the AI where faces and bodies are in the frame and which side is empty, so cards will not cover faces. All use only onnxruntime, so the package is small.",
  };
  const full = {
    label: "Full tier",
    tier: "full",
    version: "1.0.0",
    // 运动追踪 0.2.6、主体检测 0.2.8，取大的那个
    requiresApp: "0.2.8",
    provides: ["shots", "subject", "track"],
    // full 就是 light 再加两样，不重新列一遍：漏改一处就会出现「full 反而少东西」
    requirements: [...light.requirements, REQ.track, REQ.subjectFull],
    models: [...light.models, model("bootstapir", src.bootstapir), model("dino", src.dino)],
    note: "On top of the Light tier, adds: motion tracking uses BootsTAPIR for arbitrary point tracking, which can re-identify targets after they turn, deform, or are occluded;"
      + "subject detection gains an open-vocabulary tier (Grounding DINO), which can find targets from any text prompt (for example \"red cup\")."
      + " Includes PyTorch, so the package is much larger.",
  };

  return {
    light,
    full,
    // ── 以下是按能力拆开的单项包，给开发者单独重打某一项用，发布给用户的是上面两档 ──
    shots: {
      label: "Shot detection",
      version: "1.0.0",
      requiresApp: "0.2.5",  // promptcut_shots 是这一版加进去的
      provides: ["shots"],
      requirements: [REQ.shots],
      models: [model("transnet", src.model ?? src.transnet)],
      note: "After install, \"shot-cut detection\" uses TransNetV2, which recognizes both hard cuts and dissolves; without it, it falls back to ffmpeg scdet, which recognizes only hard cuts.",
    },
    track: {
      label: "Motion tracking",
      version: "1.0.0",
      requiresApp: "0.2.6",  // promptcut_track 是这一版加进去的
      provides: ["track"],
      requirements: [REQ.track],
      models: [model("bootstapir", src.model ?? src.bootstapir)],
      note: "After installation, \"Motion tracking\" uses BootsTAPIR for arbitrary point tracking: it understands the image content and can re-identify targets after they turn, deform, or are occluded for a long time. Without it, tracking falls back to numpy template matching, which tracks rigid, clearly textured targets accurately but loses targets that turn or are occluded for long.",
    },
    stt: {
      label: "Speech recognition",
      version: "1.0.0",
      requiresApp: "0.1.0",  // 语音识别很早就有了
      provides: ["stt"],
      requirements: [REQ.stt],
      models: [],  // 语音模型按需下载，不随包发，所以这里没有要声明许可证的权重
      note: "After installation, speech-to-text no longer needs to download dependencies online; models are still downloaded on demand.",
    },
  };
}

export const EXTENSION_NAMES = Object.keys(makeExtensions());

/**
 * 许可证硬闸：权重要随包发给用户，没写清楚许可证就不许出包。
 * 别指望发布前有人记得回头补 THIRD-PARTY-LICENSES.md。
 * @throws {Error} 缺字段时抛，CLI 侧转成 [FAIL] 退出。
 */
export function assertModelMeta(m) {
  for (const field of ["file", "title", "license", "source"]) {
    if (!m[field]) {
      throw new Error(`Model ${m.file || "(unnamed)"} is missing ${field}: weights shipped in the package must state their license clearly, `
        + `and sync it to desktop/THIRD-PARTY-LICENSES.md`);
    }
  }
  // 许可证名字必须是 SPDX 标识符，而且 licenses/ 下要有对应的全文。
  // 只写个名字不算履行 MIT/Apache/BSD 的「附带全文」义务，所以这两件事是同一道闸。
  for (const id of [m.license, ...(m.alsoLicenses || []).map((a) => a.id)]) {
    if (!KNOWN_LICENSES.includes(id)) {
      throw new Error(`Model ${m.file} has license "${id}", which is not a recognized SPDX identifier`
        + ` (recognized: ${KNOWN_LICENSES.join(" / ")}). The spelling must match https://spdx.org/licenses/; `
        + `if it really is a new license, put the full text in desktop/scripts/licenses/<SPDX identifier>.txt`);
    }
  }
}

/** 随包的 manifest。from 是构建机上的本地路径，绝不能写进去。 */
export function buildManifest({ name, ext, wheels, appVersion = APP_VERSION, builtAt = new Date().toISOString() }) {
  for (const m of ext.models) assertModelMeta(m);
  return {
    format: "promptcut-extension/1",
    name,
    label: ext.label,
    version: ext.version,
    ...(ext.tier ? { tier: ext.tier } : {}),
    provides: ext.provides,
    requiresApp: ext.requiresApp,
    builtAgainstApp: appVersion,
    builtAt,
    wheels,
    models: ext.models.map(({ from, ...rest }) => rest),
    note: ext.note,
  };
}

/**
 * 包内的 THIRD-PARTY-LICENSES.txt：拿到包的人不该还要回仓库翻文档才知道里面是什么授权。
 *
 * 上半截是逐模型的清单，下半截是**许可证全文**。全文这一截不是可有可无的排版：
 * MIT 要求「the above copyright notice and this permission notice shall be included
 * in all copies」，Apache-2.0 §4(a) 要求「give any other recipients a copy of this
 * License」，BSD-3-Clause 第 2 条要求二进制分发时复制条件全文 —— 只发一张写着许可证
 * 名字的清单，这三条一条都没做到。原来就是只有清单，所以这份文件在 2026-09-07 之前
 * 是不合规的。
 *
 * 同一份全文由多个模型共用时只出现一次，抬头列清适用于哪几个模型、各自的版权行是什么。
 */
export function buildLicenseText(ext) {
  // 收集这个包实际用到的许可证 → 各自适用于哪些「作品 + 版权行」
  /** @type {Map<string, {work: string, copyright: string|null, why: string|null}[]>} */
  const byLicense = new Map();
  const add = (id, entry) => {
    if (!byLicense.has(id)) byLicense.set(id, []);
    byLicense.get(id).push(entry);
  };
  for (const m of ext.models) {
    const work = `${m.title} (${m.file}${m.dir ? "/" : ""})`;
    add(m.license, { work, copyright: m.copyright || null, why: null });
    for (const a of m.alsoLicenses || []) {
      add(a.id, { work, copyright: a.copyright || null, why: a.why });
    }
  }

  const sep = "=".repeat(78);
  const licenseSections = [...byLicense.entries()].flatMap(([id, uses], i) => [
    sep,
    `License full text ${i + 1}/${byLicense.size}: ${id}`,
    sep,
    "Applies to: ",
    ...uses.flatMap((u) => [
      `  · ${u.work}${u.why ? ` —— ${u.why}` : ""}`,
      u.copyright ? `      ${u.copyright}` : "      (upstream declares no copyright line, see the note for this model above)",
    ]),
    "",
    "The full text follows; placeholders in it (such as <year> <copyright holders>) are to be read according to the respective copyright lines above.",
    "",
    licenseFullText(id),
    "",
    "",
  ]);

  return [
    `PromptCut ${ext.label} extension pack ${ext.version}: third-party licenses`,
    "",
    "This package contains the following third-party model weights. The full license text of each set of weights is appended at the end of this file, ",
    "After installation they are placed together with the models under %APPDATA%\\com.promptcut.desktop\\models\\.",
    "",
    ...ext.models.flatMap((m) => [
      `## ${m.title} (${m.file}${m.dir ? "/" : ""})`,
      `- License: ${m.license}`
        + ((m.alsoLicenses || []).length ? ` (also includes ${m.alsoLicenses.map((a) => a.id).join(" / ")}, see the end)` : ""),
      `- Source: ${m.source}`,
      ...(m.copyright ? [`- Copyright: ${m.copyright}`] : []),
      ...(m.note ? [`- Note: ${m.note}`] : []),
      "",
    ]),
    "The licenses of the Python dependencies (wheels/ directory) are in the METADATA / LICENSE inside each wheel.",
    "Of these, certifi and tqdm are MPL-2.0; per MPL §3.2, the way to obtain the source code is: ",
    "  certifi  https://github.com/certifi/python-certifi",
    "  tqdm     https://github.com/tqdm/tqdm",
    "",
    ...licenseSections,
    // 全文里是 \n，清单这半截拼的时候统一成 \n，最后一起转 CRLF：
    // 混着换行符的 .txt 在老一点的记事本里会连成一行，用户看到的就是一坨。
  ].join("\n").replace(/\r?\n/g, "\r\n");
}

/** 两档各自一个子目录，单项包还是平铺在 extensions/ 下 */
export function outDirFor(ext, base = EXT_DIR) {
  return ext.tier ? path.join(base, `_${ext.tier}`) : base;
}

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
const mb = (b) => (b / 1048576).toFixed(1);

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

/** 自带的那个解释器；用它下载 wheel 才能保证 ABI 和用户机器上一致 */
function bundledPython() {
  const p = path.join(DESKTOP_DIR, "src-tauri", "runtime", "python", "python.exe");
  if (fs.existsSync(p)) return p;
  fail("Cannot find the bundled Python (desktop/src-tauri/runtime/python), run npm run prepare-python first");
}

function findMakensis() {
  const bundled = path.join(process.env.LOCALAPPDATA || "", "tauri", "NSIS", "Bin", "makensis.exe");
  if (fs.existsSync(bundled)) return bundled;
  const probe = spawnSync("makensis", ["/VERSION"], { windowsHide: true, encoding: "utf8" });
  if (probe.status === 0 || probe.stdout) return "makensis";
  fail("Cannot find makensis. Run npm run build once first so Tauri installs NSIS.");
}

/** 哪个模型该用哪个命令行开关 —— 报错时要能直接告诉人该敲什么 */
const FLAG_OF = { transnet: "--transnet", yunet: "--yunet", rtdetr: "--rtdetr", bootstapir: "--bootstapir", dino: "--dino" };
const flagFor = (file, ext) => {
  const key = Object.keys(MODEL_META).find((k) => MODEL_META[k].file === file);
  if (!key) return "--model";
  // 单项包只有一个模型，历史上就叫 --model；两档包有好几个，必须点名
  return ext.tier ? FLAG_OF[key] : `--model (or ${FLAG_OF[key]})`;
};

function main() {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith("-"));
  const option = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const table = makeExtensions({
    model: option("--model"),
    transnet: option("--transnet"),
    bootstapir: option("--bootstapir"),
    yunet: option("--yunet"),
    rtdetr: option("--rtdetr"),
    dino: option("--dino"),
  });

  if (!name || !Object.hasOwn(table, name)) {
    fail(`Usage: node scripts/make-extension.mjs <${Object.keys(table).join("|")}>\n`
      + `  light --transnet <t.onnx> --yunet <y.onnx> --rtdetr <r.onnx>\n`
      + `  full  the three above + --bootstapir <b.pt> --dino <grounding-dino-tiny directory>
`
      + `  --keep-stage  do not delete .cache/ext-stage after packaging, to check exactly which files went into the exe`);
  }
  const ext = table[name];
  console.log(`PromptCut make-extension: ${ext.label} ${ext.version} (provides ${ext.provides.join(" / ")})`);

  for (const r of ext.requirements) {
    if (!fs.existsSync(r)) fail(`Cannot find dependency manifest ${r}`);
  }
  // 许可证硬闸和模型路径检查都提前到下载 wheel 之前：full 档要下 177 MB 轮子，
  // 少打一个 --yunet 就白等好几分钟才被拒，太亏
  for (const m of ext.models) {
    try { assertModelMeta(m); } catch (e) { fail(e.message); }
    if (!m.from) fail(`${ext.label} needs model ${m.dir ? "directory" : "file"} ${m.file}, specify it with ${flagFor(m.file, ext)} <path>`
      + ` (see tools/subject/README.md and tools/transnetv2/README.md for how to obtain them)`);
    if (!fs.existsSync(m.from)) fail(`Model ${m.dir ? "directory" : "file"} does not exist: ${m.from}`);
    const isDir = fs.statSync(m.from).isDirectory();
    if (m.dir && !isDir) fail(`${m.file} should be a directory, but a file was given: ${m.from}`);
    if (!m.dir && isDir) fail(`${m.file} should be a file, but a directory was given: ${m.from}`);
  }

  const stem = `PromptCut-ext-${name}-${ext.version}`;
  rmrf(STAGE_DIR);
  const root = path.join(STAGE_DIR, stem);
  const wheelDir = path.join(root, "wheels");
  const modelDir = path.join(root, "models");
  mkdirp(wheelDir);
  mkdirp(modelDir);

  // ── wheel ──────────────────────────────────────────────────────────
  // 用自带解释器 pip download：wheel 的 ABI 标签必须和用户机器上那个
  // 解释器对得上，用开发机的 python 下出来的可能装不上。
  const python = bundledPython();
  console.log(`  Downloading wheels (${ext.requirements.length} manifests)…`);
  const dl = spawnSync(python,
    ["-m", "pip", "download", ...ext.requirements.flatMap((r) => ["-r", r]), "-d", wheelDir],
    { windowsHide: true, stdio: "inherit", timeout: 3_600_000 });
  if (dl.status !== 0) fail(`pip download failed (exit code ${dl.status})`);
  const wheels = fs.readdirSync(wheelDir);
  if (!wheels.length) fail("Not a single wheel was downloaded");
  console.log(`  wheels: ${wheels.length}, ${mb(dirSize(wheelDir))} MB`);

  // ── 模型 ───────────────────────────────────────────────────────────
  for (const m of ext.models) {
    const dest = path.join(modelDir, m.file);
    if (m.dir) {
      // HF snapshot 是一整个目录，递归照搬；apply-extension.ps1 那边也是递归拷。
      //
      // 但要挡掉点开头的东西：`--dino <路径>` 很可能被指到一份 HF 缓存或者 git 克隆，
      // 那里面的 .git/、.cache/、.huggingface/ 会一起进 _full 档 exe——体积翻几倍不说，
      // .git 里还带着克隆来源和完整历史。模型本体从来不是点开头的，挡掉不会误伤。
      fs.cpSync(m.from, dest, {
        recursive: true,
        filter: (src) => !path.basename(src).startsWith("."),
      });
      console.log(`  model: ${m.file}/ (directory, ${mb(dirSize(dest))} MB)`);
    } else {
      fs.copyFileSync(m.from, dest);
      console.log(`  model: ${m.file}, ${mb(fs.statSync(m.from).size)} MB`);
    }
  }

  const manifest = buildManifest({ name, ext, wheels });
  fs.writeFileSync(path.join(root, "extension.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(__dirname, "apply-extension.ps1"), path.join(root, "apply-extension.ps1"));

  // 许可证跟着权重走
  if (ext.models.length) {
    fs.writeFileSync(path.join(root, "THIRD-PARTY-LICENSES.txt"), buildLicenseText(ext));
  }

  // ── 打包 ───────────────────────────────────────────────────────────
  const outDir = outDirFor(ext);
  mkdirp(outDir);
  const exePath = path.join(outDir, `${stem}.exe`);
  rmrf(exePath);
  console.log("  Packaging into an exe with NSIS…");
  const build = spawnSync(findMakensis(), [
    `-DVERSION=${ext.version}`,
    `-DLABEL=${ext.label}`,
    `-DSRCDIR=${root}`,
    `-DOUTFILE=${exePath}`,
    `-DICON=${path.join(DESKTOP_DIR, "src-tauri", "icons", "icon.ico")}`,
    path.join(__dirname, "extension-installer.nsi"),
  ], { windowsHide: true, encoding: "utf8", timeout: 3_600_000 });
  if (build.status !== 0 || !fs.existsSync(exePath)) {
    fail(`NSIS packaging failed (exit code ${build.status})\n${(build.stdout || "").slice(-2000)}${build.stderr || ""}`);
  }

  fs.writeFileSync(path.join(outDir, `ext-${name}-${ext.version}.json`), JSON.stringify(manifest, null, 2));
  // 许可证也放一份在产物旁边：发布时要往下载页贴，不该去 exe 里翻
  if (ext.models.length) {
    fs.writeFileSync(path.join(outDir, "THIRD-PARTY-LICENSES.txt"), buildLicenseText(ext));
  }
  // --keep-stage：exe 里到底进了哪些文件，打完就只剩一个自解压 exe，没有 7z 的机器上
  // 没法确认（NSIS 包不是 zip）。留下 stage 目录是最省事的核验方式：
  //   .cache/ext-stage/<stem>/ 里就是 File /r 收进 exe 的全部内容。
  if (argv.includes("--keep-stage")) {
    console.log(`  --keep-stage: stage kept at ${root} (these are the files inside the exe)`);
  } else {
    rmrf(STAGE_DIR);
  }
  console.log(`\n  extension library package: ${exePath} (${mb(fs.statSync(exePath).size)} MB)`);
}

// 被 import 时（测试）不跑主流程
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
