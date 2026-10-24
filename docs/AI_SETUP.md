# Reproduce Luma with an AI coding agent

Give the AI this repository and this document. It should inspect actual source and tests, not invent services or reconstruct private settings.

## Goal

Start a neutral desktop host, connect the mobile UI to that same authority, configure the owner's chosen models/CLI workers, and prove an authorized work request can be dispatched, executed, reviewed and returned to the original conversation. Team size and names are owner choices.

## Recommended sequence

1. Read `AGENTS.md`, `README.md`, `ARCHITECTURE.md` and `PROVIDERS.md`.
2. Confirm Node.js 24 and run `npm run setup`. Do not copy another installation's credentials, auth cache, chat history or private Git history.
3. Run `npm test`, `npm --prefix apps/mobile run lint`, `npm run build`. Keep failures distinct from environmental limitations; do not weaken tests to hide them.
4. Start with a new private data directory. Verify blank initial state and local mobile pairing. The desktop “手机页面预览” button opens the correct local authenticated URL.
5. Ask the owner which provider/login and working directory to use. The generic examples are configuration shapes, not real accounts or guaranteed model entitlements. Store real keys through the host's OS-protected credential flow.
6. Configure `agent_coordinator` if coordinator tools are needed, and any chosen number of workers. Native CLI chat routing and work registration are separate settings. Select an actual existing workspace and verify its sandbox/tool policy.
7. Use a disposable workspace and a real tiny task: create a bounded ticket, dispatch once, verify an actual output file and meaningful check, reject an incorrect report once, then inspect and accept the corrected attempt. Confirm only the originating conversation receives the final report.
   For the embedded Pi route, follow `PI.md`, bind that member's own API Profile, and register Pi with an approved workspace. Collaborative plans require the owner's approval before dispatch and the owner's final acceptance after coordinator review. Their acceptance notice goes to the coordinator direct conversation; ordinary legacy tickets retain their original direct-conversation return route.
8. For an actual phone, configure the owner's Cloudflare gateway, Access identity and relay secret according to `DEPLOYMENT.md`. Test authenticated success and anonymous rejection. Keep the authority online.
9. For VPS, reuse the same authority under Xvfb and a dedicated OS account. Verify that OS/runtime/CLI combination; do not call a systemd template an accepted deployment.
10. Optional memory or oil painting appearance comes last. Neither is required for the core work Harness. Do not add a second scheduler or a concurrent JSON writer.

## Acceptance evidence

- Correct runtime/data directory and no private records in the repository or release.
- Both clients show the runtime-configured roster and the same saved conversation.
- API request and response or actual CLI execution is observed, rather than filled in by a mock in a real chat.
- Duplicate request does not duplicate execution.
- Worker output exists inside the approved workspace; report contains checks and unknowns.
- Submission remains review until acceptance; rejection preserves evidence and uses a distinct subsequent attempt.
- Accepted result is delivered once to the actual originating conversation.
- Stopping/restarting retains saved messages and does not replay an ambiguous work attempt.

The published smoke test uses a **synthetic local HTTP provider** to validate UI/transport/persistence without real model charges. It is not evidence for a real third-party login or for model reasoning. Public Broker tests use controlled executors and real artifact files. Complete an owner-specific tiny work task before treating a new provider or VPS as accepted.

## Avoid common detours

- Do not hardcode an example team size or rewrite membership around a screenshot.
- Do not treat a ChatGPT subscription as an OpenAI-compatible API key.
- Do not add secrets to `VITE_*` or bypass Access JWT checks to fix deployment.
- Do not replace an offline authority with a pretend cloud reply.
- Do not silently combine member sessions, memories or workspaces.
- Do not rebuild the Broker merely to support a new provider; extend its adapter seam.
