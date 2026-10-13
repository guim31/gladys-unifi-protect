// -----------------------------------------------------------------------------
// Client of the official UniFi Protect Integration API, served by the console
// under `/proxy/protect/integration/v1/…` and authenticated by an API key
// created in the console (header `X-API-KEY`). No login, no session, no cloud
// account: the key is sent on every request, and only over HTTPS.
//
// Endpoints used (shapes from the OpenAPI specification of Protect 7.x, as
// mirrored by the tests of uilibs/uiprotect):
//   GET   /v1/meta/info                 { applicationVersion }
//   GET   /v1/cameras | /v1/lights | /v1/sensors
//   GET   /v1/cameras/{id}/snapshot     JPEG bytes
//   GET   /v1/cameras/{id}/rtsps-stream { high, medium, low, package? }
//   PATCH /v1/lights/{id}               { isLightForceEnabled }
//   PATCH /v1/cameras/{id}              { lcdMessage }
// The two WebSockets (`/v1/subscribe/devices`, `/v1/subscribe/events`) are
// opened by src/protect/socket.js with the same key.
//
// Errors are thrown as ProtectError with a `kind`, the one thing the hub, the
// texts and the logs need to know. Never the key in a message.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const API_PATH = '/proxy/protect/integration';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // nothing answers at this address
  TLS: 'tls', // certificate refused (self-signed and not accepted)
  AUTH: 'auth', // API key refused
  NO_API: 'no_api', // no Integration API there (Protect missing or too old)
  RATE_LIMIT: 'rate_limit',
  NOT_FOUND: 'not_found', // a device that no longer exists
  HTTP: 'http', // any other refusal
});

export class ProtectError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message
   * @param {{ status?: number }} [details]
   */
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = 'ProtectError';
    this.kind = kind;
    this.status = status;
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A network error (no HTTP answer) as a ProtectError. */
export function networkError(err) {
  if (TLS_CODES.has(err.code)) {
    return new ProtectError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
  }
  return new ProtectError(ERROR_KINDS.UNREACHABLE, err.code ? `${err.code}` : err.message);
}

/** An HTTP refusal as a ProtectError; `what` names the request in the message. */
export function statusError(status, what) {
  if (status === 401 || status === 403) {
    return new ProtectError(ERROR_KINDS.AUTH, `API key refused (HTTP ${status})`, { status });
  }
  if (status === 429) {
    return new ProtectError(ERROR_KINDS.RATE_LIMIT, 'Too many requests (HTTP 429)', { status });
  }
  return new ProtectError(ERROR_KINDS.HTTP, `${what} failed with HTTP ${status}`, { status });
}

export class ProtectClient {
  /**
   * @param {object} options
   * @param {string} options.origin `https://host[:port]`
   * @param {string} options.apiKey
   * @param {boolean} [options.insecure] accept the console's self-signed certificate
   * @param {Function} [options.request] HTTP seam (src/protect/http.js)
   */
  constructor({ origin, apiKey, insecure = false, request = httpRequest }) {
    this.origin = origin;
    this.apiKey = apiKey;
    this.insecure = insecure;
    this.request = request;
    /** SHA-256 fingerprint of the certificate of the last answer. */
    this.fingerprint = null;
  }

  url(path) {
    return `${this.origin}${API_PATH}${path}`;
  }

  /** WebSocket URL of a subscription (`devices` or `events`). */
  socketUrl(stream) {
    return `${this.url(`/v1/subscribe/${stream}`).replace(/^https:/, 'wss:')}`;
  }

  get headers() {
    return { 'X-API-KEY': this.apiKey };
  }

  async send(path, { method = 'GET', json, accept = 'application/json', timeoutMs } = {}) {
    let response;
    try {
      response = await this.request(this.url(path), {
        method,
        json,
        headers: { ...this.headers, accept },
        insecure: this.insecure,
        timeoutMs,
      });
    } catch (err) {
      throw networkError(err);
    }
    this.fingerprint = response.fingerprint ?? this.fingerprint;
    return response;
  }

  async json(path, options = {}) {
    const response = await this.send(path, options);
    const { status } = response;
    if (status === 404 && path === '/v1/meta/info') {
      throw new ProtectError(ERROR_KINDS.NO_API, 'No Protect Integration API at this address', {
        status,
      });
    }
    if (status === 404) {
      throw new ProtectError(ERROR_KINDS.NOT_FOUND, `${path} not found`, { status });
    }
    if (status < 200 || status >= 300) {
      throw statusError(status, `${options.method ?? 'GET'} ${path}`);
    }
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      // A login page or a proxy error page: something that is not Protect.
      throw new ProtectError(ERROR_KINDS.NO_API, `${path} did not answer JSON`, { status });
    }
  }

  /** `{ applicationVersion }`: also the cheapest check of the key. */
  metaInfo() {
    return this.json('/v1/meta/info');
  }

  async list(path) {
    const data = await this.json(path);
    return Array.isArray(data) ? data : [];
  }

  cameras() {
    return this.list('/v1/cameras');
  }

  lights() {
    return this.list('/v1/lights');
  }

  sensors() {
    return this.list('/v1/sensors');
  }

  /**
   * A fresh JPEG of the camera (the console's default snapshot quality).
   * @returns {Promise<{ bytes: Buffer, contentType: string }>}
   */
  async snapshot(cameraId) {
    const path = `/v1/cameras/${encodeURIComponent(cameraId)}/snapshot?highQuality=false`;
    const response = await this.send(path, { accept: 'image/jpeg', timeoutMs: 12_000 });
    if (response.status !== 200) {
      throw response.status === 404
        ? new ProtectError(ERROR_KINDS.NOT_FOUND, 'Snapshot not found', { status: 404 })
        : statusError(response.status, 'Snapshot');
    }
    return {
      bytes: response.body,
      contentType: String(response.headers?.['content-type'] ?? ''),
    };
  }

  /** The RTSPS stream URLs of a camera, by quality (`null` when not enabled). */
  rtspsStreams(cameraId) {
    return this.json(`/v1/cameras/${encodeURIComponent(cameraId)}/rtsps-stream`);
  }

  /** Floodlight: forced on (true), or back to its own lighting mode (false). */
  setLightForced(lightId, on) {
    return this.json(`/v1/lights/${encodeURIComponent(lightId)}`, {
      method: 'PATCH',
      json: { isLightForceEnabled: on },
    });
  }

  /** Doorbell screen message (see src/scenes.js for the shapes). */
  setLcdMessage(cameraId, lcdMessage) {
    return this.json(`/v1/cameras/${encodeURIComponent(cameraId)}`, {
      method: 'PATCH',
      json: { lcdMessage },
    });
  }
}
