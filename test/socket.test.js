// -----------------------------------------------------------------------------
// One subscription socket: the key header and the certificate choice on the
// upgrade, frames, reconnection with a growing delay, a refused key retried
// slowly, a silent connection detected by its unanswered ping.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS } from '../src/protect/client.js';
import { ProtectSocket } from '../src/protect/socket.js';
import { API_KEY, FakeProtect } from './helpers/fakeProtect.js';
import { settle } from './helpers/world.js';

const URL_EVENTS = 'wss://192.0.2.1/proxy/protect/integration/v1/subscribe/events';

function socket(protect, options = {}) {
  const frames = [];
  const closes = [];
  let opens = 0;
  const s = new ProtectSocket({
    url: URL_EVENTS,
    headers: { 'X-API-KEY': API_KEY },
    insecure: true,
    onFrame: (frame) => frames.push(frame),
    onOpen: () => {
      opens += 1;
    },
    onClose: (err) => closes.push(err),
    createSocket: protect.createSocket,
    timings: { reconnectMinMs: 10, reconnectMaxMs: 40, authRetryMs: 1000, ...options.timings },
    ...options,
  });
  return { s, frames, closes, opens: () => opens };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('opens with the key and the certificate choice, passes the JSON frames', async (t) => {
  const protect = new FakeProtect();
  const { s, frames, opens } = socket(protect);
  t.after(() => s.stop());
  s.start();
  await settle();
  assert.equal(opens(), 1);
  assert.equal(s.connected, true);
  const { options } = protect.socketAttempts[0];
  assert.equal(options.headers['X-API-KEY'], API_KEY);
  assert.equal(options.rejectUnauthorized, false);
  protect.send('events', { type: 'add', item: { id: 'e', modelKey: 'event' } });
  const [open] = protect.openSockets();
  open.emit('message', Buffer.from('not json'), false);
  open.emit('message', Buffer.from('{}'), true); // binary: not a frame
  assert.deepEqual(frames, [{ type: 'add', item: { id: 'e', modelKey: 'event' } }]);
});

test('reconnects after a drop, with a growing delay', async (t) => {
  const protect = new FakeProtect();
  const { s, closes, opens } = socket(protect);
  t.after(() => s.stop());
  s.start();
  await settle();
  protect.dropSockets();
  await settle();
  assert.equal(closes.length, 1);
  assert.equal(closes[0].kind, ERROR_KINDS.UNREACHABLE);
  await sleep(30);
  await settle();
  assert.equal(opens(), 2);
  assert.equal(s.delay, 10, 'the delay is reset once connected');
});

test('a console down: each attempt fails, the delay grows up to its maximum', async (t) => {
  const protect = new FakeProtect();
  protect.online = false;
  const { s, closes } = socket(protect);
  t.after(() => s.stop());
  s.start();
  await sleep(120);
  await settle();
  assert.ok(closes.length >= 2);
  assert.equal(s.delay, 40);
  protect.online = true;
  await sleep(60);
  await settle();
  assert.equal(s.connected, true);
});

test('a refused key is retried slowly', async (t) => {
  const protect = new FakeProtect({ apiKey: 'another' });
  const { s, closes } = socket(protect);
  t.after(() => s.stop());
  s.start();
  await sleep(100);
  await settle();
  assert.equal(closes.length, 1, 'no new attempt within the auth delay');
  assert.equal(closes[0].kind, ERROR_KINDS.AUTH);
});

test('a ping left unanswered closes the socket, which reconnects', async (t) => {
  const protect = new FakeProtect();
  const { s, closes, opens } = socket(protect, {
    timings: { reconnectMinMs: 10, pingMs: 20, pongTimeoutMs: 10 },
  });
  t.after(() => s.stop());
  s.start();
  await settle();
  protect.answersPings = false;
  await sleep(60);
  await settle();
  assert.ok(closes.length >= 1);
  protect.answersPings = true;
  await sleep(40);
  await settle();
  assert.ok(opens() >= 2);
});

test('stopped, it neither reconnects nor reports', async () => {
  const protect = new FakeProtect();
  const { s, closes } = socket(protect);
  s.start();
  await settle();
  s.stop();
  await sleep(40);
  await settle();
  assert.equal(closes.length, 0);
  assert.equal(protect.openSockets().length, 0);
  s.stop(); // twice: harmless
});
