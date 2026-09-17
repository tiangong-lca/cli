---
title: cli AI Working Guide
docType: contract
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - when a task may change the public `tiangong-lca` command surface, CLI runtime behavior, session handling, or release gating
  - when routing work from the workspace root into tiangong-lca-cli
  - when deciding whether a change belongs here, in tiangong-lca-skills, in tiangong-lca-mcp, or in a remote runtime repo
whenToUpdate:
  - when command ownership or repo boundaries change
  - when validation, packaging, or coverage rules change
  - when docpact routing, retained source docs, or repo-local governance rules change
checkPaths:
  - AGENTS.md
  - README.md
  - DEV_CN.md
  - docs/IMPLEMENTATION_GUIDE_CN.md
  - .docpact/config.yaml
  - docs/agents/**
  - .gitignore
  - .env.example
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - .oxlintrc.json
  - .nvmrc
  - bin/**
  - src/**
  - test/**
  - scripts/**
  - .github/workflows/**
  - .githooks/**
  - scripts/docpact
  - scripts/docpact-gate.sh
  - scripts/install-git-hooks.sh
lastReviewedAt: 2026-09-17
lastReviewedCommit: f9a9861b1856d1403f0badda2134a474d2c5f7f4
lastReviewedNote: 'Reviewed for CLI #334: version-only 0.1.16 preparation keeps the W6b source-bound assets and existing release identity while advancing live version fixtures; command, dependency, lock, authentication, quality and integration contracts remain unchanged.'
related:
  - .docpact/config.yaml
  - docs/agents/repo-validation.md
  - docs/agents/repo-architecture.md
  - README.md
  - DEV_CN.md
  - docs/IMPLEMENTATION_GUIDE_CN.md
  - docs/release-runbook.md
  - docs/release-setup.md
---

Review note, 2026-09-17: CLI W6b applies the workspace decision that the original tidas-tools schema, carried by `tidas-spec`, is authoritative. The bundled schemas now match the exact candidate; the sync gate binds commit, source commit, version and manifest hash without changing CLI command or release behavior.

Runtime distribution work is owned by [the runtime distribution contract](docs/agents/runtime-distribution-contract.md). Issue #274 adds the public `./runtime` inspection/manager API and `runtime describe|ensure|status|prune|lease-release|exec`. Component installation is manifest/SHA/inventory/lease bound and grants no task or data authority; the no-Node POSIX/PowerShell bootstrap is checked in under `scripts/bootstrap/`; adjacent product locks are generated only after a product manifest exists. CLI #275 designates 0.1.10 as the C1 package release; public product component qualification remains a separate downstream gate. New CLI launches and TIDAS artifact selection support only macOS arm64, Linux x64/arm64 and Windows x64. The macOS Intel Oxlint release-age exception is removed; transitive lockfile records remain untouched.

Private live-account testing is maintainer-only and requires explicit account authorization. Follow [the live case guide](docs/agents/live-case-testing.md); public CLI authentication remains OAuth-only and personal credentials never enter public CI.

Process QA consumes explicitly selected exact Flow/Flow Property/Unit Group evidence through `process-mass-balance.ts`; `process-qa.ts` owns report/finding projection. Keep nonmass or unresolved applicability separate from a physical mass result, retain null unavailable values and hash-bound evidence, and never infer arbitrary composite units or use a version label to restore mixed-dimension arithmetic. Foundry #122 owns downstream evidence selection and transport.

Explicit exact-reference verification follows `docs/agents/exact-reference-intent-contract.md`. Keep strict consumer/actor/reference/review binding and current input rechecks in the CLI owner; preserve default latest/root policy and current-user RLS. Foundry transports the evidence without implementing eligibility or treating a review file as write authority.

## Repo Contract

`tiangong-lca-cli` owns the checked-in public `tiangong-lca` CLI contract: command nouns and verbs, launcher behavior, local artifact workflow, remote session/auth handling, and the repo-level release gate. Start here when the task may change what the CLI does or how it is validated.

Review note, 2026-08-31: Issue #244 implements `auth login|status|whoami|doctor-auth|logout` and makes a registered public Supabase OAuth client the preferred session source. Login uses Authorization Code + S256 PKCE, a cryptographic state value, one exact `http://127.0.0.1:<registered-port>/oauth/callback`, and a shell-free system browser. The verifier and authorization code remain memory-only; the token response is byte-bounded; OAuth refresh-token rotation happens under the existing process/file locks and is atomically persisted as schema v2 in a private `0700` directory / `0600` file on POSIX. `status` reads only matching local metadata and explicitly says it is not online verification; `whoami` runs the redacted live identity receipt; `doctor-auth` combines both and returns a human login handoff without password bootstrap. Normal commands consume the access token. `TIANGONG_LCA_ACCESS_TOKEN` is an explicit short-lived headless path that is verified online, memoized only for the process, never persisted, and never auto-refreshed. OAuth failures never fall back to password sign-in.

Review note, 2026-09-01: Issue #260 makes OAuth or the explicit verified headless access-token mode mandatory for every user-authenticated remote command. The reversible user API-key parser, password sign-in, legacy session schema/mode/source, CLI flags/env, historical production-case runner, fixtures, and setup docs are removed. OAuth PKCE, private rotating refresh sessions, local logout, live identity verification, RLS request adapters, exact 100% coverage, package provenance, and four-platform release gates remain mandatory.

Review note, 2026-08-31: Issue #247 hardens that OAuth/session lock against a real inter-process release race. `readStateLockMetadata()` no longer checks existence before reading; one `readFileSync` returning `ENOENT` means the owner already released the lock, while malformed/empty metadata behavior and every non-`ENOENT` read failure remain fail-closed. Lock creation, stale-owner policy, reentrancy, timeout, cleanup, session bytes, package version, and release automation are unchanged.

Review note, 2026-08-31: Issue #246 publishes the merged OAuth runtime as CLI 0.1.4. The release delta is limited to `package.json` and four existing exact-version fixtures; the pnpm lock, runtime, public exports, dependencies, authentication semantics, commands, credentials, tag automation, Trusted Publishing/provenance, and workspace integration contract are unchanged.

Review note, 2026-08-31: Issue #250 repairs the Windows release-gate coverage gap without changing production behavior. `readCachedSessionRecord()` and `writeCachedSessionRecord()` accept an optional internal/test platform whose default remains `process.platform`; deterministic tests execute both POSIX private-mode/chmod and Windows branches on every host. Session paths, modes, OAuth tokens, lock behavior, public exports, dependencies, and package version are unchanged. The failed 0.1.4 run created no tag or npm package; a separately tracked replacement release follows only after the four-platform matrix passes.

Review note, 2026-08-31: Issue #252 prepares replacement CLI 0.1.5 after 0.1.4 stopped before tag/publish. Its delta is `package.json`, four existing version fixtures, and governed release evidence only. Runtime includes OAuth #244, lock #247, and platform coverage #250 from main; dependencies, lock bytes, exports, auth semantics, workflows, credentials, and local/manual publication prohibitions remain unchanged.

Review note, 2026-08-31: Issue #256 keeps package identity at 0.1.5 while upgrading the direct Node 24-compatible graph to Supabase JS 2.112.4, lint-staged 17.4.1, Prettier 3.9.6, and tsx 4.23.13. TIDAS SDK is pinned exactly to npm-latest 0.2.0 so a future unreviewed 0.2.x cannot drift into consumers; Node typings remain on latest 24.x instead of Node 26. `pnpm peers check` joins the authoritative pre-push gate; Prettier 3.9's deterministic existing-file rewrite is isolated in its own commit. OAuth/session/public exports and release automation do not change, and Issue #257 owns the later version-only 0.1.6 release.

Review note, 2026-08-31: Issue #257 prepares CLI 0.1.6 from dependency merge `490eb08990bf339935f7a5402add063618d844d2`. npm 0.1.6 and `cli-v0.1.6` were absent before RED fixture commit `06a3f5c`; package commit `499c910` changes only the version from 0.1.5 to 0.1.6. The four exact fixtures, package identity, and governed release evidence are the full release diff; runtime, exact TIDAS 0.2.0, Supabase JS 2.112.4, lock bytes, exports, OAuth/session behavior, workflows, credentials, and local/manual publication prohibitions remain unchanged.

Review note, 2026-08-25: Issue #228 implements `auth identity-receipt` as the CLI-owned live identity proof. It resolves the existing API-key/session chain, safely validates the canonical Supabase project before credential decode or network work, performs a redirect-disabled and incrementally byte-bounded `/auth/v1/user` lookup for a canonical user UUID, caps timeout values to Node's supported timer range, retries only one 401/403 through forced session refresh, and emits an exact-key receipt containing no credential, token, full email, session path, or credential-derived fingerprint. A production guard is valid only with both expected project and user argv assertions and `assertions.mode=intent-bound`. The companion pnpm case command owns the single clean TS7 build before its plain-Node runner starts; callers must not add a redundant prebuild. The runner rejects alternate entrypoints, single-reads/hashes source/config/lock and generated runtime/runner bytes, snapshots the exact built runtime privately before exposing three allowlisted env values, cleans the snapshot before publishing any passed/failed evidence, disables cache, uses an exclusively created clean cwd and argv-array spawn, and never persists raw child output. POSIX modes are enforced; Windows callers must choose a current-user-restricted parent ACL.

Review note, 2026-08-25: Issue #230 publishes the merged Issue #228 runtime as CLI 0.1.1 without changing command logic, published dependencies, auth behavior, credentials, or dataset operations. It pins latest-stable `sigstore@5.0.0` in dev dependencies, regenerates the sole pnpm lock only for cryptographic release verification, and converges `.nvmrc`, package engines, workflows, tests, and active docs on latest-stable Node 24.19.0. Every reusable matrix job asserts actual platform/architecture before tag creation. `release:verify-published` verifies the SLSA DSSE signature, GitHub OIDC/Fulcio certificate identity, certificate transparency and Rekor before trusting exact tag/workflow/run/commit/tarball fields; the clean consumer fixes pnpm 11.23.0, verifies registry signatures, overrides user/global package-manager config, scans all production dependency sections, and receives no TianGong or registry credential. Workspace handoff begins and ends through child `task finish` around any required tracked root integration.

Review note, 2026-08-26: Issue #232 makes `src/command-spec.ts` and `src/batch.ts` the CLI-owned public library boundary. The first preserves the exact Foundry v1 CommandSpec authority and shell-free sync/async execution, including abort-listener cleanup after synchronous adapter failure and a Node-safe timeout ceiling; the second owns identity/content/policy-bound item scheduling, resource-aware claims, per-result resume-stop decisions, explicit readback-only mutation recovery, and canonical cross-process run-directory locks. Blocked resource keys stay unclaimed and consume no worker; claim-time identity drift or getter failure is a stable zero-execution item failure, and in-flight workers drain before return. Any escaping infrastructure callback immediately closes new claims; worker aggregation drains all already-claimed work before throwing the first recorded error. Per-resource FIFO cursors plus a private minimum-ready heap avoid repeated full pending scans while preserving stop/pause/unclaimed semantics. Run-lock ownership metadata is internal-only, and all public timer-backed delays reject unsupported values. `dataset save-draft --execution-contract` dogfoods only the parallel suffix scheduler; its serial dependency prefix, durable attempt/readback authority, report bytes, and no-replay behavior remain command-owned. Package version stays 0.1.1 pending a separate release.

Review note, 2026-08-26: Issue #233 preserves that exact public batch API while making `src/batch.ts` a 62-line re-export facade over eight semantic modules under `src/lib/batch/`. The dependency graph is acyclic and executable architecture proof fixes the facade ceiling at 62 lines and the largest internal ceiling at 445 lines, both below the public 400 / internal 800 limits. The same proof locks exact runtime named exports, class/function object identity, declaration names, error/event/result bytes, forbidden upward imports, module inventory, and SCC absence. Package exports, version 0.1.1, dependencies, the pnpm-only Node 24/TS7 toolchain, run-lock behavior, and dataset save-draft dogfood remain unchanged.

Review note, 2026-08-26: Issue #236 advances only the exact pnpm toolchain pin from 11.23.0 to 11.24.0. `packageManager`, `engines.pnpm`, the release verifier, static contracts, and active maintainer docs agree; pnpm 11.24.0 lockfile-only reconciliation produces no root lockfile byte change. Node 24.19.0, TypeScript 7.0.2 as the sole compiler graph, package version 0.1.1, dependencies, public exports/runtime behavior, tags, and publication remain unchanged, with no npm/Yarn fallback or alternate lock.

Review note, 2026-08-26: Issue #237 publishes the bounded CommandSpec/batch implementation and pnpm 11.24 convergence as CLI 0.1.2 through a release-only package metadata and four-fixture change. It adds no command, dependency, runtime behavior, public export, credential, database/Foundry operation, tag rule, workflow, or alternate publication path. The four-platform gate, merge-triggered tag, native pnpm Trusted Publishing/provenance, credential-free public consumers, and exact released-commit workspace integration remain mandatory.

Review note, 2026-08-29: Issue #240 adds `src/auth-identity-receipt.ts` and the supported `@tiangong-lca/cli/auth-identity-receipt` parser/type subpath after the 0.1.2 exports map correctly closed internal deep imports. The entry directly re-exports the existing parser/constants/types, exposes neither remote execution nor test internals, adds no dependency or auth behavior, and keeps package version 0.1.2 pending a separate patch release.

Review note, 2026-08-29: Issue #242 publishes that reviewed public parser as CLI 0.1.3. The release delta is limited to `package.json` and four existing exact-version fixtures; the pnpm lock, runtime, public export identities, dependencies, auth behavior, commands, credentials, tag automation, Trusted Publishing/provenance, and workspace integration contract are unchanged.

Review note, 2026-06-04: `dataset curation-queue build/next/verify` is the CLI-owned state machine for Foundry entity queues; repo ownership boundaries remain unchanged.

Review note, 2026-06-05: release 0.0.12 only updates CLI package version metadata; command ownership, validation gates, and release workflow boundaries remain unchanged.

Review note, 2026-06-07: release 0.0.14 keeps the CLI-owned dataset classification command family and release workflow boundaries unchanged. `dataset classification apply --type location` may create an explicit missing location field such as `locationOfSupply`, but path ambiguity still blocks.

Review note, 2026-06-11: release 0.0.15 keeps command nouns/verbs, repo ownership, and release workflow boundaries unchanged. `dataset import-lca convert` now matches the tidas-tools 0.0.28 import_lca CLI surface: the wrapper no longer passes a bare `--process-bundles` flag, forwards `--no-process-bundles` when bundles are disabled, and derives report bundle/mapping file fields from on-disk state.

Review note, 2026-08-20: Issue #222 keeps `dataset import-lca convert` on the unified Rust runtime and advances its native compatibility gate to the stable `0.2.x` line. The adapter requires `tidas.operation-report.v1`, forwards only native import controls, and preserves native exit classes and atomic publication. The CLI does not bundle a platform binary or copy import domain logic; the npm package carries only a small smoke fixture. Supported artifact targets are Linux x86_64/ARM64, macOS Apple Silicon (arm64), and Windows x86_64; Windows ARM64 fails closed.

Review note, 2026-07-11: `dataset maintenance plan/apply/verify` is now the CLI-owned v1 row-level maintenance contract. It freezes exact current-user RLS scope and audit artifacts before any write, executes only approved `save_draft` / `delete` actions through platform command paths, and verifies the result with an independent readback.

Review note, 2026-07-12: the maintenance contract owns the fixed BAFU FP alias operation `merge-support-aliases` in explicit `target_mode=owner_draft`. Source/target FP/UG and all changed flow/process rows must be current-owner `state_code=0`; the ordered `time` plus `length_time` plan is applied through one whole-plan guarded RPC with exact closure, payload/timestamp locks, plan/batch audit-bound replay, and independent private-state readback. Publication remains a separate future workflow and is not a prerequisite of this operation.

Review note, 2026-07-13: maintenance account scans now require exact-count PostgREST pagination. `--page-size` is a requested maximum that may exceed the server cap; the CLI follows the actual returned row count, validates each `Content-Range` exact total and strict `id`/`version` order, and emits per-table plus aggregate completeness proof before accepting artifacts, approval, or writes. This proves pagination completeness while the filtered membership/order is stable; it is not a transaction-level or MVCC snapshot.

Review note, 2026-07-14: `rebuild-derivatives` extends the maintenance contract with one narrowly scoped `rebuild_derivatives` action. V1 accepts exactly one current-owner `processes` draft in `target_mode=owner_draft`, with the exact component set `extracted_md` plus `embedding_ft`. Planning freezes an action-scoped database snapshot; apply may only obtain a durable `accepted`/`queued` result through the guarded RPC; independent verify owns the terminal `pending`/`passed`/`failed` result. This path never mutates primary process data and has no direct Edge, `admin embedding-run`, raw queue, SQL, or REST mutation fallback.

Review note, 2026-07-15: `dataset maintenance run-protected` is the CLI-owned production-only path for one already sealed and exactly approved owner-draft alias execution. It completes full account and derivative-baseline checks before server preflight, binds three ordered live gates to a server window of at most 180 seconds, writes an immutable local marker before at most one admission POST, and permits only status/readback recovery afterward. Terminal success requires the database proof and independent RLS reads to agree on 52 rows, 59 exchanges, 55 audits, and exactly 23 flow plus 27 process derivative targets. It has no Dev replay, legacy alias RPC, automatic retry, publication, or state-code fallback.

Review note, 2026-07-15: Issue #171 keeps protected preparation in the same CLI-owned maintenance boundary. `freeze-protected` may authenticate only to the explicitly confirmed production project and is limited to complete RLS reads plus the protected derivative snapshot RPC; `seal-protected-approval` is local-only and receives no environment, session, or network client. Only `run-protected` owns preflight/admission/execution. Foundry and skills remain thin published-CLI callers and must not duplicate database access, canonical hashing, or approval construction.

Review note, 2026-07-16: Issue #157 adds a separate `dataset maintenance flow-identity capture|plan|freeze|seal-approval|run|verify` boundary for Step 3. Capture performs one complete authenticated source/process census, persists only the reviewed process reference closure, and submits exactly one immutable semantic request for a database receipt; it performs no rewrite/finalize or client-side derivative-baseline RPC. Plan accepts only that fresh post-Step2/post-#29 305-source v3 authority and database receipt. Process requests are thin ordinal/intent-proof commands; the immutable database receipt/ledger owns rewrite semantics and derivative baselines. The runner is serial, writes an immutable attempt marker, and never automatically replays an ambiguous process response. Independent verification owns terminal success. Derivative failure cannot trigger process replay; any later derivative-only compensation requires a new plan/freeze/approval.

Review note, 2026-07-17: Issue #157 COMMON hardening requires independent `status=passed` readback identities for both Issue #29 derivative prerequisites before capture. An HTTP-success RPC body with `ok:false` is a deterministic database domain rejection, not a transport ambiguity; after a process rejection the current invocation performs exactly one fresh scope read and never replays the process. Independent verify may report `pending` only for an exact `derivatives_pending` database status with no hard readback mismatch. The protected runner now enforces `approval_reusable=false` with a database-minted one-wrapper rotating permit as the cross-machine authority; a create-only local approval claim is defense in depth. Permit or preflight-response loss requires a fresh exact recovery approval and can locate the existing actor-owned scope only through the exact read-only lookup. The remaining production gate is merge, Preview validation, and coordinated DB/CLI release, not an unresolved design boundary.

Review note, 2026-07-16: Issue #175 keeps protected preflight validation fail-closed while allowing up to five seconds of server-ahead clock skew only for the client-side `completed_at` comparison. Expired, reversed, over-180-second, foreign, and malformed proofs still fail before gates or admission, the database remains authoritative for token expiry and one-shot consumption, and timing diagnostics never include the preflight token. The command, ownership, release, and workspace-integration boundaries are unchanged.

Review note, 2026-07-16: Issue #177 changes tests only: native path helpers replace POSIX separators, the default-spawn failure uses a guaranteed-missing temporary executable, successful spawn remains injected, and POSIX mode-bit assertions run only where those semantics exist. Runtime behavior, raw protected bytes, ownership, release, and workspace-integration boundaries are unchanged.

Review note, 2026-07-16: Issue #178 is the dedicated 0.0.27 version-bump release for the merged protected clock-skew fix and Windows-portable validation suite. It adds no command, runtime, dependency, approval, database, or alternate publication path; automated tag creation, Trusted Publishing, and exact released-commit workspace integration remain mandatory.

Review note, 2026-07-16: Issue #182 corrects only the terminal protected verifier's JSON hash-domain bridge. Independent RLS rows remain bound to the approved plan with the CLI canonical hash; the already closure-hash-validated primary action evidence binds PostgreSQL `jsonb::text` hashes to the fresh derivative snapshot; and the snapshot SHA remains bound to the terminal completion proof. Cross-domain hashes are never compared directly. Missing, duplicate, foreign, invalid, or drifting evidence still fails closed, and admission, ownership, database, release, and workspace-integration boundaries are unchanged.

Review note, 2026-07-16: Issue #184 is the dedicated 0.0.28 version-bump release for merged verifier fix #182. It adds no command, runtime, dependency, approval, database, or alternate publication path; automated tag creation, Trusted Publishing, provenance verification, and exact released-commit workspace integration remain mandatory before production status-only verification.

Review note, 2026-07-16: Issue #186 adds the CLI-owned `release` transport for LCI/LCIA data releases. The standalone release control plane remains the workflow owner, Edge/Database remain the authorization and state-machine owners, and this repo owns file-first command parsing, user-session exchange, exact four-ZIP upload verification, stable reports, and hash-verified downloads. The CLI never receives a service-role key; private and mutating operations depend on a server-verified `data_product_manager` account.

Review note, 2026-07-30: Issue #214 removes the retired lexical-column proof and dual-weight request shape. Identity preflight sends one `lexical_weight`; protected derivative reads and snapshots require canonical `extracted_md`, `embedding_ft`, and `embedding_ft_at` only. Command ownership, authorization, and release boundaries are unchanged.

Review note, 2026-08-07: database-engine Issue #422 freezes the CLI Data API contract at database commit `0a97cc761f8127ca379ab7d4df4395dab255707a` and migration head `20260807103000`. The default and only supported profile is `api-contract-v1`: nine core relations remain explicitly `public`, while all 16 authenticated CLI RPCs use exact `api` signatures. The retired `private.cmd_dataset_alias_plan_guarded(jsonb)` executor has no Data API transport; the production alias workflow uses the frozen preflight/gate/admit/read protected-execution façades. The CLI still rejects `anon` and `service_role`; GET/HEAD and only manifest-classified read RPCs may refresh and replay once after 401/403, while relation writes, mutation RPCs, and unknown RPCs never replay.

Review note, 2026-07-17: Issue #191 changes only LCI/LCIA release tests so the four-platform matrix asserts POSIX mode bits and chmod-based cleanup failures only where those semantics exist. Runtime behavior, command ownership, credentials, release automation, and workspace-integration requirements are unchanged.

Review note, 2026-07-17: Issue #189 is the dedicated 0.0.29 version-bump release for the merged LCI/LCIA release transport in Issue #186 / PR #187. It adds no command, runtime, dependency, credential, approval, database, or alternate publication path; automated tag creation, npm Trusted Publishing, provenance verification, and exact released-commit workspace integration remain mandatory.

Review note, 2026-07-23: Issue #194 extends `dataset save-draft` with an explicit ordered owner-draft execution contract. The CLI binds project, owner, state 0, row identity, payload hashes, expected operations, before hashes, and earlier-action dependencies; it records each `action_id@desired_sha256` attempt in stable user state before dispatch and resolves ambiguous or orphaned attempts by exact owner readback without replay. This adds no service-role, direct-table, publication, delete, state/schema, or package-release path.

Review note, 2026-07-23: Issue #196 is the dedicated 0.0.30 release for merged Issue #194 / PR #195. Windows release-gate evidence exposed that `fsync` on a reopened read-only execution-ledger descriptor returns `EPERM`; the release now fsyncs create/append operations on their write-capable descriptors before close. Attempt-before-dispatch ordering, no-replay semantics, dependencies, authorization, tag automation, npm Trusted Publishing, provenance verification, and exact released-commit workspace integration remain unchanged.

Review note, 2026-07-23: Issue #198 releases 0.0.31 and makes dataset save-draft validation side-effect free. SDK schema/entity validation receives a deep clone, while execution-contract hashing, dispatch, and readback remain bound to the original exact input payload. Owner/state/project fencing, attempt-before-dispatch ordering, no-replay semantics, command ownership, and publication boundaries remain unchanged.

Review note, 2026-07-24: Issue #200 releases 0.0.32 and makes large ordered owner-draft contracts finish within the authenticated session window. `--max-parallel` remains opt-in and capped at 8: every action through the highest referenced dependency stays serial, and only the remaining unique-target suffix can overlap. The command resolves and revalidates the exact owner token immediately before each DML dispatch. Attempt-before-dispatch durability, exact readback, dependency blocking, UNKNOWN/success no-replay, and all public/foreign/publication/delete/state/schema/service-role prohibitions remain unchanged.

Review note, 2026-07-24: Issue #202 releases 0.0.33 and keeps high-volume physical flow deletion inside the existing maintenance command boundary. Explicit `maintenance apply --max-parallel 1..8` accepts only unique owner-draft flow delete targets after zero current/projected impact and a fresh complete RLS-visible process inbound scan. Every protected delete remains an independent transaction with durable pre-dispatch evidence and exact absent readback; success/UNKNOWN are never automatically replayed and independent rows continue. No RPC, schema, dependency, alternate auth, publication, state, source, FP/UG, public, foreign-owner, direct-table, or service-role path is added.

Review note, 2026-07-24: Issue #204 bounds each page of the parallel-delete all-visible process inbound preflight at 250 rows so large process JSON cannot exhaust the production statement timeout. The scan still omits a `user_id` predicate, follows exact-count pagination to completion, and blocks every mutation after an incomplete scan or any visible inbound reference. Delete scope, authorization, attempt-before-dispatch, no-replay, RPC/schema, and all protected-row boundaries are unchanged.

Review note, 2026-07-25: Issue #206 orders that complete RLS-visible process scan only by the globally unique `(id, version)` primary key. This preserves deterministic exact-count completeness and every visible-row safety check while avoiding a redundant full-result owner/state sort; filtering, delete scope, authorization, retry, mutation, RPC/schema, and protected-row boundaries remain unchanged.

Review note, 2026-07-25: Issue #208 lets the same bounded flow-delete path admit a fresh external proof only when its exact bytes are SHA-approved and its project, actor, plan, complete target binding, contiguous chunks, SELECT-only provenance, zero inbound result, and 30-minute freshness all match. The proof must cover all process rows and is therefore stronger than the default RLS-visible scan; it is validated before approval or dispatch. The CLI does not execute raw SQL, the default scan remains available, and delete scope, owner/session DML, retry, RPC/schema, and protected-row boundaries are unchanged.

Review note, 2026-08-25: Issue #224 replaces the mixed Node package/lint toolchain with one baseline, now exact at Node 24.19.0, pnpm 11.23.0, TypeScript 7.0.2, and type-aware Oxlint. `pnpm-workspace.yaml` plus the sole root `pnpm-lock.yaml` own dependency resolution; `test:package` rejects alternate locks, legacy TypeScript/ESLint bridges, active npm package-management commands, and tool leakage into the published tarball. The feature branch stays at 0.0.33; because the migration changes maintainer and release compatibility, prepare 0.1.0 in a separate release-only PR after this feature merges and all gates pass.

Review note, 2026-08-25: consuming the stricter TIDAS SDK 0.2 contract also closes one materialization gap: plan-only process/flow build materialization requires an explicit canonical `classification_path` of continuous level `0..n` objects. Process/product entries use exact locked `@classId` plus `#text`; elementary entries use `@catId` and emit `common:elementaryFlowCategorization`. Missing, label-only, malformed, out-of-order, or taxonomy-spoofed classifications fail closed instead of receiving synthetic UUID class ids.

Review note, 2026-08-25: Issue #226 is the dedicated 0.1.0 release-only delivery for merged Issue #224 / PR #225. Its runtime delta is limited to the package version and four live CLI-version fixtures; its test-only delta extends the clean package consumer contract to an ESM host importing the explicit bin launcher subpath and a CJS host dynamically importing the same subpath, with governed/public release evidence updated alongside them. The pnpm lock/dependency graph, command/runtime behavior, package-root exports, Node 24 + pnpm 11.23.0 + TypeScript 7.0.2 + Oxlint baseline, tag workflow, native pnpm Trusted Publishing/provenance path, and exact released-commit workspace integration remain mandatory and unchanged.

## Bootstrap Order

Load docs in this order:

1. `AGENTS.md`
2. `.docpact/config.yaml`
3. `scripts/docpact route --root . --intent <intent>` when you need path-specific routing
4. `docs/agents/repo-validation.md` when proof, coverage, CI, or release gating matters
5. `docs/agents/repo-architecture.md` when command ownership, session/runtime layers, or artifact families are unclear
6. `README.md` only for user-facing invocation examples
7. `DEV_CN.md`, `docs/IMPLEMENTATION_GUIDE_CN.md`, `docs/release-runbook.md`, or `docs/release-setup.md` only when that retained source doc matches the task

Do not start with scattered subcommands or tests before you know which command family owns the task.

Preferred docpact commands:

- `scripts/docpact route --root . --intent command-surface`
- `scripts/docpact route --root . --intent remote-session`
- `scripts/docpact route --root . --intent workflow-commands`
- `scripts/docpact route --root . --intent lca-data-release`
- `scripts/docpact route --root . --intent validation-release`
- `scripts/docpact route --root . --intent repo-docs`

## Repo Ownership

This repo owns:

- `bin/tiangong-lca.js` as the stable launcher entrypoint
- `src/cli.ts` and `src/main.ts` for command dispatch, process entry, help, and exit behavior
- `src/lib/**` for reusable CLI command logic, session handling, artifacts, and remote adapters
- `src/auth-identity-receipt.ts`, `src/command-spec.ts`, and the `src/batch.ts` facade plus `src/lib/batch/**` internals for the supported typed package subpaths and their provider-neutral safety contracts
- `test/**` and `scripts/assert-full-coverage.ts` for the hard validation gate
- package metadata, build output contract, and tag/release checks in `package.json` and `scripts/ci/**`

This repo does not own:

- skill packaging and skill wrapper metadata
- MCP transport or inspector surfaces
- remote product or Edge Function business logic
- workspace integration state after merge

Route those tasks to:

- `tiangong-lca-skills` for skill wrappers and `SKILL.md` packages
- `tiangong-lca-mcp` for MCP transports and tool registration
- the owning runtime repo for API, schema, or product behavior
- `lca-workspace` for root integration after merge

## Runtime Facts

- Repo-local documentation governance is encoded in `.docpact/config.yaml` and enforced locally by the pre-push docpact gate; `.github/workflows/ai-doc-lint.yml` is manual-dispatch fallback.
- Package manager: exact `pnpm@11.24.0`, with one root workspace and lockfile
- Compiler and lint: `typescript@7.0.2` plus type-aware Oxlint; no TypeScript 5/6 or ESLint bridge
- Node baseline: exact local/CI `24.19.0`; package engine range `>=24.19.0 <25`
- Direct dependency baseline: Supabase JS `2.112.4`, exact TIDAS SDK `0.2.0`, lint-staged `17.4.1`, Prettier `3.9.6`, and tsx `4.23.13`; `@types/node 24.13.3` is the latest compatible Node 24 line. `pnpm peers check` must pass before package and coverage proof.
- Runtime style: TypeScript source, Node-native CLI, direct REST and Edge Function access only
- Public library surface: `@tiangong-lca/cli/auth-identity-receipt`, `@tiangong-lca/cli/command-spec`, `@tiangong-lca/cli/batch`, and `@tiangong-lca/cli/runtime`; the package root and internal deep paths are intentionally not APIs. The auth entry exports only the strict parser/constants/types, while CommandSpec `display` remains non-authoritative, execution is shell-free, and bound artifacts are rehashed before spawn.
- Public batch safety: all item identity/content/policy/resource projections validate before work and again before resumed acceptance or fresh claim; identity drift or getter failure has an explicit error/event and zero execution, and every in-flight worker drains before return. Escaping scheduler/event/stop infrastructure errors synchronously close new claims, drain only already-claimed workers through settled aggregation, and rethrow the first recorded cause. Exclusive keys must be runtime strings; per-resource FIFO cursors expose only the earliest ready heads through a private ordered min-heap, so same keys serialize, blocked keys remain unclaimed without occupying workers, later free keys retain bounded concurrency, and ordinary scheduling stays near `O(n log k)`. Mutation retry is rejected, incomplete attempts require explicit readback recovery, resume requires exact run/item contracts, every pre-claim result can trigger stop before its same-key successor becomes ready, and event delivery is monotonic plus awaited. Retry policy/backoff delays cannot exceed Node's timer maximum.
- Public run-lock safety: one canonical run directory is one file-lock domain across identities and processes. Reentrancy is limited to a live nested scope owned by the current holder; completed async contexts and siblings contend. The top-level promise remains pending until every nested scope drains, foreign-host or live locks are never stale-deleted, and local waiters wake only after physical lock cleanup. PID, host, and ownership time are internal facts, not public options; timeout/poll inputs are non-negative safe integers within Node's timer maximum.
- `auth identity-receipt` belongs to `src/cli.ts` plus `src/lib/auth-identity-receipt.ts`. It is read-only and must live-verify `/auth/v1/user`; cache email, local JWT decode, raw response bodies, and credential-derived fingerprints are not identity evidence. Production callers must supply both expected assertions and accept only `intent-bound` receipts. Offline consumers parse that exact safe projection through the public `./auth-identity-receipt` entry rather than an internal path.
- `auth login|status|whoami|doctor-auth|logout`, `src/lib/oauth-pkce.ts`, `src/lib/oauth-loopback.ts`, and `src/lib/supabase-session.ts` own the CLI OAuth boundary. OAuth client IDs and redirect URIs are public configuration; authorization codes and PKCE verifiers never enter argv or disk; access/refresh tokens never enter stdout, reports, or command artifacts. Status is local and non-mutating; whoami/doctor-auth use the live redacted identity receipt. Logout deletes only the matching local session; grant revocation remains the Connected applications action in Next.
- `src/lib/env.ts` owns the single official Production public profile (URL, publishable key, CLI client, registered callback, region). A clean installed consumer needs only `auth login`; missing local sessions produce `login-required`, not missing-client setup. Blank public fields and exact Production URL aliases can use defaults. Custom URL/key/client/callback values disable profile completion; complete project-matching custom configuration is required, and known Production key/client values with a foreign URL are rejected before browser/network access. Skills must not copy this profile.
- Auth selection is deterministic: explicit `TIANGONG_LCA_AUTH_MODE` wins; otherwise a short-lived access token or the resolved OAuth client selects the mode. No legacy API-key path remains. Headless access-token mode requires an explicit destination and publishable key, has no disk cache, and has no refresh replay. Configured-only remote-executor detection must not inherit the Production defaults or silently enable remote publish.
- Newly added process-maintenance commands such as `process identity-preflight`, `process build-plan`, `process scope-statistics`, `process dedup-review`, `process refresh-references`, and `process verify-rows` still belong to the native CLI command surface in `src/cli.ts` and `src/lib/process-*.ts` / shared CLI-native helpers.
- `process save-draft` now has a local `ProcessSchema` validation gate before any commit path writes remote state, and `--target-user-id` is a hard current-session/visible-draft owner guard for account-scoped batch imports.
- Dataset-level local governance commands such as `dataset validate`, `dataset curation-queue build/next/verify`, and `dataset references rewrite` belong to the same native CLI command surface in `src/cli.ts` and `src/lib/dataset-*.ts`.
- `dataset maintenance plan/apply/verify` owns ordinary current-user RLS-scoped row maintenance in `src/lib/dataset-maintenance-{contract,remote,plan,apply,verify}.ts` plus the fixed alias transformation in `src/lib/dataset-maintenance-alias-rewrite.ts`. V1 requires exact `id` + `version`, `state_code=0`, and current-session ownership. Ordinary maintenance can execute `save_draft` / `delete` actions only for `contacts`, `sources`, `flows`, and `processes`. The original whole-plan alias request remains an artifact-compatibility format, but generic `apply` must reject a sealed production `merge-support-aliases` execution before any mutation transport.
- `dataset maintenance run-protected` owns the sealed production alias path in `src/lib/dataset-maintenance-{alias-request,protected-contract,protected-run,protected-verify}.ts`. It requires the exact plan, production freeze/seal, approval, authenticated account, and private output directory. Commit mode completes the full account/support/50-target baseline scan before server preflight, accepts only server-derived ordered gates within the 180-second maximum, creates immutable local one-shot evidence, and makes at most one admission request. Status-only mode never preflights or admits. Any marker, timeout, cancellation, lost response, or ambiguous admission consumes the local attempt and permits only bounded read polling. A terminal pass requires exact server and independent-read agreement on 52 rows, 59 exchanges, 55 audits, and 50 derivative targets split 23 flows plus 27 processes. The database executor is server-dispatched and explicitly actor/user/state/plan/closure fenced; the CLI never carries service-role credentials.
- `dataset maintenance flow-identity` owns Step 3 in `src/lib/dataset-maintenance-flow-identity-*.ts`. Capture/plan/freeze/seal-approval are immutable file-first boundaries; capture makes one attestation POST after one complete census and stores only the affected/reference-closure process subset. Run uses thin authenticated guarded scope/per-process/finalize RPCs, serializes on the database-ledger next ordinal, and never computes derivative baselines client-side; verify performs a fresh exact-count owner-draft process census plus exact source/public/support/process readback. This path changes only the five TIDAS flow-reference fields in affected process exchanges. It never mutates the 305 source flows, public targets, support data, state codes, or publication state, and it never uses generic maintenance apply or the Step 2 protected runner as a fallback.
- `rebuild-derivatives` is a separate derivative-only profile: exactly one current-owner state-0 `processes` action, `action=rebuild_derivatives`, `target_mode=owner_draft`, and the exact components `extracted_md` plus `embedding_ft`. Its plan binds an action-scoped database snapshot, apply only records guarded-RPC admission as `accepted`/`queued`, and verify alone resolves `pending`/`passed`/`failed` without changing the process primary payload or `modified_at`. The direct alias-dimension and derivative worker/queue surfaces are not authenticated CLI paths. Public/shared, foreign-owner, mixed-visibility, non-draft, lifecyclemodel, and every other support-table mutation remain protected.
- `src/lib/dataset-maintenance-pagination.ts` owns fail-closed account-scan pagination for row-level maintenance and `clear-account`. It requests `Prefer: count=exact`, treats the configured page size as a requested maximum rather than a guaranteed response size, advances offsets by the number of rows actually returned, and accepts a scan only when exact totals, ranges, ordering, identities, and aggregate entity counts prove pagination completeness under stable filtered membership/order. Incomplete scans stop before maintenance artifacts or mutation gates; the resulting proof does not claim transaction-level snapshot isolation across requests.
- `lifecyclemodel save-draft` validates canonical lifecyclemodel payloads with `LifeCycleModelSchema` before any commit path writes remote state; its actor-bound bundle transport requires the official Production OAuth client to retain `CLI-RPC-01`, `DB-CORE-READ-01`, `DB-CORE-WRITE-01`, `NX-CORE-02`, and `EDGE-BUNDLE-01`. Structured application failures retain sanitized `code` and `details`, while unstructured HTTP response bodies remain excluded from artifacts. Production qualification is private and must prove disposable owner-draft create/update, exact readback, and authorized cleanup without publishing identity or payload evidence. `lifecyclemodel graph` remains a local artifact command.
- `flow publish-version` validates canonical flow payloads with `FlowSchema` before remote visibility planning or writes, and emits `flow-publish-version-gate-report.json` as the blocking ruleset artifact.
- `process publish-build` validates canonical process payloads with `ProcessSchema` before publish handoff artifacts are written, and emits `reports/process-publish-schema-gate.json`.
- `publish run` emits `verification-report.json` next to `publish-report.json`; this is the deterministic publish ruleset summary for failed/deferred/executed outcomes.
- `src/lib/runtime-rulesets.ts` is the CLI-local runtime activation layer for stable ruleset ids, methodology rule ids, severity, and blocker semantics used by review, dedup, and publish gate artifacts.
- The canonical minimum validation command is `pnpm lint`. Type-aware Oxlint is the only linter; the retired ESLint and TypeScript Compiler API lint paths must not return.
- The authoritative full gate is `pnpm prepush:gate`; it includes `pnpm test:package`, the exact 100% coverage proof, and the coverage assertion. The local pre-push hook runs it after docpact for source pushes; only a complete, verified branch-deletion-only stdin stream skips both gates as documented in the validation guide.
- Release tagging is guarded in `.github/workflows/tag-release-from-merge.yml` so only the upstream repository can execute the merge-tag flow. Its detector runs under exact Node 24.19.0; it calls the reusable four-platform `.github/workflows/quality-gate.yml` only for a CLI release, every job asserts exact runtime platform/architecture, and `cli-v<version>` tag creation depends on all four. `.github/workflows/publish.yml` publishes from that tag and also supports `workflow_dispatch` for existing-tag recovery/backfill.
- CLI package releases must go through a version-bump PR merged to upstream `main`; routine publication must not originate from a local workstation. The release-prep PR updates `package.json`; the sole root `pnpm-lock.yaml` remains frozen and unchanged unless an explicitly reviewed dependency change requires pnpm regeneration. Issue #230's only graph exception is exact dev-only `sigstore@5.0.0`; published runtime dependencies stay unchanged. Merge creates `cli-v<version>`, and GitHub Actions uses pinned `pnpm/setup` v2.0.2 plus native pnpm OIDC/provenance publication through Trusted Publishing.
- Managed Node host context uses the explicit manifest protocol and one-use inherited IPC receiver. It retains the original trusted manifest and validates actual host/cache/cwd/executable state; task/env/ordinary argv values and cache receipts cannot replace its trust anchor. Host/application inputs are snapshotted before installation, cancellation ends new handshake admission, and leases remain until child/output closure. Product task/account authorization remains separate.
- Coverage for `src/**/*.ts` is expected to stay at `100%` statements, branches, functions, and lines

## Hard Boundaries

- Do not add orchestration frameworks or new runtime/package dependencies without explicit approval
- Do not accept usernames, passwords, authorization codes, access tokens, or refresh tokens through CLI argv. Interactive OAuth owns browser authorization; headless automation may inject only the explicit short-lived actor token through its approved environment/secret boundary.
- Do not reintroduce password sign-in as an OAuth fallback, persist PKCE verifier/state/authorization code, bind a callback outside literal `127.0.0.1`, use a wildcard/dynamic redirect, launch a browser through a shell, or store an OAuth session without the existing atomic file lock and private-file contract.
- Do not add automatic mutation retry, infer idempotency from a transport result, weaken per-item content/policy binding, or turn run-directory locks into identity-specific paths. Ambiguous mutation progress remains readback-only and one run directory remains one exclusive lock domain.
- Do not add another package manager, nested lockfile, TypeScript 5/6 compatibility track, ESLint bridge, or Compiler API lint path. This repository has one package graph: pnpm 11.24.0 with the root workspace and lockfile.
- Do not publish `@tiangong-lca/cli` from a local workstation for routine releases; local npm auth state is not part of the release contract.
- Do not implement dataset maintenance through direct SQL, service-role credentials, raw REST mutation, or Foundry-local database code. Foundry and skills may prepare scope and orchestrate the CLI, but the native CLI must own current-user RLS preflight, platform-command mutation, per-action audit logging, and independent readback verification.
- Do not generalize `merge-support-aliases` beyond its reviewed two-dimension BAFU profile without a new tracked contract. The fixed factors, 52-row/59-exchange closure, 309 preserved exchanges, and postcondition counts are safety invariants.
- Do not remove or reinterpret the `target_mode=owner_draft` / `target_visibility=owner_draft` binding. The alias operation must never mutate public, foreign-owner, or mixed-visibility support or parent rows.
- Do not execute a sealed production `merge-support-aliases` plan through generic `apply`, the legacy whole-plan RPC, Dev data replay, or a second admission. Use `run-protected` only after the shared database capability is released, the live production state is freshly frozen, and the exact execution is human-approved. A transport-ambiguous attempt is consumed and recoverable only through status/readback.
- Do not implement `rebuild-derivatives` by calling an Edge Function, `admin embedding-run`, a raw queue, direct SQL, service-role credentials, or raw REST mutation. The only apply path is the authenticated guarded RPC; its admission result is not completion, and only independent verify may report `passed`.
- Do not move business logic into skill wrappers when the native `tiangong-lca` CLI should own it
- Do not weaken the coverage gate with ignore pragmas; cover the branch or remove dead code
- Do not treat governed docs as optional when command-surface, validation, or release-gate behavior changes; `docpact` should either require a matching source-doc update or record explicit review evidence.
- Do not treat a merged repo PR here as workspace-delivery complete if the root repo still needs a submodule bump

## Workspace Integration

A merged PR in `tiangong-lca-cli` is repo-complete, not delivery-complete.

If the change must ship through the workspace:

1. merge the child PR into `tiangong-lca-cli`
2. update the `lca-workspace` submodule pointer deliberately
3. complete any later workspace-level validation that depends on the updated CLI snapshot

## Local Docpact Push Gate

Install the versioned local hook once per checkout:

```bash
./scripts/install-git-hooks.sh
```

The `pre-push` hook runs `scripts/docpact-gate.sh`, which delegates CLI lookup to `scripts/docpact` and performs strict config validation plus enforced lint before the push leaves the machine. It then runs `pnpm prepush:gate` as the local test gate. The sole exception is a complete, verified branch-deletion-only stdin stream: it publishes no source. Tags, source/mixed updates, empty/TTY/malformed input and classification failures retain both gates. The wrapper checks `DOCPACT_BIN`, Cargo install locations, Homebrew install locations, and then `PATH`, so local agent shells should not fail only because bare `docpact` is unavailable. The default comparison base is `origin/main`. Override it for unusual stacks with `DOCPACT_BASE_REF=<ref>` or `scripts/docpact-gate.sh --base <ref>`. The gate writes its detailed report to a temporary file so normal pushes do not create `.docpact/runs/` artifacts. The GitHub `quality-gate` supports manual exact-head reproduction and reusable invocation; a detected CLI release must pass its four-platform invocation before the tag job can run.
