/**
 * PromptCut: Build "extension library packages".
 *
 * Third tier of three-tier release:
 *   Full installer (released on kernel generation upgrade) / update patch (changes to Node side) /
 *   extension library package (optional capabilities)
 *
 * Why it exists: speech-to-text, shot detection, and subject detection dependencies are currently
 * downloaded on the fly via pip install at runtime; they fail to install offline, on an intranet, or
 * when domestic network access is blocked, and every machine must re-download them. Extension
 * library packages pre-bundle wheels and models so they can be installed offline.
 *
 * Two tiers for users (only these two are published at release; users do not need to understand
 * how many models are inside):
 *   node scripts/make-extension.mjs light --transnet <t.onnx> --yunet <y.onnx> --rtdetr <r.onnx>
 *   node scripts/make-extension.mjs full  --transnet … --yunet … --rtdetr … \
 *                                         --bootstapir <b.pt> --dino <grounding-dino-tiny directory>
 *
 * Single-item packages for developers (legacy names, kept working, used to rebuild a single item):
 *   node scripts/make-extension.mjs shots --model <transnetv2.onnx>
 *   node scripts/make-extension.mjs track --model <bootstapir_v2.pt>
 *   node scripts/make-extension.mjs stt
 *
 * Artifact: release/extensions/_light|_full/PromptCut-ext-<name>-<version>.exe, double-click to install.
 * Separate directory: extension packages release versions at their own pace and are not the same
 * batch as installers/patches; when mixed together, one cannot tell at a glance in release/ "which
 * files should be given to users for this release".
 * Each of the two tiers has its own subdirectory: exe names in _light and _full differ by only one
 * word; keeping them flat together makes it very easy to send the wrong file to users.
 *
 * Pure logic (extension table, license hard gate, manifest) are all exported functions; see
 * desktop/test/make-extension.test.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
/** Keep extension packages separate; do not mix them with installers and patches in one directory */
const EXT_DIR = path.join(RELEASE_DIR, "extensions");
const STAGE_DIR = path.join(DESKTOP_DIR, ".cache", "ext-stage");

/** Extensions depend on app-side code (promptcut_shots / promptcut_subject / …); older versions lack it,
 *  so each extension must declare a minimum app version, blocking before install rather than failing self-check. */
export const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
).version;

const PY = path.join(PROJECT_ROOT, "python");
/** Dependency manifest per capability. light/full stitches these together, avoiding a separate copy and drift. */
const REQ = {
  shots: path.join(PY, "promptcut_shots", "requirements-shots.txt"),
  track: path.join(PY, "promptcut_track", "requirements-track.txt"),
  stt: path.join(PY, "requirements-faster-whisper.txt"),
  subjectLight: path.join(PY, "promptcut_subject", "requirements-subject-light.txt"),
  subjectFull: path.join(PY, "promptcut_subject", "requirements-subject-full.txt"),
};

/**
 * Full texts of the three licenses are in scripts/licenses/, with filenames as SPDX identifiers.
 * Full texts are shared (one MIT covers two models) while copyright notices are per-model, so full
 * texts are stored in separate files and copyright notices stay in MODEL_META, stitched together
 * by buildLicenseText.
 * Sources and comparison results against official SPDX texts are in scripts/licenses/README.md.
 */
const LICENSE_DIR = path.join(__dirname, "licenses");

/**
 * Recognized license identifiers = those with full text in the licenses/ directory.
 * Use directory contents as an allowlist rather than writing a separate table: if a spelling like
 * "Apache 2.0" (missing a hyphen) is used, no full text can be attached when packaging; the hard
 * gate must block it at this step rather than waiting until users receive the package.
 */
export const KNOWN_LICENSES = fs.existsSync(LICENSE_DIR)
  ? fs.readdirSync(LICENSE_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)).sort()
  : [];

/** Read license full text; throw if missing so CLI turns it into [FAIL], never packaging without it. */
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
 * Model weights distributed with the package. All fields other than file are license information:
 * missing any item prevents packaging (see assertModelMeta), and must match Section 9 of
 * desktop/THIRD-PARTY-LICENSES.md. from (local path) is supplied via CLI, not written to manifest.
 *
 * copyright is **optional**, and rather omitted than fabricated: when upstream has no copyright
 * notice (Apache-2.0 §4(c) requires retaining notices "already in Source form"), record this fact
 * in note; do not invent a line. Each copyright below was copied verbatim on 2026-09-07 using curl
 * from upstream LICENSE / source file headers.
 */
