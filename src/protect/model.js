// -----------------------------------------------------------------------------
// Reading the Integration API payloads into the few values the integration
// uses, and keeping them current from the subscription frames.
//
// Shapes: the OpenAPI specification of Protect 7.x, as mirrored by the tests
// of uilibs/uiprotect (MIT); see test/fixtures/protect/README.md. Every field
// is read defensively: older firmware omits some of them (sensor
// `featureFlags`, the device `type`), and a frame is a partial diff.
// -----------------------------------------------------------------------------

/** The kinds of device the integration publishes, by `modelKey`. */
export const KINDS = Object.freeze({ CAMERA: 'camera', LIGHT: 'light', SENSOR: 'sensor' });

// Smart detection types published as features of a camera (Protect name →
// feature key); the others still fire the `object_detected` trigger.
export const SMART_FEATURES = Object.freeze({
  person: 'person',
  vehicle: 'vehicle',
  animal: 'animal',
  package: 'package',
});

// Protect smart detection types → `object` value of the `object_detected`
// trigger (permanent once published: scenes store them).
export const OBJECTS = Object.freeze({
  person: 'person',
  vehicle: 'vehicle',
  animal: 'animal',
  package: 'package',
  licensePlate: 'license_plate',
  face: 'face',
});

// Event types (`type` of an event frame) the integration reads.
export const EVENT_TYPES = Object.freeze({
  MOTION: 'motion',
  SMART_ZONE: 'smartDetectZone',
  SMART_LINE: 'smartDetectLine',
  SMART_LOITER: 'smartDetectLoiterZone',
  RING: 'ring',
  LIGHT_MOTION: 'lightMotion',
});

const SMART_EVENT_TYPES = new Set([
  EVENT_TYPES.SMART_ZONE,
  EVENT_TYPES.SMART_LINE,
  EVENT_TYPES.SMART_LOITER,
]);

const OPENING_MOUNTS = new Set(['door', 'window', 'garage']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** `AABBCCDDEEFF`, `aa:bb:…` → `aabbccddeeff`; null when not a MAC. */
export function normalizeMac(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const hex = raw.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length === 12 ? hex : null;
}

/**
 * Merge a partial update into a payload: nested objects are merged key by key
 * (a frame carries only the changed fields), arrays and scalars replaced.
 */
export function mergePayload(target, patch) {
  const merged = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] =
      isObject(value) && isObject(target[key]) ? mergePayload(target[key], value) : value;
  }
  return merged;
}

/** Common to every device: identity and connection. */
function base(raw, kind) {
  return {
    kind,
    id: String(raw.id),
    mac: normalizeMac(raw.mac),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
    model: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : null,
    online: raw.state === 'CONNECTED',
  };
}

export function parseCamera(raw) {
  const flags = isObject(raw.featureFlags) ? raw.featureFlags : {};
  const smartTypes = Array.isArray(flags.smartDetectTypes) ? flags.smartDetectTypes : [];
  const device = base(raw, KINDS.CAMERA);
  return {
    ...device,
    // `type` names the model on current firmware ("UVC G4 Doorbell Pro"); the
    // hub also remembers the cameras it saw ring (src/store.js).
    doorbell: /doorbell/i.test(device.model ?? ''),
    smartTypes: Object.keys(SMART_FEATURES).filter(
      (type) => smartTypes.includes(type) || (type === 'package' && raw.hasPackageCamera === true),
    ),
  };
}

export function parseLight(raw) {
  return {
    ...base(raw, KINDS.LIGHT),
    lightOn: raw.isLightOn === true,
    forced: raw.isLightForceEnabled === true,
    motion: raw.isPirMotionDetected === true,
  };
}

