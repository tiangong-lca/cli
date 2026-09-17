---
title: cli Architecture Notes
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: en
whenToUse:
  - when you need a compact mental model of the CLI before editing command routing, helper modules, or release gates
  - when deciding which file family owns a behavior change
  - when launcher, session, review, publish, or artifact hotspots are mentioned without exact paths
whenToUpdate:
  - when major repo paths or command families change
  - when session or artifact architecture moves
  - when coverage or release gating becomes materially different
checkPaths:
  - docs/agents/repo-architecture.md
  - .docpact/config.yaml
  - .gitignore
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - .oxlintrc.json
  - bin/**
  - src/**
  - test/**
  - scripts/**
  - .githooks/pre-push
  - scripts/docpact
  - scripts/docpact-gate.sh
  - scripts/install-git-hooks.sh
lastReviewedAt: 2026-09-16
lastReviewedCommit: 0a9b328187df104d3cec445de51168d472aa88b3
lastReviewedNote: 'Reviewed for CLI #332: W6b replaces only the bundled schema bytes through an explicit tidas-spec source gate and records source identity metadata; CLI command, SDK/fallback and runtime architecture remain unchanged.'
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-validation.md
  - ../../README.md
  - ../../DEV_CN.md
---

Review note, 2026-09-17: W6b keeps the retained CLI `assets/tidas-schemas` path but synchronizes its bytes to exact `tidas-spec` candidate `6fb497bad562125ccc0c00a803351207b9ed438f`; the source identity file is package evidence only and adds no command or runtime architecture.

The `src/runtime.ts` public facade and bounded `src/lib/runtime/**` owners expose package/Node/asset identity through one read-only API and `runtime describe`. [The runtime distribution contract](runtime-distribution-contract.md) separates this package observation from complete component/dependency provenance, host ABI readiness and task authorization. `src/main.ts` admits supported architecture tuples before loading user configuration and bypasses dotenv for runtime commands. The manifest/manager/cache/lease/exec owners are now implemented under #274; the no-Node POSIX/PowerShell bootstrap is implemented under `scripts/bootstrap/`; #275 designates 0.1.10 as C1, while public product component assembly remains downstream.

The managed-host extension in issue #278 keeps launch selection in the generic CLI manager. Dedicated protocol/server/receiver modules hand the exact verified manifest to a declared Node host through a one-use IPC handshake. Original manifest bytes, selected host fields and application argv are owned snapshots; the receiver uses the existing cache/compatibility owners and shared work-directory guards. Product hosts retain their own task, account and business authorization. Cancellation ends handshake admission before child termination, and execution leases remain until output/process closure. No Foundry dependency, new credential store or alternative trust anchor is added.

## Repo Shape

This repo is organized around one stable launcher plus a library-style `src/lib/**` tree that implements command families and shared helpers.

Review note, 2026-08-25: Issue #224 makes the toolchain architecture explicit: the root `pnpm-workspace.yaml` and sole `pnpm-lock.yaml` own dependency resolution; TypeScript 7.0.2 is the only compiler line; type-aware Oxlint replaces ESLint and Compiler API linting; and Node 24 is shared by local and CI gates. The feature stays on 0.0.33, with a separate 0.1.0 release-only PR recommended after merge to make the maintainer/release compatibility boundary explicit.

Review note, 2026-08-25: the SDK 0.2 cutover makes build-plan taxonomy an explicit input rather than fabricated output. Plan-only materialization accepts canonical locked taxonomy objects only, selects product/process `common:classification` versus elementary `common:elementaryFlowCategorization` by flow type, and fails before artifact publication when classification is absent or malformed.

Review note, 2026-08-25: Issue #226 advances the package compatibility boundary to 0.1.0 without changing runtime files, dependencies, package-root exports, command families, or release workflows. The validation architecture extends `test:package` only: a clean tarball must work through `.bin`, an ESM host importing the existing explicit bin launcher subpath, and a CJS host dynamically importing that same ESM subpath; package-root module imports remain intentionally unsupported.

Review note, 2026-08-25: Issue #228 adds `src/lib/auth-identity-receipt.ts` as a narrow read-only identity adapter. It reuses the existing API-key/session cache chain but never serializes that session object: exact project intent is safely checked before credential/session work, a redirect-disabled and incrementally bounded `/auth/v1/user` response supplies a canonical live user UUID, one 401/403 may force refresh and replay the read, timeout values stay within Node's supported timer range, and an exact-key parser hashes only a public safe projection. The pnpm case command itself owns the single clean TS7 build before starting a plain-Node parent; that runner single-reads/hash-binds source/config/lock and freshly generated runtime/runner bytes, privately snapshots the exact built buffers, cleans the snapshot before evidence publication, and only then exposes passed/failed artifacts. This is local evidence, not a server-signed attestation or a dataset mutation runtime.

Review note, 2026-08-25: Issue #230 advances the package compatibility identity to 0.1.1 after merged PR #229 without changing runtime logic, published dependencies, package-root exports, command families, auth/session boundaries, or build output. The local/CI/package-engine architecture is exact Node 24.19.0. Exact `sigstore@5.0.0` is dev-only and owns cryptographic DSSE/Fulcio/CT/Rekor verification. `quality-gate.yml` is manually dispatchable and reusable with exact platform/architecture assertions; `tag-release-from-merge.yml` detects under the same exact Node version and depends on all four platforms; and the non-published verifier also checks registry signatures, tarball bytes, isolated user/global config, exact pnpm, all production dependency sections, and credential-free consumers.

Review note, 2026-08-26: Issue #232 adds two provider-neutral public primitives without adding a dependency or changing package version 0.1.1. `src/command-spec.ts` is byte-compatible with the existing Foundry v1 authority, cleans external abort listeners even when an injected spawn adapter throws synchronously, and rejects timeouts outside Node's timer range. `src/batch.ts` owns run/item identity/content/policy contracts, complete projection preflight, guarded claim-time identity drift events, resource-aware bounded scheduling, per-result resume-stop decisions, mutation no-auto-retry, explicit readback recovery, and host-aware run-directory locking. A throwing identity getter becomes a zero-attempt item failure while other in-flight workers drain. A worker infrastructure error records the first fatal cause and closes claims before the scheduler lock releases when applicable; settled aggregation drains already-claimed workers and only then rejects. A blocked key remains unclaimed so it cannot consume a worker or evade a later stop; another free key may claim. Per-resource FIFO cursors expose only their head through a private binary minimum-ready heap, avoiding quadratic pending scans and exposing a same-key successor only after completion/rejection stop evaluation. Run-lock ownership metadata is derived internally rather than accepted from a public caller, and all timer-backed public inputs fail closed before Node can clamp them. The dataset execution-contract parallel suffix now uses this scheduler while its serial prefix and action-level durability remain unchanged.

Review note, 2026-08-26: Issue #233 turns `src/batch.ts` into a stable 62-line facade without changing any public object. Eight modules under `src/lib/batch/` form an explicit DAG: `types` and `errors`; `canonical-contracts`; `run-lock` and `scheduler-runtime`; `item-projection` and `attempt-recovery`; then `engine`. The facade re-exports the owning runtime objects, so cross-import class identity and `instanceof` remain stable. `test/fixtures/public-batch-module-budgets.json` plus `test/public-batch-architecture.test.mjs` fix exact module inventory, semantic names, per-file shrink-only ceilings, allowed internal edges, forbidden upward imports, zero SCCs, declaration/runtime names, and byte-level characterization. Current ceilings are 62 lines for the facade and 445 lines for the largest internal module, below the 400/800 targets.

Review note, 2026-08-26: Issue #236 changes only the exact package-manager compatibility pin to pnpm 11.24.0. The root workspace/lock architecture, Node 24.19.0 and TypeScript 7.0.2 single tracks, package version 0.1.1, dependency graph, public subpaths and object identities, command runtime, tag workflow, and native pnpm Trusted Publishing path remain unchanged; pnpm 11.24.0 requires no lockfile byte update for the existing graph.

Review note, 2026-08-26: Issue #237 advances the package compatibility identity to 0.1.2 for the already merged bounded batch/CommandSpec implementation and pnpm 11.24 toolchain. Only `package.json` and the four live CLI-version fixtures change; the facade/internal DAG, runtime objects, generated declarations, package exports, dependencies, lock bytes, tag workflow, Trusted Publishing, provenance verification, and workspace integration architecture remain unchanged.

Review note, 2026-08-29: Issue #240 adds a third typed public subpath, `src/auth-identity-receipt.ts`, as a direct bounded re-export over the existing auth receipt semantic owner. Package-root/internal paths remain closed, declarations stay generated from source, and no session, network, credential, dependency, or release architecture changes.

Review note, 2026-08-29: Issue #242 advances only the package compatibility identity to 0.1.3 for that already merged public parser. The facade/internal DAG, generated declarations, strict export map, dependencies, pnpm lock bytes, command runtime, tag workflow, native Trusted Publishing, provenance verifier, and exact workspace integration architecture do not change.

Review note, 2026-08-31: Issue #247 keeps `src/lib/state-lock.ts` as the single session/artifact lock owner while removing its existence/read TOCTOU. Metadata is read once; `ENOENT` is the expected concurrent-release state, and all other read errors propagate. Lock creation, metadata schema, stale-owner recovery, same-process reentrancy, physical cleanup, and every consuming command/session architecture stay unchanged.

Review note, 2026-08-31: Issue #246 advances only the package compatibility identity to 0.1.4 for the already merged OAuth command/session runtime. The remote-session modules, generated declarations, strict export map, dependencies, pnpm lock bytes, command runtime, tag workflow, native Trusted Publishing, provenance verifier, and exact workspace integration architecture do not change.

Review note, 2026-08-31: Issue #250 keeps `src/lib/supabase-session.ts` as the single session-cache owner and adds no adapter or auth path. Its two private read/write helpers retain `process.platform` by default; tests may inject `linux`/`win32` to execute permission branches independent of the runner host. POSIX `0700`/`0600`, Windows parent-ACL guidance, atomic rename, runtime calls, and session schema remain unchanged.

Review note, 2026-08-31: Issue #252 advances only package compatibility identity to 0.1.5. The OAuth/session/state-lock runtime, platform injection, generated declarations, strict exports, dependencies, pnpm lock bytes, command architecture, tag workflow, Trusted Publishing, provenance, and workspace integration architecture do not change.

Review note, 2026-08-31: Issue #256 keeps package identity 0.1.5 and all command/export/OAuth/session architecture while updating Supabase JS to 2.112.4 and development tools to their Node 24-compatible stable releases. TIDAS SDK is pinned exactly to npm-latest 0.2.0, Node types stay on latest 24.x, peer validation becomes part of pre-push, and Prettier 3.9 formatting is isolated from dependency bytes. The later 0.1.6 release remains separately owned by Issue #257.

Review note, 2026-08-31: Issue #257 advances only package compatibility identity to 0.1.6. The merged command/runtime, OAuth/session/state-lock modules, generated declarations, strict exports, exact dependencies, pnpm lock bytes, tag workflow, Trusted Publishing, provenance verifier, and workspace integration architecture do not change.

Review note, 2026-06-04: Foundry entity queue state now stays in the native CLI command family as `dataset curation-queue build/next/verify`; no secondary orchestration runtime was introduced.

Review note, 2026-06-05: release 0.0.12 is a package metadata bump only; no command-family ownership, launcher, session, artifact, or release architecture paths changed.

Historical npm-era review note, 2026-06-06: release 0.0.13 kept the then-current release architecture unchanged: maintainers opened a version-bump PR, updated `package.json` and `package-lock.json`, merged to upstream `main`, and let GitHub Actions create the tag and publish through npm Trusted Publishing. Local `npm publish` was not part of that release architecture. This note is retained as history, not current guidance.

Review note, 2026-06-07: release 0.0.14 keeps the architecture in the existing TypeScript dataset classification command family. The location apply helper now creates only explicit schema-derived missing location targets and does not introduce a new orchestration layer or release path.

Review note, 2026-06-11: release 0.0.15 keeps the import-lca wrapper inside the existing TypeScript dataset command family. Only the tidas-tools spawn argument construction and report file derivation changed to match tidas-tools 0.0.28; no new orchestration layer or release path.

Review note, 2026-08-20: Issue #222 keeps `src/lib/dataset-import-lca.ts` as a thin process adapter over unified Rust `tidas import`. The adapter owns only platform/binary/config discovery, `0.2.x` plus operation-report handshake, native flag translation, and exit/report validation. Rust owns format semantics, bounded runtime, cancellation, validation, spool artifacts, and atomic output publication. The npm package carries a cross-platform text fixture, not native executables.

Review note, 2026-07-30: Issue #214 keeps identity search and derivative verification in their existing modules while narrowing their contracts. Remote identity requests expose one `lexical_weight`, and derivative snapshots/readback bind `extracted_md`, `embedding_ft`, and `embedding_ft_at`; no alternate adapter, write path, or artifact family is introduced.

Review note, 2026-08-07: database-engine Issue #422 makes `api-contract-v1` the default and only supported Data API profile at database commit `0a97cc761f8127ca379ab7d4df4395dab255707a` / migration head `20260807103000`. Core relation clients still explicitly select `public`; all 16 authenticated RPCs use exact `api` signatures and method-appropriate profile headers. The retired private whole-plan alias executor is absent from the transport manifest and fails locally; `run-protected` remains the only production alias path through the frozen preflight/gate/admit/read façades. Consumer-zero scanning, role boundaries, and replay classification remain centralized here.

Review note, 2026-07-11: row-level dataset maintenance is implemented in the native CLI as `dataset maintenance plan/apply/verify`. The architecture keeps scope freezing, current-user RLS reads, protected-row classification, approved platform-command writes, append-only action logging, and independent verification in separate maintenance modules.

Review note, 2026-07-12: `merge-support-aliases` is one fixed BAFU owner-draft transformation inside the maintenance boundary. Scope and plan require `target_mode=owner_draft`; planning freezes exact current-owner state-0 source/target support and exchange closure; apply sends ordered `time` and `length_time` batches in one `target_visibility=owner_draft` whole-plan guarded RPC; verify re-reads private state and validates the mode-bound plan/batch/row/exchange proof chain. Publication is a separate future workflow.

Review note, 2026-07-13: account-wide maintenance reads now share one exact-count paginator. Requested page size is not treated as the server's effective page size; actual returned lengths advance offsets, exact `Content-Range` totals and strict row identities prove pagination completeness under stable filtered membership/order, and incomplete scans fail before artifacts or writes. The aggregate proof describes a multi-request traversal, not transaction-level/MVCC snapshot isolation.

Review note, 2026-07-14: `rebuild-derivatives` stays inside the native dataset-maintenance family as a derivative-only asynchronous profile. V1 freezes exactly one current-owner state-0 process action and its action-scoped database snapshot, admits work only through an owner-draft guarded RPC, and separates `accepted`/`queued` apply proof from terminal `pending`/`passed`/`failed` verification. No Edge/admin/raw queue/SQL/REST mutation fallback was added.

Review note, 2026-07-15: `run-protected` remains in the native dataset-maintenance family and adds no second orchestration runtime. The command separates sealed request parsing, one-shot execution/recovery, and terminal independent verification into dedicated modules; it is production-only, admits at most once, and requires exact 23-flow + 27-process derivative closure without adding a Dev data replay or legacy-RPC fallback.

Review note, 2026-07-15: Issue #171 adds two preparation commands without broadening the mutation surface. `freeze-protected` owns production-authenticated read-only census/support/derivative capture and canonical unapproved artifacts; `seal-protected-approval` owns byte-exact offline human-approval recording and receives no session, environment, or network client. Only the existing `run-protected` module owns preflight, admission, execution, or recovery. Foundry remains a thin published-CLI caller and must not duplicate canonical hashing or database access.

Review note, 2026-07-16: Issue #157 keeps Step 3 in a dedicated native TypeScript workflow: `dataset-maintenance-flow-identity-{capture,contract,plan,execution-contract,freeze,seal,run,verify}.ts`. It does not reuse generic apply or the Step 2 runner. Capture scans the full owner-draft process table once but persists only the reviewed reference closure, then submits one thin semantic request for an immutable database receipt. The database receipt/ledger, not a later client payload or client-side derivative baseline, owns each exact rewrite. Guarded process calls contain only ordinal, scope proof, process-intent proof, and request hash. Durable database scope state is the resume authority and execution concurrency is one. After primary completion the runner polls scope read-only until a derivative decision: pending/failed/compensation returns without finalize; exact causal/current readiness permits at most one finalize POST in that invocation; an ambiguous process/finalize response or readiness race never triggers an automatic retry. Independent verification re-scans the complete owner-draft process table and exact stable rows before declaring terminal success.

Review note, 2026-07-17: Issue #157 COMMON hardening stays in the existing capture/contract/remote/run/verify modules. Capture binds two separate passed Issue #29 derivative readbacks, and the remote adapter preserves HTTP-success `ok:false` envelopes as deterministic domain rejections. The write path now carries a database-minted one-wrapper permit that rotates after every successful process/finalize write and never enters durable artifacts; the database is the cross-machine authority, while a fixed create-only local approval claim is defense in depth. Losing the permit or initial preflight response requires a fresh exact recovery approval; an exact read-only lookup can recover only the same actor-owned immutable scope. Remaining gates are merge, Preview validation, and coordinated DB/CLI release.

Review note, 2026-07-16: Issue #175 remains inside `protected-contract` parsing and tests. The client accepts at most five seconds of server-ahead skew for `completed_at`, but does not extend token expiry or the 180-second duration; the database still owns authoritative server-clock gate/admission expiry and one-shot uniqueness. No new runtime, adapter, dependency, artifact family, or database behavior is introduced.

Review note, 2026-07-16: Issue #177 modifies only `test/**` portability assumptions. Native path helpers, a guaranteed-missing temporary executable for the default-spawn failure path, an injected successful spawn, and platform-appropriate permission assertions preserve the existing launcher, artifact, protected-maintenance, dependency, and release architecture.

Review note, 2026-07-16: Issue #178 changes the package version to 0.0.27 and updates the one package-version dispatch fixture. No command family, launcher, session, artifact, protected-maintenance, dependency, tag, publication, or workspace-integration architecture changes.

Review note, 2026-07-16: Issue #182 remains entirely inside `dataset-maintenance-protected-verify`. It replaces one invalid cross-serialization equality with an exact three-part proof bridge: CLI-canonical RLS row to approved plan, PostgreSQL-domain primary action evidence to fresh derivative snapshot, and snapshot SHA to terminal completion proof. It adds no runtime, adapter, artifact schema, RPC, database, dependency, or command surface.

Review note, 2026-07-16: Issue #184 changes the package version to 0.0.28 and updates the one live package-version dispatch fixture. No command family, launcher, session, artifact, protected-maintenance, dependency, tag, publication, or workspace-integration architecture changes.

Review note, 2026-07-16: Issue #186 introduces `src/lib/lca-release.ts` as the CLI transport boundary for LCI/LCIA data releases. The standalone release repository owns the 20-stage workflow and canonical plan construction; Edge and Database own authorization/state transitions. The CLI uses the shared actor session, verifies the exact four-ZIP set before signed upload, derives the publish credential fingerprint locally, and verifies durable byte size/SHA-256 before exposing downloaded bundle or release artifacts.

Review note, 2026-07-17: Issue #191 changes only platform-specific assertions in `test/lca-release.test.ts`. The LCI/LCIA transport, artifact writer, command surface, filesystem architecture, and release workflow remain unchanged; POSIX mode and chmod failure semantics continue to be tested on platforms that implement them.

Review note, 2026-07-17: Issue #189 changes the CLI package version to 0.0.29 and updates the four live CLI-version fixtures. No command family, launcher, session, artifact, dependency, authorization, tag, publication, or workspace-integration architecture changes.

Review note, 2026-07-23: Issue #194 keeps ordered owner-draft execution inside `src/lib/dataset-save-draft-run.ts`. `src/cli.ts` owns the opt-in flag and all-success exit code; the runtime owns contract/session/before-state binding, stable per-owner/project action ledgers, dependency scheduling, exact owner readback, and no-replay recovery. It reuses the current platform dataset command transport and adds no new auth, direct-table, service-role, publication, delete, state/schema, or release architecture.

Review note, 2026-07-23: Issue #196 changes the CLI package version to 0.0.30, updates the four live CLI-version fixtures, and makes execution-ledger durability portable by fsyncing the active write descriptor rather than reopening the ledger read-only. No command family, launcher, session, artifact shape, dependency, authorization, tag, publication, or workspace-integration architecture changes.

Review note, 2026-07-23: Issue #198 changes the package version to 0.0.31 and confines SDK schema/entity mutation to a validation clone. The original dataset save-draft payload remains the single source for contract hashing, protected command dispatch, and exact owner readback. No command family, session, artifact schema, dependency, authorization, publication, or integration architecture changes.

Review note, 2026-07-24: Issue #200 releases 0.0.32 and extends the existing execution-contract scheduler without adding a second write path. The scheduler derives one serial prefix ending at the highest action referenced by any dependency, verifies that the remaining suffix has unique table/id/version targets, and runs that suffix with explicit concurrency 1..8. Each action still owns its independent protected transaction and ledger file. The existing session runtime supplies a current token immediately before dispatch, and the runner rejects any renewed user/email mismatch before attempt consumption.

Review note, 2026-07-24: Issue #202 releases 0.0.33 and extends only ordinary dataset-maintenance apply. Explicit bounded mode is restricted to flow delete-only plans, reuses owner-session RLS reads and `cmd_dataset_delete`, adds a complete all-visible-process inbound barrier, and records append-only action dispatch/outcome events beside the immutable plan. It adds no RPC, schema, dependency, service-role, direct-table, publication, or cross-owner architecture.

Review note, 2026-07-24: Issue #204 keeps the same all-visible-process inbound barrier but requests it in exact-count pages of at most 250 rows. The query still has no `user_id` predicate, and an incomplete scan still prevents approval or dispatch; only the per-request payload size changes.

Review note, 2026-07-25: Issue #206 keeps the same barrier and exact-count paginator but uses only the globally unique `(id, version)` primary-key order. The database can now satisfy stable pagination through its existing index without a redundant owner/state sort; visibility, filtering, mutation, authorization, and fail-closed semantics do not change.

Review note, 2026-07-25: Issue #208 adds only an admission artifact path: an external all-process SELECT-only zero-inbound proof whose bytes, freshness, project, actor, plan, ordered targets, and chunks are validated before any approval or dispatch. The CLI neither executes SQL nor adds a credential or mutation path; default RLS scanning, protected owner-session delete RPCs, append-only ledgers, and exact readback remain the runtime architecture.

## Stable Path Map

| Path group | Role |
| --- | --- |
| `bin/tiangong-lca.js` | stable launcher entrypoint exposed as the public `tiangong-lca` executable |
| `src/main.ts` | process entry, dotenv loading, stdout and stderr wiring |
| `src/cli.ts` | top-level command dispatch, parsing, and help routing |
| `src/auth-identity-receipt.ts` | supported offline parser/constants/types package subpath for safe identity receipts |
| `src/command-spec.ts` | supported content-bound CommandSpec package subpath |
| `src/runtime.ts` | supported installed CLI/Node/asset inspection and exact expectation API |
| `src/lib/runtime/**` | bounded runtime descriptor, file integrity and distribution command owners |
| `src/batch.ts` | stable re-export facade for the supported batch package subpath |
| `src/lib/batch/**` | bounded acyclic owners for batch types, contracts/errors, run locks, projection, scheduler runtime, attempts/recovery, and engine coordination |
| `src/lib/oauth-pkce.ts` | strict Supabase public-client authorize/token/refresh/UserInfo protocol with S256 PKCE and bounded responses |
| `src/lib/oauth-loopback.ts` | exact literal-loopback callback, state/code validation, and shell-free platform browser launch |
| `src/lib/**` | command-family implementations plus shared auth, IO, artifact, and remote helpers |
| `test/**` | unit and launcher tests that back the coverage gate |
| `scripts/assert-full-coverage.ts` | strict coverage enforcement |
| `scripts/ci/**` | release-tag and package publication checks |

## Current Architectural Clusters

### Launcher and entry contract

The public `tiangong-lca` surface starts in:

- `bin/tiangong-lca.js`
- `src/main.ts`
- `src/cli.ts`

If a task changes help output, exit behavior, or how subcommands are registered, start here.

### Typed public primitives

The package root remains intentionally unsupported. Four explicit module subpaths are owned here:

- `@tiangong-lca/cli/runtime` owns package/Node observations and exact expectation checks. The public facade describes its own source/emitted package through bounded file owners; it does not confer component provenance, task permission or data completion.
- `@tiangong-lca/cli/auth-identity-receipt` directly re-exports the exact safe-projection parser, schema/timeout constants, and receipt types from the existing auth owner. It exposes no fresh-session/network runner or test internals; internal `dist/src/lib/**` remains unreachable through package exports.
- `@tiangong-lca/cli/command-spec` preserves `tiangong-foundry.command-spec.v1` exact keys and canonical authority over executable, argv, and artifact bindings. `display` never executes. Artifact bytes and SHA-256 are revalidated before sync or async `shell:false` spawn; timeout, abort, clock, sleep, resolver, and spawn are injectable, but timeout values must fit Node's timer maximum.
- `@tiangong-lca/cli/batch` separates overall run identity from exact per-item identity/content/policy contracts. It preflights every projection before unsafe work and rechecks identity/content/policy/resource before resumed acceptance or claim. Identity drift or getter failure yields `BatchItemIdentityDriftError` plus `item_identity_drift` without execution, while every already-started worker drains before return. Escaping infrastructure errors atomically mark the scheduler fatal where serialized, close new claims, drain all claimed workers with `allSettled`, and reject with the first recorded cause. It caps concurrency at 64 and serializes matching exclusive keys through per-resource FIFO cursors whose heads enter a private binary min-heap. Blocked items remain unclaimed, later free keys can run, stop/rejection gates same-key successor exposure, and normal ready scheduling is near `O(n log k)`. It exposes input, resource-aware claim, and completion order and awaits a monotonic event sink. Read retry is explicitly classified and timer-capped; mutation retry is configuration-invalid, and consumed attempts can proceed only through explicit readback recovery.
- The same batch subpath exposes one run-directory lock domain independent of identity. It uses a physical create-only state lock across processes and an owner/scope token in async context: only a still-live scope owned by the current holder may reenter, while siblings and callbacks inherited from a completed scope contend. The physical owner and top-level promise stay active until detached nested scopes drain; local waiters wake only after physical cleanup, and live or foreign-host locks are never stale-deleted. Public callers supply no PID, host, or ownership clock; timeout/poll inputs must be non-negative safe integers within Node's timer maximum.

The auth, CommandSpec and batch primitives contain no Foundry profile, LCA stage, endpoint, artifact filename, credential, or blocker taxonomy. Runtime inspection additionally owns the CLI package layout and file inventory only. Callers project those domain facts at their own boundary.

### Session and remote access layer

The CLI talks to remote services directly through helper modules such as:

- `src/lib/env.ts`
- `src/lib/dotenv.ts`
- `src/lib/credential-safety.ts`
- `src/lib/oauth-pkce.ts`
- `src/lib/oauth-loopback.ts`
- `src/lib/supabase-session.ts`
- `src/lib/auth-identity-receipt.ts`
- `src/lib/supabase-client.ts`
- `src/lib/supabase-rest.ts`
- `src/lib/supabase-data-api-contract.ts`
- `src/lib/remote.ts`
- `src/lib/http.ts`

This is where the CLI-owned remote access contract lives.

`src/lib/env.ts` owns one bundled official Production public profile. `readRuntimeEnv`, `requireSupabaseRestRuntime`, the explicit resulting-process remote lookup, and doctor all resolve the same public URL/key/client/callback/region. Empty/blank configuration and exact Production aliases can complete that profile; any custom public field requires a complete matching environment instead. Known Production key/client values cannot be sent to a foreign URL. Headless bearer injection always requires an explicit destination/key. The configured-only `hasSupabaseRestRuntime` probe opts out of defaults so local publish executor selection never becomes remote merely because the package ships a profile. Session project/client binding and explicit remote/commit/approval gates remain unchanged; neither Skills nor a server-side token broker owns a second copy.

The preferred interactive path is `auth login`: a registered public OAuth client opens the browser, keeps state/verifier/code only in memory, receives one exact fixed-port `127.0.0.1` callback, exchanges the code with S256 PKCE, verifies UserInfo, and writes a schema-v2 access/refresh session atomically under the existing state lock. Refreshes use the OAuth token endpoint, replace rotated refresh tokens, and never fall back to password sign-in. `auth status` examines only the bound local record and marks itself not online-verified; `auth whoami` reuses the live redacted identity receipt; `auth doctor-auth` combines local readiness and live identity, returning a human login handoff before network access when the local OAuth session is missing. `auth logout` removes only a matching local project/client session; the Next Connected applications surface owns grant revocation.

`TIANGONG_LCA_ACCESS_TOKEN` is the explicit headless path. It is verified against Auth, cached only in process memory, never written to the session file, and has no automatic refresh/replay path. All remote command families consume the same resolved access-token interface, so OAuth does not fork database/Edge request code. There is no password/API-key bootstrap or alternate user bearer.

### Canonical support reads

`dataset-support-cache.ts` owns the OAuth-only `dataset support-cache export` adapter. It reuses current-user identity and Data API/exact-count pagination owners, performs two bounded observations, and publishes private raw row artifacts with an atomic completion marker. Foundry owns cache summarization and mappings; this adapter makes no transaction-snapshot or write-authority claim.

### Workflow command families

The widest feature families currently live in:

- `src/lib/flow-*.ts`
- `src/lib/dataset-*.ts`
- `src/lib/*-qa.ts`
- `src/lib/process-*.ts`
- `src/lib/lifecyclemodel-*.ts`
- `src/lib/lca-release.ts`
- `src/lib/publish.ts`
- `src/lib/run.ts`

These files own the public CLI semantics for those workflows.

### LCI/LCIA data-release transport

`src/lib/lca-release.ts` is deliberately a narrow authenticated adapter, not a second release control plane:

- `src/cli.ts` owns `release prepare|upload|finalize|approve|publish|readback-verify|unpublish|status|current|calculation-bundle|calculation-artifact|artifact-download` parsing, help, and human/JSON rendering.
- The normal OAuth session supplies the user access token; the explicit headless actor token uses the same request adapter. No legacy bootstrap, service-role credential, or release-specific API key is accepted, and release payloads contain no credential-derived fingerprint.
- Edge/Database assert the live `data_product_manager` role for private and mutating actions. CLI-side checks are input and integrity checks, never an authorization substitute.
- Upload requires exactly the Unit Process and standalone LifecycleModel+Result profiles in both TIDAS and ILCD. Local size, SHA-256, media type, and profile/format cardinality are validated before requesting signed upload URLs.
- Calculation Bundle projections, chunks, and ZIPs are file-first. The CLI writes atomically with private permissions, refuses overwrite without `--force`, and exposes downloaded bytes only after exact size and SHA-256 verification.
- The result profile reuses existing TIDAS Process exchange and LCIA result structures. Schema identity/version policy and self-contained package closure are produced upstream by the release control plane and TIDAS tools, not reimplemented here.

### Process maintenance and QA commands

Recent process maintenance commands extend the same native CLI layer instead of introducing a secondary orchestration surface:

- `src/lib/process-save-draft-run.ts`
- `src/lib/process-payload-validation.ts`
- `src/lib/process-scope-statistics.ts`
- `src/lib/process-dedup-review.ts`
- `src/lib/process-refresh-references.ts`
- `src/lib/process-verify-rows.ts`
- `src/lib/identity-preflight.ts`
- `src/lib/process-flow-build-plan.ts`
- `src/lib/process-qa.ts`
- `src/lib/runtime-rulesets.ts`

These modules share one contract:

- `src/cli.ts` owns subcommand registration, help, and exit semantics
- `process/flow identity-preflight` owns embedded/local candidate scan inputs, explicit hybrid-search remote candidate inputs, identity/fingerprint comparison, duplicate/manual-review decisions, and `identity-candidate-sources.json` provenance artifacts before any build-plan or generation step
- `process/flow build-plan` validates minimum authoring contracts and writes standard gate artifacts before downstream materialization or publish handoff; materialize now creates canonical `processDataSet` / `flowDataSet` wrappers from plan fields when no canonical payload is supplied
- `process save-draft` validates canonical payloads with `ProcessSchema` before remote writes and accepts `--target-user-id` as an account/write guard that must match the current CLI auth user and any visible draft owner
- `flow publish-version` and `process publish-build` validate canonical payloads with `FlowSchema` / `ProcessSchema` before publish planning or handoff artifacts proceed
- Process dataset writers forward nullable `modelVersion` with `modelId`. `publish run` derives an exact source LifecycleModel identity from canonical Process metadata when present, rejects a version without an id, and persists that pair for resulting Processes; it does not discover or substitute the latest Model revision. Missing `modelVersion` deliberately preserves the database's legacy same-version fallback
- `publish run` writes a deterministic `verification-report.json` next to the final publish report so downstream automation can read blockers without parsing execution details
- `runtime-rulesets` maps CLI-local QA, dedup, and publish findings to stable methodology rule ids so Foundry and UI handoffs can consume one ruleset profile contract
- maintenance and QA commands still emit artifact-first local outputs and remain covered by the strict `src/**/*.ts` coverage gate

Process dimensional QA is split between `process-mass-balance.ts` (explicit exact reference evidence, unit-chain resolution, applicability and kg arithmetic) and `process-qa.ts` (existing classification, findings and artifact reports). `cli.ts` owns repeatable reference-file parsing and help. No remote lookup, dependency, credential path or Foundry-owned physical-unit implementation is added. Selected file and payload digests bind observations, while canonical area-time is a reviewed nonmass unit and arbitrary composites remain unresolved.

`dataset-exact-reference-intent.ts` owns the [exact-reference input and evidence contract](exact-reference-intent-contract.md). `dataset-remote-verify.ts` retains row/reference collection, fresh actor identity, current-user RLS payload reads, observation caching and report output. Reference matching includes role so no path collision can change root policy. Current consumer and control-file facts are checked again before report publication; no mutation, retry or credential owner is added.

### Dataset and lifecyclemodel governance commands

Dataset-local governance now uses the same CLI-native command layer:

- `src/lib/dataset-validate.ts`
- `src/lib/dataset-save-draft-run.ts`
- `src/lib/dataset-curation-queue.ts`
- `src/lib/dataset-references-rewrite.ts`
- `src/lib/dataset-maintenance-clear-account.ts`
- `src/lib/dataset-maintenance-{contract,remote,plan,apply,verify}.ts`
- `src/lib/dataset-maintenance-pagination.ts`
- `src/lib/dataset-maintenance-alias-rewrite.ts`
- `src/lib/dataset-maintenance-alias-request.ts`
- `src/lib/dataset-maintenance-protected-artifacts.ts`
- `src/lib/dataset-maintenance-protected-before.ts`
- `src/lib/dataset-maintenance-protected-contract.ts`
- `src/lib/dataset-maintenance-protected-preparation.ts`
- `src/lib/dataset-maintenance-protected-toolchain.ts`
- `src/lib/dataset-maintenance-protected-freeze.ts`
- `src/lib/dataset-maintenance-protected-seal.ts`
- `src/lib/dataset-maintenance-protected-run.ts`
- `src/lib/dataset-maintenance-protected-verify.ts`
- `src/lib/dataset-maintenance-support-validation.ts`
- `src/lib/dataset-local.ts`
- `src/lib/lifecyclemodel-save-draft-run.ts`
- `src/lib/lifecyclemodel-graph.ts`

These modules keep validation, entity-level curation queue build/next/verify state, reference rewrites, RLS-scoped account and exact-row maintenance, save-draft preparation, graph extraction, and local artifact reports inside the CLI instead of routing through skills or MCP transports.

`lifecyclemodel-save-draft-run` selects create or update only after an exact visible-row lookup, then delegates to the existing actor-bound `save_lifecycle_model_bundle` Edge transport. The official Production OAuth client must be configured with the dedicated `EDGE-BUNDLE-01` database capability in addition to its retained general CLI, core read/write, and Next read/search grants; OAuth scopes do not grant database capabilities. The command report preserves the Edge application's sanitized `code` and `details` for actionable failures, but excludes the raw text held by the generic `REMOTE_REQUEST_FAILED` fallback.

Execution-contract mode in `dataset-save-draft-run` is deliberately action-scoped rather than report-directory-scoped. The immutable input binds each ordered row to an `action_id@desired_sha256`, expected insert/update operation, before hash, and earlier-only dependencies. The append-only ledger is rooted in stable platform user state and names one file per owner/project/action identity, so copying a contract or output directory cannot create a replay path. A durable attempt without an outcome is recovered by exact current-owner state-0 payload readback only; terminal and unknown actions are never dispatched again, while unrelated actions may continue. Issue #232 keeps the dependency prefix on its existing serial loop and delegates only unique-target suffix claims, exclusive keys, and fatal stop to `runBoundedBatch`; `executeAction` continues to own PREPARED/readback/no-replay and report ordering.

The row-level maintenance family is deliberately split by responsibility:

- `contract` owns the versioned scope, immutable plan, action, approval, and report shapes.
- `pagination` owns fail-closed PostgREST exact-count traversal for maintenance account scans and clear-account readbacks. It treats page size as a requested maximum, advances by actual returned length, verifies exact totals/ranges plus strict `id`/`version` identities, and builds per-table and aggregate completeness proofs.
- `remote` owns current-session authentication, current-user RLS reads, exact `id` + `version` row lookup, reference-impact reads, action-scoped derivative snapshots, platform `save_draft` / `delete` / guarded owner-draft RPC execution, and audit correlation. It exposes no direct alias-dimension, derivative worker, or raw queue fallback.
- `alias-request` and `protected-contract` own canonical protected execution request/approval/status parsing, exact count/hash bindings, server-window checks, and fail-closed response shapes.
- `protected-artifacts` owns raw-byte SHA-256 reads with fatal UTF-8 decoding, private immutable `0700` directories and `0600` files, and atomic whole-directory publication for completed freeze/seal evidence sets. `protected-before` owns the shared complete-account, support, projected-reference, and stable 23-flow + 27-process derivative validation used by both capture and execution, including census-to-derivative `modified_at` cross-binding.
- `protected-preparation` owns the pure canonical freeze/request/approval builders, exact human approval text contract, stable target derivation, and explicit rejection of superseded historical Step-2 plan identities. `protected-toolchain` validates released database, published CLI, and merged root-workspace evidence against the running CLI version and explicitly confirmed production project.
- `protected-freeze` owns production-authenticated read-only preparation. It performs no server preflight, gate, admission, execution, or mutation call and writes only an unapproved alias request, complete 50-row baseline, freeze, approval request text/JSON, and zero-write report.
- `protected-seal` owns completely offline approval recording. It receives no environment or remote client, preserves the human-returned UTF-8 bytes exactly, verifies explicit freeze/request/text/account/timestamp bindings, and writes approval artifacts without submitting execution.
- `protected-run` owns the production-only full scan, server preflight, three ordered gate receipts, immutable attempt allocation, single admission transport, and status-only recovery state machine. Commit mode shares the preparation denylist so superseded historical approvals cannot bypass a fresh freeze; it never retries admission or falls back to Dev or the legacy whole-plan alias RPC.
- `protected-verify` owns the terminal server proof plus independent current-user RLS cross-read of primary rows, audits, and all 23 flow + 27 process derivative snapshots. It compares only like-for-like hash domains: RLS canonical JSON to the approved plan, closure-hash-validated database action evidence to database snapshots, and snapshot SHA to terminal completion. Local artifacts or a server status alone cannot produce `passed`.
- `alias-rewrite` owns the fixed two-dimension BAFU profile, reviewed target-reference derivation, closure counting, and arbitrary-precision decimal scaling. It never uses JavaScript binary floating point for exchange amounts.
- `support-validation` validates frozen owner-draft FP/UG payload schemas plus embedded root UUID/version without importing publication behavior.
- `plan` requires a complete exact-count account scan before writing `maintenance-scope.json`, `rls-visible-snapshot.json`, `protected-rows.jsonl`, `reference-impact-report.json`, `maintenance-plan.json`, and `dry-run-report.json`; newly generated plans bind the aggregate completeness proof into the plan hash. Alias plans additionally freeze `exchange-rewrite-plan.jsonl`, three support snapshots per batch, per-process exchange locators/hashes, desired payloads, and exact postconditions. Derivative rebuild plans additionally bind a database-produced snapshot for only the one target action; markdown/vector fields do not expand the account-wide scan.
- `apply` requires another complete exact-count scan before approval or mutation, then re-runs a full-plan drift preflight, verifies `--approve-plan <sha256>` and `--confirm <email>`, and persists approval with the current proof. Ordinary actions remain sequential; the complete ordered alias plan is submitted once to `cmd_dataset_alias_plan_guarded` and is never decomposed into dimension or per-row writes. A derivative rebuild submits its frozen single action only to the guarded RPC and records `accepted`/`queued`, never `completed`; replay must recover the same durable request rather than enqueueing a duplicate. Approval alone never authorizes a derivative replay: `derivative-admission-attempt.json` is written only after the exact just-in-time preflight and immediately before the RPC call, then binds plan, action, snapshot, and actor for lost-response recovery. The ordinary sequential executor rejects derivative actions before any mutation transport. Apply records the operation-specific durable proof.
- `verify` performs fresh remote readback independently of apply and writes `readback-verify-report.json`. Ordinary and alias paths retain their complete-account proofs. Derivative rebuild reads its durable request plus a fresh action-scoped database snapshot and returns only `pending`, `passed`, or `failed`; only terminal derivative freshness with unchanged primary preconditions may pass.

`clear-account` applies the same paginator to its initial five-table snapshot, per-table commit checks, and one final fresh scan of all five tables. It reports success only when the final aggregate proof exists with zero rows; a failed final proof is preserved as `completed_with_failures` because earlier deletes may already have committed. An incomplete initial scan produces no snapshot/approval and cannot reach deletion. These proofs establish pagination completeness only while filtered membership/order is stable; they do not provide transaction-level or MVCC snapshot isolation, so hash/timestamp drift guards and quiescent-account operation remain part of the safety model.

Ordinary V1 maintenance only permits current-user, `state_code=0`, exact-version `contacts`, `sources`, `flows`, and `processes` to become `save_draft` or `delete` actions. `merge-support-aliases` is narrower still: exactly two owner-draft batches (`time`, `length_time`), 52 draft rows, 59 selected exchanges, and 309 unrelated exchanges preserved, with reviewed factors and postcondition counts encoded as contract invariants. Source and target FP/UG plus all changed parents must be the current actor's `state_code=0`; public, foreign, or mixed visibility is rejected. It rewrites references and exchange amounts but does not delete support rows or change visibility.

`rebuild-derivatives` is a third, non-primary-write profile and is bidirectionally bound to `action=rebuild_derivatives`. V1 requires exactly one exact-version `processes` row, `target_mode=owner_draft`, current actor ownership, `state_code=0`, and exactly the `extracted_md` plus `embedding_ft` components. Multiple actions, another table or component set, public/foreign/non-draft state, and primary-payload drift all fail closed. The process primary payload, owner/state, and `modified_at` are invariants rather than mutation targets.

All mutation or asynchronous work admission continues through the public platform dataset command path. Direct SQL, service-role access, raw REST mutation, direct Edge calls, `admin embedding-run`, raw queue access, and Foundry-local delete/update/rebuild implementations are outside this architecture; Foundry may only prepare scope, invoke the CLI, and retain its artifacts.

### Artifact and filesystem behavior

Artifact materialization and local state handling cluster around:

- `src/lib/artifacts.ts`
- `src/lib/io.ts`
- `src/lib/state-lock.ts`

If a task changes output layout, locking, or local run roots, inspect these first.

### Private live-case driver

`scripts/live/` uses the existing OAuth browser-opener adapter with real PKCE, callback, exchange and userinfo. Playwright is an exact dev-only dependency. The driver, browser, raw private case context, and account values are excluded from the package. See [the live case guide](live-case-testing.md).

### Repo-local validation and release gates

Repo-level maintenance gates are now split across:

- `.github/workflows/quality-gate.yml` for manual exact-head reproduction and reusable four-platform pre-tag validation
- `.github/workflows/ai-doc-lint.yml`
- `.github/workflows/tag-release-from-merge.yml`
- `.github/workflows/publish.yml`

Important constraints:

- `pnpm prepush:gate` remains the authoritative local proof for code changes and runs from the local pre-push hook; it includes the `test:package` toolchain/tarball consumer contract and exact 100% coverage
- `ai-doc-lint` keeps the historical check identity, but its implementation should run `docpact`
- `docpact` enforces that command-surface and release-gate changes also refresh or review the governed source docs
- the merge-tag workflow is guarded so only the upstream repository can execute release tagging
- CI bootstrap is pinned to `pnpm/setup` v2.0.2 with Node 24.19.0 and `pnpm install --frozen-lockfile`
- the publish workflow releases from `cli-v<package.json version>` through native pnpm OIDC/provenance and supports manual dispatch for existing-tag recovery/backfill
- routine npm releases must flow through an upstream `main` PR merge and GitHub Actions Trusted Publishing; local workstations may validate with `pnpm --filter @tiangong-lca/cli --fail-if-no-match pack --dry-run` but must not publish
- the packed consumer surface is package-manager neutral and excludes pnpm workspace/lock metadata, TypeScript, Oxlint, tests, source-only tooling, and other repository internals; ESM, CJS dynamic-import, and TypeScript hosts exercise the explicit launcher, CommandSpec, batch, and run-lock exports while root/deep imports remain closed

## Cross-Repo Boundaries

- `tiangong-lca-skills` wraps CLI commands but does not own the native command contract
- `tiangong-lca-mcp` owns MCP transports and tool exposure, not the CLI executable
- runtime API, schema, or product behavior still belong in their owning repos
- `lca-workspace` owns root delivery completion after a child PR merges

## Common Misreads

- a skill wrapper is not the source of truth for a missing command
- the CLI should not absorb MCP transport behavior
- a merged child PR does not finish workspace delivery

## Local Docpact Push Gate

This repository has a versioned local `pre-push` hook under `.githooks/pre-push` that delegates to `scripts/docpact-gate.sh` and then runs `pnpm prepush:gate`. The gate resolves the CLI through `scripts/docpact`, so local agent shells do not need bare `docpact` on `PATH`. The hook is the local guard for docpact config validation, enforced doc-governance linting, and the CLI test gate; ordinary GitHub push tests are replaced by this local gate plus release-time gates.
