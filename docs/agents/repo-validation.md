---
title: cli Validation Guide
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: en
whenToUse:
  - when a `tiangong-lca/cli` change is ready for local validation
  - when deciding the minimum proof required for command, session, artifact, test, or release-gate changes
  - when writing PR validation notes for `tiangong-lca/cli` work
whenToUpdate:
  - when the repo gains a new canonical validation command or wrapper
  - when change categories require different minimum proof
  - when the protected-branch or coverage contract changes
checkPaths:
  - docs/agents/repo-validation.md
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
  - .github/workflows/**
  - .githooks/pre-push
  - scripts/docpact
  - scripts/docpact-gate.sh
  - scripts/install-git-hooks.sh
lastReviewedAt: 2026-09-23
lastReviewedCommit: 456ec7beed6ade9a2af6f42cbb6561d2a2cc22e4
lastReviewedNote: 'Current validation matrix, coverage, and release gates are reviewed.'
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-architecture.md
  - ../../README.md
  - ../../DEV_CN.md
  - ../release-runbook.md
  - ../release-setup.md
---

## Branch-deletion-only hook exception

The local pre-push hook skips Docpact and `pnpm prepush:gate` only when `scripts/pre-push-deletion-only.sh` verifies the complete nonempty Git stdin stream as deletions of existing `refs/heads/` references. It accepts matching 40- or 64-character lowercase object IDs, requires a local zero and nonzero remote ID, and rejects incomplete or malformed records. Tags, source updates, mixed pushes, empty input and TTY input retain the original Docpact then full canonical gate, including argument forwarding and failure propagation. Missing or failed classification also falls back to those gates. No environment flag, remote argument or cached green result selects the exception.

`node --test test/pre-push-hook.test.mjs` checks the real hook in disposable Git fixtures with gate transports stubbed; the existing full test/coverage entrypoints run it too. Its real bare Git remote is confined to the disposable local fixture; it does not build packages or contact an external remote. Terminal rejection is additionally checked during hook changes with an actual open POSIX PTY and a guard-removal negative control; no new Python runtime dependency is added to the canonical gate. Source-push quality, 100% coverage, the independent package case and four-platform release gates remain mandatory. This exception changes neither the direct `pnpm prepush:gate` command nor tag/release qualification.

## Default Baseline

Unless the change is doc-only, the minimum local baseline is:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm test:package
pnpm build
```

For protected-branch parity, the authoritative full gate is:

```bash
pnpm prepush:gate
```

Process ownership-version changes require focused `dataset-command`, `process-save-draft`, and `publish` tests in addition to the baseline. Prove exact `modelId`/`modelVersion` forwarding, omission-compatible legacy fallback, rejection of `modelVersion` without `modelId`, precedence among canonical source metadata forms, and absence of any latest-Model lookup. The final proof remains the exact-100% `pnpm prepush:gate`.

Annual-volume changes require the real SDK Process schema in `process-annual-volume-policy.test.ts`, not an injected passing validator. Prove schema-valid unknown arrays remain authoring gaps; real quantities (including `9999 kg/year`) and language order survive; malformed shapes remain diagnosable; reference amounts and default units never become annual production; and historical trace metadata cannot bypass validation. Compare the two Process draft command families' complete validation results and exact payload digests. Nested SDK union language errors and duplicate annual-language entries must be reported accurately without treating classification hierarchies as multilingual fields. The private real-case lane freezes source inputs before RED and replays those same inputs after the fix; credential or service failures are not product RED evidence.

When command-surface, release-gate, or governed docs change, also run the repo-local documentation governance gate:

```bash
scripts/docpact validate-config --root . --strict
scripts/docpact lint --root . --base <base> --head <head> --mode enforce
```

First-install proof uses an isolated packed CLI without local public configuration or credentials. `doctor`, `auth status`, and `auth doctor-auth` must report the Production public profile and truthful `login-required` state without creating a session. OAuth tests use fake tokens and an isolated private session; live login qualification follows the private case guide.

LifecycleModel save-draft regressions must preserve sanitized structured application `code` and `details` without exposing raw HTTP bodies. Private Production qualification requires explicit authorization, disposable fixtures, exact owner/state/payload readback, and actor-bound cleanup. Ambiguous mutation or cleanup blocks acceptance.

## Private real-account qualification

[The live case guide](live-case-testing.md) owns the explicit, private OAuth case driver. Public gates run deterministic safety tests without account credentials or browser downloads. Record source OAuth and installed-package proof separately; environment failures are not product RED evidence.

## Support export qualification

`test/dataset-support-cache.test.ts` covers capped/empty pagination, identity and OAuth gates, row/state/order/count/response errors, changing contents, resource bounds and publication races/cleanup. Private real read-only qualification uses the explicit account case driver; public CI uses synthetic fixtures.

## Validation Matrix

| Change type | Minimum local proof | Additional proof when risk is higher | Notes |
| --- | --- | --- | --- |
| `bin/**`, `src/main.ts`, or `src/cli.ts` | `pnpm lint`; `pnpm test`; `pnpm build` | run the relevant `tiangong-lca --help` or subcommand help path after build | Launcher and dispatch changes affect the public command surface directly. |
| `src/auth-identity-receipt.ts`, `src/command-spec.ts`, `src/batch.ts`, `src/lib/batch/**`, declaration config, or public package exports | focused public primitive and architecture tests; `pnpm typecheck`; `pnpm test:package`; `pnpm test:coverage`; `pnpm test:coverage:assert-full` | `pnpm prepush:gate`; run auth parser object-identity/fail-close, cross-process run-lock, infrastructure-drain, scale-operation, package ESM/CJS/TS, LOC/DAG/SCC, declaration, and byte-characterization proofs | Keep auth parsing a direct safe-projection re-export with no remote runner/internals; preserve exact CommandSpec authority and adapter cleanup, Node timer limits, guarded claim-time identity/content/policy/resource binding, immediate fatal claim closure plus settled worker drainage, mutation no-auto-retry, per-resource FIFO/min-ready-heap scheduling and event/claim order, successor exposure only after stop, per-result resume stop, one run-directory lock domain with live-scope drainage, internal-only ownership metadata, host-aware stale handling, bounded acyclic internals, and a closed package root/internal tree. |
| session, OAuth, auth, env, credential-safety, or remote adapter helpers under `src/lib/{auth-*,credential-safety,oauth-*,dotenv,env,supabase-*,remote,http}*`, plus command-local remote adapters such as explicit identity-preflight hybrid search | `pnpm lint`; `pnpm test`; `pnpm build`; focused `oauth-pkce`, `oauth-loopback`, `oauth-session`, `supabase-session`, and auth CLI tests | run `pnpm test:coverage && pnpm test:coverage:assert-full`; run one Dev login/refresh/revocation case only when a registered client and explicit live authorization are in scope | OAuth proof must retain S256/state/exact loopback, shell-free browser launch, bounded token/UserInfo responses, private atomic rotating session, rejection of removed legacy modes, local logout vs grant revocation, and memory-only verified headless access tokens. Record live env/client assumptions in the PR note. Identity receipt changes additionally require secret-leak scans, exact receipt parsing/hashing, and an intent-bound argv case; production read cases remain local and read-only. |
| flow, process, dataset, lifecyclemodel, review, publish, release, or run command families | `pnpm lint`; `pnpm test`; `pnpm build` | run focused tests for the touched command family; run `pnpm test:coverage:assert-full` if the change touched uncovered branches; prefer `pnpm prepush:gate` when the change adds new command paths | Preserve the low-entropy command contract and structured artifact outputs, including BuildPlan, review/dedup ruleset, publish schema, and verification gate reports when authoring or publish commands are involved. LCI/LCIA release proof must preserve manager-only mutation boundaries, exact four-ZIP upload identity/integrity, masked credentials, manifest-path selection, and byte/hash-verified atomic downloads. Dataset maintenance proof must also cover exact-count account pagination under server caps, plan immutability, current-user RLS/protected-row guards, drift rejection, approval-before-write, append-only action logs, stop/resume behavior, and fresh readback. Atomic alias work additionally requires exact closure, arbitrary-precision amounts, one RPC for the complete two-batch plan, and plan/batch/row/exchange proof-chain tests. Protected preparation additionally requires production-read-only freeze, offline byte-exact seal, canonical released-toolchain evidence, exact 23/27 derivative capture, and zero-write/zero-network separation. Derivative rebuild additionally requires single-action/component allowlists, action-scoped snapshots, guarded-RPC admission/replay, unchanged primary fields, and asynchronous terminal verification tests. |

For runtime-rule composition changes, run `pnpm verify:tidas-public-rules`, the focused `runtime-rulesets` tests, and the full Node 24.19.0 `pnpm prepush:gate`. Proof must cover SDK/fallback equivalence, API absence, malformed/not-covered/stale/incompatible input, public/local ownership collisions, unknown profile references, and unchanged Process/Flow gate artifacts. | artifact, IO, or state-lock behavior | `pnpm lint`; `pnpm test`; `pnpm build` | run one representative command path that writes the changed artifact layout, if safe | Path and file layout regressions matter for downstream automation. | | `test/**` or coverage gate scripts | `pnpm lint`; `pnpm test`; `pnpm test:coverage`; `pnpm test:coverage:assert-full` | run `pnpm prepush:gate` when the change affects the protected-branch gate directly | Coverage for `src/**/*.ts` is expected to remain at `100%`. | | `.gitignore`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.nvmrc`, `.oxlintrc.json`, `scripts/ci/**`, or `.github/workflows/**` | `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm peers:check`; `pnpm test:package`; `pnpm test`; `pnpm build` | run `pnpm outdated --format json` and document only runtime-major compatibility exceptions; run `pnpm prepush:gate`; run the four-platform `quality-gate` for release workflow changes; after a real publish run `pnpm release:verify-published -- --version <x.y.z> --expected-git-head <release-merge-sha>`; run `docpact lint` when the change affects release or documentation gates | Package-manager, TS7/Oxlint, release-tag, workflow, public-consumer, and dependency baselines change the repo contract. Node 24 keeps the latest 24.x typings rather than Node 26. | | governed docs only | `scripts/docpact validate-config --root . --strict`; `scripts/docpact lint --root . --staged --mode enforce` | run one focused route check, such as `command-surface`, `remote-session`, or `validation-release`, when the change touches routing or release docs | Refresh review metadata even when prose-only docs change. |

