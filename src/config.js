// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One UniFi Protect console per installation: its address, an API key of the
// official Integration API, and an explicit choice about its certificate.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// How often a fresh image of every camera is sent to Gladys, in minutes
// (`0`: only on a detection, a ring, a scene action or the live view).
export const SNAPSHOT_INTERVALS = ['0', '1', '5', '15', '60'];

export const DEFAULT_CONFIG = {
  host: '',
  api_key: '',
  username: '',
  password: '',
  allow_self_signed: false,
  snapshot_interval: '5',
  language: 'fr',
};

/**
 * Parse the address typed by the user into the console origin: a bare host or
 * IP (`192.0.2.1`, `unvr.local:8443`), or the URL copied from the browser
 * (`https://192.0.2.1/protect/dashboard`). The Integration API is served over
 * HTTPS only, so a bare host means HTTPS and any other scheme is refused.
 * @param {unknown} raw
 * @returns {string|null} `https://host[:port]`, null when unusable
 */
export function parseHost(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs.
  if (url.username || url.password) {
    return null;
  }
  return url.origin;
}

/** Host part shown to the user (no scheme). */
export const hostOf = (origin) => origin.replace(/^https:\/\//, '');

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const typedHost = text('host');
  const host = parseHost(typedHost);
  const interval = String(source.snapshot_interval ?? DEFAULT_CONFIG.snapshot_interval);
  const language = text('language');
  return {
    host,
    // An address was typed but cannot be used: said in the connection status.
    hostInvalid: typedHost !== '' && host === null,
    apiKey: text('api_key'),
    // Optional local account, for the internal API (src/protect/legacy.js).
    username: text('username'),
    // A password is taken as typed: spaces may be part of it.
    password: typeof source.password === 'string' ? source.password : '',
    // A boolean field may arrive as a string from older form engines.
    allowSelfSigned: source.allow_self_signed === true || source.allow_self_signed === 'true',
    snapshotIntervalMs:
      (SNAPSHOT_INTERVALS.includes(interval)
        ? Number(interval)
        : Number(DEFAULT_CONFIG.snapshot_interval)) * 60_000,
    language: LANGUAGES.includes(language) ? language : DEFAULT_CONFIG.language,
  };
}
