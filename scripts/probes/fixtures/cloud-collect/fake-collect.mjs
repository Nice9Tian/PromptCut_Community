#!/usr/bin/env node
/**
 * **Downloader stand-in** for Cloud Agent web collection (test fixture; used by
 * `server/test/cloud-agent-collect.test.mjs` and `scripts/probes/cloud-agent-collect-probe.mjs`).
 *
 * There is no yt-dlp on this dev machine, and installing it for testing is not permitted. This script
 * replaces `python -m promptcut_collect <subcommand>`: speaks the same CLI and JSONL, and **accesses
 * the network only via proxies in the environment, just like the real downloader** (`HTTP_PROXY`):
 * so the entire "child process accesses network via egress gate proxy, writes to disk, stores into
 * library, records usage" chain can be fully verified with it; the real yt-dlp is left to be verified
 * on nodes.
 *
 * It is also a read-only, report-only boundary probe fixture (using the same approach defined in the
 * "Boundary probe card" section at the end of `docs/plan/sound-online-render-task.md`): it writes the
 * environment it sees (working directory, **names** of environment variables, whether any
 * `PROMPTCUT_*` exists) into the `status` response for the probe to assert; it reads no other files,
 * modifies nothing, and only sends requests to the address provided by the caller (the probe only
 * supplies stand-ins on the local loopback).
 *
 * Usage (started by Agent service): node fake-collect.mjs status | probe --url U | search --query Q | download --url U --out-dir D
 * Tokens in the address (used by the probe to select behavior):
 *   …/slow      Writes a chunk every 200 ms during download without stopping (verifies cancellation, time limit, size limit)
 *   …/outside   Reports a file path outside the job directory after download (verifies "paths elsewhere are completely rejected")
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const argv = process.argv.slice(2);
const sub = argv[0];
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy || '';

/** Sends a plaintext HTTP request via the proxy in the environment; fails directly if there is no proxy (the real downloader also only recognizes proxies here) */
function viaProxy(url, { onChunk } = {}) {
  return new Promise((resolve, reject) => {
    if (!proxyUrl) return reject(new Error('no proxy in environment'));
    const p = new URL(proxyUrl);
    const req = http.request({ host: p.hostname, port: p.port, method: 'GET', path: url, headers: { Host: new URL(url).host } }, (res) => {
      const chunks = [];
      res.on('data', (d) => { if (onChunk) onChunk(d); else chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const fail = (message, code = 1) => { emit({ event: 'error', message }); process.exit(code); };

async function main() {
  if (sub === 'status') {
    emit({
      event: 'status', version: 'fake', ready: true, ytdlp: { installed: true, version: 'fake-stand-in', error: null }, ffmpeg: '/fake/ffmpeg', pylibs: null,
      presets: [{ name: 'bilibili', notes: 'fake' }, { name: 'generic', notes: 'fake' }],
      // Read-only, report-only: environment seen by child process itself (names only, no values)
      seen: {
        cwd: process.cwd(),
        envNames: Object.keys(process.env).sort(),
        promptcutEnv: Object.keys(process.env).filter((k) => /^PROMPTCUT_/i.test(k)),
        proxy: !!proxyUrl,
        home: process.env.HOME ?? process.env.USERPROFILE ?? null,
        tmp: process.env.TMPDIR ?? process.env.TEMP ?? null,
      },
    });
    return;
  }
  if (sub === 'search') {
    emit({ event: 'done', query: opt('--query'), site: opt('--site') ?? 'bilibili', results: [{ id: 'BV1FAKE00000', title: 'Fake Search Hit', url: 'https://www.bilibili.com/video/BV1FAKE00000', duration: 12.5, uploader: 'tester', view_count: 1234, max_height: 1080 }], warnings: [] });
    return;
  }
  const url = opt('--url');
  if (!url || !/^http:\/\//.test(url)) fail('fake-collect: only http:// URLs are accepted');
  if (sub === 'probe') {
    let res;
    try { res = await viaProxy(url); } catch (err) { fail(`Unable to download webpage: ${err.message}`); }
    if (res.status !== 200) fail(`Unable to download webpage: HTTP Error ${res.status}${res.headers['x-egress-refused'] ? ` (egress refused: ${res.headers['x-egress-refused']})` : ''}`);
    const duration = Number(res.headers['x-fake-duration'] ?? 12.5);
    emit({ event: 'done', id: 'FAKE0001', title: 'Fake Video', duration, uploader: 'tester', extractor: 'fake', site: 'generic', url, heights: [1080, 720], parts: null, subtitles: [], formats: [{ big: 'x'.repeat(100) }], warnings: [] });
    return;
  }
  if (sub === 'download') {
    const outDir = opt('--out-dir');
    if (!outDir) fail('fake-collect: --out-dir is required');
    emit({ event: 'start', url, out_dir: outDir, quality: Number(opt('--quality') ?? 1080) });
    const filename = 'Fake Clip [FAKE0001].mp4';
    const file = path.join(outDir, filename);
    const fd = fs.openSync(file, 'w');
    let bytes = 0;
    let res;
    let announced = false;
    try {
      res = await viaProxy(url, {
        onChunk: (d) => {
          fs.writeSync(fd, d); bytes += d.length;
          emit({ event: 'progress', stage: 'video', percent: 50, overall: 45, downloaded: bytes, speed: 1000, eta: 1 });
        },
      });
    } catch (err) {
      fs.closeSync(fd);
      fail(`ERROR: ${err.message}`);
    }
    fs.closeSync(fd);
    if (res.status !== 200) fail(`HTTP Error ${res.status}${res.headers['x-egress-refused'] ? ` (egress refused: ${res.headers['x-egress-refused']})` : ''}`);
    if (!announced) { announced = true; emit({ event: 'info', id: 'FAKE0001', title: 'Fake Video', duration: Number(res.headers['x-fake-duration'] ?? 12.5), uploader: 'tester', site: 'generic', webpage_url: url }); }
    emit({ event: 'progress', stage: 'merge', percent: 100 });
    if (/\/outside$/.test(new URL(url).pathname)) {
      // Report a path outside the job directory: caller only recognizes files at this level in job directory
      emit({ event: 'item', id: 'FAKE0001', title: 'Outside', path: path.resolve(outDir, '..', '..', 'attachments', 'not-mine.mp4'), filename: '../../attachments/not-mine.mp4', bytes });
    } else {
      emit({ event: 'item', id: 'FAKE0001', title: 'Fake Video', path: file, filename, bytes, vcodec: 'h264', width: 1920, height: 1080, fps: 30, duration: 12.5, transcoded: false, audio_only: false });
    }
    emit({ event: 'done', items: [], site: 'generic', url, warnings: [] });
    return;
  }
  if (sub === 'install') fail('fake-collect: the cloud should not call install', 2);
  fail(`fake-collect: unknown subcommand ${sub}`, 2);
}

main().catch((err) => fail(String(err?.message ?? err)));
