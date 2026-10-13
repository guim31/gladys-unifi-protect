// -----------------------------------------------------------------------------
// An in-memory UniFi Protect console, built from test/fixtures/protect: the
// REST endpoints of the Integration API behind the `request` seam of the
// client, and its two subscription sockets behind the `createSocket` seam.
// It checks what a console checks: the API key, the certificate choice, a
// console that is down.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/protect/${name}`, import.meta.url), 'utf8'));

export const API_KEY = 'test-api-key-0123456789';
export const HOST = 'https://192.0.2.1';

export const IDS = Object.freeze({
  DOORBELL: '66f1a2b3c4d5e6f708090a01',
  DRIVEWAY: '66f1a2b3c4d5e6f708090a02',
  GARAGE: '66f1a2b3c4d5e6f708090a03',
  NAMELESS: '66f1a2b3c4d5e6f708090a04',
  FLOODLIGHT: '66f1a2b3c4d5e6f708090b01',
  DOOR_SENSOR: '66f1a2b3c4d5e6f708090c01',
  LEAK_SENSOR: '66f1a2b3c4d5e6f708090c02',
  WINDOW_SENSOR: '66f1a2b3c4d5e6f708090c03',
});

export const MACS = Object.freeze({
  DOORBELL: 'f4e2c6000001',
  DRIVEWAY: 'f4e2c6000002',
  GARAGE: 'f4e2c6000003',
  NAMELESS: 'f4e2c6000004',
  FLOODLIGHT: 'f4e2c6000011',
  DOOR_SENSOR: 'f4e2c6000021',
  LEAK_SENSOR: 'f4e2c6000022',
  WINDOW_SENSOR: 'f4e2c6000023',
});

export const eventFrames = (name) => fixture(`events/${name}`);

/** A small valid JPEG, as a camera snapshot. */
export function smallJpeg(width = 64, height = 36, shade = 120) {
  const data = Buffer.alloc(width * height * 4, shade);
  return Buffer.from(jpeg.encode({ width, height, data }, 80).data);
}

class FakeSocket extends EventEmitter {
  constructor(console, stream, options) {
    super();
    this.console = console;
    this.stream = stream;
    this.options = options;
    this.closed = false;
  }

  ping() {
    if (this.console.answersPings) {
      setImmediate(() => this.emit('pong'));
    }
  }

  close() {
    this.terminate();
  }

  terminate() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.console.sockets.delete(this);
    setImmediate(() => this.emit('close', 1006));
  }
}

export class FakeProtect {
  constructor({ apiKey = API_KEY, selfSigned = true } = {}) {
    this.apiKey = apiKey;
    this.selfSigned = selfSigned;
    this.online = true;
    this.answersPings = true;
    this.cameras = fixture('cameras.json');
    this.lights = fixture('lights.json');
    this.sensors = fixture('sensors.json');
    this.meta = fixture('meta-info.json');
    this.rtsps = fixture('rtsps-stream.json');
    this.snapshot = smallJpeg();
    this.snapshotStatus = 200;
    this.requests = [];
    this.sockets = new Set();
    this.socketAttempts = [];
    this.request = this.request.bind(this);
    this.createSocket = this.createSocket.bind(this);
  }

  // --- REST --------------------------------------------------------------------

  async request(url, { method = 'GET', headers = {}, json, insecure = false } = {}) {
    const target = new URL(url);
    const path = `${target.pathname}${target.search}`;
    this.requests.push({ method, path, headers, json });
    if (!this.online) {
      throw Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
    }
    if (this.selfSigned && !insecure) {
      throw Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
    }
    const answer = (status, body, contentType = 'application/json') => ({
      status,
      headers: { 'content-type': contentType },
      body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? {})),
      fingerprint: this.selfSigned ? 'AA:BB:CC:DD' : null,
    });
    if (headers['X-API-KEY'] !== this.apiKey) {
      return answer(401, { error: 'Unauthorized' });
    }
    const route = target.pathname.replace('/proxy/protect/integration', '');
    const match = route.match(/^\/v1\/(cameras|lights|sensors)(?:\/([^/]+))?(?:\/(.+))?$/);
    if (route === '/v1/meta/info') {
      return answer(200, this.meta);
    }
    if (!match) {
      return answer(404, { error: 'Not found' });
    }
    const [, collection, id, sub] = match;
    const list = this[collection];
    if (!id) {
      return answer(200, list);
    }
    const item = list.find((entry) => entry.id === id);
    if (!item) {
      return answer(404, { error: 'Not found' });
    }
    if (collection === 'cameras' && sub === 'snapshot') {
      return this.snapshotStatus === 200
        ? answer(200, this.snapshot, 'image/jpeg')
        : answer(this.snapshotStatus, { error: 'No snapshot' });
    }
    if (collection === 'cameras' && sub === 'rtsps-stream') {
      return answer(200, this.rtsps);
    }
    if (sub) {
      return answer(404, { error: 'Not found' });
    }
    if (method === 'PATCH') {
      if (collection === 'lights' && 'isLightForceEnabled' in json) {
        item.isLightForceEnabled = json.isLightForceEnabled;
        item.isLightOn = json.isLightForceEnabled;
      }
      if (collection === 'cameras' && json.lcdMessage) {
        item.lcdMessage = json.lcdMessage;
      }
      return answer(200, item);
    }
    return answer(200, item);
  }

  // --- Sockets ---------------------------------------------------------------------

  createSocket(url, options) {
    const stream = url.endsWith('/subscribe/events') ? 'events' : 'devices';
    const socket = new FakeSocket(this, stream, options);
    this.socketAttempts.push({ url, options });
    setImmediate(() => {
      if (!this.online) {
        socket.emit(
          'error',
          Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }),
        );
        socket.closed = true;
        socket.emit('close', 1006);
        return;
      }
      if (options.headers?.['X-API-KEY'] !== this.apiKey) {
        socket.emit('unexpected-response', {}, { statusCode: 401 });
        socket.closed = true;
        socket.emit('close', 1006);
        return;
      }
      this.sockets.add(socket);
      socket.emit('open');
    });
    return socket;
  }

  /** Send a frame on the open sockets of a stream (`devices` or `events`). */
  send(stream, frame) {
    for (const socket of this.sockets) {
      if (socket.stream === stream && !socket.closed) {
        socket.emit('message', Buffer.from(JSON.stringify(frame)), false);
      }
    }
  }

  /** Close every socket, as a console rebooting would. */
  dropSockets() {
    for (const socket of [...this.sockets]) {
      socket.terminate();
    }
  }

  openSockets(stream) {
    return [...this.sockets].filter((socket) => !stream || socket.stream === stream);
  }

  /** Change a device and say so on the devices socket, as the console does. */
  update(collection, id, patch) {
    const item = this[collection].find((entry) => entry.id === id);
    Object.assign(item, patch);
    this.send('devices', {
      type: 'update',
      item: { id, modelKey: collection.slice(0, -1), ...patch },
    });
  }
}
