/**
 * C1 探针与真东西测试用的「要登录才给高画质文件」的假站(本机回环上,只给 `cloud-tools-c1-*` 用)。
 *
 *   GET /login-site/clip.mp4   带着测试用的假登录 cookie(`pc_login=<LOGIN_VALUE>`)→ 高画质那一份(1280×720);不带 → 低画质那一份(320×180)
 *
 * 两份都是现用 ffmpeg 造的真 H.264 视频(各 2 秒),内容不同、大小不同、分辨率不同,所以「拿到的是哪一份」看哈希与分辨率就知道。
 * 站点记下每次请求带没带 cookie、带的是不是那一个(只记真假,不把值打出去)。
 * 假登录态是一个随机串,只写进探针自己的临时数据目录里的 cookies 文件,探针结束随目录删掉。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function makeClip(file, size, colour) {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-f', 'lavfi', '-i', `color=c=${colour}:size=${size}:rate=25`,
    '-filter_complex', '[0:v][1:v]blend=all_mode=average[v]', '-map', '[v]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
  { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  if (out.status !== 0 || !fs.existsSync(file)) throw new Error(`ffmpeg 没造出 ${path.basename(file)}:${String(out.stderr ?? out.error ?? '').slice(0, 300)}`);
  return fs.readFileSync(file);
}

/**
 * @param {{ port: number, dir: string }} o `dir` 放两份现造的视频
 * @returns {Promise<{ origin: string, url: string, loginValue: string, sd: {bytes: Buffer, hash: string, size: number, width: number, height: number},
 *   hd: {bytes: Buffer, hash: string, size: number, width: number, height: number}, hits: Array<{path: string, method: string, loggedIn: boolean, hasCookie: boolean, served: 'hd'|'sd'}>, close(): Promise<void> }>}
 */
export async function startLoginSite({ port, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const sdBytes = makeClip(path.join(dir, 'site-sd.mp4'), '320x180', 'red');
  const hdBytes = makeClip(path.join(dir, 'site-hd.mp4'), '1280x720', 'blue');
  const sd = { bytes: sdBytes, hash: sha256(sdBytes), size: sdBytes.length, width: 320, height: 180 };
  const hd = { bytes: hdBytes, hash: sha256(hdBytes), size: hdBytes.length, width: 1280, height: 720 };
  const loginValue = `FAKE-C1-LOGIN-${randomBytes(9).toString('hex')}`;
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://site.invalid');
    if (url.pathname !== '/login-site/clip.mp4') { res.writeHead(404); res.end('no such page'); return; }
    const cookie = String(req.headers.cookie ?? '');
    const loggedIn = cookie.split(/;\s*/).includes(`pc_login=${loginValue}`);
    const pick = loggedIn ? hd : sd;
    hits.push({ path: url.pathname, method: req.method, loggedIn, hasCookie: cookie !== '', served: loggedIn ? 'hd' : 'sd' });
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), pick.size - 1) : pick.size - 1;
    const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), 'cache-control': 'no-store', vary: 'Cookie',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${pick.size}` } : {}) };
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') res.end(); else res.end(pick.bytes.subarray(start, end + 1));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${port}`;
  return { origin, url: `${origin}/login-site/clip.mp4`, loginValue, sd, hd, hits,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/**
 * 测试用的假登录态:Netscape 格式的 cookies 文件。前三行让桌面版的站点登录判定(`server/collect-cookies.mjs` 的 bilibili 那一项)认为「已登录」,
 * 最后一行是假站认的那个 cookie。全是假值。
 */
export function fakeLoginCookies(loginValue, host = '127.0.0.1') {
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const row = (domain, name, value) => [domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', '/', 'FALSE', String(exp), name, value].join('\t');
  return ['# Netscape HTTP Cookie File', '# C1 探针的假登录态,全是假值', '',
    row('.bilibili.com', 'SESSDATA', 'FAKE-C1-SESSDATA'), row('.bilibili.com', 'bili_jct', 'FAKE-C1-JCT'), row('.bilibili.com', 'DedeUserID', 'FAKE-C1-USER'),
    row(host, 'pc_login', loginValue), ''].join('\n');
}
