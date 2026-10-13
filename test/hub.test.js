// -----------------------------------------------------------------------------
// The hub against a fake console: what Gladys receives for every kind of
// device, detection, ring, command and outage.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_TEXT } from '../src/texts.js';
import { ERROR_KINDS } from '../src/protect/client.js';
import { HUB_TIMINGS } from '../src/hub.js';
import {
  BASE_CONFIG,
  FakeProtect,
  IDS,
  MACS,
  cameraIds,
  createAll,
  createWorld,
  ids,
  settle,
} from './helpers/world.js';
import { eventFrames } from './helpers/fakeProtect.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (w, kind, mac, key) => w.fake.lastState(ids(w.gladys, kind, mac).feature(key));
const discovered = (w, kind, mac) =>
  w.fake.discoveredDevices.find((device) => device.external_id === ids(w.gladys, kind, mac).device);

test('one device per camera, floodlight and sensor, never polled by Gladys', async (t) => {
  const w = await world(t);
  const devices = w.fake.discoveredDevices;
  assert.equal(devices.length, 8);
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  const keys = (kind, mac) =>
    discovered(w, kind, mac).features.map((feature) => feature.external_id.split(':').pop());
  assert.deepEqual(keys('camera', MACS.DOORBELL), [
    'image',
    'online',
    'motion',
    'person',
    'vehicle',
    'package',
    'ring',
  ]);
  // License plates fire the trigger but have no feature.
  assert.deepEqual(keys('camera', MACS.DRIVEWAY), [
    'image',
    'online',
    'motion',
    'person',
    'vehicle',
    'animal',
  ]);
  assert.deepEqual(keys('camera', MACS.GARAGE), ['image', 'online', 'motion']);
  assert.deepEqual(keys('light', MACS.FLOODLIGHT), ['light', 'motion', 'online']);
  assert.deepEqual(keys('sensor', MACS.DOOR_SENSOR), [
    'opening',
    'temperature',
    'humidity',
    'brightness',
    'motion',
    'battery',
    'online',
  ]);
  assert.deepEqual(keys('sensor', MACS.LEAK_SENSOR), ['leak', 'battery', 'online']);
  // Older firmware without feature flags: what a window mount allows.
  assert.deepEqual(keys('sensor', MACS.WINDOW_SENSOR), [
    'opening',
    'temperature',
    'humidity',
    'brightness',
    'motion',
    'battery',
    'online',
  ]);
  assert.equal(discovered(w, 'camera', MACS.NAMELESS).name, 'Camera 000004');
  assert.equal(w.fake.connectionStatus.connected, true);
});

test('states go only to the devices the user added, then all of them', async (t) => {
  const w = await world(t);
  assert.equal(w.fake.states.length, 0, 'nothing is sent for devices not added');
  await createAll(w);
  assert.equal(state(w, 'camera', MACS.DOORBELL, 'online'), 1);
  assert.equal(state(w, 'camera', MACS.GARAGE, 'online'), 0);
  assert.equal(state(w, 'camera', MACS.DOORBELL, 'motion'), 0);
  assert.equal(state(w, 'light', MACS.FLOODLIGHT, 'light'), 0);
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'temperature'), 21.4);
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'humidity'), 48);
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'brightness'), 12);
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'battery'), 90);
  assert.equal(state(w, 'sensor', MACS.LEAK_SENSOR, 'leak'), 0);
  // Every added camera got an image.
  assert.equal(w.fake.cameraImages.length, 4);
  assert.match(w.fake.cameraImages[0].image, /^image\/jpg;base64,\/9j\//);
});

test('opening sensor: 0 is open, 1 is closed (the core convention)', async (t) => {
  const w = await world(t);
  await createAll(w);
  // The door sensor of the fixtures is open, the window closed.
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'opening'), 0);
  assert.equal(state(w, 'sensor', MACS.WINDOW_SENSOR, 'opening'), 1);
  w.protect.update('sensors', IDS.DOOR_SENSOR, { isOpened: false });
  await settle();
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'opening'), 1);
  w.protect.update('sensors', IDS.WINDOW_SENSOR, { isOpened: true });
  await settle();
  assert.equal(state(w, 'sensor', MACS.WINDOW_SENSOR, 'opening'), 0);
});

