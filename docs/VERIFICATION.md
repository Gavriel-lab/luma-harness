# Verification for public v0.1.0

Checked on Windows, 2026-10-20, using a fresh isolated public-export data directory. The original private runtime, source, data and cloud deployment were not used as test state or modified by this export.

## Verified

- Clean dependency installation: desktop/gateway `npm ci`; mobile's cross-platform lockfile was repaired and then a fresh `npm ci` succeeded. The mobile Vite/esbuild peer versions are compatible; no `--force` or `--legacy-peer-deps` was used.
- `npm test`: **110 checks passed** — 5 public initialization/local-adapter/activity tests, 36 gateway/Access/relay/optional-service tests, 18 renderer/authority/attachment checks and 51 work-broker/coordinator/native-contract checks.
- Mobile TypeScript check and both production builds pass.
- Source runtime: actual Electron and a mobile-sized Edge browser share the same authority; a mobile UI message makes exactly one real HTTP/SSE call to a synthetic loopback provider, the reply appears on both clients, and the message is persisted. Both CLI/API selectors can be selected without renderer errors. Marker: `LUMA_PUBLIC_SMOKE_OK`.
- Packaged Windows executable: the same UI/HTTP/persistence smoke passes with `packaged:true`. This tests the actual `Luma Harness.exe`, its ASAR, bundled mobile frontend and gateway helper resources.
- Packaged host modules match the checked source bytes. No user-data JSON, runtime token, auth cache, backup or `.env` file is in the ASAR. Marker: `LUMA_PACKAGE_SOURCE_MATCH`.
- Optional oil painting pack applies, both frontends build and mobile type-checks, then the base source is restored. Theme-added artwork is excluded from the base distribution. The optional mobile bundle has a non-blocking size warning.
- Source, built frontend and theme text scan passes with `LUMA_PRIVACY_OK`. The export also received a separate local check for original identities, service addresses and private memory product names.

The work-contract checks use the real Broker, scoped coordinator interface, real serialized stores and actual temporary artifact files with **controlled executors**. They verify duplication, stale authority, permissions, cancellation/restart, review/rejection and originating-conversation report behavior.

## Not verified by these checks

- An arbitrary user's real model entitlement, billing, CLI version or login. The UI smoke's synthetic provider is not model reasoning or a real subscription test.
- A new user's own Cloudflare account, Access login, physical phone, relay deployment or external service. Those are supplied/configured by the recipient and need their own authenticated success/anonymous rejection acceptance.
- Linux VPS runtime libraries, headless OS keyring or a particular VPS. The included route and systemd unit are deployment instructions, not evidence of a live server.
- A recipient's optional memory plugin, music/speech backend or customized theme.

No real user conversations were populated with fabricated test replies. Test configuration, synthetic credential, temporary sessions and screenshots remain under ignored `.local/` directories and are excluded from release archives.