## Coverage Notes

Facts that matter:

- `pnpm --version` must be exactly `11.24.0`; `pnpm-workspace.yaml` and the sole root `pnpm-lock.yaml` are the only dependency-resolution authorities
- Node must be exactly `24.19.0` for local/CI and package engines must be `>=24.19.0 <25`; TypeScript resolves only to `7.0.2`, and type-aware Oxlint is the only lint engine
- `pnpm test:package` verifies package-manager/TS7/Oxlint/CI contracts, inspects a clean tarball, and exercises a package-manager-neutral consumer
- public primitive proof must keep `@tiangong-lca/cli/auth-identity-receipt`, `@tiangong-lca/cli/command-spec`, `@tiangong-lca/cli/batch`, and `@tiangong-lca/cli/bin/tiangong-lca.js` importable from packed ESM/CJS/TS consumers without publishing Node typings or enabling package-root/deep imports
- `pnpm test:coverage` is the full coverage proof
- `pnpm test:coverage:assert-full` verifies the latest coverage artifact without rerunning coverage
- `pnpm prepush:gate` is the exact local test gate
- `pnpm peers:check` is part of that gate; direct dependencies are latest stable for Node 24 and `@types/node` remains on latest 24.x
- the local `pre-push` hook runs docpact first and then `pnpm prepush:gate`
- `.github/workflows/quality-gate.yml` supports manual exact-head reproduction and reusable invocation; its four exact matrix entries fail closed on actual `process.platform`/`process.arch`, and a detected CLI version change must pass them before tag creation
- every Node workflow bootstraps through pinned `pnpm/setup` v2.0.2 with Node 24.19.0 and installs with `pnpm install --frozen-lockfile`; publishing uses native pnpm OIDC/provenance
- `pnpm release:verify-published -- --version <x.y.z> --expected-git-head <release-merge-sha>` is the post-publish cryptographic Sigstore/registry-signature/tarball/public-consumer gate; it fixes pnpm 11.24.0, replaces user/global package-manager configs, scans every production dependency branch, and passes no TianGong or registry credential into the clean consumer
- `process save-draft`, `lifecyclemodel save-draft`, ordered `dataset save-draft --execution-contract`, dataset governance commands such as curation queue build/next/verify, BuildPlan gates, publish schema/verification gates, and the newer process maintenance commands are expected to preserve `100%` coverage even when they add schema-validation, rewrite, recovery, or fallback branches
- dataset save-draft scheduler dogfood must leave the complete dependency prefix serial and keep `executeAction` as the only owner of durable attempt-before-dispatch, exact readback, UNKNOWN/no-replay, row reports, and report bytes; a generic batch failure may stop new suffix claims but cannot synthesize a command outcome
- the stored draft is verified with the same real validator on a clone, and tests must prove it: a before with a placeholder reference description, a schema failure or a second authoring gap is refused even when the candidate would repair it, and the stored-draft verdict is a required input of the admission decision rather than an assumption from structural similarity
- the verified admission is hash-bound into the first attempt event: a crash-after-dispatch-before-outcome fixture (remote already at the desired content, only the attempt event left) must recover without dispatch, resolve by exact readback, and return the original admission with `validation.ok=false`; a rerun with a terminal outcome returns the same admission without writing; a tampered, dropped, non-object, non-array or semantically drifting admission must be rejected by the ledger check, while a legacy attempt without the field stays compatible and is never given an invented admission
- existing-Process metadata repair tests must use a real SDK-valid Process fixture and prove that only a bounded contract `save_draft` whose sole authoring failure is `annual_supply_or_production_volume_missing` with both sides' `annualSupplyOrProductionVolume` unchanged at `[]` is admitted; the write sends the complete fresh before image with `ruleVerification=false` and records `draft_repair_admission` while the row keeps `validation.ok=false`; wrong owner, stale before hash, non-draft state, schema failure, any other authoring code, science/identity/language/shape changes, an unchanged payload, a changed or absent annual field, inserts and contract-less commands must all fail without dispatch; a fully valid candidate keeps the ordinary `ruleVerification=true` path
- retained-attempt tests must prove that a candidate the current validator rejects can never be reported as an unconsumed failure: with a real pre-seeded ledger the commit run resolves by readback only (`attempt_consumed=true`, original attempt bytes preserved, no dispatch) and the dry-run reports `blocked` with `retained_attempt`/`retained_outcome` and byte-identical ledger state, while a row without ledger evidence keeps its unchanged validation classification
- guarded before-image transport and contract dry-run tests must prove that a `save_draft` dispatch carries the exact before image read in that run as `expectedJsonOrdered`, that a guard rejection is terminal (exactly one dispatch, no fallback to the unguarded save, readback-only `UNKNOWN` outcome), that a legacy save body stays byte-identical without the field, and that a contract dry-run needs the env/fetch runtime bindings, loads the ledger read-only without creating a directory or rewriting bytes, dispatches nothing, rejects `--max-parallel > 1`, preflights an existing-draft dependency chain whose earlier actions are prepared, blocks descendants of a drifted root, reports retained attempts/outcomes as `blocked` (`retained_attempt`/`retained_outcome`), and reports a reference only an earlier insert action creates as `blocked_dependency` while still failing a genuinely unresolved reference
- LCI/LCIA release tests must cover all public actions and error branches without real credentials: user-session bootstrap is stubbed, remote error codes are preserved, upload request metadata is bound to local files, Calculation Bundle artifact selection is exact-path only, credentials stay masked, and no file becomes visible before size/hash verification succeeds. Live smoke tests, when explicitly authorized, use a disposable release identity and a real `data_product_manager` account through the public Edge/Database path; service-role or direct SQL evidence is invalid.
- Dataset maintenance tests must prove exact `id` + `version`, expected state, and current-account ownership are enforced; rows outside the explicitly authorized owner-draft alias profile remain protected; no action runs after full-plan drift or approval mismatch; approval is persisted before the first mutation; each attempted action is appended durably to `apply-progress.jsonl` with plan/action/mode correlation, actor, timing, before/after hashes, result/error, and rollback fields; and `verify` performs its own remote readback instead of trusting `apply` output.
- Exact-count pagination tests must prove that a requested page size such as 5000 still follows a 1000-row server cap with offsets `0,1000,2000...`; an exact multiple terminates without a speculative empty request; a true zero result accepts `*/0`; and missing/invalid/changing totals, early empty pages, range/body mismatch, page overflow, rows beyond total, missing/duplicate/out-of-order identities, foreign-owner rows, malformed/duplicate aggregate table proofs, or partial aggregate table sets fail closed. `plan`, apply preflight, and `verify` must not produce an accepted artifact or write after an incomplete scan. `clear-account` must execute zero deletes after an incomplete initial scan, re-read all five tables at the end, require aggregate `row_count=0` for success, and retain a failure audit if the final proof cannot complete after mutation starts. The evidence proves pagination completeness under stable filtered membership/order, not transaction-level/MVCC snapshot isolation.
- Alias-plan tests must prove exact ordered `time`/`length_time` and `target_mode=owner_draft` binding; factors `0.00011415525114155251`/`1000` without binary floating point; 52 row and 59 exchange identities; embedded UUID/version preservation; 309 unrelated exchanges unchanged; source-reference zeroing and fixed target postconditions; exactly one `target_visibility=owner_draft` `cmd_dataset_alias_plan_guarded` call; rollback of the first 25 rows when the second dimension fails; whole-plan lost-response replay; rejection of public/foreign/mixed/stale or 25-row partial state; and rejection of numeric, foreign, duplicate, or mismatched plan/batch/row audit ids. CLI accepts audit ids only as positive-integer strings so PostgreSQL bigint values cannot lose precision in JavaScript. Verify validates returned plan and nested batch proofs with their local correlation, but does not independently query `public.command_audit_log`; the guarded RPC remains responsible for audit-row creation and replay proof.
- Derivative-rebuild tests must prove `operation=rebuild-derivatives` and `action=rebuild_derivatives` are bidirectionally bound; V1 accepts exactly one exact-version `processes` row with current owner, `state_code=0`, `target_mode=owner_draft`, and exactly `extracted_md` plus `embedding_ft`. They must reject zero/multiple actions, other tables/components, public/foreign/non-draft rows, malformed snapshots, and pre-apply drift. Plan tests must prove the action-scoped database snapshot is included without adding large derivative columns to the account-wide scan. Apply tests must prove exactly one guarded-RPC admission, durable `accepted`/`queued` reporting, idempotent lost-response replay with the same request identity, and no direct Edge, `admin embedding-run`, raw queue, SQL, service-role, or raw REST mutation path. Approval alone must not skip the exact just-in-time preflight; only a valid immutable `derivative-admission-attempt.json`, created immediately before transport and bound to the same plan/action/snapshot/actor, may enable lost-response recovery. Tests must also prove the ordinary sequential executor rejects derivative and unsupported actions before any mutation transport. Verify tests must cover `pending`, `passed`, and `failed`, require both requested derivatives to be current, and fail if any frozen primary precondition changes; an apply admission report alone can never pass verification.
- Protected alias-runner tests must prove commit/status-only mutual exclusion; production project and exact actor/plan/freeze/approval/target-set/baseline bindings; no full rescan after server preflight; three ordered server-derived gates within 180 seconds; immutable per-attempt artifacts; one admission POST maximum; no automatic retry, restart replay, Dev replay, generic apply, or legacy-RPC fallback; read-only recovery for timeout, cancellation, lost response, and transient status-read failures; immutable first terminal evidence; and later-live-drift reporting without canonical overwrite. Contract tests must accept exact zero-child `not_started` derivative evidence only for active pre-dispatch states or terminal `failed`/`indeterminate`, while rejecting it for `completed` and `derivatives_pending`. Terminal verification must require exact 52 rows, 59 exchanges, 55 audits, 50 unique targets with a 23/27 table split, causal Markdown/embedding proof, and independent live RLS snapshot equality.
- Protected preparation tests must prove `freeze-protected` performs complete account/support/projected-reference checks and exactly 50 derivative snapshot reads in stable 23-flow + 27-process order while making zero preflight, gate, admission, execution, or mutation calls. Every derivative snapshot must match the immediately preceding census row identity, owner, state, and `modified_at`; concurrent primary drift must fail before freeze artifacts. Tests must reject non-production project evidence, mismatched running CLI/package evidence, malformed or non-canonical toolchain/freeze/request files, public/foreign/non-draft targets, duplicate or incomplete targets, and each superseded historical plan SHA-256. `seal-protected-approval` must receive no environment, session, HTTP, or remote adapter; tests must prove raw-byte hashing, fatal invalid-UTF-8 rejection, exact whitespace/final-newline preservation, explicit freeze-file/request/text/account/timestamp guards, immutable artifacts, and unchanged acceptance by the existing protected runner/parser and production approval-identity algorithm. The canonical `approved_at_utc` must be present in the pre-review request hash/text, and resealing with any other timestamp must fail.
- Live maintenance validation, when explicitly authorized, must use a disposable current-user draft scope and the official platform command path. Direct SQL, service-role credentials, or raw REST mutation are never acceptable test evidence.
- release-tag and docpact lint workflow changes should be described in the PR note when they alter the local or protected-branch proof
- `tag-release-from-merge.yml` is idempotent when the expected `cli-v*` tag already points at the merge commit, and `publish.yml` can be re-run with `workflow_dispatch` only for an existing `cli-v*` tag on `origin/main`
- local npm authentication is not release validation evidence; routine publication is verified by the upstream tag workflow and npm Trusted Publishing workflow after merge

