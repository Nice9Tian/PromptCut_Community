// Common part for P2 (cloud speech-to-text) real verification (placed in server/test/ because tests
// under server/ cannot import scripts/; probe scripts reference here in reverse): locate
// dependencies and generate assets. Assets go into out/p2-stt/ (ignored by .gitignore, not stored).
// Dependencies (Python, faster-whisper, weights) are neither stored nor downloaded: copied to
// out/p2-stt/ from an installed copy in main checkout (main checkout is read-only);
// copy is performed once only when absent in out/p2-stt/.
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
 * Main checkout directory. Works in .worktrees/<name> and inside main itself: computed from
 * parent of git's common directory (`--git-common-dir`), without guessing directory depth.
 * `P2_MAIN_ROOT` can override (for testing). Returns null if it cannot be determined.
 */
export function mainRootOf(root = ROOT) {
  if (process.env.P2_MAIN_ROOT) return path.resolve(process.env.P2_MAIN_ROOT);
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return path.dirname(path.resolve(r.stdout.trim()));
}

/**
 * Dependency sources, searched in order: this tree's out/…, then main checkout's out/…
 * (each directory listed only once); read-only
 */
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

/** Reports whatever is missing; returns null when all are present */
export function realDepsMissing() {
  if (!findPython()) return 'Built-in Python not found (PROMPTCUT_PYTHON or the main checkout\'s desktop/src-tauri/runtime/python)';
  if (!fs.existsSync(path.join(PATHS.pylibs, 'faster_whisper'))) return 'faster_whisper is missing from out/p2-stt/pylibs (run node cloud/scripts/probes/cloud-tools-p2-stt-probe.mjs --setup first)';
  if (!fs.existsSync(path.join(PATHS.models, MODEL_DIR))) return 'The faster-whisper small weights are missing from out/p2-stt/models (run --setup first)';
  if (!ffmpegBin()) return 'ffmpeg is not on PATH';
  return null;
}

/**
 * Copies installed pylibs and small weights into `<root>/out/p2-stt/` (sources searched in order of
 * `depSources`, read-only; leaves untouched if already present in target).
 * Inside .worktrees/<name>: takes from main checkout if absent in this tree; inside main: this tree
 * is the main checkout, takes its own out/pylibs and out/models.
 */
export function copyDeps({ root = ROOT, mainRoot = mainRootOf(root) } = {}) {
  const out = path.join(root, 'out', 'p2-stt');
  fs.mkdirSync(out, { recursive: true });
  const sources = depSources(root, mainRoot);
  const todo = [[sources.pylibs, path.join(out, 'pylibs')], [sources.models, path.join(out, 'models', MODEL_DIR)]];
  for (const [candidates, to] of todo) {
    if (fs.existsSync(to)) continue;
    const from = candidates.find((c) => fs.existsSync(c));
    if (!from) throw new Error(`No copyable source found, searched: ${candidates.join(', ')}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  }
}

/**
 * Creates realistic short media: reads a known English passage using Windows built-in speech
 * synthesis; then uses ffmpeg to assemble variants: with video, without audio track,
 * and long audio
 */
export function ensureMedia() {
  fs.mkdirSync(PATHS.media, { recursive: true });
  const m = (name) => path.join(PATHS.media, name);
  const need = (file) => !fs.existsSync(file) || fs.statSync(file).size === 0;
  const ff = (args) => {
    const r = run('ffmpeg', ['-v', 'error', '-y', ...args]);
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  const english = m('en-speech.wav');
  if (need(english)) {
    if (process.platform !== 'win32') throw new Error('en-speech.wav must be generated with Windows built-in speech synthesis; on other systems, put a wav that reads "quick brown fox" into out/p2-stt/media/ yourself');
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop'); $s.SetOutputToWaveFile('${english.replace(/'/g, "''")}'); $s.Speak('Hello. This is a short test of cloud speech recognition. The quick brown fox jumps over the lazy dog.'); $s.Dispose()`;
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
    if (r.status !== 0 || need(english)) throw new Error(`Speech synthesis failed: ${r.stderr}`);
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
