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
    throw new Error(`没有 ${spdxId} 的许可证全文（找不到 ${p}）：`
      + `MIT / Apache-2.0 / BSD-3-Clause 都要求随分发附带全文，只写许可证名字不算数。`
      + `新增许可证时把全文按 SPDX 标识符命名放进 desktop/scripts/licenses/。`);
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
    note: "权重由官方 TensorFlow checkpoint 经官方 convert_weights.py 转 PyTorch 后导出 ONNX，未再训练。",
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
    note: "官方 checkpoint 原样收录，未做任何转换或再训练。官方说明 checkpoints 与代码同为 Apache 2.0。"
      + "（曾考虑 CoTracker3，因其全仓库为 CC-BY-NC、禁止商用，不能随包分发，故改用本模型。）",
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
      why: "权重的训练上游 ShiqiYu/libfacedetection.train（https://github.com/ShiqiYu/libfacedetection.train）",
      copyright: "Copyright (c) 2022-2026, Shiqi Yu <shiqi.yu@gmail.com>",
    }],
    note: "官方 ONNX（face_detection_yunet_2023mar.onnx）原样收录，未做转换或再训练。"
      + "许可证以模型目录内的 LICENSE 为准 = MIT；权重的训练上游 ShiqiYu/libfacedetection.train 是 BSD-3-Clause，"
      + "两份全文都随包附带。训练集 WIDER FACE 的数据集条款为非商用，业界普遍仍按模型自身的许可证分发，分发前请自行评估。",
  },
  rtdetr: {
    file: "rtdetr_r18vd.onnx",
    title: "RT-DETR-R18vd",
    license: "Apache-2.0",
    source: "https://huggingface.co/PekingU/rtdetr_r18vd",
    // 没有 copyright 字段：上游没有可保留的版权声明，见下面 note，不编一行
    note: "由 HF 权重经 torch.onnx.export 导出，未再训练；训练集 COCO。"
      + "上游未声明版权行 —— lyuwenyu/RT-DETR 的 LICENSE 是未填写的 Apache-2.0 模板（结尾仍是"
      + "「Copyright [yyyy] [name of copyright owner]」占位符），HF 仓库 PekingU/rtdetr_r18vd 里没有 LICENSE 文件，"
      + "故此处不写版权行。原始发布：https://github.com/lyuwenyu/RT-DETR ，HF 镜像标注 apache-2.0。",
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
    note: "HF snapshot 原样收录（safetensors）；1.5/1.6 版不开源，本包用的是开源的 1.0。",
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
    label: "轻装档",
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
    note: "装完后：镜头切换识别用 TransNetV2（认得硬切也认得溶解）；主体检测用 YuNet + RT-DETR，"
      + "能告诉 AI 人脸和人体在画面哪儿、哪一侧是空的，卡片就不会盖住人脸。都只用 onnxruntime，包不大。",
  };
  const full = {
    label: "完整档",
    tier: "full",
    version: "1.0.0",
    // 运动追踪 0.2.6、主体检测 0.2.8，取大的那个
    requiresApp: "0.2.8",
    provides: ["shots", "subject", "track"],
    // full 就是 light 再加两样，不重新列一遍：漏改一处就会出现「full 反而少东西」
    requirements: [...light.requirements, REQ.track, REQ.subjectFull],
    models: [...light.models, model("bootstapir", src.bootstapir), model("dino", src.dino)],
    note: "在轻装档之上再加：运动追踪用 BootsTAPIR 做任意点追踪，目标转向、形变、被挡后还能重新认出；"
      + "主体检测多一个开放词汇档（Grounding DINO），能按任意文字提示找目标（例如「红色的杯子」）。"
      + "带 PyTorch，包大得多。",
  };

  return {
    light,
    full,
    // ── 以下是按能力拆开的单项包，给开发者单独重打某一项用，发布给用户的是上面两档 ──
    shots: {
      label: "镜头识别",
      version: "1.0.0",
      requiresApp: "0.2.5",  // promptcut_shots 是这一版加进去的
      provides: ["shots"],
      requirements: [REQ.shots],
      models: [model("transnet", src.model ?? src.transnet)],
      note: "装完后「镜头切换识别」会用 TransNetV2，认得硬切也认得溶解；不装则退回 ffmpeg scdet，只认硬切。",
    },
    track: {
      label: "运动追踪",
      version: "1.0.0",
      requiresApp: "0.2.6",  // promptcut_track 是这一版加进去的
      provides: ["track"],
      requirements: [REQ.track],
      models: [model("bootstapir", src.model ?? src.bootstapir)],
      note: "装完后「运动追踪」用 BootsTAPIR 做任意点追踪，理解画面内容，目标转向、形变、长时间被挡后还能重新认出；不装则退回 numpy 的模板匹配兜底，刚体且纹理清晰的目标追得很准，但目标转向或长时间被挡就会跟丢。",
    },
    stt: {
      label: "语音识别",
      version: "1.0.0",
      requiresApp: "0.1.0",  // 语音识别很早就有了
      provides: ["stt"],
      requirements: [REQ.stt],
      models: [],  // 语音模型按需下载，不随包发，所以这里没有要声明许可证的权重
      note: "装完后语音转文字不再需要联网下载依赖；模型仍按需下载。",
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
      throw new Error(`模型 ${m.file || "(未命名)"} 缺少 ${field}：随包分发的权重必须写清楚许可证，`
        + `并同步到 desktop/THIRD-PARTY-LICENSES.md`);
    }
  }
  // 许可证名字必须是 SPDX 标识符，而且 licenses/ 下要有对应的全文。
  // 只写个名字不算履行 MIT/Apache/BSD 的「附带全文」义务，所以这两件事是同一道闸。
  for (const id of [m.license, ...(m.alsoLicenses || []).map((a) => a.id)]) {
    if (!KNOWN_LICENSES.includes(id)) {
      throw new Error(`模型 ${m.file} 的 license "${id}" 不是认得的 SPDX 标识符`
        + `（认得的：${KNOWN_LICENSES.join(" / ")}）。拼写要和 https://spdx.org/licenses/ 一致；`
        + `确实是新许可证就把全文放进 desktop/scripts/licenses/<SPDX 标识符>.txt`);
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
    const work = `${m.title}（${m.file}${m.dir ? "/" : ""}）`;
    add(m.license, { work, copyright: m.copyright || null, why: null });
    for (const a of m.alsoLicenses || []) {
      add(a.id, { work, copyright: a.copyright || null, why: a.why });
    }
  }

  const sep = "=".repeat(78);
  const licenseSections = [...byLicense.entries()].flatMap(([id, uses], i) => [
    sep,
    `许可证全文 ${i + 1}/${byLicense.size}：${id}`,
    sep,
    "适用于：",
    ...uses.flatMap((u) => [
      `  · ${u.work}${u.why ? ` —— ${u.why}` : ""}`,
      u.copyright ? `      ${u.copyright}` : "      （上游未声明版权行，见上面该模型的说明）",
    ]),
    "",
    "下面是全文；其中的占位符（<year> <copyright holders> 之类）按上面各自的版权行理解。",
    "",
    licenseFullText(id),
    "",
    "",
  ]);

  return [
    `PromptCut ${ext.label} 拓展库 ${ext.version} — 第三方许可证`,
    "",
    "本包内含以下第三方模型权重。每份权重的许可证全文附在本文件末尾，",
    "安装后会和模型一起放到 %APPDATA%\\com.promptcut.desktop\\models\\ 下。",
    "",
    ...ext.models.flatMap((m) => [
      `## ${m.title}（${m.file}${m.dir ? "/" : ""}）`,
      `- 许可证：${m.license}`
        + ((m.alsoLicenses || []).length ? `（另附 ${m.alsoLicenses.map((a) => a.id).join(" / ")}，见末尾）` : ""),
      `- 来源：${m.source}`,
      ...(m.copyright ? [`- 版权：${m.copyright}`] : []),
      ...(m.note ? [`- 说明：${m.note}`] : []),
      "",
    ]),
    "Python 依赖（wheels/ 目录）各自的许可证见各 wheel 内的 METADATA / LICENSE。",
    "其中 certifi 与 tqdm 为 MPL-2.0，按 MPL §3.2 告知源码获取途径：",
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
  fail("找不到自带的 Python（desktop/src-tauri/runtime/python），先跑 npm run prepare-python");
}

function findMakensis() {
  const bundled = path.join(process.env.LOCALAPPDATA || "", "tauri", "NSIS", "Bin", "makensis.exe");
  if (fs.existsSync(bundled)) return bundled;
  const probe = spawnSync("makensis", ["/VERSION"], { windowsHide: true, encoding: "utf8" });
  if (probe.status === 0 || probe.stdout) return "makensis";
  fail("找不到 makensis。先跑一次 npm run build 让 Tauri 把 NSIS 装下来。");
}

/** 哪个模型该用哪个命令行开关 —— 报错时要能直接告诉人该敲什么 */
const FLAG_OF = { transnet: "--transnet", yunet: "--yunet", rtdetr: "--rtdetr", bootstapir: "--bootstapir", dino: "--dino" };
const flagFor = (file, ext) => {
  const key = Object.keys(MODEL_META).find((k) => MODEL_META[k].file === file);
  if (!key) return "--model";
  // 单项包只有一个模型，历史上就叫 --model；两档包有好几个，必须点名
  return ext.tier ? FLAG_OF[key] : `--model（或 ${FLAG_OF[key]}）`;
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
    fail(`用法：node scripts/make-extension.mjs <${Object.keys(table).join("|")}>\n`
      + `  light --transnet <t.onnx> --yunet <y.onnx> --rtdetr <r.onnx>\n`
      + `  full  上面三个 + --bootstapir <b.pt> --dino <grounding-dino-tiny 目录>\n`
      + `  --keep-stage  打完不删 .cache/ext-stage，用来核对 exe 里到底进了哪些文件`);
  }
  const ext = table[name];
  console.log(`PromptCut make-extension：${ext.label} ${ext.version}（提供 ${ext.provides.join(" / ")}）`);

  for (const r of ext.requirements) {
    if (!fs.existsSync(r)) fail(`找不到依赖清单 ${r}`);
  }
  // 许可证硬闸和模型路径检查都提前到下载 wheel 之前：full 档要下 177 MB 轮子，
  // 少打一个 --yunet 就白等好几分钟才被拒，太亏
  for (const m of ext.models) {
    try { assertModelMeta(m); } catch (e) { fail(e.message); }
    if (!m.from) fail(`${ext.label} 需要模型${m.dir ? "目录" : "文件"} ${m.file}，用 ${flagFor(m.file, ext)} <路径> 指定`
      + `（怎么来的见 tools/subject/README.md 和 tools/transnetv2/README.md）`);
    if (!fs.existsSync(m.from)) fail(`模型${m.dir ? "目录" : "文件"}不存在：${m.from}`);
    const isDir = fs.statSync(m.from).isDirectory();
    if (m.dir && !isDir) fail(`${m.file} 应该是一个目录，给的是文件：${m.from}`);
    if (!m.dir && isDir) fail(`${m.file} 应该是一个文件，给的是目录：${m.from}`);
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
  console.log(`  下载 wheel（${ext.requirements.length} 份清单）…`);
  const dl = spawnSync(python,
    ["-m", "pip", "download", ...ext.requirements.flatMap((r) => ["-r", r]), "-d", wheelDir],
    { windowsHide: true, stdio: "inherit", timeout: 3_600_000 });
  if (dl.status !== 0) fail(`pip download 失败（退出码 ${dl.status}）`);
  const wheels = fs.readdirSync(wheelDir);
  if (!wheels.length) fail("一个 wheel 都没下到");
  console.log(`  wheel：${wheels.length} 个，${mb(dirSize(wheelDir))} MB`);

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
      console.log(`  模型：${m.file}/（目录，${mb(dirSize(dest))} MB）`);
    } else {
      fs.copyFileSync(m.from, dest);
      console.log(`  模型：${m.file}，${mb(fs.statSync(m.from).size)} MB`);
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
  console.log("  用 NSIS 打成 exe…");
  const build = spawnSync(findMakensis(), [
    `-DVERSION=${ext.version}`,
    `-DLABEL=${ext.label}`,
    `-DSRCDIR=${root}`,
    `-DOUTFILE=${exePath}`,
    `-DICON=${path.join(DESKTOP_DIR, "src-tauri", "icons", "icon.ico")}`,
    path.join(__dirname, "extension-installer.nsi"),
  ], { windowsHide: true, encoding: "utf8", timeout: 3_600_000 });
  if (build.status !== 0 || !fs.existsSync(exePath)) {
    fail(`NSIS 打包失败（退出码 ${build.status}）\n${(build.stdout || "").slice(-2000)}${build.stderr || ""}`);
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
    console.log(`  --keep-stage：stage 留在 ${root}（exe 里就是这些文件）`);
  } else {
    rmrf(STAGE_DIR);
  }
  console.log(`\n  拓展库包：${exePath}（${mb(fs.statSync(exePath).size)} MB）`);
}

// 被 import 时（测试）不跑主流程
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