test('sensor readings, leaks and motion follow the devices socket, changes only', async (t) => {
  const w = await world(t);
  await createAll(w);
  const before = w.fake.states.length;
  // A partial diff of a nested object, as the console sends it.
  w.protect.send('devices', {
    type: 'update',
    item: { id: IDS.DOOR_SENSOR, modelKey: 'sensor', stats: { temperature: { value: 22.04 } } },
  });
  await settle();
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'temperature'), 22);
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'humidity'), 48, 'humidity kept');
  assert.equal(w.fake.states.length, before + 1, 'only the change is sent');
  w.protect.update('sensors', IDS.LEAK_SENSOR, { leakDetectedAt: 1735690000000 });
  w.protect.update('sensors', IDS.DOOR_SENSOR, { isMotionDetected: true });
  await settle();
  assert.equal(state(w, 'sensor', MACS.LEAK_SENSOR, 'leak'), 1);
  assert.equal(state(w, 'sensor', MACS.DOOR_SENSOR, 'motion'), 1);
});

test('a smart detection: its types turn on, then off; one scene event per type, after a fresh image', async (t) => {
  const w = await world(t);
  await createAll(w);
  const [add, more, end, duplicate] = eventFrames('smartdetect-lifecycle.json');
  // Past the spacing of the images taken when the devices were added.
  w.clock.advance(HUB_TIMINGS.imageSpacingMs + 1);
  const imagesBefore = w.fake.cameraImages.length;

  await w.send('events', add);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'person'), 1);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'vehicle'), 0);
  await w.send('events', more);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'vehicle'), 1);
  await w.send('events', end);
  await w.send('events', duplicate);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'person'), 0);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'vehicle'), 0);

  const events = w.fake.sceneEvents.filter((event) => event.key === 'object_detected');
  assert.deepEqual(
    events.map((event) => event.data),
    [
      {
        camera: cameraIds(w.gladys, MACS.DRIVEWAY).device,
        object: 'person',
        camera_name: 'Allée',
        object_name: 'person',
      },
      {
        camera: cameraIds(w.gladys, MACS.DRIVEWAY).device,
        object: 'vehicle',
        camera_name: 'Allée',
        object_name: 'vehicle',
      },
    ],
  );
  // The image of the camera went to Gladys before its scene event.
  assert.equal(w.fake.cameraImages.length, imagesBefore + 1);
  const paths = w.fake.requests.map((request) => request.path);
  assert.ok(paths.lastIndexOf('/camera/image') < paths.indexOf('/scene/event'));
});

test('motion turns on with its event and off at its end', async (t) => {
  const w = await world(t);
  await createAll(w);
  const [start, end] = eventFrames('motion-lifecycle.json');
  await w.send('events', start);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'motion'), 1);
  await w.send('events', end);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'motion'), 0);
  assert.equal(w.fake.sceneEvents.length, 0, 'plain motion fires no trigger');
});

test('a package, detected in one closed frame, pulses and fires the trigger', async (t) => {
  const w = await world(t);
  await createAll(w);
  await w.events('package-born-closed.json');
  assert.equal(state(w, 'camera', MACS.DOORBELL, 'package'), 1);
  assert.deepEqual(w.fake.sceneEvents.at(-1).data.object, 'package');
  await sleep(80);
  await settle();
  assert.equal(state(w, 'camera', MACS.DOORBELL, 'package'), 0);
});

test('a ring pulses the ring feature and fires doorbell_rang with a fresh image', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, language: 'fr' } });
  await createAll(w);
  w.clock.advance(HUB_TIMINGS.imageSpacingMs + 1);
  const images = w.fake.cameraImages.length;
  await w.events('ring.json');
  assert.equal(state(w, 'camera', MACS.DOORBELL, 'ring'), 1);
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: 'doorbell_rang',
      data: {
        doorbell: cameraIds(w.gladys, MACS.DOORBELL).device,
        doorbell_name: "Porte d'entrée",
      },
    },
  ]);
  assert.equal(w.fake.cameraImages.length, images + 1);
  await sleep(80);
  await settle();
  assert.equal(state(w, 'camera', MACS.DOORBELL, 'ring'), 0);
});

