// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the reports of the Configuration actions, scene
// action errors, trigger variables. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks
// every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './protect/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noHost: {
    en: 'Enter the address of your UniFi console and an API key in the configuration.',
    fr: "Saisissez l'adresse de votre console UniFi et une clé d'API dans la configuration.",
    de: 'Gib die Adresse deiner UniFi-Konsole und einen API-Schlüssel in der Konfiguration ein.',
    es: 'Introduzca la dirección de su consola UniFi y una clave de API en la configuración.',
  },
  invalidHost: {
    en: 'Address not understood, e.g. 192.168.1.1',
    fr: 'Adresse incomprise, ex. 192.168.1.1',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.1',
    es: 'Dirección no válida, p. ej. 192.168.1.1',
  },
  noKey: {
    en: 'Enter the API key created in the UniFi console.',
    fr: "Saisissez la clé d'API créée dans la console UniFi.",
    de: 'Gib den in der UniFi-Konsole erstellten API-Schlüssel ein.',
    es: 'Introduzca la clave de API creada en la consola UniFi.',
  },
  live: {
    en: 'Connected, but live events are interrupted: states follow every minute.',
    fr: 'Connectée, mais les événements en direct sont coupés : états relus chaque minute.',
    de: 'Verbunden, aber die Live-Ereignisse sind unterbrochen: Zustände jede Minute neu gelesen.',
    es: 'Conectada, pero los eventos en directo están cortados: estados leídos cada minuto.',
  },
};

// One explanation per error kind (src/protect/client.js), shown in the
// connection status and in the reports.
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'The console does not answer: check its address and that Gladys can reach it.',
    fr: "La console ne répond pas : vérifiez son adresse et que Gladys peut l'atteindre.",
    de: 'Die Konsole antwortet nicht: Prüfe ihre Adresse und ob Gladys sie erreicht.',
    es: 'La consola no responde: compruebe su dirección y que Gladys pueda alcanzarla.',
  },
  [ERROR_KINDS.TLS]: {
    en: 'The console presents a self-signed certificate: tick "Accept the self-signed certificate".',
    fr: 'La console présente un certificat auto-signé : cochez « Accepter le certificat auto-signé ».',
    de: 'Die Konsole nutzt ein selbstsigniertes Zertifikat: Aktiviere „Selbstsigniertes Zertifikat akzeptieren“.',
    es: 'La consola presenta un certificado autofirmado: marque «Aceptar el certificado autofirmado».',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'API key refused: create a new one in the console and paste it again.',
    fr: "Clé d'API refusée : créez-en une nouvelle dans la console et collez-la à nouveau.",
    de: 'API-Schlüssel abgelehnt: Erstelle einen neuen in der Konsole und füge ihn erneut ein.',
    es: 'Clave de API rechazada: cree una nueva en la consola y péguela de nuevo.',
  },
  [ERROR_KINDS.NO_API]: {
    en: 'No UniFi Protect Integration API at this address: Protect 6 or later is required.',
    fr: "Pas d'API Integration UniFi Protect à cette adresse : Protect 6 ou plus est nécessaire.",
    de: 'Keine UniFi-Protect-Integration-API unter dieser Adresse: Protect 6 oder neuer ist nötig.',
    es: 'No hay API Integration de UniFi Protect en esta dirección: se necesita Protect 6 o posterior.',
  },
  [ERROR_KINDS.RATE_LIMIT]: {
    en: 'The console asks to slow down: the integration will retry.',
    fr: "La console demande de ralentir : l'intégration va réessayer.",
    de: 'Die Konsole bittet, langsamer zu werden: Die Integration versucht es erneut.',
    es: 'La consola pide reducir el ritmo: la integración lo volverá a intentar.',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'This device no longer exists in Protect.',
    fr: "Cet appareil n'existe plus dans Protect.",
    de: 'Dieses Gerät existiert in Protect nicht mehr.',
    es: 'Este dispositivo ya no existe en Protect.',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'The console refused the request: see the integration logs.',
    fr: "La console a refusé la requête : voir les logs de l'intégration.",
    de: 'Die Konsole hat die Anfrage abgelehnt: Sieh dir die Protokolle der Integration an.',
    es: 'La consola rechazó la solicitud: consulte los registros de la integración.',
  },
};

