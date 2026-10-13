# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes. In
particular:

- **Secrets**: the API key of the UniFi Protect Integration API lives in the
  Gladys configuration of the integration (a `secret` field). It is sent only
  to the console address configured, over HTTPS, in the `X-API-KEY` header,
  and never written to the logs or to `/data`.
- **`/data`**: the only file is `protect-state.json`, the MAC addresses of the
  cameras seen ringing. No secret, no image.
- **Network**: the integration talks only to the configured console (HTTPS
  REST and WebSockets on the address and port given), never to a cloud. The
  self-signed certificate of the console is accepted only when the user ticks
  the option, and its SHA-256 fingerprint is shown by "Test the connection".
- **Camera images** stay in memory (the last ones, for the widget) and go to
  Gladys only. RTSP stream addresses, which work as credentials of the
  stream, are shown to the user on request and never logged.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the UniFi console, its firmware and its devices (report those to
Ubiquiti).
