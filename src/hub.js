// -----------------------------------------------------------------------------
// The Protect hub: one console, followed live and read again on a timer.
//
//   - REST (src/protect/client.js): the full list of cameras, floodlights and
//     sensors at start, when a socket reopens, and every 5 minutes (every
//     minute while the devices socket is down): the container refreshes
//     itself, Gladys never polls (should_poll: false, GladysAssistant/
//     Gladys#3198);
//   - the devices socket: every change of a device (online, light, sensor
//     readings) as it happens;
//   - the events socket: motion, smart detections, rings. A detection opens
//     an event and closes it later; a ring and a package are instantaneous,
//     published as a short 1 → 0 pulse;
//   - snapshots: a fresh image of a camera at each detection or ring (before
//     the scene event, so a scene sending "the camera image" sends the right
//     one), on the timer chosen in the configuration, and on demand.
//
// States go through publishChangedStates (only the changes, plus a heartbeat
// every 6 hours: the front shows "no recent value" past 48 hours), and only
// for the devices the user added: Gladys drops the others.
//
// Logs: info keeps the lifecycle (connected, console lost and back, a device
// offline and back, user commands); a problem that repeats is logged once,
// and once when it clears; the rest goes to debug (LOG_LEVEL=debug). Never
// the API key.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { hostOf } from './config.js';
import {
  FEATURE_KEYS,
  buildDevice,
  deviceIds,
  deviceName,
  featureKeys,
  featureValues,
} from './devices.js';
import { toCameraImage } from './image.js';
import { ERROR_KINDS, ProtectClient } from './protect/client.js';
import { LegacyReader } from './protect/legacy.js';
import { DeviceStore, EVENT_TYPES, EventTracker, KINDS, OBJECTS } from './protect/model.js';
import { ProtectSocket } from './protect/socket.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  OBJECT_NAMES,
  REPORT_TEXT,
  localized,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'protect-hub' });

export const WIDGET_KEY = 'protect';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  OBJECT: 'object_detected',
  RING: 'doorbell_rang',
});

export const HUB_TIMINGS = {
  refreshMs: 5 * 60_000,
  // While the devices socket is down, the REST reads carry the states.
  fallbackRefreshMs: 60_000,
  heartbeatMs: 6 * 60 * 60_000,
  // Night detection over the internal API (optional local account).
  darkMs: 60_000,
  // A ring, a package, a floodlight detection: 1, then 0 after this.
  pulseMs: 10_000,
  // The core takes 12 images a minute per camera at most.
  imageSpacingMs: 6_000,
  // A scene event waits this long at most for the fresh image of its camera.
  eventImageWaitMs: 4_000,
};

// Detections kept for the widget (with their image) and counted over 24 h.
export const MAX_DETECTIONS = 8;
const DAY_MS = 24 * 60 * 60_000;
const MAX_COUNTED = 5000;