test('a camera the console does not name a doorbell becomes one when it rings, and stays one', async (t) => {
  const protect = new FakeProtect();
  const first = await world(t, { protect });
  const keys = () =>
    discovered(first, 'camera', MACS.NAMELESS).features.map((f) => f.external_id.split(':').pop());
  assert.ok(!keys().includes('ring'));
  await first.send('events', {
    type: 'add',
    item: {
      id: '67a00000000000000000ff01',
      modelKey: 'event',
      type: 'ring',
      start: 1735690000000,
      device: IDS.NAMELESS,
    },
  });
  assert.ok(keys().includes('ring'), 'the ring feature appears in the Discovery tab');
  await first.app.stop();

  // After a restart (same /data), the camera keeps its ring feature.
  const second = await world(t, { protect, dataDir: first.dataDir });
  assert.ok(
    discovered(second, 'camera', MACS.NAMELESS).features.some((f) =>
      f.external_id.endsWith(':ring'),
    ),
  );
});

test('the floodlight: forced on from Gladys, back to its mode, motion from the socket', async (t) => {
  const w = await world(t);
  await createAll(w);
  const light = discovered(w, 'light', MACS.FLOODLIGHT);
  const feature = light.features.find((f) => f.external_id.endsWith(':light'));
  assert.equal(feature.read_only, false);

  const ack = await w.fake.setValue(light, feature, 1);
  assert.equal(ack.success, true, ack.error);
  const patch = w.protect.requests.find((request) => request.method === 'PATCH');
  assert.equal(patch.path, `/proxy/protect/integration/v1/lights/${IDS.FLOODLIGHT}`);
  assert.deepEqual(patch.json, { isLightForceEnabled: true });
  assert.equal(state(w, 'light', MACS.FLOODLIGHT, 'light'), 1);

  await w.fake.setValue(light, feature, 0);
  assert.deepEqual(w.protect.requests.at(-1).json, { isLightForceEnabled: false });
  assert.equal(state(w, 'light', MACS.FLOODLIGHT, 'light'), 0);

  w.protect.update('lights', IDS.FLOODLIGHT, { isPirMotionDetected: true, isLightOn: true });
  await settle();
  assert.equal(state(w, 'light', MACS.FLOODLIGHT, 'motion'), 1);
  assert.equal(state(w, 'light', MACS.FLOODLIGHT, 'light'), 1);

  // A command on a read-only feature is refused.
  const motion = light.features.find((f) => f.external_id.endsWith(':motion'));
  assert.equal((await w.fake.setValue(light, motion, 1)).success, false);
});

test('floodlight motion events pulse its motion feature', async (t) => {
  const w = await world(t);
  await createAll(w);
  await w.events('light-motion.json');
  assert.equal(state(w, 'light', MACS.FLOODLIGHT, 'motion'), 1);
  await sleep(80);
  await settle();
  assert.equal(state(w, 'light', MACS.FLOODLIGHT, 'motion'), 0);
});

test('a camera going offline: its state, its transport badge, back online', async (t) => {
  const w = await world(t);
  await createAll(w);
  const external = cameraIds(w.gladys, MACS.DRIVEWAY).device;
  w.protect.update('cameras', IDS.DRIVEWAY, { state: 'DISCONNECTED' });
  await settle();
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'online'), 0);
  assert.equal(
    w.fake.transports.filter((entry) => entry.device_external_id === external).at(-1).transport,
    'unreachable',
  );
  w.protect.update('cameras', IDS.DRIVEWAY, { state: 'CONNECTED' });
  await settle();
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'online'), 1);
  assert.equal(
    w.fake.transports.filter((entry) => entry.device_external_id === external).at(-1).transport,
    'local',
  );
});

