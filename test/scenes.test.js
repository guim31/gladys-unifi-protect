// -----------------------------------------------------------------------------
// The scene actions: a fresh camera image for the next action, the doorbell
// screen message. Nothing they do can lower the security of the house.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUB_TIMINGS } from '../src/hub.js';
import { parseMinutes } from '../src/scenes.js';
import { IDS, MACS, cameraIds, createAll, createWorld } from './helpers/world.js';

async function world(t) {
  const w = await createWorld();
  t.after(() => w.app.stop());
  await createAll(w);
  return w;
}

const lcdPatches = (w) =>
  w.protect.requests
    .filter(
      (request) => request.method === 'PATCH' && request.path.endsWith(`/cameras/${IDS.DOORBELL}`),
    )
    .map((request) => request.json.lcdMessage);

test('refresh_snapshot sends a fresh image of the camera to Gladys', async (t) => {
  const w = await world(t);
  const images = w.fake.cameraImages.length;
  const ack = await w.fake.sceneAction('refresh_snapshot', {
    camera: cameraIds(w.gladys, MACS.DRIVEWAY).device,
  });
  assert.equal(ack.success, true, ack.error);
  assert.equal(w.fake.cameraImages.length, images + 1, 'fresh, even within the 6 s spacing');
  assert.equal(
    w.fake.cameraImages.at(-1).device_external_id,
    cameraIds(w.gladys, MACS.DRIVEWAY).device,
  );
  w.protect.snapshotStatus = 503;
  w.clock.advance(HUB_TIMINGS.imageSpacingMs);
  const failed = await w.fake.sceneAction('refresh_snapshot', {
    camera: cameraIds(w.gladys, MACS.DRIVEWAY).device,
  });
  assert.equal(failed.success, false);
  assert.match(failed.error, /did not send an image/);
});

test('refresh_snapshot refuses a device that is not a camera of the console', async (t) => {
  const w = await world(t);
  const light = w.gladys.externalIds('light', MACS.FLOODLIGHT).device;
  assert.equal((await w.fake.sceneAction('refresh_snapshot', { camera: light })).success, false);
  assert.equal((await w.fake.sceneAction('refresh_snapshot', {})).success, false);
});

test('set_doorbell_message: the three messages, for a while or until changed, and clearing', async (t) => {
  const w = await world(t);
  const doorbell = cameraIds(w.gladys, MACS.DOORBELL).device;
  const now = w.clock.now();
  const send = (fields) => w.fake.sceneAction('set_doorbell_message', { doorbell, ...fields });

  assert.equal((await send({ message: 'do_not_disturb', duration: 60 })).success, true);
  assert.equal((await send({ message: 'leave_package', duration: 0 })).success, true);
  assert.equal(
    (await send({ message: 'custom', text: '  Back at 6 pm  ', duration: 30 })).success,
    true,
  );
  assert.equal((await send({ message: 'clear' })).success, true);
  assert.deepEqual(lcdPatches(w), [
    { type: 'DO_NOT_DISTURB', resetAt: now + 60 * 60_000 },
    { type: 'LEAVE_PACKAGE_AT_DOOR', resetAt: null },
    { type: 'CUSTOM_MESSAGE', text: 'Back at 6 pm', resetAt: now + 30 * 60_000 },
    // A message whose reset time has passed is how Protect clears one.
    { type: 'DO_NOT_DISTURB', resetAt: 0 },
  ]);
  // The screen shows 30 characters.
  await send({ message: 'custom', text: 'x'.repeat(50) });
  assert.equal(lcdPatches(w).at(-1).text.length, 30);
});

test('set_doorbell_message refuses an empty custom text and a camera without a screen', async (t) => {
  const w = await world(t);
  const doorbell = cameraIds(w.gladys, MACS.DOORBELL).device;
  const empty = await w.fake.sceneAction('set_doorbell_message', {
    doorbell,
    message: 'custom',
    text: ' ',
  });
  assert.equal(empty.success, false);
  assert.match(empty.error, /text of the message/);
  const notDoorbell = await w.fake.sceneAction('set_doorbell_message', {
    doorbell: cameraIds(w.gladys, MACS.DRIVEWAY).device,
    message: 'do_not_disturb',
  });
  assert.equal(notDoorbell.success, false);
  assert.match(notDoorbell.error, /not a doorbell/);
  assert.deepEqual(lcdPatches(w), []);
});

test('durations: integers from 0 to a day, comma accepted, a default otherwise', () => {
  assert.equal(parseMinutes(30), 30);
  assert.equal(parseMinutes('12,6'), 13);
  assert.equal(parseMinutes(-5), 0);
  assert.equal(parseMinutes(99999), 1440);
  assert.equal(parseMinutes('soon'), 60);
  assert.equal(parseMinutes(undefined), 0);
});
