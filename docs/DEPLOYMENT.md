# Local, mobile and VPS deployment

## Local authority

Run `npm run setup`, `npm run build`, then `npm start`. The source launcher initializes only a new data directory. It refuses corrupt existing data and does not re-seed saved accounts or conversations on subsequent starts.

| Variable | Meaning |
| --- | --- |
| `LUMA_DATA_DIR` | Absolute private data directory; source default is `.local/userData` |
| `LUMA_CONFIG` | Private initial configuration JSON; source default is `luma.config.json` |
| `LUMA_WORKSPACE` | Approved coordinator workspace; source default is `.local/workspace` |
| `LUMA_HEADLESS=1` | Keep the desktop window hidden while the same authority runs |
| `LUMA_LOCAL_MOBILE_PORT` | Loopback preview port; default `8787`, `0` selects an unused port |
| `LUMA_DISABLE_LOCAL_MOBILE=1` | Disable loopback mobile preview |
| `LUMA_MEMORY_PLUGIN` | Optional absolute path to your own memory module |
| `CODEX_BINARY_PATH` | Optional explicit Codex executable |

The top-bar mobile preview opens a temporary, private pairing link and sets an HttpOnly same-site cookie. It listens only on `127.0.0.1`, checks Host/Origin and does not expose the Broker to a LAN. The private URL is also in `<data-dir>/local-mobile/connection.json`. Do not post this file or pairing URL publicly.

For an installed Windows Release, default data lives in the OS app-data directory named `luma-harness`; source and installed profiles are intentionally separate. You can pass `--user-data-dir=<absolute-path>` directly to the executable when migrating a tested profile. Stop both hosts first and preserve a full backup.

## Remote phone: your own Cloudflare gateway and relay

The phone is a client of a running authority. In the local route, the computer must stay online. Installing a PWA does not turn it into an independent cloud model or memory server.

Required owner-provided resources:

- Your Cloudflare account, two Worker names and a Durable Object binding.
- A Cloudflare Access application for your mobile gateway URL, allowing only your owner identity. Use your own team domain, application audience and owner email.
- Your model/CLI credentials on the authority host, not on the phone or Worker.

Do not reuse another person's home ID, deployment, Access audience or relay secret. The templates are blank on purpose. Missing Access configuration denies access rather than falling back to anonymous mode.

1. Build the clients and sign in to Wrangler using your own account.
2. Decide unique Worker names and the relay URL. Create/configure the Access application for the gateway URL; its signed JWT must match the values below. Cover production and any enabled preview URL. Configure no public allow-all policy.
3. Create private local settings:

```sh
npm run configure:cloud -- --relay-host YOUR-RELAY.YOUR-SUBDOMAIN.workers.dev --team-domain https://YOUR-TEAM.cloudflareaccess.com --aud YOUR_64_HEX_APPLICATION_AUD --owner-email YOU@example.com --gateway-name YOUR-GATEWAY --relay-name YOUR-RELAY
```

This creates a new random relay token only if none exists, binds the existing authority `homeId`, and writes ignored `wrangler.json` files. It does not log into or deploy to a cloud account.

4. Deploy the relay and gateway using the installed Wrangler. From the repository root:

```sh
node services/gateway/node_modules/wrangler/bin/wrangler.js deploy --config services/relay/wrangler.json
node services/gateway/node_modules/wrangler/bin/wrangler.js deploy --config services/gateway/wrangler.json
node scripts/cloud-secret.mjs
```

`cloud-secret.mjs` installs the **same** protected local token as `RELAY_TOKEN` into the two configured Workers through stdin. It does not print the token. First deployment can be offline until the secrets exist. The gateway still verifies owner JWTs throughout.

5. Restart the authority so it reads the pairing file. Open the gateway on the phone, complete your Access login, and verify `/api/bootstrap`, members, messages and a test reply. Confirm an anonymous browser cannot read `/api/members` or chat data.
6. Add the gateway to the phone's home screen if desired. Its service worker caches only allowed public static resources; API responses and login pages must not be cached.

The relay URL is owner-configured in a protected host file. The host requires WSS, the fixed relay path, the same home ID, and a 64-character secret file within the dedicated relay directory. No browser field can replace this address or token.

Music and speech are optional external integrations. They return unavailable until you configure your own backend/keys/voice. No shared music server, voice reference or private service is bundled.

## VPS authority

The included VPS route runs **the same Electron authority** under a virtual display. It does not replace storage or introduce an independent scheduler. Electron requires a display driver; [its headless guide](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci) documents Xvfb for a machine without a screen.

Use a dedicated Linux account with a desktop-capable Electron runtime, Node.js 24, Xvfb and OS libraries required by your distribution. For Ubuntu/Debian, install the current distribution packages for GTK, NSS, X11, GBM, ALSA and Xvfb; package names can differ by release. Do not run the host as root.

```sh
git clone https://github.com/Gavriel-lab/luma-harness.git
cd luma-harness
npm run setup
npm run build
# Complete your own CLI login or provider setup in this same service account.
# Configure the same cloud gateway route described above.
LUMA_HEADLESS=1 LUMA_DATA_DIR=/srv/luma/data LUMA_WORKSPACE=/srv/luma/workspace xvfb-run -a npm start
```

Make the data and workspace directories owned by that account. Keep the Broker and local preview on loopback. Use the authenticated gateway for remote phone access. For first-time API key configuration on a Linux headless host, ensure a functioning OS secret store or configure the host on a secure desktop; do not add a plaintext credential fallback.

An example service unit is in `deploy/luma.service.example`. Replace its paths and user before installation. Install/configure it only on your own VPS. Keep the entire authority state, CLI login/thread files and any external memory storage on persistent disks and back them up independently.

The public work-contract checks and builds are reproducible locally. A particular Linux distribution, GUI keyring, third-party CLI or VPS deployment is not certified by the Windows release checks; run the provided tests and your own end-to-end message/work acceptance before relying on that host.

## Troubleshooting without changing contracts

- `npm ci` must succeed from the committed lockfiles; do not use `--force` or disable peer dependency validation.
- If downloading the Electron runtime is blocked, configure your network/proxy for Node or an Electron mirror according to the Electron installer documentation. Setup passes through existing proxy settings; it does not change global npm/network configuration.
- If `8787` is occupied, set `LUMA_LOCAL_MOBILE_PORT` to another unused port.
- If the phone reports offline, verify the authority process and its relay connection. Do not invent a cloud-side reply or import test data into real chats.
- A successful build proves compilation, not that model login, file tools, Access login or phone delivery works.
