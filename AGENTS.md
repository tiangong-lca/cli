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
  - when routing work from the workspace root into `cli`
  - when deciding whether a change belongs here, in `agent-skills`, in `mcp`, or in a remote runtime repo
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
lastReviewedAt: 2026-09-23
lastReviewedCommit: 456ec7beed6ade9a2af6f42cbb6561d2a2cc22e4
lastReviewedNote: 'Current command ownership, runtime boundaries, validation gates, and workspace integration rules are reviewed.'
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

# CLI Repository Contract

`tiangong-lca/cli` owns the checked-in public `tiangong-lca` CLI contract: command nouns and verbs, launcher behavior, local artifact workflow, remote session/auth handling, and the repo-level release gate. Start here when the task may change what the CLI does or how it is validated.

## Specialized contracts

Private live-account testing is maintainer-only and requires explicit account authorization. Follow [the live case guide](docs/agents/live-case-testing.md); public CLI authentication remains OAuth-only and personal credentials never enter public CI.

Process QA consumes explicitly selected exact Flow/Flow Property/Unit Group evidence through `process-mass-balance.ts`; `process-qa.ts` owns report/finding projection. Keep nonmass or unresolved applicability separate from a physical mass result, retain null unavailable values and hash-bound evidence, and never infer arbitrary composite units or use a version label to restore mixed-dimension arithmetic. Foundry #122 owns downstream evidence selection and transport.

Explicit exact-reference verification follows `docs/agents/exact-reference-intent-contract.md`. Keep strict consumer/actor/reference/review binding and current input rechecks in the CLI owner; preserve default latest/root policy and current-user RLS. Foundry transports the evidence without implementing eligibility or treating a review file as write authority.

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

- `agent-skills` for skill wrappers and `SKILL.md` packages
- `mcp` for MCP transports and tool registration
- the owning runtime repo for API, schema, or product behavior
- `lca-workspace` for root integration after merge

## Runtime Facts

- Repo-local documentation governance is encoded in `.docpact/config.yaml` and enforced locally by the pre-push docpact gate; `.github/workflows/ai-doc-lint.yml` is manual-dispatch fallback.
- Package manager: exact `pnpm@11.24.0`, with one root workspace and lockfile
- Compiler and lint: `typescript@7.0.2` plus type-aware Oxlint; no TypeScript 5/6 or ESLint bridge
- Node baseline: exact local/CI `24.19.0`; package engine range `>=24.19.0 <25`
- Direct dependency baseline: Supabase JS `2.112.4`, exact published TIDAS SDK `0.2.2`, lint-staged `17.4.1`, Prettier `3.9.6`, and tsx `4.23.13`; `@types/node 24.13.3` remains on the compatible Node 24 line. `pnpm peers check` must pass before package and coverage proof.
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
- `src/lib/runtime-rulesets.ts` composes released, exact source-bound public definitions with CLI-local activation policy for stable ruleset ids, methodology rule ids, severity, phases, and blocker semantics used by review, dedup, and publish gate artifacts. SDK 0.2.2's public API is accepted only after equivalence checks; the bundled copy is a hash-bound no-API fallback. `src/lib/dataset-contract-ruleset.ts` projects the separate CLI-owned context profile and preserves requested artifact paths without reading SDK mixed ruleset assets.
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

A merged PR in `tiangong-lca/cli` is repo-complete, not delivery-complete.

If the change must ship through the workspace:

1. merge the child PR into `tiangong-lca/cli`
2. update the `lca-workspace` submodule pointer deliberately
3. complete any later workspace-level validation that depends on the updated CLI snapshot

## Local Docpact Push Gate

Install the versioned local hook once per checkout:

```bash
./scripts/install-git-hooks.sh
```

The `pre-push` hook runs `scripts/docpact-gate.sh`, which delegates CLI lookup to `scripts/docpact` and performs strict config validation plus enforced lint before the push leaves the machine. It then runs `pnpm prepush:gate` as the local test gate. The sole exception is a complete, verified branch-deletion-only stdin stream: it publishes no source. Tags, source/mixed updates, empty/TTY/malformed input and classification failures retain both gates. The wrapper checks `DOCPACT_BIN`, Cargo install locations, Homebrew install locations, and then `PATH`, so local agent shells should not fail only because bare `docpact` is unavailable. The default comparison base is `origin/main`. Override it for unusual stacks with `DOCPACT_BASE_REF=<ref>` or `scripts/docpact-gate.sh --base <ref>`. The gate writes its detailed report to a temporary file so normal pushes do not create `.docpact/runs/` artifacts. The GitHub `quality-gate` supports manual exact-head reproduction and reusable invocation; a detected CLI release must pass its four-platform invocation before the tag job can run.