/** The capabilities of a sensor: its feature flags, else what its mount allows. */
function sensorCapabilities(raw) {
  const mount = typeof raw.mountType === 'string' ? raw.mountType : 'none';
  const flags = isObject(raw.featureFlags) ? raw.featureFlags : {};
  const declared = Object.keys(flags).filter((key) => isObject(flags[key]));
  const has = (key) =>
    declared.length > 0 ? declared.includes(key) : key === 'waterLeak' ? false : true;
  const leakMount = mount === 'leak';
  return {
    // The environment readings are suppressed on a leak mount (uiprotect).
    temperature: has('temperature') && !leakMount,
    humidity: has('humidity') && !leakMount,
    light: has('light') && !leakMount,
    motion: has('motion') && !leakMount,
    opening: OPENING_MOUNTS.has(mount) && (declared.length === 0 || declared.includes('open')),
    leak: leakMount || declared.includes('waterLeak'),
  };
}

export function parseSensor(raw) {
  const stats = isObject(raw.stats) ? raw.stats : {};
  const metric = (key) => (isObject(stats[key]) ? finite(stats[key].value) : null);
  const battery = isObject(raw.batteryStatus) ? finite(raw.batteryStatus.percentage) : null;
  return {
    ...base(raw, KINDS.SENSOR),
    capabilities: sensorCapabilities(raw),
    battery,
    temperature: metric('temperature'),
    humidity: metric('humidity'),
    light: metric('light'),
    opened: typeof raw.isOpened === 'boolean' ? raw.isOpened : null,
    motion: raw.isMotionDetected === true,
    leak: raw.leakDetectedAt != null || raw.externalLeakDetectedAt != null,
  };
}

export const PARSERS = {
  [KINDS.CAMERA]: parseCamera,
  [KINDS.LIGHT]: parseLight,
  [KINDS.SENSOR]: parseSensor,
};

/**
 * The devices of the console: the raw payloads by id, kept current from the
 * REST reads and the frames of the devices socket.
 */
export class DeviceStore {
  constructor() {
    /** @type {Map<string, { kind: string, raw: object }>} */
    this.items = new Map();
  }

  /**
   * Replace every device of one kind with a fresh REST list.
   * @returns {boolean} whether the list of devices changed (added or removed)
   */
  replace(kind, list) {
    const before = new Set(this.ids(kind));
    for (const id of before) {
      this.items.delete(id);
    }
    for (const raw of list) {
      if (isObject(raw) && raw.id && normalizeMac(raw.mac)) {
        this.items.set(String(raw.id), { kind, raw });
      }
    }
    const after = new Set(this.ids(kind));
    return before.size !== after.size || [...after].some((id) => !before.has(id));
  }

  ids(kind) {
    return [...this.items].filter(([, item]) => item.kind === kind).map(([id]) => id);
  }

  /**
   * Apply a frame of the devices socket.
   * @returns {{ ids: string[], membership: boolean }} the devices touched, and
   *   whether one appeared or disappeared (a new discovery is due)
   */
  applyFrame(frame) {
    const item = isObject(frame?.item) ? frame.item : null;
    const kind = item?.modelKey;
    if (!item || !Object.values(KINDS).includes(kind)) {
      return { ids: [], membership: false };
    }
    // A bulk frame carries one payload for a list of ids.
    const ids = (Array.isArray(item.id) ? item.id : [item.id]).filter(Boolean).map(String);
    let membership = false;
    const touched = [];
    for (const id of ids) {
      const payload = { ...item, id };
      const known = this.items.get(id);
      if (frame.type === 'remove') {
        membership ||= this.items.delete(id);
      } else if (frame.type === 'add') {
        if (normalizeMac(payload.mac)) {
          membership ||= !known;
          this.items.set(id, { kind, raw: known ? mergePayload(known.raw, payload) : payload });
          touched.push(id);
        }
      } else if (frame.type === 'update' && known) {
        known.raw = mergePayload(known.raw, payload);
        touched.push(id);
      }
    }
    return { ids: touched, membership };
  }

  /** The parsed devices, of one kind or all. */
  devices(kind) {
    const out = [];
    for (const item of this.items.values()) {
      if (!kind || item.kind === kind) {
        out.push(PARSERS[item.kind](item.raw));
      }
    }
    return out.sort((a, b) => (a.name ?? a.mac).localeCompare(b.name ?? b.mac));
  }

  get(id) {
    const item = this.items.get(String(id));
    return item ? PARSERS[item.kind](item.raw) : null;
  }
}

