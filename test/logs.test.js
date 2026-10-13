// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal cycle — reads, frames, detections, images, scene events —
// writes nothing; a failure that repeats is logged once, and its end once.
// Never the API key, nor the address of a stream.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_KEY,
  BASE_CONFIG,
  IDS,
  MACS,
  cameraIds,
  createAll,
  createWorld,
  settle,
} from './helpers/world.js';
import { eventFrames } from './helpers/fakeProtect.js';

/** Capture the lines of the SDK logger at a level. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('a normal cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  assert.ok(
    logs.texts().some((text) => text.includes('Connected to UniFi Protect 7.3.70')),
    'the start is logged',
  );
  await createAll(w);
  logs.clear();

  for (let i = 0; i < 3; i += 1) {
    w.protect.update('sensors', IDS.DOOR_SENSOR, {
      stats: { temperature: { value: 20 + i, status: 'neutral' } },
    });
    await w.send(
      'events',
      eventFrames('smartdetect-lifecycle.json').map((frame) => ({
        ...frame,
        item: { ...frame.item, id: `67a0000000000000000001${i}0` },
      })),
    );
    await w.events('ring.json');
    w.clock.advance(5 * 60_000);
    await w.hub.refresh();
    await w.hub.snapshotAll();
  }
  await sleep(80); // the pulses end
  await settle();
  assert.deepEqual(logs.texts(), []);
});

test('a console that stays down is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();

  w.protect.online = false;
  w.protect.dropSockets();
  for (let i = 0; i < 6; i += 1) {
    w.clock.advance(60_000);
    await w.hub.refresh();
    await sleep(50); // the sockets retry
  }
  const lines = logs.texts();
  assert.equal(
    lines.filter((text) => text.includes('Cannot read the console')).length,
    1,
    lines.join('\n'),
  );
  assert.equal(lines.filter((text) => text.includes('Live devices')).length, 1, lines.join('\n'));
  assert.equal(lines.filter((text) => text.includes('Live events')).length, 1, lines.join('\n'));
  assert.equal(lines.length, 3, lines.join('\n'));

  logs.clear();
  w.protect.online = true;
  await w.hub.refresh();
  await sleep(80);
  await settle();
  await w.hub.refresh();
  const back = logs.texts();
  assert.equal(
    back.filter((text) => /answers again after 5 min/.test(text)).length,
    1,
    back.join('\n'),
  );
  assert.equal(back.filter((text) => text.includes('connected again')).length, 2, back.join('\n'));
  assert.equal(back.length, 3, back.join('\n'));
});

test('a refused API key is logged once, its repeats only at debug; never the key', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: { ...BASE_CONFIG, api_key: 'wrong-key-secret-value' } });
  for (let i = 0; i < 5; i += 1) {
    await w.hub.refresh();
    await sleep(50);
  }
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(
    warnings.filter((line) => line.text.includes('Cannot read the console')).length,
    1,
    logs.texts().join('\n'),
  );
  assert.ok(!logs.texts().join('\n').includes('wrong-key-secret-value'), 'never the key');
});

test('a camera that stops sending images is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  await createAll(w);
  logs.clear();
  w.protect.snapshotStatus = 500;
  for (let i = 0; i < 4; i += 1) {
    w.clock.advance(10 * 60_000);
    await w.hub.snapshotAll();
  }
  const failing = logs.texts();
  // One line per camera that is online and added: three of them.
  assert.equal(failing.length, 3, failing.join('\n'));
  assert.ok(failing.every((text) => text.includes('No image from')));
  logs.clear();
  w.protect.snapshotStatus = 200;
  w.clock.advance(10 * 60_000);
  await w.hub.snapshotAll();
  assert.equal(logs.texts().length, 3, logs.texts().join('\n'));
  assert.ok(logs.texts().every((text) => text.includes('back')));
});

test('a user command is one line; the stream address is never logged', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  await createAll(w);
  logs.clear();
  const light = w.fake.discoveredDevices.find((d) => d.external_id.includes(MACS.FLOODLIGHT));
  await w.fake.setValue(light, light.features[0], 1);
  assert.equal(logs.texts().length, 1);
  assert.match(logs.texts()[0], /Projecteur jardin: light forced on/);
  logs.clear();
  await w.fake.action('stream_url', { camera: cameraIds(w.gladys).device });
  assert.equal(logs.texts().length, 1);
  assert.ok(!logs.texts()[0].includes('Xa1Bc2De3Fg4Hi5J'), 'the stream token stays out');
});

test('LOG_LEVEL=debug shows the frames and the reads; never the API key', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t);
  await w.events('ring.json');
  w.protect.online = false;
  await w.hub.refresh();
  await w.hub.refresh();
  const text = logs.texts().join('\n');
  assert.match(text, /\[DEBUG\].*Event ring/);
  assert.match(text, /\[DEBUG\].*Cannot read the console/);
  assert.ok(!text.includes(API_KEY), 'never the key');
});
