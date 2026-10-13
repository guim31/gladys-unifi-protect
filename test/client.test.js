// -----------------------------------------------------------------------------
// The Integration API client: URLs, the key header, the certificate choice,
// and every failure turned into an error kind — never with the key inside.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, ProtectClient, ProtectError } from '../src/protect/client.js';
import { API_KEY, FakeProtect, HOST, IDS } from './helpers/fakeProtect.js';

function client(protect = new FakeProtect(), options = {}) {
  return new ProtectClient({
    origin: HOST,
    apiKey: API_KEY,
    insecure: true,
    request: protect.request,
    ...options,
  });
}

const kindOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ProtectError);
    assert.ok(!err.message.includes(API_KEY), 'never the key in a message');
    return err.kind;
  }
  throw new Error('no error');
};

test('reads the console under /proxy/protect/integration with the key header', async () => {
  const protect = new FakeProtect();
  const api = client(protect);
  assert.deepEqual(await api.metaInfo(), { applicationVersion: '7.3.70' });
  assert.equal((await api.cameras()).length, 4);
  assert.equal((await api.lights()).length, 1);
  assert.equal((await api.sensors()).length, 3);
  const [first] = protect.requests;
  assert.equal(first.path, '/proxy/protect/integration/v1/meta/info');
  assert.equal(first.headers['X-API-KEY'], API_KEY);
  assert.equal(api.fingerprint, 'AA:BB:CC:DD');
  assert.equal(
    api.socketUrl('events'),
    'wss://192.0.2.1/proxy/protect/integration/v1/subscribe/events',
  );
});

test('snapshots, streams and commands', async () => {
  const protect = new FakeProtect();
  const api = client(protect);
  const { bytes, contentType } = await api.snapshot(IDS.DOORBELL);
  assert.equal(contentType, 'image/jpeg');
  assert.equal(bytes[0], 0xff);
  assert.match(protect.requests.at(-1).path, /\/snapshot\?highQuality=false$/);
  assert.match((await api.rtspsStreams(IDS.DOORBELL)).high, /^rtsps:/);
  const light = await api.setLightForced(IDS.FLOODLIGHT, true);
  assert.equal(light.isLightForceEnabled, true);
  await api.setLcdMessage(IDS.DOORBELL, { type: 'DO_NOT_DISTURB', resetAt: null });
  assert.deepEqual(protect.requests.at(-1).json, {
    lcdMessage: { type: 'DO_NOT_DISTURB', resetAt: null },
  });
  protect.snapshotStatus = 500;
  assert.equal(await kindOf(api.snapshot(IDS.DOORBELL)), ERROR_KINDS.HTTP);
  assert.equal(await kindOf(api.snapshot('missing')), ERROR_KINDS.NOT_FOUND);
});

test('every failure has its kind', async () => {
  const protect = new FakeProtect();
  assert.equal(await kindOf(client(protect, { apiKey: 'wrong' }).cameras()), ERROR_KINDS.AUTH);
  assert.equal(await kindOf(client(protect, { insecure: false }).cameras()), ERROR_KINDS.TLS);
  protect.online = false;
  assert.equal(await kindOf(client(protect).cameras()), ERROR_KINDS.UNREACHABLE);

  const answering =
    (status, body = '{}') =>
    async () => ({
      status,
      headers: {},
      body: Buffer.from(body),
      fingerprint: null,
    });
  const api = (request) => new ProtectClient({ origin: HOST, apiKey: API_KEY, request });
  assert.equal(await kindOf(api(answering(404)).metaInfo()), ERROR_KINDS.NO_API);
  assert.equal(await kindOf(api(answering(404)).cameras()), ERROR_KINDS.NOT_FOUND);
  assert.equal(await kindOf(api(answering(429)).cameras()), ERROR_KINDS.RATE_LIMIT);
  assert.equal(await kindOf(api(answering(403)).cameras()), ERROR_KINDS.AUTH);
  assert.equal(await kindOf(api(answering(502)).cameras()), ERROR_KINDS.HTTP);
  // A login page instead of JSON: not the Integration API.
  assert.equal(await kindOf(api(answering(200, '<html>')).cameras()), ERROR_KINDS.NO_API);
  // A list that is not a list is read as empty.
  assert.deepEqual(await api(answering(200, '{"a":1}')).cameras(), []);
  const timeout = async () => {
    throw Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' });
  };
  assert.equal(await kindOf(api(timeout).cameras()), ERROR_KINDS.UNREACHABLE);
  const expired = async () => {
    throw Object.assign(new Error('expired'), { code: 'CERT_HAS_EXPIRED' });
  };
  assert.equal(await kindOf(api(expired).cameras()), ERROR_KINDS.TLS);
});
