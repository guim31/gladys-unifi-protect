// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake Protect console (REST
// and sockets), a temporary /data and a manual clock, with the integration
// wired on top through registerHandlers. No periodic timer runs unless
// `timers: true` (with node:test mock timers): the tests read the console
// with `world.hub.refresh()` and push frames with `world.send(...)`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { API_KEY, FakeProtect, HOST, IDS, MACS, eventFrames } from './fakeProtect.js';

// The integration logs its lifecycle; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const BASE_CONFIG = {
  host: '192.0.2.1',
  api_key: API_KEY,
  allow_self_signed: true,
  snapshot_interval: '5',
  language: 'en',
};

/** A manual clock. */
export function createClock(start = Date.UTC(2026, 9, 13, 18, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/** Let the socket callbacks, the frame handlers and the fake network settle. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @param {object} [options]
 * @param {FakeProtect} [options.protect]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers]
 * @param {object} [options.timings] HUB_TIMINGS overrides
 */
export async function createWorld({
  clock = createClock(),
  protect = new FakeProtect(),
  config = BASE_CONFIG,
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-unifi-protect-')),
  timings = {},
  socketTimings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: protect.request,
    createSocket: protect.createSocket,
    timers,
    timings: { pulseMs: 50, eventImageWaitMs: 200, ...timings },
    socketTimings: { reconnectMinMs: 20, reconnectMaxMs: 40, authRetryMs: 40, ...socketTimings },
    now: clock.now,
  });
  const world = {
    gladys,
    fake: gladys.fake,
    protect,
    app,
    hub: app.hub,
    clock,
    dataDir,
    /** Push frames on a socket of the console, then let them be handled. */
    async send(stream, frames) {
      for (const frame of Array.isArray(frames) ? frames : [frames]) {
        protect.send(stream, frame);
        await settle();
      }
    },
    /** Push the frames of an events fixture. */
    events(name) {
      return world.send('events', eventFrames(name));
    },
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
    await settle();
  }
  return world;
}

/** External ids of a device of the fixtures. */
export const ids = (gladys, kind, mac) => gladys.externalIds(kind, mac);
export const cameraIds = (gladys, mac = MACS.DOORBELL) => ids(gladys, 'camera', mac);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await settle();
}

export { API_KEY, FakeProtect, HOST, IDS, MACS };
