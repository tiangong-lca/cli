---
title: Existing CLI runtime safeguards
docType: contract
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - adapting existing runtime helpers during the refactor
whenToUpdate:
  - when the documented scope or behavior changes
checkPaths:
  - AGENTS.md
  - src/lib/**
lastReviewedAt: 2026-11-13
lastReviewedCommit: dd02e887a2e75d8ab8f636560736ba6b97d1d9d0
lastReviewedNote: 'Reviewed signed Model connection guidance and bounded port/amount/coefficient diagnostics; existing calculation, runtime selection and delivery contracts remain unchanged.'
---

# Existing runtime safeguards

These constraints govern the current CLI, shared algorithms and specialized protocols. Target capabilities are defined in the interface design; implementation status is recorded separately. Cleanup must preserve authorization, unknown-outcome recovery, scientific validation, public interfaces and release requirements.

## Specialized contracts

Study commands follow `docs/agents/study-cli-contract.md`. Edge owns the contained portable wire codec; CLI owns private pre-dispatch intent and actor/client/destination recovery binding. A worktree codec is task-local development evidence only, never a Production/release trust claim. Study installation grants no remote capability. CLI #462 deliberately adopts the existing qualified Edge #556 V2 archive response correction while retaining V2 wire 2.0.0, valid historical journals and unchanged V3–V5/renderer1–2 bytes; rejected archive successes remain unknown with explicit original-intent recovery. Explicit V6 method evidence/assessment/report/review/share consumes the contained owner interface and export4/view3/renderer3; owner hashes and exact immutable journals remain separate from local scientific evaluation, professional approval and actual runtime qualification. P2 analysis/report/export selects v3 independently; P3 review/finalization/named sharing selects v4, retaining historical signatures and exact-key recovery. Member/export upgrades require an explicit API selection. Detached signature/view binding uses the same fixed owner renderer; bundled artifacts pin clean committed Edge/Platform source. Future worktree candidates remain loopback development-only, and source provenance does not grant hosted activation, permission or public-release trust.

Private live-account testing is maintainer-only and requires explicit account authorization. Follow [the live case guide](../../docs/agents/live-case-testing.md); public CLI authentication remains OAuth-only and personal credentials never enter public CI.

Read-side exact-reference verification follows `docs/agents/exact-reference-intent-contract.md`. Keep strict consumer/actor/reference/review binding and current input rechecks in the CLI owner; preserve default latest/root policy and current-user RLS. Foundry transports the evidence without implementing eligibility or treating a review file as write authority.

## Runtime Facts

- Repo-local documentation governance is encoded in `.docpact/config.yaml` and enforced locally by the pre-push docpact gate; `.github/workflows/ai-doc-lint.yml` is manual-dispatch fallback.
- Package manager: exact `pnpm@11.24.0`, with one root workspace and lockfile
- Compiler and lint: `typescript@7.0.2` plus type-aware Oxlint; no TypeScript 5/6 or ESLint bridge
- Node baseline: exact local/CI `24.19.0`; package engine range `>=24.19.0 <25`
- Direct dependency baseline: Supabase JS `2.118.0`, exact published TIDAS SDK `0.5.1`, lint-staged `17.4.1`, Prettier `3.9.6`, and tsx `4.23.13`; `@types/node 24.13.3` remains on the compatible Node 24 line. `pnpm peers check` must pass before package and coverage proof.
- Runtime style: TypeScript source, Node-native CLI, direct REST and Edge Function access only
- Public library surface: `@tiangong-lca/cli/auth-identity-receipt`, `@tiangong-lca/cli/command-spec`, `@tiangong-lca/cli/batch`, and `@tiangong-lca/cli/runtime`; the package root and internal deep paths are intentionally not APIs. The auth entry exports only the strict parser/constants/types, while CommandSpec `display` remains non-authoritative, execution is shell-free, and bound artifacts are rehashed before spawn.
- Public batch safety: all item identity/content/policy/resource projections validate before work and again before resumed acceptance or fresh claim; identity drift or getter failure has an explicit error/event and zero execution, and every in-flight worker drains before return. Escaping scheduler/event/stop infrastructure errors synchronously close new claims, drain only already-claimed workers through settled aggregation, and rethrow the first recorded cause. Exclusive keys must be runtime strings; per-resource FIFO cursors expose only the earliest ready heads through a private ordered min-heap, so same keys serialize, blocked keys remain unclaimed without occupying workers, later free keys retain bounded concurrency, and ordinary scheduling stays near `O(n log k)`. Mutation retry is rejected, incomplete attempts require explicit readback recovery, resume requires exact run/item contracts, every pre-claim result can trigger stop before its same-key successor becomes ready, and event delivery is monotonic plus awaited. Retry policy/backoff delays cannot exceed Node's timer maximum.
- Internal lock failures preserve stable conflict/timeout codes at the CLI boundary without changing the public constructors or exposing owner/path metadata.
- Public run-lock safety: one canonical run directory is one file-lock domain across identities and processes. Reentrancy is limited to a live nested scope owned by the current holder; completed async contexts and siblings contend. The top-level promise remains pending until every nested scope drains, foreign-host or live locks are never stale-deleted, and local waiters wake only after physical lock cleanup. PID, host, and ownership time are internal facts, not public options; timeout/poll inputs are non-negative safe integers within Node's timer maximum.
- `auth identity-receipt` uses `src/commands/auth.ts` for shared presentation, `src/cli.ts` for composition and `src/lib/auth/auth-identity-receipt.ts` for authoritative identity semantics. It is read-only and must live-verify `/auth/v1/user`; cache email, local JWT decode, raw response bodies, and credential-derived fingerprints are not identity evidence. Production callers must supply both expected assertions and accept only `intent-bound` receipts. The shared CLI result carries that exact safe projection under `data.receipt`; `--output` writes the standalone receipt. Offline consumers parse the projection through the unchanged public `./auth-identity-receipt` entry rather than an internal path.
- `auth login|status|whoami|doctor-auth|logout`, `src/lib/auth/oauth-pkce.ts`, `src/lib/auth/oauth-loopback.ts`, and `src/lib/auth/supabase-session.ts` own the CLI OAuth boundary. OAuth client IDs and redirect URIs are public configuration; authorization codes and PKCE verifiers never enter argv or disk; access/refresh tokens never enter stdout, reports, or command artifacts. Status is local and non-mutating; whoami uses the live redacted identity receipt; doctor-auth keeps that canonical path for Production/default and uses the distinct local-only diagnostic for an explicit complete loopback tuple. Logout deletes only the matching local session; grant revocation remains the Connected applications action in Next.
- `src/lib/config/env.ts` owns the single official Production public profile (URL, publishable key, CLI client, registered callback, region). A clean installed consumer needs only `auth login`; missing local sessions produce `login-required`, not missing-client setup. Blank public fields and exact Production URL aliases can use defaults. Custom URL/key/client/callback values disable profile completion; complete project-matching custom configuration is required, and known Production key/client values with a foreign URL are rejected before browser/network access. Skills must not copy this profile.
- Auth selection is deterministic: explicit `TIANGONG_LCA_AUTH_MODE` wins; otherwise a short-lived access token or the resolved OAuth client selects the mode. No legacy API-key path remains. Headless access-token mode requires an explicit destination and publishable key, has no disk cache, and has no refresh replay. Configured-only remote-executor detection must not inherit the Production defaults or silently enable remote publish.
- Old Process production/QA roots and generic Dataset routes are removed from help, parsing and dispatch. Only implementations needed by current adapters and retained protocols remain; old workflow implementations and exclusive tests are removed.
- Public local content operations use `dataset <type> validate/patch/translations/list-references`. Internal curation and reference-rewrite helpers do not create standalone public commands.
- `dataset maintenance plan/apply/verify` owns current-user RLS-scoped row maintenance in `src/lib/maintenance/`. Plans bind exact `id` + `version`, `state_code=0`, current-session ownership, frozen payloads and complete exact-count snapshots. Ordinary `save_draft` / `delete` actions are limited to `contacts`, `sources`, `flows` and `processes`. Apply retains exact plan/account confirmation, audit correlation, drift and reference closure checks, and durable readback recovery.
- `rebuild-derivatives` is a separate derivative-only profile: exactly one current-owner state-0 `processes` action, `action=rebuild_derivatives`, `target_mode=owner_draft`, and the exact components `extracted_md` plus `embedding_ft`. Its plan binds an action-scoped database snapshot, apply only records guarded-RPC admission as `accepted`/`queued`, and verify alone resolves `pending`/`passed`/`failed` without changing the process primary payload or `modified_at`. The derivative worker/queue surfaces are not authenticated CLI paths. Public/shared, foreign-owner, mixed-visibility, non-draft, lifecyclemodel, and every other support-table mutation remain protected.
- `src/lib/maintenance/pagination.ts` owns fail-closed account-scan pagination for row-level maintenance and `clear-account`. It requests `Prefer: count=exact`, treats the configured page size as a requested maximum rather than a guaranteed response size, advances offsets by the number of rows actually returned, and accepts a scan only when exact totals, ranges, ordering, identities, and aggregate entity counts prove pagination completeness under stable filtered membership/order. Incomplete scans stop before maintenance artifacts or mutation gates; the resulting proof does not claim transaction-level snapshot isolation across requests.
- `src/lib/validation/runtime-rulesets.ts` verifies source-bound released public definitions and exact SDK/fallback equivalence. Discovery does not claim an executed gate or define permission. CLI validation and contract owners apply their own explicit consumer policy.
- The canonical minimum validation command is `pnpm lint`. Type-aware Oxlint is the only linter; the retired ESLint and TypeScript Compiler API lint paths must not return.
- The authoritative full gate is `pnpm prepush:gate`; it includes `pnpm test:package`, the exact 100% coverage proof, and the coverage assertion. The local pre-push hook runs it after docpact for source pushes; only a complete, verified branch-deletion-only stdin stream skips both gates as documented in the validation guide.
- Release tagging is guarded in `.github/workflows/tag-release-from-merge.yml` so only the upstream repository can execute the merge-tag flow. Its detector runs under exact Node 24.19.0; it calls the reusable four-platform `.github/workflows/quality-gate.yml` only for a CLI release, every job asserts exact runtime platform/architecture, and `cli-v<version>` tag creation depends on all four. `.github/workflows/publish.yml` publishes from that tag and also supports `workflow_dispatch` for existing-tag recovery/backfill.
- CLI package releases must go through a version-bump PR merged to upstream `main`; routine publication must not originate from a local workstation. The release-prep PR updates `package.json`; the sole root `pnpm-lock.yaml` remains frozen and unchanged unless an explicitly reviewed dependency change requires pnpm regeneration. Issue #230's only graph exception is exact dev-only `sigstore@5.0.0`; published runtime dependencies stay unchanged. Merge creates `cli-v<version>`, and GitHub Actions uses pinned `pnpm/setup` v3.1.1 plus native pnpm OIDC/provenance publication through Trusted Publishing.
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

The `pre-push` hook runs `scripts/docpact-gate.sh`, which delegates CLI lookup to `scripts/docpact` and performs strict config validation plus enforced lint before the push leaves the machine. It then runs `pnpm prepush:gate` as the local test gate. The sole exception is a complete, verified branch-deletion-only stdin stream: it publishes no source. Tags, source/mixed updates, empty/TTY/malformed input and classification failures retain both gates. The wrapper checks `DOCPACT_BIN`, Cargo install locations, Homebrew install locations, and then `PATH`, so local agent shells should not fail only because bare `docpact` is unavailable. The default comparison base is `origin/main`. Override it for unusual stacks with `DOCPACT_BASE_REF=<ref>` or `scripts/docpact-gate.sh --base <ref>`. The gate writes its detailed report to a temporary file so normal pushes do not create `.docpact/runs/` artifacts. The GitHub `quality-gate` automatically validates dependency/configuration/Actions PRs targeting main and supports manual exact-head reproduction and reusable invocation; a detected CLI release must pass its four-platform invocation before the tag job can run.

PCR content discovery, task pins and forced local reader execution belong to `src/lib/pcr/**`; see `docs/agents/pcr-snapshot-contract.md`. PCR owns offline reader and scientific semantics. Task snapshots and selected installed tool bytes are immutable; release and snapshot source fingerprints use different hash domains. No runtime dependency or executable installation is added.

Study P4 consumption uses separately negotiated V5, immutable owner assets and versioned renderer2/view2/export3. Existing journals, defaults and historical renderer1 artifacts remain separate. The Study CLI contract owns exact pins, rollback-safe historical reads and the distinction between package proof and actual installed runtime qualification.

## Maintenance and historical evidence

Ordinary maintenance and derivative-only rebuild have separate admission contracts. A derivative admission is accepted/queued; only independent verification establishes terminal freshness. Installation or a readable artifact does not prove deployment admission.

Specialized Alias, Length×time and Flow-identity repair profiles have no command, client RPC, planner or executor in the current package. Ordinary scope and plan parsing reject their operations, action kinds and batch bindings before transport. Zero-valued summary fields in ordinary version-1 plans remain hash-bound inert metadata; they grant no repair capability.

Historical plans, approvals, attempts and server ledgers keep their original identity and consumed-attempt rules. Removal does not cancel, complete, retry or migrate an operation. Recovery and historical verification require the matching original client and its owner contract; ordinary maintenance is not a substitute. No downstream workflow is recreated here.
