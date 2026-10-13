// -----------------------------------------------------------------------------
// The timers of the container. Gladys never polls a device published with
// should_poll: false (and never polls the devices created without should_poll,
// GladysAssistant/Gladys#3198): the console must be read again by the hub's
// own timer, with no onPoll at all — every 5 minutes while the devices socket
// is live, every minute while it is down — and the camera images refreshed at
// the interval of the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUB_TIMINGS } from '../src/hub.js';
import { BASE_CONFIG, IDS, MACS, createAll, createWorld, ids, settle } from './helpers/world.js';

async function timedWorld(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_760_000_000_000 });
  // The hub reads the mocked clock, which the ticks move.
  const clock = { now: () => Date.now() };
  const w = await createWorld({ timers: true, clock, ...options });
  t.after(() => w.app.stop());
  await createAll(w);
  return w;
}

const cameraReads = (w) => w.protect.requests.filter((r) => r.path.endsWith('/v1/cameras')).length;

async function tick(t, ms) {
  t.mock.timers.tick(ms);
  await settle();
}

test('the internal timer reads the console again without any onPoll from Gladys', async (t) => {
  const w = await timedWorld(t);
  assert.ok(w.fake.discoveredDevices.every((device) => device.should_poll === false));
  const feature = ids(w.gladys, 'sensor', MACS.DOOR_SENSOR).feature('temperature');
  const before = cameraReads(w);

  // A change the devices socket never told (a frame lost): the next read sees it.
  w.protect.sensors.find((sensor) => sensor.id === IDS.DOOR_SENSOR).stats.temperature.value = 18.2;
  await tick(t, HUB_TIMINGS.refreshMs);
  assert.equal(w.fake.lastState(feature), 18.2);
  w.protect.sensors.find((sensor) => sensor.id === IDS.DOOR_SENSOR).stats.temperature.value = 17.5;
  await tick(t, HUB_TIMINGS.refreshMs);
  assert.equal(w.fake.lastState(feature), 17.5);

  // The test never calls fake.poll(): every read came from the timer.
  assert.equal(cameraReads(w) - before, 2, 'one read per interval');
});

test('while the devices socket is down, the console is read every minute', async (t) => {
  const w = await timedWorld(t, { socketTimings: { reconnectMinMs: 10 * 60_000 } });
  w.protect.dropSockets();
  await settle();
  const before = cameraReads(w);
  await tick(t, HUB_TIMINGS.fallbackRefreshMs);
  await tick(t, HUB_TIMINGS.fallbackRefreshMs);
  assert.equal(cameraReads(w) - before, 2);
});

test('camera images follow the interval of the configuration', async (t) => {
  const w = await timedWorld(t);
  const images = w.fake.cameraImages.length;
  await tick(t, 5 * 60_000);
  // Three cameras added and online (the garage camera is offline).
  assert.equal(w.fake.cameraImages.length - images, 3);
});

test('no periodic image when the configuration says "only on detection"', async (t) => {
  const w = await timedWorld(t, { config: { ...BASE_CONFIG, snapshot_interval: '0' } });
  const images = w.fake.cameraImages.length;
  await tick(t, 60 * 60_000);
  assert.equal(w.fake.cameraImages.length, images);
});

test('the timers stop with the integration', async (t) => {
  const w = await timedWorld(t);
  await w.app.stop();
  const requests = w.protect.requests.length;
  await tick(t, 60 * 60_000);
  assert.equal(w.protect.requests.length, requests);
  assert.equal(w.protect.openSockets().length, 0);
});

test('an unchanged value is sent again every 6 hours (heartbeat, under the 12 h rule)', async (t) => {
  const w = await timedWorld(t);
  const feature = ids(w.gladys, 'sensor', MACS.WINDOW_SENSOR).feature('battery');
  const sent = () =>
    w.fake.states.filter((state) => state.device_feature_external_id === feature).length;
  const before = sent();
  // Reads every 5 minutes, the battery never changes.
  for (let elapsed = 0; elapsed < HUB_TIMINGS.heartbeatMs - HUB_TIMINGS.refreshMs;) {
    await tick(t, HUB_TIMINGS.refreshMs);
    elapsed += HUB_TIMINGS.refreshMs;
  }
  assert.equal(sent(), before, 'nothing sent while the value is recent');
  await tick(t, 2 * HUB_TIMINGS.refreshMs);
  assert.equal(sent(), before + 1, 'sent again once 6 hours old');
  assert.ok(HUB_TIMINGS.heartbeatMs <= 12 * 60 * 60_000);
});
