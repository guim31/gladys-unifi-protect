# UniFi Protect fixtures

Payloads of the official UniFi Protect Integration API, as the tests feed them
to the integration (through `test/helpers/fakeProtect.js`).

No real console was available to write this integration. The shapes come from
the test payloads of [uilibs/uiprotect](https://github.com/uilibs/uiprotect)
(MIT licence), the library of the Home Assistant `unifiprotect` integration,
whose public-API models are checked against the OpenAPI specification of
Protect 7.3.70:

- `cameras.json`, `lights.json`, `sensors.json`: `CAMERA_PAYLOAD`,
  `LIGHT_PAYLOAD` and `SENSOR_PAYLOAD` of `tests/test_public_devices_models.py`,
  varied to cover the cases the integration handles: a doorbell with a package
  camera, a camera with license plate detection, a camera offline, a camera and
  a sensor of an older firmware (no `type`, no `featureFlags`, as uiprotect
  documents for Protect 7.1.69), a leak mount;
- `events/`: the frames of `tests/sample_data/events_ws_public/` (smart
  detection lifecycle with its duplicate `end`, package detection born closed,
  floodlight motion) and the ring frame of `tests/test_api_public.py`;
- `meta-info.json`, `rtsps-stream.json`: the shapes of `GET /v1/meta/info` and
  `GET /v1/cameras/{id}/rtsps-stream` read by uiprotect.

Anonymised: names are invented, MAC addresses use an invented `F4E2C6` prefix,
identifiers are invented, addresses are in `192.0.2.0/24` (RFC 5737).
