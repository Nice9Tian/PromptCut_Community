/**
 * Minimal WebSocket server for document service (RFC 6455), with no third-party dependencies.
 *
 * Handles only the minimal subset document service needs: handshake, text frames (including
 * fragmentation), ping / pong, and closing handshake. Binary frames are rejected unconditionally:
 * this connection only carries small JSON messages; asset bytes and prerender outputs go through
 * asset service (`docs/semantics/product/document-service.md` "Responsibilities").
 * Extensions are unsupported (permessage-deflate, etc.): handshake does not reply with
 * `Sec-WebSocket-Extensions`, so clients will not use them.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
/** Max time to wait for peer close frame after sending close frame; terminates TCP directly on timeout */
const CLOSE_WAIT_MS = 2000;

export const CLOSE = Object.freeze({
  NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL: 1002, UNSUPPORTED: 1003,
  NO_STATUS: 1005, ABNORMAL: 1006, INVALID_DATA: 1007, TOO_BIG: 1009,
});

/** HTTP token chars (RFC 7230): subprotocol names may only contain these, preventing extra response headers */
const TOKEN_CHARS = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Handles handshake in http server `upgrade` event. Returns `WsConnection` on success; replies with
 * 400 and returns null if the request is non-compliant.
 * Auth, path, and connection limits should be checked by caller before invoking this.
 * `protocol` (optional): subprotocol to echo, written to `Sec-WebSocket-Protocol`. When client
 * requests a subprotocol and server does not reply, browsers fail the handshake, so caller should
 * pass it when client provides an agreed subprotocol; values that are not valid tokens are not sent.
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

/** Reject during handshake phase: reply with a normal HTTP response and close socket */
export function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * A handshaked connection. Events: `message(text)`, `pong()`, `drain()`, `close({ code, reason })`
 * (emitted only once).
 *
 * `drain`: emitted when underlying write buffer drains; assembly layer relies on it to resume writing
 * backlogged messages (contract H.2). The socket's own `drain` only fires after a `write` crosses its
 * high watermark (default 16 KiB); caller's high watermark may be lower, so it is also emitted once
 * all written data is handed to the system (`writableLength` reaches zero in write callback).
 * May duplicate; caller can simply treat it as "can write again now".
 */
export class WsConnection extends EventEmitter {
  #socket;
  #maxPayload;
  #buf = Buffer.alloc(0);
  /** Received fragments when a fragmented message is partially received */
  #frags = null;
  #fragLen = 0;
  #closeSent = false;
  /** Stop parsing subsequent bytes after a protocol error occurs */
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
    // Errors are always followed by close; this only prevents unhandled error events from crashing the process
    socket.on('error', () => {});
    // HTTP server sockets allow half-closure, and no one cleans up for us after upgrade: when peer ends
    // TCP without sending a close frame (process exit, etc.), end here too so close occurs immediately
    // instead of waiting for heartbeat timeout
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

  /** Bytes not yet sent by underlying layer (`buffered` in contract H.2) */
  get bufferedAmount() {
    return this.#socket.writableLength;
  }

  /** Send a text message; drops and returns false if connection is already closing */
  send(text) {
    if (this.#closeSent || !this.#socket.writable) return false;
    this.#writeFrame(OP.TEXT, Buffer.from(text, 'utf8'));
    return true;
  }

  ping() {
    if (this.#closeSent || !this.#socket.writable) return;
    this.#writeFrame(OP.PING, Buffer.alloc(0));
  }

  /** Initiate closing handshake: send close frame, disconnect after peer replies close frame, or disconnect on timeout */
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
   * End TCP after writing close frame without waiting for peer reply. Used when "informing peer why
   * right after handshaking" (resume failure closing with 4404 / 4410 / 1002,
   * `docs/plan/http-transport-contract.md` section 16): peer has nothing else to say, so no need to
   * hold connection waiting for its close frame
   */
  closeNow(code = CLOSE.NORMAL, reason = '') {
    this.close(code, reason);
    this.#dead = true;
    if (!this.#socket.destroyed) this.#socket.end();
  }

  /** Disconnect directly without handshake (used on heartbeat timeout) */
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

  /** Write callback: emits an extra `drain` when buffer has drained and socket will not emit `drain` again */
  #onFlushed = (err) => {
    const s = this.#socket;
    if (err || s.destroyed || s.writableLength !== 0 || s.writableNeedDrain) return;
    this.emit('drain');
  };

  /** Protocol error: send close frame, discard subsequent bytes, and end TCP once sent */
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

  /** Slice a full frame from buffer; returns null if there are insufficient bytes */
  #readFrame() {
    const b = this.#buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    if (b[0] & 0x70) return this.#fail(CLOSE.PROTOCOL, 'RSV bits must be 0');
    if (!(b[1] & 0x80)) return this.#fail(CLOSE.PROTOCOL, 'Client frames must be masked');
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.#maxPayload)) return this.#fail(CLOSE.TOO_BIG, 'Message too large');
      len = Number(big);
      off = 10;
    }
    if (opcode >= 0x8 && (!fin || len > 125)) return this.#fail(CLOSE.PROTOCOL, 'Control frames cannot be fragmented or exceed 125 bytes');
    if (len > this.#maxPayload) return this.#fail(CLOSE.TOO_BIG, 'Message too large');
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
        if (this.#frags) return this.#fail(CLOSE.PROTOCOL, 'The previous fragmented message is not finished yet');
        if (fin) return this.#deliver(payload);
        this.#frags = [payload];
        this.#fragLen = payload.length;
        return;
      case OP.CONT:
        if (!this.#frags) return this.#fail(CLOSE.PROTOCOL, 'No fragmented message is being received');
        this.#fragLen += payload.length;
        if (this.#fragLen > this.#maxPayload) return this.#fail(CLOSE.TOO_BIG, 'Message too large');
        this.#frags.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.#frags);
          this.#frags = null;
          this.#deliver(whole);
        }
        return;
      case OP.BINARY:
        return this.#fail(CLOSE.UNSUPPORTED, 'Only text messages are accepted');
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
        // Peer-initiated close: reply with a close frame (1005 cannot appear on the wire, reply 1000)
        this.close(code === CLOSE.NO_STATUS ? CLOSE.NORMAL : code);
        this.#socket.end();
        return;
      }
      default:
        return this.#fail(CLOSE.PROTOCOL, `Unknown opcode ${opcode}`);
    }
  }

  #deliver(payload) {
    if (this.#closeSent) return;
    let text;
    try {
      text = this.#decoder.decode(payload);
    } catch {
      return this.#fail(CLOSE.INVALID_DATA, 'Text message is not valid UTF-8');
    }
    this.emit('message', text);
  }
}
