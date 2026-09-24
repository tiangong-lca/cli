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
lastReviewedAt: 2026-09-24
lastReviewedCommit: 4f1f0543146e554b4f088e2eeac54f223fb3651f
lastReviewedNote: 'Reviewed for CLI #370 at 4f1f054: version-only release changes no module ownership, runtime policy, SDK/schema or cross-repository boundary.'
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-validation.md
  - ../../README.md
  - ../../DEV_CN.md
---

Review note, 2026-09-24: CLI #370 changes only the package version and directly bound fixture constants; module ownership, SDK 0.4.1/spec 0.2.3 data flow, runtime rules and public exports remain as reviewed for #368.

The `src/runtime.ts` public facade and bounded `src/lib/runtime/**` owners expose package/Node/asset identity through one read-only API and `runtime describe`. [The runtime distribution contract](runtime-distribution-contract.md) separates this package observation from complete component/dependency provenance, host ABI readiness and task authorization. `src/main.ts` admits supported architecture tuples before loading user configuration and bypasses dotenv for runtime commands. The manifest/manager/cache/lease/exec owners are under `src/lib/runtime/**`, and the no-Node POSIX/PowerShell bootstrap is under `scripts/bootstrap/`. Product component assembly remains downstream.

Managed-host launch selection stays in the generic CLI manager. Dedicated protocol/server/receiver modules hand the exact verified manifest to a declared Node host through a one-use IPC handshake. Original manifest bytes, selected host fields and application argv are owned snapshots; the receiver uses the existing cache/compatibility owners and shared work-directory guards. Product hosts retain their own task, account and business authorization. Cancellation ends handshake admission before child termination, and execution leases remain until output/process closure.

## Repo Shape

This repo is organized around one stable launcher plus a library-style `src/lib/**` tree that implements command families and shared helpers.

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
- `runtime-rulesets` verifies the released spec 0.2.3 public-rule identity/content, prefers the equivalent SDK 0.4.1 public API, falls back only when that API is unavailable, and composes CLI-owned severity/phase/blocker/profile/local-mapping policy. `dataset-contract-ruleset` separately derives the CLI context-pack projection; neither reads the retired SDK mixed ruleset asset.
- maintenance and QA commands still emit artifact-first local outputs and remain covered by the strict `src/**/*.ts` coverage gate

Process dimensional QA is split between `process-mass-balance.ts` (explicit exact reference evidence, unit-chain resolution, applicability and kg arithmetic) and `process-qa.ts` (existing classification, findings and artifact reports). `cli.ts` owns repeatable reference-file parsing and help. No remote lookup, dependency, credential path or Foundry-owned physical-unit implementation is added. Selected file and payload digests bind observations, while canonical area-time is a reviewed nonmass unit and arbitrary composites remain unresolved.

Annual supply/production volume remains a separate evidence field. `process-required-fields.ts` preserves real single-object and multilingual values, recognizes only explicit historical missing markers, and retains unknown volume as `[]` with an authoring blocker. A quantitative reference or default/reference unit cannot supply annual production. `process-flow-build-plan.ts` preserves explicit annual input and emits an unknown array when evidence is absent. Legacy unresolved-trace metadata cannot waive the evidence requirement.

`dataset-validation-layers.ts` binds recognized-row findings to the complete original payload using the existing canonical `sha256Json` contract. It projects separate `schema`, `authoring_evidence`, `content`, and `multilingual` results; SDK union language findings retain their complete field path, and the supplemental duplicate-language rule is confined to the annual-volume field rather than arbitrary classification arrays. Both Process draft command families consume `process-payload-validation.ts`; SDK parsing uses a deep clone and cannot alter execution-contract content. The aggregate invalid result is retained when authoring evidence is missing even if the SDK accepts the unknown representation. Layer results grant no write, publication, or provider-weight eligibility.

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

- `agent-skills` wraps CLI commands but does not own the native command contract
- `mcp` owns MCP transports and tool exposure, not the CLI executable
- runtime API, schema, or product behavior still belong in their owning repos
- `lca-workspace` owns root delivery completion after a child PR merges

## Common Misreads

- a skill wrapper is not the source of truth for a missing command
- the CLI should not absorb MCP transport behavior
- a merged child PR does not finish workspace delivery

## Local Docpact Push Gate

This repository has a versioned local `pre-push` hook under `.githooks/pre-push` that delegates to `scripts/docpact-gate.sh` and then runs `pnpm prepush:gate`. The gate resolves the CLI through `scripts/docpact`, so local agent shells do not need bare `docpact` on `PATH`. The hook is the local guard for docpact config validation, enforced doc-governance linting, and the CLI test gate; ordinary GitHub push tests are replaced by this local gate plus release-time gates.
