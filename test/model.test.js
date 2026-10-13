// -----------------------------------------------------------------------------
// Reading the Integration API payloads: devices, partial and bulk frames, and
// the detection events folded into what a camera sees.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DeviceStore,
  EventTracker,
  KINDS,
  mergePayload,
  normalizeMac,
  parseCamera,
  parseLight,
  parseSensor,
} from '../src/protect/model.js';
import { IDS, eventFrames } from './helpers/fakeProtect.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/protect/${name}`, import.meta.url), 'utf8'));

test('MAC addresses are normalized, anything else refused', () => {
  assert.equal(normalizeMac('F4:E2:C6:00:00:01'), 'f4e2c6000001');
  assert.equal(normalizeMac('F4E2C6000001'), 'f4e2c6000001');
  assert.equal(normalizeMac('nope'), null);
  assert.equal(normalizeMac(undefined), null);
});

test('cameras: doorbell by model name, smart types the camera has', () => {
  const [doorbell, driveway, garage, nameless] = fixture('cameras.json').map(parseCamera);
  assert.equal(doorbell.doorbell, true);
  assert.deepEqual(doorbell.smartTypes, ['person', 'vehicle', 'package']);
  assert.deepEqual(driveway.smartTypes, ['person', 'vehicle', 'animal']);
  assert.equal(driveway.doorbell, false);
  assert.equal(garage.online, false);
  assert.equal(nameless.name, null);
  assert.equal(nameless.model, null);
  assert.equal(nameless.doorbell, false);
  // A package camera alone is enough for the package feature.
  const camera = parseCamera({ ...fixture('cameras.json')[1], hasPackageCamera: true });
  assert.ok(camera.smartTypes.includes('package'));
});

test('floodlight: light on, forced, PIR motion', () => {
  const light = parseLight({
    ...fixture('lights.json')[0],
    isLightOn: true,
    isPirMotionDetected: true,
  });
  assert.equal(light.kind, KINDS.LIGHT);
  assert.equal(light.lightOn, true);
  assert.equal(light.motion, true);
  assert.equal(light.forced, false);
});

test('sensors: capabilities from the feature flags, else from the mount', () => {
  const [door, leak, windowSensor] = fixture('sensors.json').map(parseSensor);
  assert.deepEqual(door.capabilities, {
    temperature: true,
    humidity: true,
    light: true,
    motion: true,
    opening: true,
    leak: false,
  });
  assert.equal(door.opened, true);
  assert.equal(door.temperature, 21.37);
  // A leak mount suppresses the environment readings.
  assert.deepEqual(leak.capabilities, {
    temperature: false,
    humidity: false,
    light: false,
    motion: false,
    opening: false,
    leak: true,
  });
  assert.equal(leak.temperature, null);
  assert.equal(leak.battery, 61);
  // Older firmware, no feature flags: what a window mount allows.
  assert.equal(windowSensor.capabilities.opening, true);
  assert.equal(windowSensor.capabilities.leak, false);
  // A sensor on no mount has no opening.
  assert.equal(
    parseSensor({ ...fixture('sensors.json')[0], mountType: 'none' }).capabilities.opening,
    false,
  );
  // `featureFlags: null` (UP-AirQuality on Protect 7.2) is read like an absent map.
  assert.equal(
    parseSensor({ ...fixture('sensors.json')[2], featureFlags: null }).capabilities.temperature,
    true,
  );
});

test('a partial update merges nested objects key by key', () => {
  const merged = mergePayload(
    {
      stats: { temperature: { value: 20, status: 'neutral' }, humidity: { value: 40 } },
      list: [1, 2],
    },
    { stats: { temperature: { value: 21 } }, list: [3] },
  );
  assert.deepEqual(merged, {
    stats: { temperature: { value: 21, status: 'neutral' }, humidity: { value: 40 } },
    list: [3],
  });
});

