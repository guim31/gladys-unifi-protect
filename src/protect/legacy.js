// -----------------------------------------------------------------------------
// Optional reader of the internal Protect API (the one of the Protect web app),
// for what the official Integration API does not tell: whether a camera sees
// the night (`isDark`, forum t/11350). Used only when the user typed a username
// and a password of a local console account; read only, nothing is written.
//
// This API is not documented and may change with a Protect update: a read that
// fails leaves the "Dark" features empty, the rest of the integration keeps
// working over the API key.
//
//   POST /api/auth/login                { username, password, rememberMe }
//        → cookie TOKEN, header X-CSRF-Token
//   GET  /proxy/protect/api/cameras     [{ id, mac, isDark, … }]
//
// A refused login is not tried again until the configuration changes: a
// console locks an account after repeated failures. Never the password, the
// cookie or the token in a message.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';
import { ERROR_KINDS, ProtectError, networkError } from './client.js';
import { normalizeMac } from './model.js';

const LOGIN_PATH = '/api/auth/login';
const CAMERAS_PATH = '/proxy/protect/api/cameras';

const header = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The `TOKEN=…` pair of the Set-Cookie headers, null when absent. */
function tokenCookie(headers) {
  const cookies = [headers?.['set-cookie'] ?? []].flat();
  for (const cookie of cookies) {
    const pair = String(cookie).split(';')[0].trim();
    if (/^TOKEN=./.test(pair)) {
      return pair;
    }
  }
  return null;
}

export class LegacyReader {
  /**
   * @param {object} options
   * @param {string} options.origin `https://host[:port]`
   * @param {string} options.username
   * @param {string} options.password
   * @param {boolean} [options.insecure]
   * @param {Function} [options.request] HTTP seam (src/protect/http.js)
   */
  constructor({ origin, username, password, insecure = false, request = httpRequest }) {
    this.origin = origin;
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.request = request;
    this.cookie = null;
    this.csrf = null;
    /** The login was refused: not tried again with these credentials. */
    this.refused = null;
  }

  async send(path, { method = 'GET', json, headers = {} } = {}) {
    try {
      return await this.request(`${this.origin}${path}`, {
        method,
        json,
        headers: { accept: 'application/json', ...headers },
        insecure: this.insecure,
      });
    } catch (err) {
      throw networkError(err);
    }
  }

  async login() {
    if (this.refused) {
      throw this.refused;
    }
    const response = await this.send(LOGIN_PATH, {
      method: 'POST',
      json: { username: this.username, password: this.password, rememberMe: true },
    });
    const cookie = response.status === 200 ? tokenCookie(response.headers) : null;
    if (!cookie) {
      const error = new ProtectError(
        ERROR_KINDS.AUTH,
        response.status === 200
          ? 'Login answered without a session'
          : `Login refused (HTTP ${response.status})`,
        { status: response.status },
      );
      // 429 and server errors pass; a refusal of the account does not.
      if (response.status < 429 || response.status === 499) {
        this.refused = error;
      }
      throw error;
    }
    this.cookie = cookie;
    this.csrf = header(response.headers, 'x-csrf-token') ?? null;
  }

  async getCameras() {
    const response = await this.send(CAMERAS_PATH, {
      headers: { cookie: this.cookie, ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
    });
    this.csrf = header(response.headers, 'x-updated-csrf-token') ?? this.csrf;
    return response;
  }

  /**
   * Whether each camera sees the night, by MAC.
   * @returns {Promise<Map<string, boolean>>}
   */
  async darkness() {
    if (!this.cookie) {
      await this.login();
    }
    let response = await this.getCameras();
    if (response.status === 401 || response.status === 403) {
      // The session expired: one new login.
      this.cookie = null;
      await this.login();
      response = await this.getCameras();
    }
    if (response.status !== 200) {
      throw new ProtectError(ERROR_KINDS.HTTP, `Cameras failed with HTTP ${response.status}`, {
        status: response.status,
      });
    }
    let cameras;
    try {
      cameras = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new ProtectError(ERROR_KINDS.HTTP, 'Cameras answered something else than JSON');
    }
    const dark = new Map();
    for (const camera of Array.isArray(cameras) ? cameras : []) {
      const mac = normalizeMac(camera?.mac);
      if (mac && typeof camera.isDark === 'boolean') {
        dark.set(mac, camera.isDark);
      }
    }
    return dark;
  }
}
