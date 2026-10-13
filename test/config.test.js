// -----------------------------------------------------------------------------
// The configuration, normalized: the console address, the key, the
// certificate choice, the image interval, the language.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, hostOf, normalizeConfig, parseHost } from '../src/config.js';

test('the console address: a host, an IP with a port, a URL copied from the browser', () => {
  assert.equal(parseHost('192.0.2.1'), 'https://192.0.2.1');
  assert.equal(parseHost(' unvr.local:8443 '), 'https://unvr.local:8443');
  assert.equal(parseHost('https://192.0.2.1/protect/dashboard'), 'https://192.0.2.1');
  assert.equal(parseHost('[2001:db8::1]'), 'https://[2001:db8::1]');
  assert.equal(hostOf('https://192.0.2.1:8443'), '192.0.2.1:8443');
});

test('an address that cannot be used is refused', () => {
  for (const raw of [
    '',
    '   ',
    'http://192.0.2.1',
    'ftp://x',
    'https://user:pass@192.0.2.1',
    'a b',
    42,
  ]) {
    assert.equal(parseHost(raw), null, String(raw));
  }
});

test('defaults: nothing configured, French names, images every 5 minutes, certificate checked', () => {
  const config = normalizeConfig();
  assert.equal(config.host, null);
  assert.equal(config.hostInvalid, false);
  assert.equal(config.apiKey, '');
  assert.equal(config.allowSelfSigned, false);
  assert.equal(config.snapshotIntervalMs, 5 * 60_000);
  assert.equal(config.language, 'fr');
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('values from the form are read safely', () => {
  const config = normalizeConfig({
    host: 'http://192.0.2.1',
    api_key: '  key  ',
    allow_self_signed: 'true',
    snapshot_interval: '15',
    language: 'es',
  });
  assert.equal(config.hostInvalid, true);
  assert.equal(config.apiKey, 'key');
  assert.equal(config.allowSelfSigned, true);
  assert.equal(config.snapshotIntervalMs, 15 * 60_000);
  assert.equal(config.language, 'es');
  const odd = normalizeConfig({ snapshot_interval: '7', language: 'it', allow_self_signed: 1 });
  assert.equal(odd.snapshotIntervalMs, 5 * 60_000);
  assert.equal(odd.language, 'fr');
  assert.equal(odd.allowSelfSigned, false);
  assert.equal(normalizeConfig({ snapshot_interval: '0' }).snapshotIntervalMs, 0);
  assert.equal(normalizeConfig(null).host, null);
});