// Report of the "Test the connection" action. Functions of the figures read.
export const REPORT_TEXT = {
  en: {
    ok: (version, cameras, lights, sensors) =>
      `UniFi Protect ${version}: ${cameras} camera(s), ${lights} floodlight(s), ${sensors} sensor(s).`,
    certificate: (fingerprint) => `Self-signed certificate accepted, SHA-256 ${fingerprint}.`,
  },
  fr: {
    ok: (version, cameras, lights, sensors) =>
      `UniFi Protect ${version} : ${cameras} caméra(s), ${lights} projecteur(s), ${sensors} capteur(s).`,
    certificate: (fingerprint) => `Certificat auto-signé accepté, SHA-256 ${fingerprint}.`,
  },
  de: {
    ok: (version, cameras, lights, sensors) =>
      `UniFi Protect ${version}: ${cameras} Kamera(s), ${lights} Flutlicht(er), ${sensors} Sensor(en).`,
    certificate: (fingerprint) => `Selbstsigniertes Zertifikat akzeptiert, SHA-256 ${fingerprint}.`,
  },
  es: {
    ok: (version, cameras, lights, sensors) =>
      `UniFi Protect ${version}: ${cameras} cámara(s), ${lights} foco(s), ${sensors} sensor(es).`,
    certificate: (fingerprint) => `Certificado autofirmado aceptado, SHA-256 ${fingerprint}.`,
  },
};

// Messages of the Configuration actions and errors of the scene actions.
export const ACTION_TEXT = {
  notConfigured: {
    en: 'Configure the console address and the API key first.',
    fr: "Configurez d'abord l'adresse de la console et la clé d'API.",
    de: 'Konfiguriere zuerst die Adresse der Konsole und den API-Schlüssel.',
    es: 'Configure primero la dirección de la consola y la clave de API.',
  },
  pickCamera: {
    en: 'Choose a camera added to Gladys.',
    fr: 'Choisissez une caméra ajoutée à Gladys.',
    de: 'Wähle eine Kamera, die zu Gladys hinzugefügt wurde.',
    es: 'Elija una cámara añadida a Gladys.',
  },
  unknownCamera: {
    en: 'This camera is not (or no longer) in UniFi Protect.',
    fr: "Cette caméra n'est pas (ou plus) dans UniFi Protect.",
    de: 'Diese Kamera ist nicht (mehr) in UniFi Protect.',
    es: 'Esta cámara no está (o ya no está) en UniFi Protect.',
  },
  notDoorbell: {
    en: 'This camera is not a doorbell: it has no screen.',
    fr: "Cette caméra n'est pas une sonnette : elle n'a pas d'écran.",
    de: 'Diese Kamera ist keine Türklingel und hat keinen Bildschirm.',
    es: 'Esta cámara no es un timbre: no tiene pantalla.',
  },
  customText: {
    en: 'Enter the text of the message (30 characters at most).',
    fr: 'Saisissez le texte du message (30 caractères au plus).',
    de: 'Gib den Text der Nachricht ein (höchstens 30 Zeichen).',
    es: 'Introduzca el texto del mensaje (30 caracteres como máximo).',
  },
  noStream: {
    en: 'No RTSPS stream is enabled for this camera: enable one in Protect (camera settings, Advanced, RTSP).',
    fr: 'Aucun flux RTSPS activé pour cette caméra : activez-en un dans Protect (réglages de la caméra, Avancé, RTSP).',
    de: 'Für diese Kamera ist kein RTSPS-Stream aktiv: Aktiviere einen in Protect (Kameraeinstellungen, Erweitert, RTSP).',
    es: 'No hay ningún flujo RTSPS activado para esta cámara: active uno en Protect (ajustes de la cámara, Avanzado, RTSP).',
  },
  stream: {
    en: 'For the "RTSP camera" integration of Gladys:',
    fr: "Pour l'intégration « Caméra RTSP » de Gladys :",
    de: 'Für die Integration „RTSP-Kamera“ von Gladys:',
    es: 'Para la integración «Cámara RTSP» de Gladys:',
  },
  snapshotFailed: {
    en: 'The console did not send an image of this camera.',
    fr: "La console n'a pas envoyé d'image de cette caméra.",
    de: 'Die Konsole hat kein Bild dieser Kamera gesendet.',
    es: 'La consola no envió ninguna imagen de esta cámara.',
  },
};

// `object_name` variable of the `object_detected` trigger, by `object` value.
export const OBJECT_NAMES = {
  en: {
    person: 'person',
    vehicle: 'vehicle',
    animal: 'animal',
    package: 'package',
    license_plate: 'license plate',
    face: 'face',
  },
  fr: {
    person: 'personne',
    vehicle: 'véhicule',
    animal: 'animal',
    package: 'colis',
    license_plate: "plaque d'immatriculation",
    face: 'visage',
  },
  de: {
    person: 'Person',
    vehicle: 'Fahrzeug',
    animal: 'Tier',
    package: 'Paket',
    license_plate: 'Kennzeichen',
    face: 'Gesicht',
  },
  es: {
    person: 'persona',
    vehicle: 'vehículo',
    animal: 'animal',
    package: 'paquete',
    license_plate: 'matrícula',
    face: 'cara',
  },
};

export const LANGUAGE_FALLBACK = 'en';

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** A multi-language object built by a function of the language. */
export const localized = (render) =>
  Object.fromEntries(['en', 'fr', 'de', 'es'].map((language) => [language, render(language)]));