export const MODEL_META = {
  transnet: {
    file: "transnetv2.onnx",
    // No official ONNX; this copy was converted ourselves from official TF weights, see tools/transnetv2/README.md
    title: "TransNet V2",
    license: "MIT",
    source: "https://github.com/soCzech/TransNetV2",
    // Upstream LICENSE lists only Souček (previously had Jakub Lokoč, a paper author, not copyright notice)
    copyright: "Copyright (c) 2020 Tomáš Souček",
    note: "Weights were converted from the official TensorFlow checkpoint to PyTorch with the official convert_weights.py, then exported to ONNX; not retrained.",
  },
  bootstapir: {
    // Note this is .pt, not .onnx: TAPIR has 4 instances of 5D grid_sample, and all four torch export
    // paths fail to export ONNX, so this model directly bundles PyTorch to run raw weights.
    // As a result, the package containing it is much larger than the light tier (torch 194 MB + weights 208 MB).
    file: "bootstapir_v2.pt",
    title: "BootsTAPIR (TAP-Net)",
    license: "Apache-2.0",
    source: "https://github.com/google-deepmind/tapnet",
    // Upstream LICENSE is an unfilled Apache-2.0 template; copyright notice only in source headers, verbatim as shown
    copyright: "Copyright 2026 Google LLC",
    note: "The official checkpoint is included as is, with no conversion or retraining. The official statement says the checkpoints are under Apache 2.0, same as the code."
      + " (CoTracker3 was considered, but its whole repository is CC-BY-NC, which forbids commercial use and so cannot ship with the package; this model was used instead.)",
  },
  yunet: {
    file: "yunet.onnx",
    title: "YuNet (libfacedetection)",
    // MIT is not Apache-2.0: opencv_zoo root repo is indeed Apache-2.0, but README explicitly states
    // "Please refer to licenses of different models", and this model directory comes with its own
    // MIT LICENSE, which takes precedence. Verified by curling LICENSE in that directory on 2026-09-07.
    license: "MIT",
    // source is specific to the model directory; pointing to the root repository reads as Apache-2.0
    source: "https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet",
    copyright: "Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>",
    // Training upstream for weights is another repository with another license; full text must also be attached
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
    // No copyright field: upstream has no retainable copyright notice, see note below; do not invent a line
    note: "Exported from HF weights via torch.onnx.export; not retrained; training set COCO."
      + "Upstream declares no copyright line: the LICENSE of lyuwenyu/RT-DETR is an unfilled Apache-2.0 template (it still ends with the"
      + "\"Copyright [yyyy] [name of copyright owner]\" placeholder), and the HF repository PekingU/rtdetr_r18vd has no LICENSE file,"
      + "so no copyright line is written here. Original release: https://github.com/lyuwenyu/RT-DETR , the HF mirror is labeled apache-2.0.",
  },
  dino: {
    // The only directory-type model: HF snapshot is a complete set of config + safetensors + tokenizer;
    // splitting it makes no sense, goes into models/grounding-dino-tiny/ as is.
    file: "grounding-dino-tiny",
    dir: true,
    title: "Grounding DINO Tiny",
    license: "Apache-2.0",
    source: "https://huggingface.co/IDEA-Research/grounding-dino-tiny",
    // The line filled in the LICENSE appendix of the upstream GroundingDINO repository, verbatim as shown
    copyright: "Copyright 2023 - present, IDEA Research.",
    note: "HF snapshot is included as is (safetensors); versions 1.5/1.6 are not open source, and this package uses the open-source 1.0.",
  },
};

const model = (key, from) => ({ ...MODEL_META[key], from: from || null });

/**
 * What each extension installs.
 * requirements fetches wheels via pip download (multiple can be provided; pip supports multiple -r);
 * models are files or directories bundled directly with the package.
 * provides indicates which promptcut_* modules this package makes available: installer uses it for
 * per-item self-checks.
 *
 * @param {{model?:string, transnet?:string, bootstapir?:string,
 *          yunet?:string, rtdetr?:string, dino?:string}} src Local path of each model file
 */
