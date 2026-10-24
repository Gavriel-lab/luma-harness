# Luma Harness v0.2.0 — Embedded Pi and acceptance workflow

The public desktop/mobile Harness now includes Pi execution and the collaboration approval/review/handoff improvements, with generic configurable members and owner-supplied providers.

- Embedded Pi SDK worker: scoped read, atomic new-file creation, exact edits, and structured Node file/test/npm-script execution.
- Per-member model Profile and credential forwarding; no cross-member fallback.
- Human-approved plans, dependency dispatch, backend coordinator review, partial revision preserving unaffected work, and final human acceptance.
- Restart recovery waits for writable authority; delivery is deduplicated against saved sent notifications.
- Ordinary legacy tickets retain their original direct-conversation return route. Collaborative project acceptance notices use the coordinator direct conversation.
- Updated English/Chinese READMEs, Pi setup, architecture and verification boundaries.
- Pi SDK 1.4.0; Undici 8.12.2 for the embedded connector and desktop transport.

Validation: 151 tests and 24 scenario checks pass; both frontend builds, mobile type checking and Windows packaging pass. The actual EXE passes synthetic cross-client reply/persistence checks and all 12 Pi bridge checks using the packaged connector and dependencies. These use controlled providers/executors, not a real model account. See `docs/VERIFICATION.md`.

Download:

- `luma-harness-windows-x64-v0.2.0.zip`: extract the complete directory and run `Luma Harness.exe`.
- `luma-harness-source-v0.2.0.zip`: source, lockfiles and bilingual documentation; run `npm run setup` to install dependencies.
- `luma-oil-painting-v0.2.0.zip`: optional matching-version appearance source/assets. Apply to source and rebuild using `docs/THEMES.md`.
- `SHA256SUMS.txt`: archive checksums.

Existing installations: stop the host and back up the complete data directory and external CLI state before replacing program files. Supply your own model configuration, authorized workspace and CLI login where applicable. Pi uses the member's API Profile; CLI subscription integrations remain separate. Node/npm is needed for npm-script execution.

Physical phones, provider entitlements, Linux/VPS combinations and custom memory plugins need recipient-specific setup and acceptance. Project code runs with host OS privileges; scoped tools are not an OS sandbox. MIT applies to Luma's own code and original appearance materials; preserve third-party notices.
