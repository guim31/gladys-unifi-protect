// -----------------------------------------------------------------------------
// The Gladys devices of a Protect console: one per camera, per floodlight and
// per UP-Sense sensor.
//
// Identity: the MAC address the console reports (`gladys.externalIds(kind,
// mac)`), the one value that survives a rename, a firmware update or a new
// adoption, where the Protect `id` does not. Feature keys are permanent once
// published (test/gladys-rules.test.js checks the couples).
//
// Features (category/type couples of the core table):
//   camera     image (camera/image), online (input/binary), motion and one
//              smart detection per type the camera can see — person, vehicle,
//              animal, package — (motion-sensor/binary), ring for a doorbell
//              (doorbell/ring, a 1 → 0 pulse, as the core expects);
//   floodlight light (light/binary, writable), motion, online;
//   sensor     opening (opening-sensor/binary: 0 open, 1 closed, the core
//              convention), temperature, humidity, brightness, motion, water
//              leak, battery, online — each one only when the sensor has it.
//
// "Online" is input/binary (shown On/Off): presence-sensor/binary would read
// "Presence detected" on a camera, which a user takes for a person.
//
// The devices are published with should_poll: false: the integration follows
// the console over its WebSockets and reads it again on its own timer
// (src/hub.js), never waiting for Gladys to poll (GladysAssistant/Gladys#3198).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { KINDS, SMART_FEATURES } from './protect/model.js';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  IMAGE: 'image',
  ONLINE: 'online',
  MOTION: 'motion',
  PERSON: 'person',
  VEHICLE: 'vehicle',
  ANIMAL: 'animal',
  PACKAGE: 'package',
  RING: 'ring',
  LIGHT: 'light',
  OPENING: 'opening',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  BRIGHTNESS: 'brightness',
  LEAK: 'leak',
  BATTERY: 'battery',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    image: 'Image',
    online: 'Online',
    motion: 'Motion',
    person: 'Person',
    vehicle: 'Vehicle',
    animal: 'Animal',
    package: 'Package',
    ring: 'Doorbell ring',
    light: 'Light',
    opening: 'Opening',
    temperature: 'Temperature',
    humidity: 'Humidity',
    brightness: 'Brightness',
    leak: 'Water leak',
    battery: 'Battery',
  },
  fr: {
    image: 'Image',
    online: 'En ligne',
    motion: 'Mouvement',
    person: 'Personne',
    vehicle: 'Véhicule',
    animal: 'Animal',
    package: 'Colis',
    ring: 'Sonnette',
    light: 'Éclairage',
    opening: 'Ouverture',
    temperature: 'Température',
    humidity: 'Humidité',
    brightness: 'Luminosité',
    leak: "Fuite d'eau",
    battery: 'Batterie',
  },
  de: {
    image: 'Bild',
    online: 'Online',
    motion: 'Bewegung',
    person: 'Person',
    vehicle: 'Fahrzeug',
    animal: 'Tier',
    package: 'Paket',
    ring: 'Türklingel',
    light: 'Licht',
    opening: 'Öffnung',
    temperature: 'Temperatur',
    humidity: 'Luftfeuchtigkeit',
    brightness: 'Helligkeit',
    leak: 'Wasserleck',
    battery: 'Batterie',
  },
  es: {
    image: 'Imagen',
    online: 'En línea',
    motion: 'Movimiento',
    person: 'Persona',
    vehicle: 'Vehículo',
    animal: 'Animal',
    package: 'Paquete',
    ring: 'Timbre',
    light: 'Luz',
    opening: 'Apertura',
    temperature: 'Temperatura',
    humidity: 'Humedad',
    brightness: 'Luminosidad',
    leak: 'Fuga de agua',
    battery: 'Batería',
  },
};

// Name of a device the console did not name, before its MAC suffix.
export const KIND_NAMES = {
  en: { camera: 'Camera', light: 'Floodlight', sensor: 'Sensor' },
  fr: { camera: 'Caméra', light: 'Projecteur', sensor: 'Capteur' },
  de: { camera: 'Kamera', light: 'Flutlicht', sensor: 'Sensor' },
  es: { camera: 'Cámara', light: 'Foco', sensor: 'Sensor' },
};

const binary = (category, extra = {}) => ({
  category,
  type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...extra,
});

