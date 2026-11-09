---
title: Private OAuth Live Case Testing
docType: runbook
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - when an explicitly authorized private account must qualify a real CLI or Foundry case
whenToUpdate:
  - when the private driver, credential boundary, or installed-consumer evidence changes
checkPaths:
  - scripts/live/**
  - test/live-oauth-harness.test.ts
  - package.json
  - test/toolchain-contract.test.mjs
lastReviewedAt: 2026-11-09
lastReviewedCommit: cafb56cfdae7d5c7b03605f4fc706390cb609be0
lastReviewedNote: 'CLI #468: reviewed removal of unreferenced workflows, obsolete wrappers/config/examples and stale documentation; current algorithms, security, specialized protocols, public exports and publication identity remain governed.'
related:
  - repo-validation.md
  - repo-architecture.md
  - ../../AGENTS.md
---

# Private OAuth live cases

This driver is maintainer tooling for an explicitly authorized account. The public CLI continues to accept only OAuth login or the existing explicit headless token configuration. It has no password CLI surface. `playwright@1.62.1` is a pinned development dependency compatible with the repository's Node 24 baseline; neither Playwright nor `scripts/live/` ships in the runtime package.

## Preparation

Run `pnpm exec playwright install chromium` in the CLI checkout. Install the exact candidate or explicitly selected published `@tiangong-lca/cli` version in a separate temporary consumer using pnpm, and verify its source/package identity and lock integrity. Do not pass a source checkout as the installed-consumer proof.

Prepare a private local environment file containing exactly one nonempty `TIANGONG_LCA_USERNAME` and `TIANGONG_LCA_PASSWORD`. The file must be absolute, regular, not a symlink, and current-user-readable only on POSIX. The driver reads only those two values in memory; it does not source the file or inherit its other keys. The account owner must have explicitly authorized the case.

Choose a new absolute case directory outside every Git checkout. The driver refuses an existing directory and creates private `0700` state with `0600` files. Keep the parent directory under your control. The current live-account qualification lane is macOS arm64; public platform CI runs credential-free regression tests. Windows live use requires separate private ACL qualification and is not enabled by this driver.

```sh
pnpm live:oauth --credentials-file /absolute/private/account.env --case-dir /absolute/private/new-case --installed-cli /absolute/private/consumer/node_modules/@tiangong-lca/cli/bin/tiangong-lca.js
```

The official public Production runtime comes from the CLI's existing profile. The reviewed browser login origin is `https://lca.tiangong.earth`; the driver checks it before each credential fill and consent. It uses a fresh browser context and the actual OAuth PKCE, loopback callback, token exchange and userinfo implementations. No fake callbacks, tokens or identity receipts are injected.

## Evidence and limits

The first server-verified session email must match the selected username in memory. Source identity establishes the verified user ID; the installed CLI then receives both expected project and user ID and must return an intent-bound identity receipt. The CLI subprocess receives the isolated session path, never username/password values. This proves source-level browser OAuth and published-package read-only session consumption separately; it does not claim that the published binary itself opened the test browser.

`context.json`, `session.json`, `source-identity.json` and `installed-identity.json` remain private. Only `result.json` and the stdout projection contain the generated case ID, fixed stage and pass/fail status. The driver never prints caught errors, subprocess output, authorization URLs, PKCE values, full email, tokens or cookies. Browser trace, HAR, screenshots, videos and storage-state exports are disabled. Do not turn on protocol debugging or upload the private directory to CI.

This driver reads identity only and does not mutate business data. OAuth login itself creates or reuses the selected application's authorization grant. A retained session supports subsequent separately scoped cases; local session removal does not revoke that grant. For full revocation use the existing Connected applications UI.

Missing credentials, browser dependencies, CAPTCHA/MFA, rejected login, network failure or a timeout are environment/service evidence, never a product RED. Preserve a genuine failing product case before its implementation change, then rerun the same case after the fix and after refactoring. Record private evidence locations locally and publish only redacted conclusions in the tracked task. Workspace #980 owns the later Foundry boundary RED/GREEN, business draft and no-replay cases.

## Owner-draft LifecycleModel bundle qualification

The read-only `live:oauth` driver remains unchanged. A Production LifecycleModel write qualification is a separate, explicitly authorized maintainer case using its isolated OAuth session and a new private case directory outside Git. The operator must supply a disposable, schema-valid canonical LifecycleModel fixture whose identity is reserved for that case; neither the fixture nor its identifiers may enter a public Issue, PR, command log, or repository file.

Before any dataset mutation, verify that the JWT client matches the bundled official Production profile and that the audited OAuth client configuration retains exactly the approved capability class: `CLI-RPC-01`, `DB-CORE-READ-01`, `DB-CORE-WRITE-01`, `NX-CORE-02`, and `EDGE-BUNDLE-01`. Environment client IDs and before/after registry evidence remain private deployment evidence, never checked-in configuration. Capability correction is owned by `database-engine`: an idempotent migration must preserve the client kind and enabled state, add only the missing capability, and verify one corresponding audit delta; merging its PR is the deployment path, and manual Production SQL is not part of this qualification.

The case order is fixed:

1. Confirm the fixture identity is absent from the authenticated user's visible scope.
2. Run `lifecyclemodel save-draft --commit` to create it, then read back the exact ID/version, current user, `state_code=0`, and canonical payload.
3. Change one harmless fixture-owned payload field, run the same command to update it, and repeat exact owner/state/payload readback.
4. Delete the fixture only through the authorized actor-bound bundle path and verify exact absence.

Do not retry an ambiguous mutation. Preserve the private action/readback evidence locally and publish only fixed `create_passed`, `update_passed`, `cleanup_passed`, and overall status fields. If cleanup cannot be proven, record a blocker and the private recovery location; never claim a passed disposable case with residual data.

## Public verification

`node --import tsx --test test/live-oauth-harness.test.ts` checks credential file safety, exact origin enforcement, checkout isolation and output projection with synthetic inputs. The ordinary full CLI gate retains 100% source coverage and validates packed-consumer boundaries. Browser cleanup regression cases also prove browser closure when context creation, case execution or context teardown fails. Public CI never invokes `live:oauth`, downloads a browser for it, or receives personal account secrets.
