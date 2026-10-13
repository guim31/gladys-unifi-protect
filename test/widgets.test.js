// -----------------------------------------------------------------------------
// The `protect` dashboard widget: content within the core budget (checked with
// the SDK's validator), every camera or one, the detections with their image.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import {
  BASE_CONFIG,
  FakeProtect,
  MACS,
  cameraIds,
  createAll,
  createWorld,
} from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function content(w, settings = {}, language = 'en') {
  const ack = await w.fake.widgetGet(WIDGET_KEY, { settings, language });
  assert.equal(ack.success, true, ack.error);
  const { content: tree } = ack.data;
  assert.deepEqual(validateWidgetContent(tree), [], 'within the core vocabulary and budget');
  assert.ok(tree.components.length <= 8);
  return tree;
}

const ofType = (tree, type) => tree.components.filter((component) => component.type === type);

test('every camera: online count, detections, state of each camera', async (t) => {
  const w = await world(t);
  const tree = await content(w);
  assert.deepEqual(
    ofType(tree, 'value').map(({ label, value }) => [label, value]),
    [
      ['Cameras online', '3/4'],
      ['Detections 24 h', 0],
    ],
  );
  assert.equal(ofType(tree, 'card-list').length, 0);
  assert.match(ofType(tree, 'text')[0].text, /No detection/);
  const [status] = ofType(tree, 'status');
  assert.deepEqual(
    status.items.map(({ label, value }) => [label, value]),
    [
      ['Allée', 'Online'],
      ['Camera 000004', 'Online'],
      ['Garage', 'Offline'],
      ["Porte d'entrée", 'Online'],
    ],
  );
});

test('the detections, newest first, with the image taken when they happened', async (t) => {
  const w = await world(t);
  await createAll(w);
  await w.events('smartdetect-lifecycle.json');
  w.clock.advance(60_000);
  await w.events('ring.json');
  const tree = await content(w, {}, 'fr');
  const [list] = ofType(tree, 'card-list');
  assert.deepEqual(
    list.items.map(({ title }) => title),
    ["Sonnette · Porte d'entrée", 'Personne, véhicule · Allée'],
  );
  assert.equal(ofType(tree, 'value')[1].value, 2);
  // Each image is served by its key, as raw base64 of a JPEG.
  for (const item of list.items) {
    const image = await w.fake.widgetGetImage(item.image);
    assert.equal(image.success, true, image.error);
    assert.equal(Buffer.from(image.data.image, 'base64')[0], 0xff);
  }
  assert.equal((await w.fake.widgetGetImage('det-unknown')).success, false);
  assert.ok(w.fake.widgetRefreshes.includes(WIDGET_KEY), 'a detection nudges the widget');
});

test('one camera: its tiles, its detections, its row', async (t) => {
  const w = await world(t);
  await w.events('smartdetect-lifecycle.json');
  await w.events('ring.json');
  const tree = await content(w, { camera: cameraIds(w.gladys, MACS.DOORBELL).device });
  assert.equal(ofType(tree, 'value')[0].value, '1/1');
  assert.equal(ofType(tree, 'value')[1].value, 1);
  assert.deepEqual(
    ofType(tree, 'card-list')[0].items.map(({ title }) => title),
    ["Doorbell · Porte d'entrée"],
  );
  assert.equal(ofType(tree, 'status')[0].items.length, 1);
  const gone = await content(w, { camera: w.gladys.externalIds('camera', 'f4e2c6999999').device });
  assert.match(gone.components[0].text, /no longer in UniFi Protect/);
});

test('floodlights and sensors offline are counted on one row', async (t) => {
  const protect = new FakeProtect();
  protect.lights[0].state = 'DISCONNECTED';
  protect.sensors[1].state = 'DISCONNECTED';
  const w = await world(t, { protect });
  const [status] = ofType(await content(w), 'status');
  assert.deepEqual(status.items.at(-1), {
    label: 'Floodlights, sensors offline',
    icon: 'alert-triangle',
    value: 2,
    color: 'warning',
  });
});

test('not configured, or console unreachable: the widget says so', async (t) => {
  const empty = await world(t, { config: {} });
  assert.match((await content(empty)).components[0].text, /Enter the address/);
  const w = await world(t, { config: { ...BASE_CONFIG } });
  w.protect.online = false;
  await w.hub.refresh();
  const tree = await content(w, {}, 'de');
  assert.match(ofType(tree, 'text')[0].text, /Konsole antwortet nicht/);
});
