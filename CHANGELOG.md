# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.1.1] - 2026-10-22

### Security

- Rebuilt on Node.js 24.22.1, the October 2026 security release (remote code
  execution in the Brotli decoder, CVE-2026-111497; TLS hostname and DNS
  fixes).

## [1.1.0] - 2026-10-18

### Added

- Night detection (optional): with a local account of the console, every
  camera gets a "Dark" feature that follows `isDark` of the internal Protect
  API, read every minute — for example to switch outdoor lights (forum
  t/11350). Without the account nothing changes; the internal API is not
  documented and may break with a Protect update.

## [1.0.1] - 2026-10-13

### Added

- UniFi Protect cameras, doorbells, floodlights and sensors in Gladys, over the
  local Integration API of the console (API key, no cloud account).
- Cameras: image, online, motion, and the smart detections each camera can do
  (person, vehicle, animal, package).
- Doorbells: the ring, shown by Gladys as "Ringing" and the time of the last
  ring; a doorbell older firmware does not name as such is recognised at its
  first ring.
- Floodlights: light on and off, motion, online.
- Sensors: opening, temperature, humidity, brightness, motion, water leak,
  battery, online — what each mount allows.
- Camera images refreshed on a timer (every 5 minutes by default), at each
  detection and ring, and on demand from the dashboard; resized to fit Gladys.
- Scene triggers "Object detected by a camera" (filters: camera, what was
  detected) and "Someone rang the doorbell", fired after a fresh image of the
  camera.
- Scene actions "Refresh a camera image" and "Show a message on the doorbell".
- Dashboard widget "UniFi Protect": cameras online, detections of the last
  24 hours, last detections with their image, state of the cameras.
- Configuration actions "Test the connection" and "Show the video stream
  address" (for the "RTSP camera" integration of Gladys).
- Explicit choice to accept the self-signed certificate of the console.
- Feature names, messages and documentation in English, French, German and
  Spanish.

[Unreleased]: https://github.com/guim31/gladys-unifi-protect/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/guim31/gladys-unifi-protect/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/guim31/gladys-unifi-protect/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/guim31/gladys-unifi-protect/releases/tag/v1.0.1
