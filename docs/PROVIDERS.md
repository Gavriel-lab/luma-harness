# CLI, API and worker adapters

## Choose what the route actually provides

| Route | What it provides | What the owner supplies |
| --- | --- | --- |
| OpenAI-compatible Profile | Text/image chat through the host's SSE transport | HTTPS Base URL, supported model ID, own API key if required |
| Codex app-server | Native CLI conversations; coordinator can use the MCP workbench | Installed CLI, own login, model availability and workspace |
| Registered Kiro / OpenCode / ZCode / Antigravity adapter | Existing native chat/work integration where supported by that CLI | Compatible CLI version, own login, model and approved workspace |
| Custom work executor | Tool-enabled execution through the Broker contract | Adapter that enforces scope and reports actual work |

Subscription access follows the provider's supported CLI login flow. It is not automatically an API key or permission to proxy a subscription as a public service. API key usage is billed separately where the provider does so. For Codex's supported authentication choices see [official authentication documentation](https://learn.chatgpt.com/docs/auth).

## API chat

Use member settings or `examples/config.api.json`. Configure a real model ID; no real provider is called until you enable/configure a route and send a request. Keys saved through desktop settings use host-side OS credential encryption. A plaintext key is never sent to the mobile browser. This public release does not add an insecure fallback when OS encryption is unavailable.

Native chat routing, when explicitly enabled for a registered member, takes precedence over a Profile. Disable that native chat route before expecting the member to use its API Profile.

API chat returns model text; it does not supply a coding tool loop. To use an API model for coding, provide a tool-capable executor/agent and connect it through the work contract below. Do not mark an API-only chat response as completed file work.

## Codex coordinator

Install/authenticate the CLI in the account that runs the host, select CLI in member settings, and choose a model available to that login. `CODEX_BINARY_PATH` can identify an explicit executable; `LUMA_WORKSPACE` identifies the approved working directory.

The host launches app-server, keeps a member/conversation thread binding, and adds `connectors/coordinator.mjs --mcp` using a protected session manifest. The tool name is `xiaowu_workbench`; this stable internal protocol name is not a roster or a separate service.

A useful coordinator instruction is in `examples/coordinator-prompt.md`. Permission to handle a human's work request does not authorize unrelated publication, payment, account changes or access outside the configured workspace.

## Native workers

Add a member, select its work executor in the desktop workbench, select an existing approved directory, register it, and connect the managed client. Chat routing is a separate switch. No workers are registered in the blank public data.

- `LUMA_OPENCODE_CLI`: optional executable path; `LUMA_OPENCODE_MODEL`: your chosen model ID. No bundled free-model entitlement is promised.
- `LUMA_KIRO_MODEL`: optional model override for Kiro.
- `LUMA_ZCODE_CJS`: absolute path to your installed ZCode JavaScript CLI entry; missing paths fail with a configuration error.
- `LUMA_ANTIGRAVITY_CLI`: optional executable path for Antigravity; otherwise the adapter checks `agy` on PATH. `LUMA_ANTIGRAVITY_MODEL` is an optional model setting.
- Other native adapters discover their CLI or use their documented environment/path configuration in their source modules.

The public contract tests run the Broker with controlled executors and real artifact files; they do not certify current third-party subscriptions or every CLI on every OS.

## Integrating a different executor

Extend the existing registration allowlist and `connectors/bridge-entry.mjs` adapter dispatch; do not add a second scheduler. A worker session manifest contains the Broker's loopback URL, home/generation, stable member/executor IDs, approved workspace and a protected token-file path. Never expose these files to the browser.

The native protocol is JSON over the loopback Broker:

```text
GET  /v1/bridge/session
POST /v1/bridge/claim
POST /v1/bridge/context
POST /v1/bridge/heartbeat
POST /v1/bridge/event
POST /v1/bridge/report
```

Send `Authorization: Bearer <session token>`, `schemaVersion: 1`, and the identifiers required by each operation. Consult the handlers in `bridgeBroker.cjs` and the executable `scripts/bridge-contract.test.cjs` for exact payload fields; a third-party library's similarly named method is not this contract.

For each claimed job: bind the current attempt, obtain context, enforce the workspace/tool policy, acknowledge cancellation, send a bounded factual report with artifact paths/checks/unknowns, and wait for review. A stale job, changed authority, wrong worker or reused attempt must fail closed. Never turn an error into a made-up success reply.

This is the extension seam for an API agent with tools. A model HTTP endpoint alone is not such an executor.