export function makeExtensions(src = {}) {
  const light = {
    label: "Light tier",
    tier: "light",
    version: "1.0.0",
    // Subject detection (promptcut_subject) was added in this version; shot detection was earlier (0.2.5), take larger
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
    // Motion tracking 0.2.6, subject detection 0.2.8, take the larger one
    requiresApp: "0.2.8",
    provides: ["shots", "subject", "track"],
    // full is just light plus two items, not listed again: missing a change leads to "full is missing items instead"
    requirements: [...light.requirements, REQ.track, REQ.subjectFull],
    models: [...light.models, model("bootstapir", src.bootstapir), model("dino", src.dino)],
    note: "On top of the Light tier, adds: motion tracking uses BootsTAPIR for arbitrary point tracking, which can re-identify targets after they turn, deform, or are occluded;"
      + "subject detection gains an open-vocabulary tier (Grounding DINO), which can find targets from any text prompt (for example \"red cup\")."
      + " Includes PyTorch, so the package is much larger.",
  };

  return {
    light,
    full,
    // ── Below are single-item packages split by capability for developers to rebuild one item; users get the two tiers above ──
    shots: {
      label: "Shot detection",
      version: "1.0.0",
      requiresApp: "0.2.5",  // promptcut_shots was added in this version
      provides: ["shots"],
      requirements: [REQ.shots],
      models: [model("transnet", src.model ?? src.transnet)],
      note: "After install, \"shot-cut detection\" uses TransNetV2, which recognizes both hard cuts and dissolves; without it, it falls back to ffmpeg scdet, which recognizes only hard cuts.",
    },
    track: {
      label: "Motion tracking",
      version: "1.0.0",
      requiresApp: "0.2.6",  // promptcut_track was added in this version
      provides: ["track"],
      requirements: [REQ.track],
      models: [model("bootstapir", src.model ?? src.bootstapir)],
      note: "After installation, \"Motion tracking\" uses BootsTAPIR for arbitrary point tracking: it understands the image content and can re-identify targets after they turn, deform, or are occluded for a long time. Without it, tracking falls back to numpy template matching, which tracks rigid, clearly textured targets accurately but loses targets that turn or are occluded for long.",
    },
    stt: {
      label: "Speech recognition",
      version: "1.0.0",
      requiresApp: "0.1.0",  // Speech-to-text was added early on
      provides: ["stt"],
      requirements: [REQ.stt],
      models: [],  // Voice models are downloaded on demand and not bundled, so there are no weights needing license declarations here
      note: "After installation, speech-to-text no longer needs to download dependencies online; models are still downloaded on demand.",
    },
  };
}

export const EXTENSION_NAMES = Object.keys(makeExtensions());

/**
 * License hard gate: weights are distributed to users with the package; packaging is disallowed
 * without clearly specified licenses.
 * Do not expect anyone to remember to backfill THIRD-PARTY-LICENSES.md before release.
 * @throws {Error} Thrown when fields are missing, which the CLI converts to [FAIL] and exits.
 */
export function assertModelMeta(m) {
  for (const field of ["file", "title", "license", "source"]) {
    if (!m[field]) {
      throw new Error(`Model ${m.file || "(unnamed)"} is missing ${field}: weights shipped in the package must state their license clearly, `
        + `and sync it to desktop/THIRD-PARTY-LICENSES.md`);
    }
  }
  // License name must be an SPDX identifier, and licenses/ must have the corresponding full text.
  // Merely writing a name does not fulfill the "accompanying full text" obligation of MIT/Apache/BSD,
  // so these two things share the same gate.
  for (const id of [m.license, ...(m.alsoLicenses || []).map((a) => a.id)]) {
    if (!KNOWN_LICENSES.includes(id)) {
      throw new Error(`Model ${m.file} has license "${id}", which is not a recognized SPDX identifier`
        + ` (recognized: ${KNOWN_LICENSES.join(" / ")}). The spelling must match https://spdx.org/licenses/; `
        + `if it really is a new license, put the full text in desktop/scripts/licenses/<SPDX identifier>.txt`);
    }
  }
}