test('the device store: lists, frames, bulk frames, removals', () => {
  const store = new DeviceStore();
  assert.equal(store.replace(KINDS.CAMERA, fixture('cameras.json')), true);
  assert.equal(store.replace(KINDS.CAMERA, fixture('cameras.json')), false, 'same list');
  assert.equal(store.devices(KINDS.CAMERA).length, 4);

  // Without a MAC, a payload is ignored: the MAC is the identity.
  store.replace(KINDS.LIGHT, [{ id: 'x', modelKey: 'light' }]);
  assert.equal(store.devices(KINDS.LIGHT).length, 0);

  const update = store.applyFrame({
    type: 'update',
    item: { id: IDS.GARAGE, modelKey: 'camera', state: 'CONNECTED' },
  });
  assert.deepEqual(update, { ids: [IDS.GARAGE], membership: false });
  assert.equal(store.get(IDS.GARAGE).online, true);

  const bulk = store.applyFrame({
    type: 'update',
    item: { id: [IDS.DOORBELL, IDS.DRIVEWAY], modelKey: 'camera', state: 'DISCONNECTED' },
  });
  assert.deepEqual(bulk.ids, [IDS.DOORBELL, IDS.DRIVEWAY]);

  assert.deepEqual(
    store.applyFrame({ type: 'update', item: { id: 'unknown', modelKey: 'camera' } }),
    {
      ids: [],
      membership: false,
    },
  );
  assert.equal(
    store.applyFrame({ type: 'remove', item: { id: IDS.GARAGE, modelKey: 'camera' } }).membership,
    true,
  );
  assert.equal(store.get(IDS.GARAGE), null);
  // Other models (chimes, sirens, the NVR) are not devices of the integration.
  assert.deepEqual(store.applyFrame({ type: 'add', item: { id: 'c', modelKey: 'chime' } }), {
    ids: [],
    membership: false,
  });
});

test('events: a smart detection opens, gains types, closes once', () => {
  const tracker = new EventTracker({ now: () => 0 });
  const [add, more, end, duplicate] = eventFrames('smartdetect-lifecycle.json');
  const opened = tracker.applyFrame(add);
  assert.equal(opened.opened, true);
  assert.deepEqual(opened.newObjects, ['person']);
  assert.deepEqual([...tracker.activity(IDS.DRIVEWAY).objects], ['person']);
  assert.deepEqual(tracker.applyFrame(more).newObjects, ['vehicle']);
  const closed = tracker.applyFrame(end);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.newObjects, []);
  assert.equal(tracker.applyFrame(duplicate).closed, false, 'a repeated end is no news');
  assert.equal(tracker.activity(IDS.DRIVEWAY).objects.size, 0);
});

test('events: a package arrives closed in one update frame', () => {
  const tracker = new EventTracker();
  const [frame] = eventFrames('package-born-closed.json');
  const result = tracker.applyFrame(frame);
  assert.equal(result.opened && result.closed, true);
  assert.deepEqual(result.newObjects, ['package']);
  // An update of an unseen event that is not complete is dropped.
  assert.equal(
    tracker.applyFrame({ type: 'update', item: { id: 'x', modelKey: 'event', end: 5 } }),
    null,
  );
});

test('events: motion, ring, an event never closed', () => {
  let now = 0;
  const tracker = new EventTracker({ now: () => now, maxOpenMs: 1000 });
  const [motion] = eventFrames('motion-lifecycle.json');
  tracker.applyFrame(motion);
  assert.equal(tracker.activity(IDS.DRIVEWAY).motion, true);
  const [ring] = eventFrames('ring.json');
  assert.deepEqual(tracker.applyFrame(ring).newObjects, [], 'a ring is not a smart detection');
  now = 2000;
  assert.deepEqual(tracker.expire(), [IDS.DRIVEWAY, IDS.DOORBELL]);
  assert.equal(tracker.activity(IDS.DRIVEWAY).motion, false);
  assert.deepEqual(tracker.expire(), [], 'already closed');
});

test('events: the tracker keeps a bounded number of events', () => {
  const tracker = new EventTracker({ maxEvents: 3 });
  for (let i = 0; i < 10; i += 1) {
    tracker.applyFrame({
      type: 'add',
      item: { id: `e${i}`, modelKey: 'event', type: 'motion', start: i, device: 'cam' },
    });
  }
  assert.deepEqual([...tracker.events.keys()], ['e7', 'e8', 'e9']);
  assert.equal(
    tracker.applyFrame({ type: 'remove', item: { id: 'e9', modelKey: 'event' } }).closed,
    true,
  );
  assert.equal(tracker.applyFrame({ type: 'add', item: { id: ['a'], modelKey: 'event' } }), null);
  assert.equal(tracker.applyFrame({ type: 'add', item: { id: 'z', modelKey: 'camera' } }), null);
});
