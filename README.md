# UniFi Protect for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
**UniFi Protect**: the cameras, doorbells, floodlights and sensors of a UniFi
console (UDM, UCG, UNVR, Cloud Key), **locally**, through the official Protect
Integration API. No Ubiquiti cloud account, nothing leaves your network.

> **Developed without the hardware: feedback welcome.** No Protect console was
> available to write this integration: it was built from the API
> specification, as mirrored by the tests of
> [uilibs/uiprotect](https://github.com/uilibs/uiprotect), and is covered by
> tests against a fake console. Please report what works and what does not in
> the [issues](https://github.com/guim31/gladys-unifi-protect/issues).

## Features

- **Cameras**: image (refreshed on a timer, at each detection and ring, and on
  demand), online, motion, and the smart detections each camera can do —
  person, vehicle, animal, package.
- **Doorbells**: the ring, as the core `doorbell` feature (Gladys shows
  "Ringing" and the time of the last ring).
- **Floodlights** (UP Floodlight): light on/off, motion, online.
- **Sensors** (UP-Sense): opening (open/closed, the core convention:
  0 open, 1 closed), temperature, humidity, brightness, motion, water leak,
  battery, online — what each mount allows.
- **Scene triggers**: _Object detected by a camera_ (filter by camera and by
  type: person, vehicle, animal, package, license plate, face) and _Someone
  rang the doorbell_. The image of the camera is refreshed in Gladys before
  the scene starts, so "send the camera image" sends the visitor.
- **Scene actions**, harmless on purpose: _Refresh a camera image_ and _Show a
  message on the doorbell_ (do not disturb, leave the package, your own text,
  or clear it, for a while or until changed).
- **Dashboard widget** _UniFi Protect_: cameras online, detections of the
  last 24 hours, the last detections with their image, the state of each
  camera.
- **Configuration actions**: _Test the connection_ (version, devices,
  certificate fingerprint) and _Show the video stream address_ (the RTSP
  address of a camera, for the "RTSP camera" integration of Gladys).
- Four languages: English, French, German, Spanish.

## Requirements

- UniFi Protect **6 or later** (the Integration API; 7.x recommended) and an
  API key created in the console: **Settings → Control Plane →
  Integrations**.
- Gladys Assistant **5.1.0 or later**, able to reach the console over HTTPS.

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-unifi-protect`
   (or install **UniFi Protect** from the catalog once it is listed).
2. In **Configuration**, enter the address of the console and the API key,
   tick _Accept the self-signed certificate_ (UniFi consoles serve one), save,
   then click **Test the connection**.
3. Open the **Discover** tab and add the devices.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- **API**: the official Integration API only
  (`/proxy/protect/integration/v1/…`, header `X-API-KEY`): `meta/info`,
  `cameras`, `lights`, `sensors`, camera `snapshot` and `rtsps-stream`, and
  `PATCH` of a light (`isLightForceEnabled`) and of a doorbell message
  (`lcdMessage`). The private API (local account and password, the one
  `uiprotect` started with) is not used: the Integration API covers every need
  of this integration, and a key can be revoked without touching an account.
- **Live**: the two subscription WebSockets (`subscribe/devices`,
  `subscribe/events`), with a growing reconnection delay and a ping every
  minute. The devices are published with `should_poll: false`: the container
  reads the full state again every 5 minutes (every minute while the devices
  socket is down) — Gladys never polls (GladysAssistant/Gladys#3198).
- **States**: `publishChangedStates`, only the changes, plus a heartbeat every
  6 hours; only for the devices added to Gladys.
- **Detections**: an event opens, gains smart types, closes. One scene event
  per new type, after a fresh image of the camera (waited 4 s at most). A
  package detection arrives closed, and the ring is instantaneous: their
  features pulse 1 → 0 for 10 seconds. An event never closed is dropped after
  30 minutes, and every open one when the events socket reopens.
- **Images**: Gladys takes 150 KB per camera image. A larger snapshot is
  decoded straight at 1/2, 1/4 or 1/8 by a small baseline JPEG decoder
  (`src/jpeg-scaled.js`, a few MB even in 4K, where a general decoder needs
  ~50 bytes per pixel), then encoded again with
  [jpeg-js](https://github.com/eugeneware/jpeg-js) at 960 pixels at most, in a
  worker thread ended after each conversion. No native module, no ffmpeg.
- **Persistence**: `/data/protect-state.json` keeps the MAC addresses of the
  cameras seen ringing (a doorbell older firmware does not name as such). The
  API key stays in the Gladys configuration.
- **Logs**: the lifecycle only at info level; a repeated failure is logged
  once, and once when it clears; `LOG_LEVEL=debug` shows the rest. Never the
  key, nor a stream address.

## What could not be checked

No console, no camera, no Gladys instance were available: the tests run
against the SDK's fake Gladys and an in-memory console built from the payloads
of uiprotect's tests (`test/fixtures/protect/`). Not checked for real:

- the exact path of the API key screen in every UniFi OS version;
- the resolution and size of a real `snapshot?highQuality=false` (the
  re-encoding handles up to 4K baseline JPEG);
- the `type` of every doorbell model (a doorbell not named so becomes one at
  its first ring);
- the plain RTSP port 7447 next to the RTSPS stream (port 7441) on current
  firmware;
- the behaviour of the floodlight when forced off while lit by motion.

## Limitations

- No control of recording, notifications, alarm, chimes or sirens (not in the
  Integration API, or unsafe to automate).
- No audio detections, license plate text or face identities.
- The widget's detection list is kept in memory (the API has no event
  history).
- Live video goes through the "RTSP camera" integration of Gladys.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and an in-memory console (`test/helpers/fakeProtect.js`). See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

### Releasing

Describe each change under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md), then **Actions → Release → Run workflow**
(`patch`, `minor` or `major`): the workflow bumps the version everywhere, moves
the changelog section, tags, builds the multi-arch image to `ghcr.io` and
publishes the GitHub Release.

> A hand-pushed tag (`git tag v1.2.3 && git push --tags`) triggers the same
> build and Release, but does **not** bump anything: update `version` in
> `package.json` and in `gladys-assistant-integration.json` (with the
> `docker_image` tag) and commit it before tagging.

## Credits

- [uilibs/uiprotect](https://github.com/uilibs/uiprotect) (MIT), the library of
  Home Assistant's
  [`unifiprotect`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/unifiprotect)
  integration (Apache-2.0): its public-API models and test payloads gave the
  shapes of the Integration API (fixtures adapted and anonymised), the
  handling of partial and bulk frames, of package events born closed, of
  events whose end is lost, and the doorbell message rules. No code was
  copied.
- [jpeg-js](https://github.com/eugeneware/jpeg-js) (BSD-3-Clause) encodes the
  resized images; [ws](https://github.com/websockets/ws) (MIT) carries the
  subscriptions.
- The architecture, the conformity tests and the quiet logs follow
  [gladys-pihole](https://github.com/guim31/gladys-pihole) and
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Ubiquiti Inc.
UniFi and UniFi Protect are trademarks of Ubiquiti Inc.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