If the task changes control flow, add or update tests instead of using coverage-ignore pragmas.

Process mass QA tests must prove count and canonical area-time are not added to kg, mass-valued fuels and scaled mass units remain included, exact reference/version/occurrence conflicts and malformed selections fail closed, quantity and aggregate overflow remain actionable, zero-input ratios are not fabricated, and source quantities remain byte-stable. The CLI transport must retain every explicit reference file. Both the new unit owner and existing QA module remain subject to exact full-source coverage without exclusions; local focused coverage alone is not the release gate.

Exact-reference tests must cover default latest behavior, explicit older/public/own-draft success, fresh actor/project mismatch, root and undeclared-reference preservation, role/path collisions, consumer/control-file drift, selected/latest owner/state/payload mismatch, missing transport evidence, exact-payload/review caching, and zero mutation through the real RLS adapter with controlled HTTP responses. The parser and verifier remain under the whole-source 100% gate. See [the protocol contract](exact-reference-intent-contract.md).

## Minimum PR Note Quality

A good PR note for this repo should say:

1. which commands ran
2. which focused tests or help paths were exercised when the change touched one command family
3. whether the full protected-branch gate was run or deferred

## Local Docpact Push Gate

Install the versioned local hook once per checkout:

```bash
./scripts/install-git-hooks.sh
```