/**
 * The detection events of the events socket, folded into what a camera
 * currently sees and into the moments worth a scene event.
 *
 * An event is opened by an `add` frame (or born closed: package detections
 * arrive as a single closed `update`), refined by partial `update` frames
 * (more smart types, then `end`). A camera "sees a person" while one of its
 * open smart events lists `person`.
 */
export class EventTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxOpenMs] an event never closed is dropped after this
   * @param {number} [options.maxEvents] events remembered (to merge their updates)
   * @param {() => number} [options.now]
   */
  constructor({ maxOpenMs = 30 * 60_000, maxEvents = 500, now = () => Date.now() } = {}) {
    this.maxOpenMs = maxOpenMs;
    this.maxEvents = maxEvents;
    this.now = now;
    /** @type {Map<string, object>} by event id, oldest first */
    this.events = new Map();
  }

  /**
   * Apply a frame of the events socket.
   * @returns {null | { event: object, opened: boolean, closed: boolean, newObjects: string[] }}
   *   what changed: `newObjects` are the smart types this frame added to the
   *   event (each fires `object_detected` once)
   */
  applyFrame(frame) {
    const item = isObject(frame?.item) ? frame.item : null;
    if (!item || item.modelKey !== 'event' || !item.id || Array.isArray(item.id)) {
      return null;
    }
    const id = String(item.id);
    const known = this.events.get(id);
    if (frame.type === 'remove') {
      this.events.delete(id);
      return known
        ? {
            event: { ...known, end: known.end ?? this.now() },
            opened: false,
            closed: !known.end,
            newObjects: [],
          }
        : null;
    }
    let event;
    if (known) {
      event = { ...known };
      if (typeof item.type === 'string') event.type = item.type;
      if (item.device) event.device = String(item.device);
      if (finite(item.start) !== null) event.start = item.start;
      if ('end' in item) event.end = finite(item.end);
      if (Array.isArray(item.smartDetectTypes)) event.types = [...item.smartDetectTypes];
    } else {
      // `add`, or an `update` for an unseen event: usable only when complete
      // (a package detection arrives closed, in a single frame).
      if (typeof item.type !== 'string' || !item.device || finite(item.start) === null) {
        return null;
      }
      if (frame.type !== 'add' && finite(item.end) === null) {
        return null;
      }
      event = {
        id,
        type: item.type,
        device: String(item.device),
        start: item.start,
        end: finite(item.end),
        types: Array.isArray(item.smartDetectTypes) ? [...item.smartDetectTypes] : [],
        seenTypes: [],
        seenAt: this.now(),
      };
    }
    const newObjects = event.types.filter((type) => !event.seenTypes.includes(type));
    event.seenTypes = [...event.seenTypes, ...newObjects];
    this.events.delete(id);
    this.events.set(id, event);
    this.trim();
    return {
      event,
      opened: !known,
      closed: event.end !== null && (!known || known.end === null),
      newObjects: SMART_EVENT_TYPES.has(event.type) ? newObjects : [],
    };
  }

  trim() {
    while (this.events.size > this.maxEvents) {
      this.events.delete(this.events.keys().next().value);
    }
  }

  /**
   * Close the events that stayed open too long (an `end` lost in a socket
   * gap), or every open event (`all`, after the events socket reopened).
   * @returns {string[]} the devices whose detections changed
   */
  expire({ all = false } = {}) {
    const devices = new Set();
    const now = this.now();
    for (const event of this.events.values()) {
      if (event.end === null && (all || now - event.seenAt > this.maxOpenMs)) {
        event.end = now;
        devices.add(event.device);
      }
    }
    return [...devices];
  }

  /** What a camera sees now: motion, and the smart types of its open events. */
  activity(deviceId) {
    const active = { motion: false, objects: new Set() };
    for (const event of this.events.values()) {
      if (event.device !== deviceId || event.end !== null) {
        continue;
      }
      if (event.type === EVENT_TYPES.MOTION) {
        active.motion = true;
      } else if (SMART_EVENT_TYPES.has(event.type)) {
        for (const type of event.types) {
          active.objects.add(type);
        }
      }
    }
    return active;
  }
}
