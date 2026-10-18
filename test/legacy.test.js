// Night detection over the internal API, with the optional local account
// (forum t/11350): isDark of each camera as a "Dark" feature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_CONFIG, FakeProtect, MACS, createAll, createWorld, ids } from './helpers/world.js';

const ACCOUNT = { ...BASE_CONFIG, username: 'gladys', password: 'secret pass' };

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const darkOf = (w, mac) => w.fake.lastState(ids(w.gladys, 'camera', mac).feature('dark'));
const hasDark = (w, mac) =>
  w.fake.discoveredDevices
    .find((device) => device.external_id === ids(w.gladys, 'camera', mac).device)
    .features.some((feature) => feature.external_id.endsWith(':dark'));
const logins = (w) => w.protect.requests.filter((r) => r.path === '/api/auth/login').length;

test('without a local account: no "Dark" feature, no login', async (t) => {
  const w = await world(t);
  assert.equal(hasDark(w, MACS.DOORBELL), false);
  assert.equal(logins(w), 0);
});

test('with a local account: "Dark" follows isDark of each camera', async (t) => {
  const protect = new FakeProtect();
  protect.dark.set('F4E2C6000001', false);
  const w = await world(t, { protect, config: ACCOUNT });
  assert.equal(hasDark(w, MACS.DOORBELL), true);
  const feature = w.fake.discoveredDevices[0].features.find((f) => f.external_id.endsWith(':dark'));
  assert.equal(`${feature.category}/${feature.type}`, 'input/binary');
  await createAll(w);
  assert.equal(darkOf(w, MACS.DOORBELL), 0);
  assert.equal(darkOf(w, MACS.DRIVEWAY), undefined, 'unknown: nothing published');

  protect.dark.set('F4E2C6000001', true);
  await w.hub.readDarkness();
  assert.equal(darkOf(w, MACS.DOORBELL), 1);
  assert.equal(logins(w), 1, 'the session is kept between reads');

  // The session expired: one new login, the read goes on.
  protect.session += 1;
  protect.dark.set('F4E2C6000001', false);
  assert.equal(await w.hub.readDarkness(), true);
  assert.equal(darkOf(w, MACS.DOORBELL), 0);
  assert.equal(logins(w), 2);
  const login = w.protect.requests.find((r) => r.path === '/api/auth/login');
  assert.deepEqual(login.json, { username: 'gladys', password: 'secret pass', rememberMe: true });
});

test('a refused login is not tried again, the rest keeps working', async (t) => {
  const w = await world(t, { config: { ...ACCOUNT, password: 'wrong', language: 'fr' } });
  await createAll(w);
  assert.equal(await w.hub.readDarkness(), false);
  assert.equal(await w.hub.readDarkness(), false);
  assert.equal(logins(w), 1, 'a console locks an account after repeated failures');
  assert.equal(
    w.fake.lastState(ids(w.gladys, 'camera', MACS.DOORBELL).feature('online')),
    1,
    'the API key still carries the states',
  );
  const ack = await w.fake.action('test_connection', {});
  assert.match(
    ack.data.message.fr,
    /Détection de nuit indisponible : Login refused \(HTTP 401\)\.$/,
  );
  assert.doesNotMatch(JSON.stringify(ack), /wrong/);
});

test('the connection test tells how many cameras the night detection reads', async (t) => {
  const w = await world(t, { config: { ...ACCOUNT, language: 'fr' } });
  const ack = await w.fake.action('test_connection', {});
  // No camera tells isDark in the fixtures yet.
  assert.match(ack.data.message.fr, /Détection de nuit : lue sur 0 caméra\(s\)\.$/);
});

test('a UniFi OS cookie named UOS_TOKEN opens the session too', async (t) => {
  const protect = new FakeProtect();
  protect.cookieName = 'UOS_TOKEN';
  protect.dark.set('F4E2C6000001', true);
  const w = await world(t, { protect, config: ACCOUNT });
  await createAll(w);
  assert.equal(darkOf(w, MACS.DOORBELL), 1);
});

test('an account that cannot see Protect: one login, never a loop', async (t) => {
  const protect = new FakeProtect();
  protect.protectAccess = false;
  const w = await world(t, { protect, config: ACCOUNT });
  assert.equal(await w.hub.readDarkness(), false);
  assert.equal(await w.hub.readDarkness(), false);
  assert.equal(logins(w), 1);
});

test('a console that restarts (login 404) is tried again; reads share one login', async (t) => {
  const protect = new FakeProtect();
  protect.loginStatus = 404;
  protect.dark.set('F4E2C6000001', true);
  const w = await world(t, { protect, config: ACCOUNT });
  await createAll(w);
  assert.equal(await w.hub.readDarkness(), false);
  protect.loginStatus = null;
  const before = logins(w);
  const results = await Promise.all([w.hub.readDarkness(), w.hub.readDarkness()]);
  assert.deepEqual(results, [true, true]);
  assert.equal(logins(w) - before, 1);
  assert.equal(darkOf(w, MACS.DOORBELL), 1);
});