The `pre-push` hook runs `scripts/docpact-gate.sh`, which delegates CLI lookup to `scripts/docpact` and performs strict config validation plus enforced lint before the push leaves the machine. It then runs `pnpm prepush:gate` as the local test gate, including `pnpm test:package` and exact 100% source coverage. Only the verified branch-deletion-only exception above returns before both gates; source and tag pushes retain full validation. The wrapper checks `DOCPACT_BIN`, Cargo install locations, Homebrew install locations, and then `PATH`, so local agent shells should not fail only because bare `docpact` is unavailable. The default comparison base is `origin/main`. Override it for unusual stacks with `DOCPACT_BASE_REF=<ref>` or `scripts/docpact-gate.sh --base <ref>`. The gate writes its detailed report to a temporary file so normal pushes do not create `.docpact/runs/` artifacts.

## Version-bound source profile (CLI #312)

Each published CLI version maps to exactly one source identity; no version may choose freely between identities:

- `<= 0.1.14` (legacy): repository `tiangong-lca/tiangong-cli`, repository id `1194220834`, owner id `199785309`, tag ref `refs/tags/cli-v<version>`.
- `future versions` (current): repository `tiangong-lca/cli`, repository id `1194220834`, owner id `327771381`, tag ref `refs/tags/cli-v<version>`.