/** Manifest bundled with package. from is a local path on the build machine and must never be written in. */
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
 * THIRD-PARTY-LICENSES.txt inside the package: whoever gets the package should not need to dig
 * through repo docs to find out what licenses are inside.
 *
 * The top half is a per-model inventory, and the bottom half is the **full license text**. This full
 * text section is not an optional layout choice: MIT requires "the above copyright notice and this
 * permission notice shall be included in all copies", Apache-2.0 §4(a) requires "give any other
 * recipients a copy of this License", and BSD-3-Clause Clause 2 requires reproducing the full
 * conditions in binary distributions: releasing only a list with license names fulfills none of
 * these three. Originally there was only a list, so this file was non-compliant before 2026-09-07.
 *
 * When the same full text is shared by multiple models, it appears only once, with the header
 * clearly listing which models it applies to and what each one's copyright notice is.
 */
export function buildLicenseText(ext) {
  // Collect licenses actually used by this package → which "work + copyright notice" each applies to
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
    // Full texts use \n; the list half is normalized to \n when concatenating, then converted together
    // to CRLF: a .txt with mixed newlines merges into one line in older Notepad versions, looking like a mess.
  ].join("\n").replace(/\r?\n/g, "\r\n");
}

/** Two tiers each have a subdirectory; single-item packages remain flat under extensions/ */
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

/** Bundled interpreter: downloading wheels with it guarantees ABI compatibility with user machines */
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

/** Which CLI flag each model should use: when an error occurs, tell people directly what to type */
const FLAG_OF = { transnet: "--transnet", yunet: "--yunet", rtdetr: "--rtdetr", bootstapir: "--bootstapir", dino: "--dino" };
const flagFor = (file, ext) => {
  const key = Object.keys(MODEL_META).find((k) => MODEL_META[k].file === file);
  if (!key) return "--model";
  // Single-item packages have only one model, historically --model; two-tier packages have several, must name them
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
  // License hard gate and model path checks are moved before downloading wheels: full tier downloads
  // 177 MB of wheels; missing a single --yunet wastes several minutes waiting only to get rejected.
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
  // pip download using bundled interpreter: wheel ABI tag must match the interpreter on the user
  // machine; wheels downloaded using python on development machines might fail to install.
  const python = bundledPython();
  console.log(`  Downloading wheels (${ext.requirements.length} manifests)…`);
  const dl = spawnSync(python,
    ["-m", "pip", "download", ...ext.requirements.flatMap((r) => ["-r", r]), "-d", wheelDir],
    { windowsHide: true, stdio: "inherit", timeout: 3_600_000 });
  if (dl.status !== 0) fail(`pip download failed (exit code ${dl.status})`);
  const wheels = fs.readdirSync(wheelDir);
  if (!wheels.length) fail("Not a single wheel was downloaded");
  console.log(`  wheels: ${wheels.length}, ${mb(dirSize(wheelDir))} MB`);

  // ── Models ─────────────────────────────────────────────────────────
  for (const m of ext.models) {
    const dest = path.join(modelDir, m.file);
    if (m.dir) {
      // HF snapshot is an entire directory, copied recursively as is; apply-extension.ps1 also copies recursively.
      //
      // But filter out dot-prefixed items: `--dino <path>` might point to an HF cache or git clone, where
      // .git/, .cache/, .huggingface/ would be included in the _full tier exe: not only multiplying size,
      // but .git also carries the clone source and full history. The model itself never starts with a dot,
      // so filtering will not cause false positives.
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

  // Licenses follow weights
  if (ext.models.length) {
    fs.writeFileSync(path.join(root, "THIRD-PARTY-LICENSES.txt"), buildLicenseText(ext));
  }

  // ── Packaging ───────────────────────────────────────────────────────
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
  // Place a license copy next to artifact: needs pasting to download page upon release, not digging into exe
  if (ext.models.length) {
    fs.writeFileSync(path.join(outDir, "THIRD-PARTY-LICENSES.txt"), buildLicenseText(ext));
  }
  // --keep-stage: which files actually went into the exe; once built only a self-extracting exe
  // remains, which cannot be verified on machines without 7z (NSIS packages are not zip). Leaving the
  // stage directory is the most effortless verification method:
  //   .cache/ext-stage/<stem>/ contains the entire content bundled into the exe via File /r.
  if (argv.includes("--keep-stage")) {
    console.log(`  --keep-stage: stage kept at ${root} (these are the files inside the exe)`);
  } else {
    rmrf(STAGE_DIR);
  }
  console.log(`\n  extension library package: ${exePath} (${mb(fs.statSync(exePath).size)} MB)`);
}

// Do not run main flow when imported (tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
