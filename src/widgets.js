// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `protect`.
//
// The use case: a glance at the wall tablet — "who came by, are the cameras
// up?". So the widget shows:
//   - two tiles: cameras online (3/4) and detections over the last 24 hours;
//   - the last detections and rings, newest first, each with the image taken
//     when it happened (card-list, list display, its date under the title);
//   - the state of the cameras (online or not), and the floodlights and
//     sensors offline, if any.
// Every camera by default, or the one chosen in the widget settings.
//
// Budget (8 components, ≤ 2 texts, one focal component, one status): at most
// two tiles, one card-list, one status, one caption. The detections are kept
// in memory (the Integration API has no event history): the list starts empty
// after a restart. Images: keys `det-<event id>`, immutable, served by
// onWidgetGetImage from the thumbnails of the hub.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { deviceIds, deviceName } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { KINDS } from './protect/model.js';
import { ERROR_TEXT, OBJECT_NAMES, pick } from './texts.js';

export const TEXT = {
  configure: {
    en: 'Enter the address of your UniFi console and an API key in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre console UniFi et une clé d'API dans la configuration de l'intégration.",
    de: 'Gib die Adresse deiner UniFi-Konsole und einen API-Schlüssel in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su consola UniFi y una clave de API en la configuración de la integración.',
  },
  unknown: {
    en: 'This camera is no longer in UniFi Protect: choose another one in the widget settings.',
    fr: "Cette caméra n'est plus dans UniFi Protect : choisissez-en une autre dans les réglages du widget.",
    de: 'Diese Kamera ist nicht mehr in UniFi Protect: Wähle eine andere in den Widget-Einstellungen.',
    es: 'Esta cámara ya no está en UniFi Protect: elija otra en la configuración del widget.',
  },
  noDetection: {
    en: 'No detection since the integration started.',
    fr: "Aucune détection depuis le démarrage de l'intégration.",
    de: 'Keine Erkennung seit dem Start der Integration.',
    es: 'Ninguna detección desde el inicio de la integración.',
  },
  online: {
    en: 'Cameras online',
    fr: 'Caméras en ligne',
    de: 'Kameras online',
    es: 'Cámaras en línea',
  },
  detections: {
    en: 'Detections 24 h',
    fr: 'Détections 24 h',
    de: 'Erkennungen 24 h',
    es: 'Detecciones 24 h',
  },
  isOnline: { en: 'Online', fr: 'En ligne', de: 'Online', es: 'En línea' },
  isOffline: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Sin conexión' },
  othersOffline: {
    en: 'Floodlights, sensors offline',
    fr: 'Projecteurs, capteurs hors ligne',
    de: 'Flutlichter, Sensoren offline',
    es: 'Focos, sensores sin conexión',
  },
  ring: { en: 'Doorbell', fr: 'Sonnette', de: 'Türklingel', es: 'Timbre' },
  motion: { en: 'Motion', fr: 'Mouvement', de: 'Bewegung', es: 'Movimiento' },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** "Person, vehicle · Front door" — what a detection saw, and where. */
export function detectionTitle(detection, cameraName, language) {
  const names = OBJECT_NAMES[language] ?? OBJECT_NAMES.en;
  const what = detection.ring
    ? t(TEXT.ring, language)
    : capitalize(detection.objects.map((object) => names[object]).join(', ')) ||
      t(TEXT.motion, language);
  return fit(`${what} · ${cameraName}`, 60);
}

async function get(hub, { settings, language = 'en' }) {
  const view = hub.view();
  if (!view.configured) {
    return message(TEXT.configure, language);
  }
  const cameras = view.devices.filter((device) => device.kind === KINDS.CAMERA);
  let shown = cameras;
  if (settings?.camera) {
    const camera = cameras.find(
      (device) => deviceIds(hub.gladys, device.kind, device.mac).device === settings.camera,
    );
    if (!camera) {
      return message(TEXT.unknown, language);
    }
    shown = [camera];
  }
  const components = [];
  if (view.reachable === false) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: fit(t(ERROR_TEXT[view.error.kind] ?? ERROR_TEXT.http, language), 80),
    });
  }

  const onlineCount = shown.filter((camera) => camera.online).length;
  const cameraId = settings?.camera ? shown[0].id : null;
  components.push(
    {
      type: 'value',
      value: `${onlineCount}/${shown.length}`,
      label: t(TEXT.online, language),
      icon: 'video',
      color: onlineCount === shown.length ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
    },
    {
      type: 'value',
      value: view.detectionsToday(cameraId),
      label: t(TEXT.detections, language),
      icon: 'eye',
    },
  );

  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  const detections = view.detections
    .filter((detection) => !cameraId || detection.cameraId === cameraId)
    .filter((detection) => byId.has(detection.cameraId));
  if (detections.length > 0) {
    components.push({
      type: 'card-list',
      display: 'list',
      items: detections.slice(0, 8).map((detection) => ({
        title: detectionTitle(
          detection,
          deviceName(byId.get(detection.cameraId), language),
          language,
        ),
        date: new Date(detection.at).toISOString(),
        ...(detection.imageKey ? { image: detection.imageKey } : {}),
      })),
    });
  } else if (view.reachable !== false) {
    components.push({ type: 'text', variant: 'caption', text: t(TEXT.noDetection, language) });
  }

  const items = shown.slice(0, 9).map((camera) => ({
    label: fit(deviceName(camera, language), 40),
    icon: camera.online ? 'video' : 'video-off',
    value: t(camera.online ? TEXT.isOnline : TEXT.isOffline, language),
    color: camera.online ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
  }));
  const othersOffline = settings?.camera
    ? 0
    : view.devices.filter((device) => device.kind !== KINDS.CAMERA && !device.online).length;
  if (othersOffline > 0) {
    items.push({
      label: t(TEXT.othersOffline, language),
      icon: 'alert-triangle',
      value: othersOffline,
      color: WIDGET_COLORS.WARNING,
    });
  }
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  // New detections nudge the widget (requestWidgetRefresh); the TTL is a net.
  return { ttl_seconds: 120, components };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get },
};
