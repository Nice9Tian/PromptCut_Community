/**
 * 仅供测试与探针，生产代码不得引用。
 *
 * 原始 TCP 上的最小 WebSocket 客户端（RFC 6455 客户端一侧），给背压测试用（契约 `docs/plan/render-queue-contract.md`
 * H.5 的 I3、I5）：它能在握手之后**停止读取 socket**，让服务端的发送缓冲真的积压起来。Node 内置的 `WebSocket`
 * 做不到这一点，它总是尽快把数据读走。
 *
 *   const c = await rawWsClient(port, { protocols })
 *   c.send(obj)             发一条文本消息（带掩码）
 *   c.next(match, ms)       等一条匹配的消息（取走）
 *   c.pause() / c.resume()  停止 / 恢复读取 socket（停止期间内核缓冲写满后，服务端的 writableLength 会涨）
 *   c.closeFrame            收到的关闭帧 { code, reason }，没收到是 null
 *   c.ended                 Promise：socket 关掉时兑现 { closeFrame, bytesRead }
 *   c.stats                 { messages, bytesRead }
 *   c.destroy()
 *
 * 收到的消息默认只计数、不保留（`keep: true` 时保留在 inbox 里供 next 取），免得大量消息把测试进程的堆撑大。
 * 收到 ping 回 pong；收到关闭帧回一个关闭帧后结束 TCP。只支持文本帧与分片，二进制帧当作协议错误断开。
 * 只引 Node 内置模块。
 */
import { connect as netConnect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/**
 * @param {number} port
 * @param {{ host?: string, path?: string, protocols?: string[], keep?: boolean, onMessage?: (msg: any) => void }} [options]
 */
export async function rawWsClient(port, { host = '127.0.0.1', path = '/', protocols, keep = true, onMessage } = {}) {
  const sock = netConnect(port, host);
  sock.on('error', () => {});
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  const key = randomBytes(16).toString('base64');
  const lines = [
    `GET ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
  ];
  if (protocols?.length) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
  sock.write(`${lines.join('\r\n')}\r\n\r\n`);

  let buf = Buffer.alloc(0);
  const head = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等握手响应超时')), 3000);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(t);
      sock.off('data', onData);
      const text = buf.subarray(0, end).toString('latin1');
      buf = buf.subarray(end + 4);
      resolve(text);
    };
    sock.on('data', onData);
    sock.once('close', () => { clearTimeout(t); reject(new Error('握手时连接被关闭')); });
  });
  const status = Number(head.split('\r\n')[0].split(' ')[1]);
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  if (status !== 101 || !head.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) {
    sock.destroy();
    throw new Error(`握手失败：${head.split('\r\n')[0]}`);
  }

  const inbox = [];
  const waiters = [];
  const stats = { messages: 0, bytesRead: 0 };
  let frags = null;
  let closeSent = false;
  const client = {
    sock,
    stats,
    inbox,
    closeFrame: null,
    ended: null,
    send(msg) {
      if (closeSent || !sock.writable) return false;
      sock.write(frame(0x1, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg), 'utf8')));
      return true;
    },
    next(match = () => true, ms = 3000) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error(`等消息超时（原始客户端，已收 ${stats.messages} 条）`)); }
        }, ms);
      });
    },
    pause() { sock.pause(); },
    resume() { sock.resume(); },
    destroy() { sock.destroy(); },
  };

  function deliver(text) {
    stats.messages += 1;
    let msg;
    try { msg = JSON.parse(text); } catch { msg = { __raw: text }; }
    onMessage?.(msg);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else if (keep) inbox.push(msg);
  }

  function onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x1:
        if (fin) return deliver(payload.toString('utf8'));
        frags = [payload];
        return;
      case 0x0:
        if (!frags) return sock.destroy();
        frags.push(payload);
        if (fin) { const whole = Buffer.concat(frags); frags = null; deliver(whole.toString('utf8')); }
        return;
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        client.closeFrame = { code, reason };
        if (!closeSent && sock.writable) {
          closeSent = true;
          const echo = Buffer.alloc(2);
          echo.writeUInt16BE(code === 1005 ? 1000 : code, 0);
          sock.write(frame(0x8, echo));
        }
        sock.end();
        return;
      }
      case 0x9:
        if (!closeSent && sock.writable) sock.write(frame(0xa, payload));
        return;
      case 0xa:
        return;
      default:
        sock.destroy();
    }
  }

  function parse() {
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      onFrame(fin, opcode, payload);
    }
  }

  sock.on('data', (d) => {
    stats.bytesRead += d.length;
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    parse();
  });
  client.ended = new Promise((resolve) => sock.once('close', () => resolve({ closeFrame: client.closeFrame, bytesRead: stats.bytesRead })));
  if (buf.length) parse();
  return client;
}