const DEFINITIONS = {
  [FEATURE_KEYS.IMAGE]: {
    category: DEVICE_FEATURE_CATEGORIES.CAMERA,
    type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
    read_only: true,
    has_feedback: false,
    // Images travel on their own channel, never in the states history.
    keep_history: false,
    min: 0,
    max: 0,
  },
  [FEATURE_KEYS.ONLINE]: binary(DEVICE_FEATURE_CATEGORIES.INPUT),
  [FEATURE_KEYS.MOTION]: binary(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.PERSON]: binary(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.VEHICLE]: binary(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.ANIMAL]: binary(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.PACKAGE]: binary(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [FEATURE_KEYS.RING]: binary(DEVICE_FEATURE_CATEGORIES.DOORBELL, {
    type: DEVICE_FEATURE_TYPES.DOORBELL.RING,
  }),
  [FEATURE_KEYS.LIGHT]: {
    category: DEVICE_FEATURE_CATEGORIES.LIGHT,
    type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
    read_only: false,
    has_feedback: true,
    keep_history: true,
    min: 0,
    max: 1,
  },
  [FEATURE_KEYS.OPENING]: binary(DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR),
  [FEATURE_KEYS.TEMPERATURE]: {
    category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    // The UP-Sense range (-10 to 50 °C, uiprotect), with margin.
    min: -40,
    max: 80,
  },
  [FEATURE_KEYS.HUMIDITY]: {
    category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    min: 0,
    max: 100,
  },
  [FEATURE_KEYS.BRIGHTNESS]: {
    category: DEVICE_FEATURE_CATEGORIES.LIGHT_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.LUX,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    min: 0,
    max: 100_000,
  },
  [FEATURE_KEYS.LEAK]: binary(DEVICE_FEATURE_CATEGORIES.LEAK_SENSOR),
  [FEATURE_KEYS.BATTERY]: {
    category: DEVICE_FEATURE_CATEGORIES.BATTERY,
    type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    min: 0,
    max: 100,
  },
};

/** External ids of a device and its features. */
export const deviceIds = (gladys, kind, mac) => gladys.externalIds(kind, mac);

/** The feature keys a device has, in display order. */
export function featureKeys(device, { doorbell = false } = {}) {
  if (device.kind === KINDS.CAMERA) {
    const keys = [FEATURE_KEYS.IMAGE, FEATURE_KEYS.ONLINE, FEATURE_KEYS.MOTION];
    keys.push(...device.smartTypes.map((type) => SMART_FEATURES[type]));
    if (device.doorbell || doorbell) {
      keys.push(FEATURE_KEYS.RING);
    }
    return keys;
  }
  if (device.kind === KINDS.LIGHT) {
    return [FEATURE_KEYS.LIGHT, FEATURE_KEYS.MOTION, FEATURE_KEYS.ONLINE];
  }
  const { capabilities } = device;
  return [
    capabilities.opening && FEATURE_KEYS.OPENING,
    capabilities.temperature && FEATURE_KEYS.TEMPERATURE,
    capabilities.humidity && FEATURE_KEYS.HUMIDITY,
    capabilities.light && FEATURE_KEYS.BRIGHTNESS,
    capabilities.motion && FEATURE_KEYS.MOTION,
    capabilities.leak && FEATURE_KEYS.LEAK,
    device.battery !== null && FEATURE_KEYS.BATTERY,
    FEATURE_KEYS.ONLINE,
  ].filter(Boolean);
}

/** The name shown for a device: the console's, else its kind and MAC end. */
export function deviceName(device, language = 'en') {
  if (device.name) {
    return device.name;
  }
  const kinds = KIND_NAMES[language] ?? KIND_NAMES.en;
  return `${kinds[device.kind]} ${device.mac.slice(-6).toUpperCase()}`;
}

/**
 * The discovery payload of a device.
 * @param {object} gladys SDK client
 * @param {object} device a parsed device (src/protect/model.js)
 * @param {object} [options]
 * @param {string} [options.language] feature names language
 * @param {boolean} [options.doorbell] the camera was seen ringing
 */
export function buildDevice(gladys, device, { language = 'en', doorbell = false } = {}) {
  const ids = deviceIds(gladys, device.kind, device.mac);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: deviceName(device, language),
    external_id: ids.device,
    should_poll: false,
    features: featureKeys(device, { doorbell }).map((key) => ({
      ...DEFINITIONS[key],
      name: names[key],
      external_id: ids.feature(key),
    })),
  };
}

const flag = (value) => (value ? 1 : 0);
const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

/**
 * The value of every feature of a device (null: nothing to publish).
 * @param {object} device a parsed device
 * @param {object} live what the events say now: `{ motion, objects: Set, pulses: Set }`
 */
export function featureValues(device, live = {}) {
  const objects = live.objects ?? new Set();
  const pulses = live.pulses ?? new Set();
  const values = { [FEATURE_KEYS.ONLINE]: flag(device.online) };
  if (device.kind === KINDS.CAMERA) {
    values[FEATURE_KEYS.MOTION] = flag(live.motion);
    for (const type of Object.keys(SMART_FEATURES)) {
      values[SMART_FEATURES[type]] = flag(objects.has(type) || pulses.has(type));
    }
    values[FEATURE_KEYS.RING] = flag(pulses.has(FEATURE_KEYS.RING));
  } else if (device.kind === KINDS.LIGHT) {
    values[FEATURE_KEYS.LIGHT] = flag(device.lightOn);
    values[FEATURE_KEYS.MOTION] = flag(device.motion || pulses.has(FEATURE_KEYS.MOTION));
  } else {
    // Protect says "opened"; the core's opening sensor says 1 for closed.
    values[FEATURE_KEYS.OPENING] = device.opened === null ? null : flag(!device.opened);
    values[FEATURE_KEYS.TEMPERATURE] = round1(device.temperature);
    values[FEATURE_KEYS.HUMIDITY] = round1(device.humidity);
    values[FEATURE_KEYS.BRIGHTNESS] = round1(device.light);
    values[FEATURE_KEYS.MOTION] = flag(device.motion);
    values[FEATURE_KEYS.LEAK] = flag(device.leak);
    values[FEATURE_KEYS.BATTERY] = device.battery === null ? null : Math.round(device.battery);
  }
  return values;
}
