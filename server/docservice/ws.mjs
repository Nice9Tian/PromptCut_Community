/**
 * 文档服务用的最小 WebSocket 服务端（RFC 6455），不引第三方依赖。
 *
 * 只做文档服务要的那一小块：握手、文本帧（含分片）、ping / pong、关闭握手。二进制帧一律拒收——
 * 这条连接只传小 JSON 消息，素材字节和预渲染产物走素材服务（`docs/semantics/product/document-service.md`「职责」）。
 * 不支持扩展（permessage-deflate 等）：握手时不回 `Sec-WebSocket-Extensions`，客户端就不会用。
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
/** 发出关闭帧后等对端回关闭帧的最长时间，过了就直接断 TCP */
const CLOSE_WAIT_MS = 2000;

export const CLOSE = Object.freeze({
  NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL: 1002, UNSUPPORTED: 1003,
  NO_STATUS: 1005, ABNORMAL: 1006, INVALID_DATA: 1007, TOO_BIG: 1009,
});

/** HTTP token 字符（RFC 7230）：子协议名只能由这些字符组成，防止拼出多余的响应头 */
const TOKEN_CHARS = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * 处理 http 服务 `upgrade` 事件里的握手。成功返回 `WsConnection`；请求不合规就回 400、返回 null。
 * 鉴权、路径、连接数这些由调用方在调它之前判断。
 * `protocol`（可选）：要回显的子协议，写进 `Sec-WebSocket-Protocol`。客户端请求了子协议而服务端不回时，
 * 浏览器会让握手失败，所以调用方在客户端给了约定的子协议时要传它；不是合法 token 的值不回。
 */
export function acceptUpgrade(req, socket, head, { maxPayload, protocol } = {}) {
  const key = req.headers['sec-websocket-key'];
  const ok = req.method === 'GET'
    && String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
    && req.headers['sec-websocket-version'] === '13'
    && typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
  if (!ok) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  const proto = typeof protocol === 'string' && TOKEN_CHARS.test(protocol) ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '';
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
  return new WsConnection(socket, head, maxPayload);
}

/** 握手阶段拒绝：回一个普通 HTTP 响应后关掉 socket */
export function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * 一条已握手的连接。事件：`message(text)`、`pong()`、`drain()`、`close({ code, reason })`（只发一次）。
 *
 * `drain`：底层写缓冲排空时发出，组装层靠它继续写积压的消息（契约 H.2）。socket 自己的 `drain` 只在某次
 * `write` 越过它的高水位（缺省 16 KiB）之后才来；调用方的高水位可能比它低，所以写出的数据全部交给系统后
 * （写回调里 `writableLength` 归零）也发一次。可能重复，调用方按「现在可以再写」处理即可。
 */
