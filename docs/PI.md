# Built-in Pi worker

Pi is an embedded execution engine behind Luma's existing Broker. Luma owns authorization, tickets, context, attempts, review, persistence and delivery. Pi owns the model/tool loop for a claimed job. It is not a second coordinator, database or memory service.

## Configure a worker

1. Install dependencies with `npm run setup`. The Pi connector has its own committed lockfile; setup installs it alongside the clients and gateway. SDK version: `@earendil-works/pi-coding-agent@1.4.0`.
2. Add a member and bind its own OpenAI-compatible API Profile in member settings. Supply its Base URL, model ID and host-encrypted API key. Pi uses this member's Profile; it never borrows another member's credentials. A CLI subscription alone does not supply Pi with an API endpoint.
3. In the desktop workbench's client connections, select that member, choose **Pi SDK · 受控工作**, select an existing authorized workspace and register it. Connect the managed client. No standalone Pi desktop app or Pi CLI login is required for this embedded route.
4. Configure your coordinator separately. The existing Codex coordinator route can use the workbench MCP to create/update a plan. Approve the exact plan version in the desktop workbench before work starts.
5. Use a disposable, trusted Node.js project for the first task. Verify dispatch, an actual file change, a meaningful test result, coordinator review and final human acceptance. Model compatibility and entitlements belong to your chosen provider.

Workers receive a short-lived Broker manifest/token and a loopback model-forwarding address. API keys stay in the host. Environment overrides `LUMA_PI_MODEL_BASE_URL`, `LUMA_PI_MODEL_API_KEY` and `LUMA_PI_MODEL_NAME` are optional owner-controlled host configuration; member Profiles are the normal route. Never commit real values.

## Tools and boundaries

| Tool | Permitted operation |
| --- | --- |
| `read` | Read an allowed regular file under the approved workspace; protected paths and credential files are blocked. |
| `write` | Create a new file atomically without overwriting an existing file; create permitted parent directories. |
| `edit` | Apply exact, unambiguous text replacements and preserve other content. |
| `run` | Structured `node_file`, `node_test` or declared `npm_script` actions, with bounded output, timeout and cancellation. |

Only an authoritative `work` packet with a matching workspace enables write/edit/run. Chat and mismatched/missing authorization remain read-only. Built-in general shell tools are not enabled. A test run with no passing tests is not reported as a successful test.

Project processes use a cleaned environment. On Windows cancellation stops the owned process tree. The runtime can run Node actions through Electron's Node mode when necessary; npm-script actions additionally require a usable Node/npm installation on the host.

These controls constrain tool entry points and authorized paths. Project code still runs with the host OS user's privileges: this is **not an OS sandbox**. Use trusted projects or add your own OS/container isolation for untrusted code. Do not disable scope checks to make a project run.

## Plan, review and final acceptance

`draft plan → human approval → dependency dispatch → worker submission → coordinator review → pending user acceptance → human completion`

Creating a ticket or updating a draft does not start execution. The Broker tracks plan versions, revision rounds and attempts. Repeated scheduling does not duplicate work; partial revisions preserve unaffected work. Changed scope can require renewed plan approval.

Worker reports remain in backend event/report channels, without turning internal progress into ordinary group-chat messages. The coordinator inspects submitted artifacts and checks, and can reject the exact report for repair. Internal acceptance is distinct from final human acceptance; coordinator/model tokens cannot approve the plan or complete the project on the user's behalf.

Collaborative projects hand off to the coordinator's direct conversation for final human review. Ordinary legacy tickets retain their original direct-conversation return route. Restart recovery waits for writable renderer authority; a saved `rep_pub_<ticketId>` message with `status: sent` is delivery evidence. Failed notice persistence remains recoverable and must not mark the notice as delivered.

## Checks and packaging

```sh
npm run test:pi
npm run test:workflow
```

These checks use temporary projects, controlled executors and synthetic model endpoints. They cover the Pi SDK tool loop, read/write/edit/run, credential isolation, cancellation, approval gates, review, revision and restart handoff. They do not consume a real model account or prove compatibility with every provider.

The Windows distribution includes the Pi connector and its runtime dependencies under `resources/connectors/pi/`. Keep the complete extracted runtime directory together. Source archives omit installed dependencies; `npm run setup` restores them from lockfiles. See [Verification](VERIFICATION.md) for the exact tested release boundaries.