const signature = (config) =>
  JSON.stringify([
    config.host,
    config.apiKey,
    config.allowSelfSigned,
    config.username,
    config.password,
  ]);

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export class ProtectHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/protect/http.js)
   * @param {Function} [options.createSocket] WebSocket seam (src/protect/socket.js)
   * @param {Function} [options.toImage] snapshot → camera image (src/image.js)
   * @param {boolean} [options.timers] periodic timers (off in most tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.socketTimings] SOCKET_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({
    gladys,
    store,
    request,
    createSocket,
    toImage,
    timers = true,
    timings,
    socketTimings,
    now,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.createSocket = createSocket;
    this.toImage = toImage ?? toCameraImage;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.socketTimings = socketTimings;
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.signature = null;
    this.client = null;
    /** Reader of the internal API, only with a local account (t/11350). */
    this.legacy = null;
    /** Whether each camera sees the night, by MAC; `error` of the last read. */
    this.dark = new Map();
    this.darkError = null;
    this.devices = new DeviceStore();
    this.tracker = new EventTracker({ now: this.now });
    this.sockets = {};
    this.live = { devices: false, events: false };
    this.read = { ok: null, error: null, version: null, downSince: null };
    this.reading = null;
    this.discovery = null;
    this.doorbells = new Set();
    /** Pulses running, by Protect device id: Map<feature key, timer>. */
    this.pulses = new Map();
    /** Last image per camera id: { at, image }. */
    this.images = new Map();
    this.imageReads = new Map();
    /** Detections, newest first: { id, at, cameraId, objects: string[], ring, imageKey }. */
    this.detections = [];
    this.detectionTimes = [];
    this.thumbnails = new Map();
    this.online = new Map();
    this.transports = new Map();
    this.connection = null;
    this.refreshTimer = null;
    this.snapshotTimer = null;
    this.darkTimer = null;
    this.stopped = false;
    /** Problems already logged, by key: their repeats go to debug. */
    this.warned = new Set();
  }

  get language() {
    return this.config?.language ?? 'en';
  }

  // --- Logs ------------------------------------------------------------------

  /** Log a problem once (`level` warn or error), its repeats at debug. */
  problem(key, message, level = 'warn') {
    if (this.warned.has(key)) {
      logger.debug(message);
      return;
    }
    this.warned.add(key);
    logger[level](message);
  }

  /** The problem `key` is gone: say so once, the next occurrence logs again. */
  resolved(key, message) {
    if (this.warned.delete(key) && message) {
      logger.info(message);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.doorbells = new Set(Array.isArray(saved.doorbells) ? saved.doorbells : []);
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovery = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const next = signature(config);
    const changed = next !== this.signature;
    this.config = config;
    if (changed) {
      this.closeSockets();
      this.signature = next;
      this.devices = new DeviceStore();
      this.tracker = new EventTracker({ now: this.now });
      this.read = { ok: null, error: null, version: null, downSince: null };
      this.online.clear();
      this.client =
        config.host && config.apiKey
          ? new ProtectClient({
              origin: config.host,
              apiKey: config.apiKey,
              insecure: config.allowSelfSigned,
              request: this.request,
            })
          : null;
      this.legacy =
        this.client && config.username && config.password
          ? new LegacyReader({
              origin: config.host,
              username: config.username,
              password: config.password,
              insecure: config.allowSelfSigned,
              request: this.request,
            })
          : null;
      this.dark = new Map();
      this.darkError = null;
    }
    if (!this.client) {
      clearTimeout(this.refreshTimer);
      clearTimeout(this.snapshotTimer);
      clearTimeout(this.darkTimer);
      await this.publishDevices();
      await this.publishConnectionStatus();
      return;
    }
    // A new language renames nothing already created, but the Discovery tab
    // shows the new names.
    this.discovery = null;
    await this.refresh();
    if (changed) {
      this.openSockets();
    }
    await this.readDarkness();
    this.scheduleRefresh();
    this.scheduleSnapshots();
    this.scheduleDarkness();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.snapshotTimer);
    clearTimeout(this.darkTimer);
    this.closeSockets();
    for (const timers of this.pulses.values()) {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    }
    this.pulses.clear();
    await this.store.flush();
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    const wait = this.live.devices ? this.timings.refreshMs : this.timings.fallbackRefreshMs;
    this.refreshTimer = setTimeout(async () => {
      await this.refresh();
      this.scheduleRefresh();
    }, wait);
  }

  scheduleSnapshots() {
    clearTimeout(this.snapshotTimer);
    const interval = this.config?.snapshotIntervalMs ?? 0;
    if (!this.timersEnabled || this.stopped || !this.client || interval <= 0) {
      return;
    }
    this.snapshotTimer = setTimeout(async () => {
      await this.snapshotAll();
      this.scheduleSnapshots();
    }, interval);
  }

  scheduleDarkness() {
    clearTimeout(this.darkTimer);
    if (!this.timersEnabled || this.stopped || !this.legacy) {
      return;
    }
    this.darkTimer = setTimeout(async () => {
      await this.readDarkness();
      this.scheduleDarkness();
    }, this.timings.darkMs);
  }

  // --- Reading the console ---------------------------------------------------

  /** Read every device over REST. Concurrent calls share the read. */
  refresh() {
    this.reading ??= this.readAll().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  async readAll() {
    const client = this.client;
    if (!client) {
      return false;
    }
    let lists;
    try {
      lists = await Promise.all([
        this.read.version ? null : client.metaInfo(),
        client.cameras(),
        client.lights(),
        client.sensors(),
      ]);
    } catch (err) {
      if (client === this.client) {
        await this.readFailed(err);
      }
      return false;
    }
    if (client !== this.client) {
      return false; // reconfigured while reading
    }
    const [meta, cameras, lights, sensors] = lists;
    if (meta) {
      this.read.version =
        typeof meta.applicationVersion === 'string' ? meta.applicationVersion : '?';
    }
    this.devices.replace(KINDS.CAMERA, cameras);
    this.devices.replace(KINDS.LIGHT, lights);
    this.devices.replace(KINDS.SENSOR, sensors);
    await this.readSucceeded();
    // An event whose end was lost (socket gap) does not stay open for ever.
    this.tracker.expire();
    await this.publishDevices();
    await this.publishAllStates();
    await this.afterChanges();
    return true;
  }

  /**
   * Read `isDark` over the internal API and publish what changed. A failure
   * keeps the last values: the rest of the integration does not depend on it.
   * @returns {Promise<boolean>}
   */
  async readDarkness() {
    const legacy = this.legacy;
    if (!legacy) {
      return false;
    }
    let dark;
    try {
      dark = await legacy.darkness();
    } catch (err) {
      if (legacy === this.legacy) {
        this.darkError = err;
        this.problem('dark', `Night detection unavailable (internal API): ${err.message}`);
      }
      return false;
    }
    if (legacy !== this.legacy) {
      return false; // reconfigured while reading
    }
    this.darkError = null;
    this.resolved('dark', 'Night detection read again');
    const changed = [...dark].filter(([mac, value]) => this.dark.get(mac) !== value);
    this.dark = dark;
    for (const device of this.devices.devices()) {
      if (device.kind === KINDS.CAMERA && changed.some(([mac]) => mac === device.mac)) {
        await this.publishStates(device);
      }
    }
    return true;
  }

  async readSucceeded() {
    const wasDown = this.read.ok === false;
    const first = this.read.ok === null;
    this.read.ok = true;
    this.read.error = null;
    const version = this.read.version ? ` ${this.read.version}` : '';
    const label = `UniFi Protect${version} at ${hostOf(this.config.host)}`;
    if (first) {
      const count = (kind) => this.devices.ids(kind).length;
      logger.info(
        `Connected to ${label}: ${count(KINDS.CAMERA)} camera(s), ${count(KINDS.LIGHT)} floodlight(s), ${count(KINDS.SENSOR)} sensor(s)`,
      );
    } else if (wasDown) {
      const minutes = Math.max(1, Math.round((this.now() - this.read.downSince) / 60_000));
      logger.info(`${label} answers again after ${minutes} min`);
    }
    this.warned.delete('read');
    this.read.downSince = null;
  }

  async readFailed(err) {
    if (this.read.ok !== false) {
      this.read.downSince = this.now();
    }
    this.read.ok = false;
    this.read.error = err;
    this.problem('read', `Cannot read the console at ${hostOf(this.config.host)}: ${err.message}`);
    await this.afterChanges();
  }

  // --- Live sockets ----------------------------------------------------------

  openSockets() {
    this.closeSockets();
    if (!this.client || this.stopped) {
      return;
    }
    for (const stream of ['devices', 'events']) {
      const socket = new ProtectSocket({
        url: this.client.socketUrl(stream),
        headers: this.client.headers,
        insecure: this.client.insecure,
        onFrame: (frame) =>
          (stream === 'devices' ? this.onDevicesFrame(frame) : this.onEventsFrame(frame)).catch(
            (err) =>
              this.problem(`frame-${stream}`, `Cannot handle a ${stream} frame: ${err.message}`),
          ),
        onOpen: () => this.socketOpened(stream),
        onClose: (err) => this.socketClosed(stream, err),
        createSocket: this.createSocket,
        timings: this.socketTimings,
      });
      this.sockets[stream] = socket;
      socket.start();
    }
  }

  closeSockets() {
    for (const socket of Object.values(this.sockets)) {
      socket.stop();
    }
    this.sockets = {};
    this.live = { devices: false, events: false };
  }

  socketOpened(stream) {
    const wasDown = this.warned.has(`socket-${stream}`);
    this.live[stream] = true;
    this.resolved(`socket-${stream}`, `Live ${stream} of the console: connected again`);
    logger.debug(`Live ${stream} socket open`);
    // What happened while it was closed is lost: read the full state again,
    // and close the detections whose end may have been missed.
    if (stream === 'events') {
      this.expireAll().catch(() => {});
    } else if (wasDown) {
      this.refresh().catch(() => {});
    }
    this.scheduleRefresh();
    this.publishConnectionStatus().catch(() => {});
  }

  socketClosed(stream, err) {
    this.live[stream] = false;
    // Losing the console is lifecycle (info); a refused key or certificate
    // is a problem to fix (warn). Once per outage either way.
    const level = err.kind === ERROR_KINDS.UNREACHABLE ? 'info' : 'warn';
    this.problem(
      `socket-${stream}`,
      `Live ${stream} of the console interrupted: ${err.message}`,
      level,
    );
    this.scheduleRefresh();
    this.publishConnectionStatus().catch(() => {});
  }

  async expireAll() {
    for (const deviceId of this.tracker.expire({ all: true })) {
      const device = this.devices.get(deviceId);
      if (device) {
        await this.publishStates(device);
      }
    }
  }

  async onDevicesFrame(frame) {
    const { ids, membership } = this.devices.applyFrame(frame);
    if (membership) {
      logger.debug('Devices added or removed in Protect: discovery updated');
      await this.publishDevices();
    }
    for (const id of ids) {
      const device = this.devices.get(id);
      if (device) {
        await this.publishStates(device);
      }
    }
    if (ids.length > 0 || membership) {
      await this.afterChanges();
    }
  }

  async onEventsFrame(frame) {
    const result = this.tracker.applyFrame(frame);
    if (!result) {
      return;
    }
    const { event, opened, closed, newObjects } = result;
    const device = this.devices.get(event.device);
    if (!device) {
      logger.debug(`Event ${event.type} of an unknown device`);
      return;
    }
    logger.debug(
      `Event ${event.type} on ${deviceName(device)}${opened ? ' (start)' : ''}${closed ? ' (end)' : ''}`,
    );
    if (device.kind === KINDS.CAMERA && event.type === EVENT_TYPES.RING) {
      if (opened) {
        await this.ring(device, event);
      }
      return;
    }
    if (device.kind === KINDS.LIGHT && event.type === EVENT_TYPES.LIGHT_MOTION) {
      if (opened) {
        await this.pulse(device, FEATURE_KEYS.MOTION);
      }
      return;
    }
    if (device.kind !== KINDS.CAMERA) {
      return;
    }
    // A detection born closed (package) shows as a pulse.
    if (opened && closed) {
      for (const type of newObjects) {
        await this.pulse(device, type, { publish: false });
      }
    }
    await this.publishStates(device);
    if (newObjects.length > 0) {
      await this.detected(device, event, newObjects);
    }
  }

  // --- Detections, rings and their scene events --------------------------------

  /** A doorbell rang: the ring feature pulses, the trigger fires with a fresh image. */
  async ring(camera, event) {
    if (!camera.doorbell && !this.doorbells.has(camera.mac)) {
      // A doorbell the console does not name as such: it now has a ring feature.
      this.doorbells.add(camera.mac);
      this.store.save({ doorbells: [...this.doorbells] });
      logger.info(`${deviceName(camera)} rang: it is now known as a doorbell`);
      await this.publishDevices();
    }
    await this.pulse(camera, FEATURE_KEYS.RING);
    const detection = this.remember(camera, event, { ring: true });
    await this.imageFor(camera, detection);
    await this.fire(TRIGGERS.RING, {
      doorbell: deviceIds(this.gladys, camera.kind, camera.mac).device,
      doorbell_name: deviceName(camera, this.language),
    });
    await this.afterChanges(true);
  }

  /** New object types seen by a camera: one scene event each, after a fresh image. */
  async detected(camera, event, types) {
    const objects = types.map((type) => OBJECTS[type]).filter(Boolean);
    if (objects.length === 0) {
      return;
    }
    const detection = this.remember(camera, event, { objects });
    await this.imageFor(camera, detection);
    const names = OBJECT_NAMES[this.language] ?? OBJECT_NAMES.en;
    for (const object of objects) {
      await this.fire(TRIGGERS.OBJECT, {
        camera: deviceIds(this.gladys, camera.kind, camera.mac).device,
        object,
        camera_name: deviceName(camera, this.language),
        object_name: names[object],
      });
    }
    await this.afterChanges(true);
  }

  /** Keep a detection for the widget (one entry per event, its objects merged). */
  remember(camera, event, { objects = [], ring = false }) {
    let detection = this.detections.find((entry) => entry.id === event.id);
    if (detection) {
      detection.objects = [...new Set([...detection.objects, ...objects])];
      return detection;
    }
    detection = {
      id: event.id,
      at: this.now(),
      cameraId: camera.id,
      objects,
      ring,
      imageKey: null,
    };
    this.detections.unshift(detection);
    for (const dropped of this.detections.splice(MAX_DETECTIONS)) {
      this.thumbnails.delete(dropped.imageKey);
    }
    this.detectionTimes.push(detection.at);
    if (this.detectionTimes.length > MAX_COUNTED) {
      this.detectionTimes.splice(0, this.detectionTimes.length - MAX_COUNTED);
    }
    return detection;
  }

  /** Detections over the last 24 hours, of one camera or all. */
  detectionsToday(cameraId) {
    const since = this.now() - DAY_MS;
    if (cameraId) {
      return this.detections.filter((entry) => entry.cameraId === cameraId && entry.at >= since)
        .length;
    }
    this.detectionTimes = this.detectionTimes.filter((at) => at >= since);
    return this.detectionTimes.length;
  }

  /** A fresh image for a detection, waited for a few seconds at most. */
  async imageFor(camera, detection) {
    const read = this.cameraImage(camera).then((image) => {
      if (image && !detection.imageKey) {
        detection.imageKey = `det-${detection.id
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .slice(0, 40)}`;
        this.thumbnails.set(detection.imageKey, image.slice(image.indexOf(',') + 1));
      }
    });
    await Promise.race([read, delay(this.timings.eventImageWaitMs)]);
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.resolved('scene-event');
    } catch (err) {
      this.problem('scene-event', `Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Pulses ------------------------------------------------------------------

  /** A momentary feature: 1 now, 0 after `pulseMs` (the core's doorbell model). */
  async pulse(device, key, { publish = true } = {}) {
    const timers = this.pulses.get(device.id) ?? new Map();
    this.pulses.set(device.id, timers);
    clearTimeout(timers.get(key));
    const timer = setTimeout(() => {
      timers.delete(key);
      const current = this.devices.get(device.id);
      if (current && !this.stopped) {
        this.publishStates(current).catch(() => {});
      }
    }, this.timings.pulseMs);
    timer.unref?.();
    timers.set(key, timer);
    if (publish) {
      await this.publishStates(device);
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------

  /** Whether the user added the device to Gladys. */
  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  async publishDevices() {
    const devices = this.devices.devices().map((device) =>
      buildDevice(this.gladys, device, {
        language: this.language,
        doorbell: this.doorbells.has(device.mac),
        dark: Boolean(this.legacy),
      }),
    );
    const key = JSON.stringify(devices);
    if (key === this.discovery) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale device.
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovery = key;
      this.resolved('discovery');
    } catch (err) {
      this.problem('discovery', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: publish the devices again after a read. */
  async rediscover() {
    this.discovery = null;
    if (!(await this.refresh())) {
      await this.publishDevices();
    }
  }

  /** The user added a device: the SDK forgot its values, send them again. */
  async onDeviceCreated(device) {
    const found = this.findDevice(device.external_id);
    if (!found) {
      return;
    }
    await this.publishStates(found);
    await this.publishTransports();
    if (found.kind === KINDS.CAMERA) {
      this.cameraImage(found).catch(() => {});
    }
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async publishAllStates() {
    for (const device of this.devices.devices()) {
      await this.publishStates(device);
    }
  }

  /** The current values of one device, sent if they changed. */
  async publishStates(device) {
    const ids = deviceIds(this.gladys, device.kind, device.mac);
    if (!this.isCreated(ids.device)) {
      return;
    }
    const activity =
      device.kind === KINDS.CAMERA
        ? this.tracker.activity(device.id)
        : { motion: false, objects: new Set() };
    const values = featureValues(device, {
      ...activity,
      pulses: new Set(this.pulses.get(device.id)?.keys() ?? []),
      dark: this.dark.get(device.mac),
    });
    const states = featureKeys(device, {
      doorbell: this.doorbells.has(device.mac),
      dark: Boolean(this.legacy),
    })
      .filter((key) => values[key] !== undefined && values[key] !== null)
      .map((key) => ({ device_feature_external_id: ids.feature(key), state: values[key] }));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.resolved('states');
    } catch (err) {
      this.problem('states', `States of ${deviceName(device)} refused: ${err.message}`);
    }
  }

  /** After any change: devices offline and back, transports, status, widget. */
  async afterChanges(widgetChanged = false) {
    let changed = widgetChanged;
    for (const device of this.devices.devices()) {
      const before = this.online.get(device.id);
      if (before !== undefined && before !== device.online) {
        logger.info(`${deviceName(device)} is ${device.online ? 'online again' : 'offline'}`);
        changed = true;
      }
      if (before === undefined) {
        changed = true;
      }
      this.online.set(device.id, device.online);
    }
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (changed) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  async publishTransports() {
    const entries = [];
    for (const device of this.devices.devices()) {
      const externalId = deviceIds(this.gladys, device.kind, device.mac).device;
      if (!this.isCreated(externalId)) {
        continue;
      }
      const transport =
        this.read.ok !== false && device.online
          ? DEVICE_TRANSPORTS.LOCAL
          : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, entry.transport);
      }
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name, in the Configuration screen. */
  connectionStatus() {
    const config = this.config;
    if (!config?.host) {
      return {
        connected: false,
        message: config?.hostInvalid ? CONNECTION_TEXT.invalidHost : CONNECTION_TEXT.noHost,
      };
    }
    if (!config.apiKey) {
      return { connected: false, message: CONNECTION_TEXT.noKey };
    }
    if (this.read.ok === false) {
      return { connected: false, message: ERROR_TEXT[this.read.error.kind] ?? ERROR_TEXT.http };
    }
    if (this.read.ok === null) {
      return null; // first read not done yet
    }
    // A socket still connecting at start is not news: only a lost one is.
    const lost = ['devices', 'events'].some(
      (stream) => !this.live[stream] && this.warned.has(`socket-${stream}`),
    );
    if (lost) {
      return { connected: true, message: CONNECTION_TEXT.live };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    if (!status) {
      return;
    }
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  // --- Camera images -------------------------------------------------------------

  /**
   * A fresh image of a camera, sent to Gladys when the camera is added.
   * Concurrent calls share the read; a read younger than `imageSpacingMs`
   * is reused (the core takes 12 images a minute per camera).
   * @returns {Promise<string|null>} the `image/jpg;base64,…` string
   */
  cameraImage(camera, { fresh = false } = {}) {
    const last = this.images.get(camera.id);
    if (!fresh && last && this.now() - last.at < this.timings.imageSpacingMs) {
      return Promise.resolve(last.image);
    }
    const running = this.imageReads.get(camera.id);
    if (running) {
      return running;
    }
    const read = this.readImage(camera).finally(() => this.imageReads.delete(camera.id));
    this.imageReads.set(camera.id, read);
    return read;
  }

  async readImage(camera) {
    const client = this.client;
    if (!client) {
      return null;
    }
    let image;
    try {
      const { bytes } = await client.snapshot(camera.id);
      image = await this.toImage(bytes);
      this.resolved(`image-${camera.id}`, `Images of ${deviceName(camera)}: back`);
    } catch (err) {
      this.problem(`image-${camera.id}`, `No image from ${deviceName(camera)}: ${err.message}`);
      return null;
    }
    this.images.set(camera.id, { at: this.now(), image });
    const externalId = deviceIds(this.gladys, camera.kind, camera.mac).device;
    if (this.isCreated(externalId)) {
      try {
        await this.gladys.publishCameraImage(externalId, image);
        this.resolved('camera-image');
      } catch (err) {
        this.problem('camera-image', `Image of ${deviceName(camera)} refused: ${err.message}`);
      }
    }
    return image;
  }

  /** The timer of the configuration: every added, online camera, one after the other. */
  async snapshotAll() {
    const half = (this.config?.snapshotIntervalMs ?? 0) / 2;
    for (const camera of this.devices.devices(KINDS.CAMERA)) {
      const externalId = deviceIds(this.gladys, camera.kind, camera.mac).device;
      const last = this.images.get(camera.id);
      // Skip a camera imaged less than half a period ago (a detection did it).
      if (!camera.online || !this.isCreated(externalId) || (last && this.now() - last.at < half)) {
        continue;
      }
      await this.cameraImage(camera);
    }
  }

  /** Gladys asks for a fresh image (dashboard live view, chat). */
  async getImage(device) {
    const camera = this.findDevice(device.external_id);
    if (!camera || camera.kind !== KINDS.CAMERA) {
      throw new Error(pick(ACTION_TEXT.unknownCamera, this.language));
    }
    const image = await this.cameraImage(camera);
    if (!image) {
      throw new Error(pick(ACTION_TEXT.snapshotFailed, this.language));
    }
    return image;
  }

  // --- Commands --------------------------------------------------------------------

  /** The Protect device of a Gladys external id, null when unknown. */
  findDevice(externalId) {
    if (!externalId) {
      return null;
    }
    return (
      this.devices
        .devices()
        .find((device) => deviceIds(this.gladys, device.kind, device.mac).device === externalId) ??
      null
    );
  }

  requireClient() {
    if (!this.client) {
      throw new Error(pick(ACTION_TEXT.notConfigured, this.language));
    }
    return this.client;
  }

  /** The camera a scene action or a Configuration action names. */
  requireCamera(externalId) {
    this.requireClient();
    if (!externalId) {
      throw new Error(pick(ACTION_TEXT.pickCamera, this.language));
    }
    const camera = this.findDevice(externalId);
    if (!camera || camera.kind !== KINDS.CAMERA) {
      throw new Error(pick(ACTION_TEXT.unknownCamera, this.language));
    }
    return camera;
  }

  /** The floodlight switch: forced on, or back to its own lighting mode. */
  async setValue(device, feature, value) {
    const light = this.findDevice(device.external_id);
    const ids = light ? deviceIds(this.gladys, light.kind, light.mac) : null;
    if (
      !light ||
      light.kind !== KINDS.LIGHT ||
      feature.external_id !== ids.feature(FEATURE_KEYS.LIGHT)
    ) {
      throw new Error(`No command for ${feature.external_id}`);
    }
    const on = Number(value) === 1;
    const client = this.requireClient();
    try {
      const updated = await client.setLightForced(light.id, on);
      this.devices.applyFrame({
        type: 'update',
        item: { ...updated, id: light.id, modelKey: 'light' },
      });
    } catch (err) {
      logger.warn(`${deviceName(light)}: command failed: ${err.message}`);
      throw err;
    }
    logger.info(`${deviceName(light)}: light ${on ? 'forced on' : 'back to its lighting mode'}`);
    const current = this.devices.get(light.id);
    // The PATCH answer may predate the light really switching: show the
    // command at once, the devices socket follows with the real state.
    await this.publishStates({ ...current, lightOn: on ? true : current.lightOn });
  }

  /** Scene action and widget: a fresh image now, sent to Gladys. */
  async refreshSnapshot(externalId) {
    const camera = this.requireCamera(externalId);
    logger.info(`Scene action: fresh image of ${deviceName(camera)}`);
    const image = await this.cameraImage(camera, { fresh: true });
    if (!image) {
      throw new Error(pick(ACTION_TEXT.snapshotFailed, this.language));
    }
    return image;
  }

  /**
   * Scene action: the message of a doorbell screen.
   * @param {string} externalId
   * @param {{ type: string|null, text?: string, resetAt?: number|null }} message
   *   `type` null clears the screen
   */
  async setDoorbellMessage(externalId, message) {
    const camera = this.requireCamera(externalId);
    if (!camera.doorbell && !this.doorbells.has(camera.mac)) {
      throw new Error(pick(ACTION_TEXT.notDoorbell, this.language));
    }
    // A message whose reset time has passed is how Protect clears one.
    const body =
      message.type === null
        ? { type: 'DO_NOT_DISTURB', resetAt: 0 }
        : {
            type: message.type,
            ...(message.text !== undefined ? { text: message.text } : {}),
            resetAt: message.resetAt ?? null,
          };
    await this.client.setLcdMessage(camera.id, body);
    logger.info(
      `Scene action: screen of ${deviceName(camera)} set to ${message.type ?? 'nothing'}`,
    );
  }

  // --- Configuration actions -------------------------------------------------------

  /** "Test the connection": read the console now and report, in four languages. */
  async testConnection() {
    if (!this.client) {
      return this.config?.hostInvalid ? CONNECTION_TEXT.invalidHost : CONNECTION_TEXT.noHost;
    }
    this.read.version = null; // asks the version again
    const ok = await this.refresh();
    await this.readDarkness();
    if (!ok) {
      const err = this.read.error;
      logger.info(`Connection test: failed (${err?.message ?? 'no answer'})`);
      return ERROR_TEXT[err?.kind] ?? ERROR_TEXT.http;
    }
    const count = (kind) => this.devices.ids(kind).length;
    const fingerprint = this.client.fingerprint;
    logger.info('Connection test: success');
    return localized((language) => {
      const text = REPORT_TEXT[language];
      const parts = [
        text.ok(this.read.version, count(KINDS.CAMERA), count(KINDS.LIGHT), count(KINDS.SENSOR)),
      ];
      if (this.client.insecure && fingerprint) {
        parts.push(text.certificate(fingerprint));
      }
      if (this.legacy) {
        parts.push(
          this.darkError ? text.darkFailed(this.darkError.message) : text.dark(this.dark.size),
        );
      }
      return parts.join(' ');
    });
  }

  /**
   * "RTSP stream address": the stream of a camera, as the "RTSP camera"
   * integration of Gladys reads it (RTSP on port 7447, the same path as the
   * RTSPS stream Protect serves on 7441). Read only: nothing is created.
   */
  async streamUrl(externalId) {
    const camera = this.requireCamera(externalId);
    const streams = await this.client.rtspsStreams(camera.id);
    const url = ['high', 'medium', 'low']
      .map((quality) => streams?.[quality])
      .find((value) => typeof value === 'string' && value.startsWith('rtsps://'));
    if (!url) {
      return ACTION_TEXT.noStream;
    }
    const parsed = new URL(url.replace(/^rtsps:/, 'https:'));
    const rtsp = `rtsp://${parsed.hostname}:7447${parsed.pathname}`;
    // The URL is a credential of the stream: shown to the user, never logged.
    logger.info(`Configuration action: stream address of ${deviceName(camera)} shown`);
    return localized((language) => `${pick(ACTION_TEXT.stream, language)} ${rtsp}`);
  }

  // --- Widget ------------------------------------------------------------------------

  /** What the widget shows: the devices and the detections. */
  view() {
    return {
      configured: Boolean(this.client),
      reachable: this.read.ok,
      error: this.read.error,
      devices: this.devices.devices(),
      detections: this.detections,
      detectionsToday: (cameraId) => this.detectionsToday(cameraId),
    };
  }

  /** The raw base64 of a detection image of the widget. */
  thumbnail(key) {
    const image = this.thumbnails.get(key);
    if (!image) {
      throw new Error(`Unknown image ${key}`);
    }
    return image;
  }
}
