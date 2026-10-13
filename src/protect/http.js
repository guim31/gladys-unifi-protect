// -----------------------------------------------------------------------------
// The one function that talks HTTP to the console: a request on node:https.
// Not on fetch: fetch cannot accept the self-signed certificate of one server
// only (every UniFi console serves one by default), node:https can, per
// request, and it tells the certificate fingerprint the "Test the connection"
// action shows. The body comes back as a Buffer: snapshots are JPEG bytes.
//
// The client takes this function as a parameter: the tests replace it with an
// in-memory console (test/helpers/fakeProtect.js).
// -----------------------------------------------------------------------------

import https from 'node:https';

// A camera snapshot at full resolution stays well under this.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * @param {string} url absolute https URL
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {unknown} [options.json] body, sent as JSON
 * @param {boolean} [options.insecure] accept a certificate that does not verify
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer, fingerprint: string|null }>}
 */
export function httpRequest(
  url,
  { method = 'GET', headers = {}, json, insecure = false, timeoutMs = 10_000 } = {},
) {
  const payload = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
  const requestHeaders = {
    ...headers,
    ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
  };

  return new Promise((resolve, reject) => {
    const request = https.request(
      new URL(url),
      { method, headers: requestHeaders, timeout: timeoutMs, rejectUnauthorized: !insecure },
      (response) => {
        const chunks = [];
        let size = 0;
        const certificate = response.socket?.getPeerCertificate?.();
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            fingerprint: certificate?.fingerprint256 ?? null,
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('timeout', () => {
      const error = new Error(`Timed out after ${timeoutMs} ms`);
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.on('error', reject);
    request.end(payload);
  });
}
