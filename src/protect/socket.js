// -----------------------------------------------------------------------------
// One subscription WebSocket of the Integration API (`/v1/subscribe/devices`
// or `/v1/subscribe/events`), kept open for life: it reconnects with a growing
// delay, and a silent connection (console rebooted without closing it, cable
// pulled) is detected by a ping every minute that must be answered.
//
// The console sends one JSON frame per change: `{ type: 'add' | 'update' |
// 'remove', item: { id, modelKey, ... } }`. Nothing is sent on connection: the
// hub reads the full state over REST when a socket (re)opens.
//
// On `ws` rather than the WebSocket of Node.js: the standard client can send
// neither the `X-API-KEY` header nor accept a self-signed certificate. `ws` is
// already the transport of the Gladys SDK, so it costs no extra package.
// -----------------------------------------------------------------------------

import WebSocket from 'ws';
import { ERROR_KINDS, ProtectError, networkError, statusError } from './client.js';

export const SOCKET_TIMINGS = {
  reconnectMinMs: 5_000,
  reconnectMaxMs: 5 * 60_000,
  // A refused key will not fix itself in seconds: retry slowly.
  authRetryMs: 5 * 60_000,
  pingMs: 60_000,
  pongTimeoutMs: 15_000,
  handshakeTimeoutMs: 15_000,
};

export class ProtectSocket {
  /**
   * @param {object} options
   * @param {string} options.url `wss://…/v1/subscribe/<stream>`
   * @param {Record<string, string>} options.headers the API key header
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {(frame: object) => void} options.onFrame a parsed frame
   * @param {() => void} [options.onOpen]
   * @param {(error: ProtectError|null) => void} [options.onClose] why it closed, null when asked to
   * @param {(url: string, options: object) => object} [options.createSocket] test seam
   * @param {object} [options.timings]
   */
  constructor({ url, headers, insecure = false, onFrame, onOpen, onClose, createSocket, timings }) {
    this.url = url;
    this.headers = headers;
    this.insecure = insecure;
    this.onFrame = onFrame;
    this.onOpen = onOpen ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.createSocket = createSocket ?? ((target, options) => new WebSocket(target, options));
    this.timings = { ...SOCKET_TIMINGS, ...timings };
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.delay = this.timings.reconnectMinMs;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
  }

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearKeepalive();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      socket.removeAllListeners?.();
      // The error a terminate() may still emit must not crash the process.
      socket.on?.('error', () => {});
      socket.terminate?.();
    }
  }

  connect() {
    if (this.stopped) {
      return;
    }
    let failure = null;
    const socket = this.createSocket(this.url, {
      headers: this.headers,
      rejectUnauthorized: !this.insecure,
      handshakeTimeout: this.timings.handshakeTimeoutMs,
    });
    this.socket = socket;

    socket.on('open', () => {
      if (socket !== this.socket) {
        return;
      }
      this.connected = true;
      this.delay = this.timings.reconnectMinMs;
      this.scheduleKeepalive();
      this.onOpen();
    });

    socket.on('message', (data, isBinary) => {
      if (socket !== this.socket || isBinary) {
        return;
      }
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return; // not JSON: nothing the console documents
      }
      if (frame && typeof frame === 'object') {
        this.onFrame(frame);
      }
    });

    socket.on('pong', () => clearTimeout(this.pongTimer));

    // The upgrade was answered by a plain HTTP response: 401 for a bad key.
    socket.on('unexpected-response', (_request, response) => {
      failure = statusError(response.statusCode, 'WebSocket upgrade');
      if (response.statusCode === 404) {
        failure = new ProtectError(ERROR_KINDS.NO_API, 'No subscription endpoint', {
          status: 404,
        });
      }
      socket.terminate?.();
    });

    socket.on('error', (err) => {
      failure ??= err instanceof ProtectError ? err : networkError(err);
    });

    socket.on('close', () => {
      if (socket !== this.socket) {
        return;
      }
      this.clearKeepalive();
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      if (this.stopped) {
        return;
      }
      const error =
        failure ??
        new ProtectError(
          ERROR_KINDS.UNREACHABLE,
          wasConnected ? 'Connection closed' : 'Connection refused',
        );
      this.onClose(error);
      this.scheduleReconnect(error);
    });
  }

  scheduleReconnect(error) {
    clearTimeout(this.reconnectTimer);
    const wait =
      error?.kind === ERROR_KINDS.AUTH
        ? Math.max(this.delay, this.timings.authRetryMs)
        : this.delay;
    this.delay = Math.min(this.delay * 2, this.timings.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  scheduleKeepalive() {
    this.clearKeepalive();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || !this.connected) {
        return;
      }
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        // No answer: the connection is dead even if TCP has not noticed yet.
        socket.terminate?.();
      }, this.timings.pongTimeoutMs);
      try {
        socket.ping();
      } catch {
        socket.terminate?.();
      }
    }, this.timings.pingMs);
  }

  clearKeepalive() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }
}