export class WsConnection extends EventEmitter {
  #socket;
  #maxPayload;
  #buf = Buffer.alloc(0);
  /** 分片消息收到一半时的已收片段 */
  #frags = null;
  #fragLen = 0;
  #closeSent = false;
  /** 出了协议错误之后不再解析后续字节 */
  #dead = false;
  #closeTimer = null;
  #peerClose = { code: CLOSE.ABNORMAL, reason: '' };
  #decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(socket, head, maxPayload) {
    super();
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.remoteAddress = socket.remoteAddress ?? null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    // 错误之后一定跟着 close，这里只防止未处理的 error 事件把进程带崩
    socket.on('error', () => {});
    // http 服务的 socket 允许半关闭，升级之后没人替我们收尾：对端不发关闭帧就结束 TCP（进程退出等）时，
    // 这边也结束，好让 close 立刻发生，而不是等心跳超时
    socket.on('end', () => {
      this.#dead = true;
      if (!socket.destroyed) socket.end();
    });
    socket.on('drain', () => this.emit('drain'));
    socket.on('close', () => {
      clearTimeout(this.#closeTimer);
      this.emit('close', this.#peerClose);
    });
    if (head?.length) this.#onData(head);
  }

  /** 底层尚未发出的字节数（契约 H.2 的 `buffered`） */
  get bufferedAmount() {
    return this.#socket.writableLength;
  }

  /** 发一条文本消息。连接已在关闭中就丢弃，返回 false */
  send(text) {
    if (this.#closeSent || !this.#socket.writable) return false;
    this.#writeFrame(OP.TEXT, Buffer.from(text, 'utf8'));
    return true;
  }

  ping() {
    if (this.#closeSent || !this.#socket.writable) return;
    this.#writeFrame(OP.PING, Buffer.alloc(0));
  }

  /** 发起关闭握手：发关闭帧，等对端回关闭帧后断开；对端不回就超时断开 */
  close(code = CLOSE.NORMAL, reason = '') {
    if (this.#closeSent) return;
    this.#closeSent = true;
    if (this.#socket.writable) {
      const text = Buffer.from(reason, 'utf8').subarray(0, 123);
      const payload = Buffer.alloc(2 + text.length);
      payload.writeUInt16BE(code, 0);
      text.copy(payload, 2);
      this.#writeFrame(OP.CLOSE, payload);
    }
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_WAIT_MS);
    this.#closeTimer.unref?.();
  }

  /**
   * 发关闭帧后不等对端回关闭帧，写完就结束 TCP。给「刚握上就要告诉对方为什么关」的场合用（接续失败以 4404 / 4410 / 1002 关闭，
   * `docs/plan/http-transport-contract.md` 第 16 节）：对端此时没有别的要说，不必占着连接等它回关闭帧
   */
  closeNow(code = CLOSE.NORMAL, reason = '') {
    this.close(code, reason);
    this.#dead = true;
    if (!this.#socket.destroyed) this.#socket.end();
  }

  /** 不走握手直接断开（心跳超时用） */
  terminate() {
    this.#socket.destroy();
  }

  #writeFrame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x80 | opcode;
    this.#socket.write(Buffer.concat([head, payload]), this.#onFlushed);
  }

  /** 写回调：缓冲已排空、且 socket 自己不会再发 `drain` 时，补发一次 `drain` */
  #onFlushed = (err) => {
    const s = this.#socket;
    if (err || s.destroyed || s.writableLength !== 0 || s.writableNeedDrain) return;
    this.emit('drain');
  };

  /** 协议错误：发关闭帧，丢掉后续字节，发完就结束 TCP */
  #fail(code, reason) {
    this.#dead = true;
    this.#buf = Buffer.alloc(0);
    this.#frags = null;
    this.#peerClose = { code, reason };
    this.close(code, reason);
    this.#socket.end();
    return null;
  }

  #onData(chunk) {
    if (this.#dead) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) return;
      this.#onFrame(frame);
      if (this.#dead) return;
    }
  }

  /** 从缓冲里切出一整帧；字节不够返回 null */
  #readFrame() {
    const b = this.#buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    if (b[0] & 0x70) return this.#fail(CLOSE.PROTOCOL, 'RSV 位必须为 0');
    if (!(b[1] & 0x80)) return this.#fail(CLOSE.PROTOCOL, '客户端帧必须带掩码');
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.#maxPayload)) return this.#fail(CLOSE.TOO_BIG, '消息过大');
      len = Number(big);
      off = 10;
    }
    if (opcode >= 0x8 && (!fin || len > 125)) return this.#fail(CLOSE.PROTOCOL, '控制帧不能分片或超过 125 字节');
    if (len > this.#maxPayload) return this.#fail(CLOSE.TOO_BIG, '消息过大');
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.#buf = b.subarray(off + 4 + len);
    return { fin, opcode, payload };
  }

  #onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.TEXT:
        if (this.#frags) return this.#fail(CLOSE.PROTOCOL, '上一条分片消息还没收完');
        if (fin) return this.#deliver(payload);
        this.#frags = [payload];
        this.#fragLen = payload.length;
        return;
      case OP.CONT:
        if (!this.#frags) return this.#fail(CLOSE.PROTOCOL, '没有正在接收的分片消息');
        this.#fragLen += payload.length;
        if (this.#fragLen > this.#maxPayload) return this.#fail(CLOSE.TOO_BIG, '消息过大');
        this.#frags.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.#frags);
          this.#frags = null;
          this.#deliver(whole);
        }
        return;
      case OP.BINARY:
        return this.#fail(CLOSE.UNSUPPORTED, '只收文本消息');
      case OP.PING:
        if (!this.#closeSent && this.#socket.writable) this.#writeFrame(OP.PONG, payload);
        return;
      case OP.PONG:
        this.emit('pong');
        return;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.NO_STATUS;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.#peerClose = { code, reason };
        this.#dead = true;
        // 对端先发的关闭：回一个关闭帧（1005 不能出现在线上，回 1000）
        this.close(code === CLOSE.NO_STATUS ? CLOSE.NORMAL : code);
        this.#socket.end();
        return;
      }
      default:
        return this.#fail(CLOSE.PROTOCOL, `未知的 opcode ${opcode}`);
    }
  }

  #deliver(payload) {
    if (this.#closeSent) return;
    let text;
    try {
      text = this.#decoder.decode(payload);
    } catch {
      return this.#fail(CLOSE.INVALID_DATA, '文本消息不是合法的 UTF-8');
    }
    this.emit('message', text);
  }
}