test('a camera adopted or removed in Protect updates the Discovery tab', async (t) => {
  const w = await world(t);
  const added = {
    ...w.protect.cameras[2],
    id: '66f1a2b3c4d5e6f708090a09',
    mac: 'F4E2C6000009',
    name: 'Terrasse',
  };
  await w.send('devices', { type: 'add', item: added });
  assert.equal(w.fake.discoveredDevices.length, 9);
  await w.send('devices', { type: 'remove', item: { id: added.id, modelKey: 'camera' } });
  assert.equal(w.fake.discoveredDevices.length, 8);
  // A bulk frame: one payload, several ids.
  await w.send('devices', {
    type: 'update',
    item: { id: [IDS.DOORBELL, IDS.DRIVEWAY], modelKey: 'camera', state: 'DISCONNECTED' },
  });
  assert.equal(w.hub.devices.get(IDS.DOORBELL).online, false);
  assert.equal(w.hub.devices.get(IDS.DRIVEWAY).online, false);
});

test('adding a device in Gladys sends its states and its image again', async (t) => {
  const w = await world(t);
  await createAll(w);
  const doorbell = discovered(w, 'camera', MACS.DOORBELL);
  const before = w.fake.states.length;
  const images = w.fake.cameraImages.length;
  await w.fake.deviceCreated(doorbell);
  await settle();
  assert.ok(w.fake.states.length > before, 'states sent again (the SDK forgot them)');
  assert.ok(w.fake.cameraImages.length >= images);
  assert.ok(w.fake.widgetRefreshes.includes('protect'));
});

test('Gladys asks for a fresh image: the live view gets the snapshot', async (t) => {
  const w = await world(t);
  await createAll(w);
  const doorbell = discovered(w, 'camera', MACS.DOORBELL);
  const ack = await w.fake.getImage(doorbell);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.image, /^image\/jpg;base64,/);
  w.protect.snapshotStatus = 500;
  w.clock.advance(HUB_TIMINGS.imageSpacingMs + 1);
  const failed = await w.fake.getImage(doorbell);
  assert.equal(failed.success, false);
  const light = discovered(w, 'light', MACS.FLOODLIGHT);
  assert.equal((await w.fake.getImage(light)).success, false);
});

test('images of a camera are spaced: 12 a minute at most', async (t) => {
  const w = await world(t);
  await createAll(w);
  const snapshots = () =>
    w.protect.requests.filter((request) => request.path.includes('/snapshot')).length;
  const before = snapshots();
  await w.events('ring.json');
  await w.send('events', {
    type: 'add',
    item: {
      id: '67a00000000000000000ff02',
      modelKey: 'event',
      type: 'ring',
      start: 1735690001000,
      device: IDS.DOORBELL,
    },
  });
  assert.equal(snapshots(), before, 'the image of the first ring is reused within 6 s');
  assert.equal(w.fake.sceneEvents.length, 2, 'both rings fire the trigger');
});

test('the console unreachable: connection status, transports; then back', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.protect.online = false;
  w.protect.dropSockets();
  await settle();
  await w.hub.refresh();
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.deepEqual(w.fake.connectionStatus.message, ERROR_TEXT[ERROR_KINDS.UNREACHABLE]);
  assert.ok(w.fake.transports.some((entry) => entry.transport === 'unreachable'));
  w.protect.online = true;
  await w.hub.refresh();
  await sleep(60); // the sockets reconnect after their delay
  await settle();
  assert.equal(w.fake.connectionStatus.connected, true);
  assert.equal(w.fake.connectionStatus.message, undefined);
  assert.equal(w.protect.openSockets().length, 2);
});

test('a self-signed certificate is refused until the user accepts it', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, allow_self_signed: false } });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.deepEqual(w.fake.connectionStatus.message, ERROR_TEXT[ERROR_KINDS.TLS]);
  assert.equal(w.fake.discoveredDevices.length, 0);
  await w.fake.configUpdated({ ...BASE_CONFIG, allow_self_signed: true });
  await settle();
  assert.equal(w.fake.connectionStatus.connected, true);
  assert.equal(w.fake.discoveredDevices.length, 8);
  // The sockets follow the same choice.
  assert.equal(w.protect.socketAttempts.at(-1).options.rejectUnauthorized, false);
});

