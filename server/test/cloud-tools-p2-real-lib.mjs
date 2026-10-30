// P2(云端语音转写)真实验证的公共部分(放在 server/test/ 是因为 server/ 下的测试不许 import scripts/;探针脚本反过来引用这里):找依赖、造素材。素材放 out/p2-stt/(被 .gitignore 忽略,不入库)。
// 依赖(Python、faster-whisper、权重)不入库也不下载:从主工作区已装好的一份复制到 out/p2-stt/(只读主工作区),
// 复制只在 out/p2-stt/ 里没有时做一次。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const OUT = path.join(ROOT, 'out', 'p2-stt');
export const PATHS = {
  root: ROOT,
  out: OUT,
  pylibs: path.join(OUT, 'pylibs'),
  models: path.join(OUT, 'models'),
  media: path.join(OUT, 'media'),
  sourceRoot: path.join(ROOT, 'python'),
};
const MODEL_DIR = 'models--Systran--faster-whisper-small';

/**
 * 主工作区目录。在 .worktrees/<名> 里和在 main 自己里都对:用 git 的公共目录(`--git-common-dir`)的上一级求,不靠目录层数猜。
 * `P2_MAIN_ROOT` 可以覆盖(测试用)。求不出来回 null。
 */
export function mainRootOf(root = ROOT) {
  if (process.env.P2_MAIN_ROOT) return path.resolve(process.env.P2_MAIN_ROOT);
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return path.dirname(path.resolve(r.stdout.trim()));
}

/** 依赖的来源,按顺序找:本树的 out/…,再主工作区的 out/…(同一个目录只列一次);只读 */
export function depSources(root = ROOT, mainRoot = mainRootOf(root)) {
  const roots = [...new Set([root, mainRoot].filter(Boolean).map((r) => path.resolve(r)))];
  return { roots, pylibs: roots.map((r) => path.join(r, 'out', 'pylibs')), models: roots.map((r) => path.join(r, 'out', 'models', MODEL_DIR)) };
}

export function findPython(root = ROOT, mainRoot = mainRootOf(root)) {
  const candidates = [process.env.PROMPTCUT_PYTHON,
    ...depSources(root, mainRoot).roots.map((r) => path.join(r, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'))].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 120_000, ...options });
}

export const ffmpegBin = () => (run('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null);

/** 缺什么就说缺什么;齐了回 null */
export function realDepsMissing() {
  if (!findPython()) return '没有找到内置 Python(PROMPTCUT_PYTHON 或主工作区 desktop/src-tauri/runtime/python)';
  if (!fs.existsSync(path.join(PATHS.pylibs, 'faster_whisper'))) return 'out/p2-stt/pylibs 里没有 faster_whisper(先跑 node scripts/probes/cloud-tools-p2-stt-probe.mjs --setup)';
  if (!fs.existsSync(path.join(PATHS.models, MODEL_DIR))) return 'out/p2-stt/models 里没有 faster-whisper small 的权重(先跑 --setup)';
  if (!ffmpegBin()) return 'PATH 上没有 ffmpeg';
  return null;
}

/**
 * 把已装好的 pylibs 和 small 权重复制进 `<root>/out/p2-stt/`(来源按 `depSources` 的顺序找,只读;目标里已有就不动)。
 * 在 .worktrees/<名> 里:本树没有就取主工作区的;在 main 里:本树就是主工作区,取自己的 out/pylibs、out/models。
 */
export function copyDeps({ root = ROOT, mainRoot = mainRootOf(root) } = {}) {
  const out = path.join(root, 'out', 'p2-stt');
  fs.mkdirSync(out, { recursive: true });
  const sources = depSources(root, mainRoot);
  const todo = [[sources.pylibs, path.join(out, 'pylibs')], [sources.models, path.join(out, 'models', MODEL_DIR)]];
  for (const [candidates, to] of todo) {
    if (fs.existsSync(to)) continue;
    const from = candidates.find((c) => fs.existsSync(c));
    if (!from) throw new Error(`找不到可复制的来源,找过:${candidates.join('、')}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  }
}

/** 造真实的短素材:Windows 系统自带的合成语音念一段已知的英文;再用 ffmpeg 拼成带视频、无音轨、长音频几种 */
export function ensureMedia() {
  fs.mkdirSync(PATHS.media, { recursive: true });
  const m = (name) => path.join(PATHS.media, name);
  const need = (file) => !fs.existsSync(file) || fs.statSync(file).size === 0;
  const ff = (args) => {
    const r = run('ffmpeg', ['-v', 'error', '-y', ...args]);
    if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
  };
  const english = m('en-speech.wav');
  if (need(english)) {
    if (process.platform !== 'win32') throw new Error('en-speech.wav 要用 Windows 自带合成语音生成;其它系统请自己放一份念「quick brown fox」的 wav 到 out/p2-stt/media/');
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop'); $s.SetOutputToWaveFile('${english.replace(/'/g, "''")}'); $s.Speak('Hello. This is a short test of cloud speech recognition. The quick brown fox jumps over the lazy dog.'); $s.Dispose()`;
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
    if (r.status !== 0 || need(english)) throw new Error(`合成语音失败:${r.stderr}`);
  }
  const chinese = m('zh-speech.wav');
  if (need(chinese)) fs.copyFileSync(path.join(ROOT, 'src', 'audio', 'assets', 'missing-material.wav'), chinese);
  const video = m('en-speech-video.mp4');
  if (need(video)) ff(['-f', 'lavfi', '-i', 'testsrc=d=10:s=160x120:r=10', '-i', english, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  const silentVideo = m('silent-video.mp4');
  if (need(silentVideo)) ff(['-f', 'lavfi', '-i', 'testsrc=d=2:s=160x120:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo]);
  const long = m('en-speech-long.wav');
  if (need(long)) ff(['-stream_loop', '5', '-i', english, '-c', 'copy', long]);
  return { english, chinese, video, silentVideo, long };
}