The repository id is the continuity anchor across the migration (identical on both sides); the owner id differs and the legacy owner id stays bound only to historical evidence. Mixed fields across the two profiles are rejected. `scripts/ci/release-context.sh` enforces the current profile (name, numeric repository/owner ids, tag-ref dispatch binding) and is executed against real git fixtures by `test/workflow-release-context.test.mjs`; the verifier enforces the same profile through certificate OIDs, exact SAN/issuer, signed workflow/source/event/builder fields, one tarball subject and one resolved dependency. CT and Rekor remain mandatory.

Publication floor: new-identity publication (tag creation and release) requires a version above the frozen legacy ceiling `CLI_LEGACY_LAST_VERSION` (0.1.14), as classified by the shared `src/lib/cli-repository-identity.ts` helper via `scripts/ci/check-publication-floor.cjs`. The publish release-context guard rejects legacy-ceiling versions for both tag pushes and exact-tag dispatch, and the tag-creation automation enforces the same floor before creating `cli-v*` refs, so an unused lower/backport version can never be published under the current identity and become unverifiable. This rule does not select the next release version; unchanged-version main source PRs remain no-release. Historical tags and registry packages stay immutable.

The event SHA and workflow-definition SHA are separate facts (`github.sha` and `github.workflow_sha`). Both tag pushes and exact-tag dispatch must match the resolved release commit; a moved tag or divergent workflow fails before publication. The workflow regression reads the actual YAML-to-shell bindings so one SHA cannot be substituted for the other. The shared source policy is loaded as ESM by the private CommonJS helpers without requiring a build or application runtime imports.

Git-backed test fixtures must clear inherited repository routing (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, index/object paths and prefix) before running Git or release-shell commands in temporary repositories. Preserve scoped configuration/credential inputs. The release-context suite exercises a foreign Git hook environment and verifies its config, HEAD, index and files remain byte-identical. This isolation is required when the suite runs from the pre-push hook in a linked worktree.