test('a refused API key says so, sockets included', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, api_key: 'wrong' } });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.deepEqual(w.fake.connectionStatus.message, ERROR_TEXT[ERROR_KINDS.AUTH]);
  assert.equal(w.protect.openSockets().length, 0);
});

test('nothing configured: no device, and the status says what to do', async (t) => {
  const w = await world(t, { config: {} });
  assert.deepEqual(w.fake.discoveredDevices, []);
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /address of your UniFi console/);
  const invalid = await world(t, { config: { host: 'http://192.0.2.1', api_key: 'x' } });
  assert.match(invalid.fake.connectionStatus.message.en, /Address not understood/);
});

test('the events socket reopening closes the detections whose end was missed', async (t) => {
  const w = await world(t);
  await createAll(w);
  const [add] = eventFrames('smartdetect-lifecycle.json');
  await w.send('events', add);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'person'), 1);
  w.protect.dropSockets();
  await sleep(60);
  await settle();
  assert.equal(w.protect.openSockets('events').length, 1, 'reconnected');
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'person'), 0);
});

test('a detection never closed is dropped after 30 minutes', async (t) => {
  const w = await world(t);
  await createAll(w);
  const [start] = eventFrames('motion-lifecycle.json');
  await w.send('events', start);
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'motion'), 1);
  w.clock.advance(31 * 60_000);
  await w.hub.refresh();
  assert.equal(state(w, 'camera', MACS.DRIVEWAY, 'motion'), 0);
});

test('a new language renames the devices offered in the Discovery tab', async (t) => {
  const w = await world(t);
  assert.equal(discovered(w, 'camera', MACS.NAMELESS).name, 'Camera 000004');
  await w.fake.configUpdated({ ...BASE_CONFIG, language: 'de' });
  await settle();
  const camera = discovered(w, 'camera', MACS.NAMELESS);
  assert.equal(camera.name, 'Kamera 000004');
  assert.deepEqual(
    camera.features.map((feature) => feature.name),
    ['Bild', 'Online', 'Bewegung', 'Person'],
  );
  assert.equal(w.protect.socketAttempts.length, 2, 'same console: the sockets stay open');
});

test('Gladys restarting: everything is sent again', async (t) => {
  const w = await world(t);
  await createAll(w);
  const states = w.fake.states.length;
  await w.gladys.disconnect();
  await w.gladys.connect();
  await settle();
  assert.ok(w.fake.states.length > states, 'the states are sent again');
});

test('test the connection: version, devices, certificate fingerprint', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, language: 'fr' } });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.fr,
    'UniFi Protect 7.3.70 : 4 caméra(s), 1 projecteur(s), 3 capteur(s). Certificat auto-signé accepté, SHA-256 AA:BB:CC:DD.',
  );
  w.protect.online = false;
  const failed = await w.fake.action('test_connection', {});
  assert.deepEqual(failed.data.message, ERROR_TEXT[ERROR_KINDS.UNREACHABLE]);
});

test('the video stream address: RTSP for the RTSP camera integration of Gladys', async (t) => {
  const w = await world(t);
  await createAll(w);
  const camera = cameraIds(w.gladys, MACS.DOORBELL).device;
  const ack = await w.fake.action('stream_url', { camera });
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /rtsp:\/\/192\.0\.2\.1:7447\/Xa1Bc2De3Fg4Hi5J$/);
  w.protect.rtsps = { high: null, medium: null, low: null };
  const none = await w.fake.action('stream_url', { camera });
  assert.match(none.data.message.en, /No RTSPS stream/);
  const missing = await w.fake.action('stream_url', {});
  assert.equal(missing.success, false);
});

test('onPoll, if Gladys ever polls, reads the console', async (t) => {
  const w = await world(t);
  await createAll(w);
  const reads = () => w.protect.requests.filter((r) => r.path.endsWith('/v1/cameras')).length;
  const before = reads();
  const ack = await w.fake.poll(discovered(w, 'camera', MACS.DOORBELL));
  assert.equal(ack.success, true);
  assert.equal(reads(), before + 1);
});
