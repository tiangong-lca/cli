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
lastReviewedAt: 2026-11-14
lastReviewedCommit: 11d71916c1cf9332ed4beee023a5dca6ba0589c1
lastReviewedNote: 'Reviewed signed Model connection guidance and bounded port/amount/coefficient diagnostics; existing calculation, runtime selection and delivery contracts remain unchanged.'
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-validation.md
  - ../../README.md
  - ../../DEV_CN.md
---

The `src/runtime.ts` public facade and bounded `src/lib/runtime/**` owners expose package/Node/asset identity through one read-only API and `runtime describe`. [The runtime distribution contract](runtime-distribution-contract.md) separates this package observation from complete component/dependency provenance, host ABI readiness and task authorization. `src/main.ts` admits supported architecture tuples before loading user configuration and bypasses dotenv for runtime commands. The manifest/manager/cache/lease/exec owners are under `src/lib/runtime/**`, and the no-Node POSIX/PowerShell bootstrap is under `scripts/bootstrap/`. Product component assembly remains downstream.

Managed-host launch selection stays in the generic CLI manager. Dedicated protocol/server/receiver modules hand the exact verified manifest to a declared Node host through a one-use IPC handshake. Original manifest bytes, selected host fields and application argv are owned snapshots; the receiver uses the existing cache/compatibility owners and shared work-directory guards. Product hosts retain their own task, account and business authorization. Cancellation ends handshake admission before child termination, and execution leases remain until output/process closure.

## 0.2.0 command layers

`src/cli-composition.ts` resolves production defaults once, and `src/cli.ts` routes the typed Dataset, Review, environment and authentication adapters and delegates their public parsing and presentation to `src/commands/`. Retained runtime protocols keep their authorization and execution contracts. Old business roots and generic Dataset compatibility routes are removed; there is no alias or fallback dispatcher. The migration comparison records the exact removed surface.

- `src/cli-deps.ts`: internal composition dependencies, result types and shared failure projection, without package exports.
- `src/commands/`: strict CLI argument/help handling, bounded output and local artifact coordination. Auth service, Release, admin, package tools, classification maintenance and ordinary maintenance have bounded modules; Study, PCR and runtime parsing also lives here; specialized result schemas and safety checks retain their own contracts.
- `src/application/`: Dataset identity, query/cursor rules, statistics selection/grouping, content diff/patch, reference discovery, supplied-translation application, and Dataset/Review write use cases with typed IO ports; no filesystem/network transport or CLI command construction.
- `src/adapters/`: authenticated exact reads/search, existing contract and validation helpers, Model calculations, Source attachment transfer and authenticated write dispatch. `private-mutation-journal.ts` shares private-file/locking primitives while each operation retains its own receipt, unknown-outcome and readback policy.
- `src/shared/`: result types, safe file IO, platform-aware continuation quoting, error projection and installed template lookup.
- `assets/reply-templates/`: Markdown guidance selected by actual outcome.

Core commands project readable text help and machine help from the same factual manifests. Dataset action options/defaults and unavailable actions reflect the actual parser; translations has its own group discovery, and retained service/maintenance/package tools are discoverable without changing their output protocols. Root and classification discovery expose bounded structured help and content-bound local pagination. Authentication presentation reuses the existing OAuth, session and exact-identity implementations through an injected execution port. The common envelope stores the unchanged receipt under `data.receipt`; standalone output writes only that receipt. Public receipt parsing is unchanged. Doctor separates local runtime/configuration observations from an explicit public Auth health GET, which never refreshes sessions or verifies actor permission.

Dataset uses one typed command router for all eight object types. Model `build-resulting-process` and its `aggregate` alias share a canonical operation and implementation. Calculation inputs are explicit snapshots; exact remote Process lookups never fall back to latest. Source uploads verify selected bytes and independent readback, preserve failed references and do not save Source content.

Process result discovery and complete inventory reads use `application/process-results.ts` with a dedicated authenticated adapter. Caller selections remain Process/Result identities; the adapter owns publication/runtime pagination context and one bounded whole-read restart. Public/current-user search scopes are explicit; Flow/Process filtering uses the existing matched-version service contract.

`src/commands/dataset-discovery.ts` owns query result presentation. Model graph metadata never enters identity context; explicit Process exchange projections are labeled incomplete content. Statistics adapts bounded visible-row reads and uses `src/lib/process-statistics/summary.ts` directly, without a second legacy scan or Markdown-report workflow; count drift, repeated identities and scan bounds remain partial observations. `contract` exposes verified released public definitions rather than retired authoring/identity workflow gates. Executed checks and omitted layers belong to validation reports.

Create and save are separate service intents. Ordinary saves reuse server content CAS. Model writes use the existing atomic model service with no implicit Process mutations or create-conflict fallback; existing graph metadata is preserved while composition graph changes follow the explicit Model content. Delete and Model save disclose when expected-content comparisons occur only before dispatch. Durable local intents prohibit replay after an unknown mutation outcome. Exact existing service rejection codes are interpreted by a pure application policy; known no-effect refusals preserve only safe code/category fields and a durable rejected result. Network failures, 5xx, unknown codes, malformed/mismatched decision receipts and post-acknowledgment readback failures remain unknown. A repeated rejected request returns its original refusal without dispatch.

Review adapts the existing business contract: one submission root with server-related data, current participant queries/materials, reviewer draft save and separate reviewer decision. Historical packages and server round links are not fabricated. See the [service comparison](../analysis/cli-interface-comparison.md#现有业务服务与本次实施基线) for the boundary against deferred target semantics.

Imports flow from composition to commands to application; adapters implement ports and reuse shared runtime helpers. Application may use pure shared result types and type-only domain report shapes. Presentation and filesystem modules stay out of application. Existing public library subpaths and Release/runtime/PCR protocols keep their own contracts.

## Dependency and operation boundaries

The complete source boundary test covers commands, application, adapters, shared facilities and library owners. The emitted import/re-export/dynamic-import graph must be acyclic. Type-only imports use declaration-level `import type`, avoiding empty runtime imports under verbatim module syntax. Library dependencies on shared modules are limited to pure errors and state-directory leaves; CLI lock-failure projection preserves public error-class identity and never exposes private owner metadata. Literal graph checks complement behavioral tests; computed module loading and child execution retain their own integrity checks.

Dataset capability discovery and command flags share a finite action type. Model graph/result generation, Process statistics and Source uploads use discriminated operation selections; uploads and remote scans are not described as local processing. External JSON remains runtime-validated at the use-case boundary. Typed write dispatch carries exact target, content, preconditions and the pre-dispatch hook rather than an arbitrary action string.

Dataset and Review application use cases own readable preconditions, dry-run meaning, service acknowledgment interpretation and operation-specific unknown outcomes. Adapters supply actor/environment observation, exact reads, transport and durable private storage. Commands own executable continuations and reply guidance. Shared storage retains existing request/target hash keys and journal shapes; it provides no automatic retry or universal mutation state machine.

`maintenance/contract/` separates types, pure values, scope parsing and artifact IO; the bounded entry owns plan parsing. `maintenance/apply/` separates preconditions, progress and execution. `model/result/` separates request normalization, exact source selection, payload calculation and projection. Canonical sorted-object hashes, insertion-order content hashes and newline-bound artifact bytes remain distinct domains.

## Repo Shape

The stable launcher composes current command/application/adapter layers and the shared `src/lib/**` protocol and algorithm owners. Unreferenced retired workflows are removed from source and package output.

## Stable Path Map

| Path group | Role |
| --- | --- |
| `bin/tiangong-lca.js` | stable launcher entrypoint exposed as the public `tiangong-lca` executable |
| `src/main.ts` | process entry, dotenv loading, stdout and stderr wiring |
| `src/cli.ts` | top-level command dispatch, parsing, and help routing |
| `src/auth-identity-receipt.ts` | supported offline parser/constants/types package subpath for safe identity receipts |
| `src/command-spec.ts` | supported content-bound CommandSpec package subpath |
| `src/runtime.ts` | supported installed CLI/Node/asset inspection and exact expectation API |
| `src/lib/runtime/**`, `src/commands/runtime/**` | runtime integrity/execution owners and separate command parsing/presentation |
| `src/batch.ts` | stable re-export facade for the supported batch package subpath |
| `src/lib/batch/**` | bounded acyclic owners for batch types, contracts/errors, projection, scheduler runtime, attempts/recovery, and engine coordination |
| `src/lib/auth/oauth-pkce.ts` | strict Supabase public-client authorize/token/refresh/UserInfo protocol with S256 PKCE and bounded responses |
| `src/lib/auth/oauth-loopback.ts` | exact literal-loopback callback, state/code validation, and shell-free platform browser launch |
| `src/lib/locks/**` | shared lock, lock identity/types/errors and state-file locking, independent of Batch scheduling |
| `src/lib/{auth,config,transport}/` | identity/session, public configuration and remote protocol owners |
| `src/lib/{dataset,validation,model,maintenance}/` | object content, scientific checks, model calculation and ordinary maintenance |
| `src/lib/{study,pcr,release,runtime}/` | separate service/runtime protocols |
| `src/lib/platform/` | artifacts, filesystem, run identity, package version and hash facilities |
| `test/**` | unit and launcher tests that back the coverage gate |
| `scripts/assert-full-coverage.ts` | strict coverage enforcement |
| `scripts/ci/**` | release-tag and package publication checks |

## Current Architectural Clusters

### Study lifecycle consumer

`src/commands/study.ts` and `src/lib/study/{transport,intent,protocol,codec,export,renderer}.ts` own the `study` namespace, bounded authenticated transport, immutable pre-dispatch request recovery and exact Edge-owned codec consumption. `assets/study-contract/v2/`, `v3/` and `v4/` are contained owner artifacts, with clean committed Edge source provenance and separate explicit gating for any future worktree candidate. It has no sibling/runtime install fallback. See [the Study contract](study-cli-contract.md); numerical rules, permissions and producer facts remain remote-owned, v3 analysis/report and v4 review/finalization/sharing keep independent negotiation. CLI transports exact current action projections and immutable-outcome/current-state pairs without deriving review or permission policy. V4 downloads bind the authorized export/share descriptor to the independently verified signed snapshot. Detached exports additionally consume the fixed `assets/study-renderer/v1/` package, independently pinned archive and issuer anchors; authenticity includes owner view bindings and exact HTML re-rendering from the captured verified complete module graph. Export files are completed in private staging before one final rename, with failed staging retained rather than path-based rollback; the Study contract states portable rename limits.

V6 method assessment adds an explicit family in the same owners and `assets/study-contract/v6/`; its schema discovery uses captured verified bytes. Owner config/evidence helpers preserve domain authority. Method report export4/view3 selects the independently pinned `assets/study-renderer/v3/` with its complete JS/MJS graph. Historical verifiers retain their original family and renderer; online downloads bind the exact selected descriptor. CLI never evaluates method rules or creates Worker contexts. See the Study contract for immutable provenance, unavailable values and actual runtime qualification debt.

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
- The batch subpath re-exports the shared `locks/` run-lock primitives, using the same function and error-class objects as internal commands. Core CLI dependencies do not load the Batch facade or scheduler. One run-directory lock domain is independent of identity. It uses a physical create-only state lock across processes and an owner/scope token in async context: only a still-live scope owned by the current holder may reenter, while siblings and callbacks inherited from a completed scope contend. The physical owner and top-level promise stay active until detached nested scopes drain; local waiters wake only after physical cleanup, and live or foreign-host locks are never stale-deleted. Public callers supply no PID, host, or ownership clock; timeout/poll inputs must be non-negative safe integers within Node's timer maximum.

The auth, CommandSpec and batch primitives contain no Foundry profile, LCA stage, endpoint, artifact filename, credential, or blocker taxonomy. Runtime inspection additionally owns the CLI package layout and file inventory only. Callers project those domain facts at their own boundary.

### Session and remote access layer

The CLI talks to remote services directly through helper modules such as:

- `src/lib/config/env.ts`
- `src/lib/config/dotenv.ts`
- `src/lib/auth/credential-safety.ts`
- `src/lib/auth/oauth-pkce.ts`
- `src/lib/auth/oauth-loopback.ts`
- `src/lib/auth/supabase-session.ts`
- `src/lib/auth/auth-identity-receipt.ts`
- `src/lib/transport/supabase-client.ts`
- `src/lib/transport/supabase-rest.ts`
- `src/lib/transport/supabase-data-api-contract.ts`
- `src/lib/transport/remote.ts`
- `src/lib/transport/http.ts`

This is where the CLI-owned remote access contract lives.

`src/lib/config/env.ts` owns one bundled official Production public profile. `readRuntimeEnv`, `requireSupabaseRestRuntime`, the explicit resulting-process remote lookup, and doctor all resolve the same public URL/key/client/callback/region. Empty/blank configuration and exact Production aliases can complete that profile; any custom public field requires a complete matching environment instead. Known Production key/client values cannot be sent to a foreign URL. Headless bearer injection always requires an explicit destination/key. The configured-only `hasSupabaseRestRuntime` probe opts out of defaults so remote executor selection never becomes remote merely because the package ships a profile. Session project/client binding and explicit remote/commit/approval gates remain unchanged; neither Skills nor a server-side token broker owns a second copy.

The preferred interactive path is `auth login`: a registered public OAuth client opens the browser, keeps state/verifier/code only in memory, receives one exact fixed-port `127.0.0.1` callback, exchanges the code with S256 PKCE, verifies UserInfo, and writes a schema-v2 access/refresh session atomically under the existing state lock. Refreshes use the OAuth token endpoint and never fall back to password sign-in. A validated token rotation first checkpoints the new refresh token in the bound private record with an expired access-token state; only successful UserInfo verification publishes a usable session. This preserves recovery after a profile outage without treating cached identity as verification. A token-endpoint HTTP 400 RFC `invalid_grant` or unambiguous Supabase `refresh_token_not_found` retires only the exact rejected record under the existing session/state locks, so later commands require login without resubmitting it. The native code is accepted only from the legacy matching numeric `code` plus `error_code`, or the versioned string `code` envelope. Mixed RFC/native fields, unknown native codes and provider messages supply no terminal authority. UserInfo errors never retire a rotation checkpoint. Network, rate-limit, upstream and protocol failures retain recovery state and return a sanitized `SUPABASE_OAUTH_REFRESH_UNAVAILABLE` result; re-read comparisons prevent late responses from replacing or deleting a newer login or a different project/client session. When disk caching is enabled, every session reuse and refresh candidate is bound to the current private file; deletion or a different project/client record suppresses stale process memory. Memory-only mode retains its own authoritative record, and late responses require that exact record to still exist. `auth status` examines only the bound local record and marks itself not online-verified; `auth whoami` reuses the live redacted identity receipt; `auth doctor-auth` combines local readiness and live identity, returning a human login handoff before network access when the local OAuth session is missing. An explicitly configured loopback tuple selects a distinct local-only diagnostic up front, reusing bounded current-user and actual token/client checks; its current callback is configuration, not historical callback proof. Production/default doctor, whoami and the canonical identity-receipt contract retain their existing paths. `auth logout` removes only a matching local project/client session; the Next Connected applications surface owns grant revocation.

`TIANGONG_LCA_ACCESS_TOKEN` is the explicit headless path. It is verified against Auth, cached only in process memory, never written to the session file, and has no automatic refresh/replay path. All remote command families consume the same resolved access-token interface, so OAuth does not fork database/Edge request code. There is no password/API-key bootstrap or alternate user bearer.

### LCI/LCIA data-release transport

`src/lib/release/lca-release.ts` is deliberately a narrow authenticated adapter, not a second release control plane:

- `src/commands/release.ts` owns `release prepare|upload|finalize|approve|publish|readback-verify|unpublish|status|current|calculation-bundle|calculation-artifact|artifact-download` parsing, help, and human/JSON rendering.
- The normal OAuth session supplies the user access token; the explicit headless actor token uses the same request adapter. No legacy bootstrap, service-role credential, or release-specific API key is accepted, and release payloads contain no credential-derived fingerprint.
- Edge/Database assert the live `data_product_manager` role for private and mutating actions. CLI-side checks are input and integrity checks, never an authorization substitute.
- Upload requires exactly the Unit Process and standalone LifecycleModel+Result profiles in both TIDAS and ILCD. Local size, SHA-256, media type, and profile/format cardinality are validated before requesting signed upload URLs.
- Calculation Bundle projections, chunks, and ZIPs are file-first. The CLI writes atomically with private permissions, refuses overwrite without `--force`, and exposes downloaded bytes only after exact size and SHA-256 verification.
- The result profile reuses existing TIDAS Process exchange and LCIA result structures. Schema identity/version policy and self-contained package closure are produced upstream by the release control plane and TIDAS tools, not reimplemented here.

### Validation, references and ordinary maintenance

`dataset/contract.ts` reads the selected SDK and public rules. `validation/` owns schema/business, evidence, placeholder, multilingual and scientific checks without generating missing evidence. `dataset/remote-verify.ts` supplies exact reference observations to typed validation and maintenance. The [exact-reference contract](exact-reference-intent-contract.md) grants no write authority. Dataset writes use typed application ports, adapters and private mutation intents.

`maintenance/contract/` owns scope types, pure values and artifact IO; `maintenance/contract.ts` validates immutable plans. `pagination.ts` requires complete exact-count traversal with exact `id`/`version` identities. `plan.ts` freezes current-owner draft actions, before hashes, untouched-row and reference-impact proofs. `desired-payload.ts` loads only frozen hash-matching content.

`remote.ts` owns current-session reads and platform save/delete or guarded derivative RPCs. `apply/` separates preconditions, durable progress and execution. Apply repeats completeness, ownership, state, drift and reference closure checks, requires exact plan/account confirmation and persists action proofs. Ordinary actions execute sequentially; flow delete-only parallel admission remains explicitly bounded and fenced by fresh global inbound evidence. Unknown outcomes require readback, never blind mutation replay.

`derivatives.ts` admits one exact current-owner draft Process through the guarded database contract. Accepted/queued is distinct from completion; independent verify compares the same request and a fresh database snapshot without changing primary payload or `modified_at`. `clear-account.ts` retains its current-account RLS filters, reference-safe order, dry-run/confirmation and complete readback.

Alias, Length×time and Flow-identity repairs have no implementation or RPC consumer here. Their artifacts are not ordinary maintenance input. Historical evidence remains bound to the matching client; removal creates no write fallback or downstream workflow.

### Artifact and filesystem behavior

Artifact materialization and local state handling cluster around:

- `src/lib/platform/artifacts.ts`
- `src/lib/platform/io.ts`
- `src/lib/locks/state-lock.ts`

If a task changes output layout, locking, or local run roots, inspect these first.

### Private live-case driver

`scripts/live/` uses the existing OAuth browser-opener adapter with real PKCE, callback, exchange and userinfo. Playwright is an exact dev-only dependency. The driver, browser, raw private case context, and account values are excluded from the package. See [the live case guide](live-case-testing.md).

### Repo-local validation and release gates

Repo-level maintenance gates are now split across:

- `.github/workflows/quality-gate.yml` for automatic dependency/configuration/Actions PR validation, manual exact-head reproduction and reusable four-platform pre-tag validation
- `.github/workflows/ai-doc-lint.yml`
- `.github/workflows/tag-release-from-merge.yml`
- `.github/workflows/publish.yml`

Important constraints:

- `pnpm prepush:gate` remains the authoritative local proof for code changes and runs from the local pre-push hook; it includes the `test:package` toolchain/tarball consumer contract, separate uninstrumented `test:entrypoints` launcher tests and exact 100% coverage
- `ai-doc-lint` keeps the historical check identity, but its implementation should run `docpact`
- `docpact` enforces that command-surface and release-gate changes also refresh or review the governed source docs
- the merge-tag workflow is guarded so only the upstream repository can execute release tagging
- CI bootstrap is pinned to `pnpm/setup` v3.1.1 with Node 24.19.0 and `pnpm install --frozen-lockfile`
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

Task PCR content uses `src/commands/pcr.ts` and `src/lib/pcr/{contract,release,cache,tool}.ts` and the dedicated [task snapshot contract](pcr-snapshot-contract.md). The CLI prepares exact published compatible content into a separate data cache, retains task and installed reader pins, and forces those selectors during shell-free PCR consumption. PCR core remains the offline semantic owner.

## Process allocation admission and resulting-process lineage

`process-semantic-validation.ts` adapts the pinned SDK's pure, versioned `analyzeProcessSemantics` API. `validateProcessPayload` keeps structural, authoring, content and multilingual layers and reports `allocation_semantics` separately, including unresolved coverage, candidate hash, exact Flow-document hashes, profile and tolerance. Local callers supply `semantic_context.flow_documents` containing complete exact-version Flow datasets; the adapter validates their schema and original identity without fetching or rewriting scientific data. A local report can be unresolved; draft and publish admission requires a passed report. A generator's optional `allocation_transformation` receipt binds its candidate hash and declared profile. A schema-valid wrong recipient cannot reveal lost source identity, so this receipt is generator evidence rather than a validator retargeting policy.

Remote process create, save-draft and state-aware save/publish routes share `process-allocation-write-admission.ts`. Immediately before dispatch they read explicit target Flows through the existing current-user Supabase RLS boundary at exact UUID/version. Missing or ambiguous evidence blocks dispatch. Supplied local Flow bytes must match those reads; admission then recomputes semantics against fresh bytes. Local evidence alone cannot authorize a forged Product type for a remote Elementary Flow. These reads introduce no privileged credential or production mutation.

`resulting-process-allocation.ts` conserves declared allocated quantities across compatible exchange groups: `sum(quantity * fraction) / sum(quantity)`. Keys include exact Flow version, direction and explicit quantity-basis fields; provenance keys include source process instance and source exchange ID. Final numbering maps those source identities to final exchanges, and compatible many-to-one targets add their fractions. Multipliers apply to quantities before aggregation; the builder does not apply allocation coefficients to inventory amounts. Conflicting mean/resulting amounts, signed or zero allocated contributions, already allocated inventory, eliminated targets and cancellation without unique exact endpoint lineage fail with an explicit diagnostic. Unique compatible cancellation updates the individual source contributions before reconciliation.

The SDK owns compatibility interpretation. Whole-inventory legacy Output shares are projected uniformly before aggregation, including undeclared exchanges. A legacy share vector omitting the selected reference has Worker default-one semantics that an explicit sparse vector cannot conserve; that conversion is rejected. Mixing explicit declarations with undeclared inventory requires its verified unique reference fallback. The builder never chooses a new allocation recipient. Source lineage, contribution quantities and the final candidate hash are emitted alongside the unchanged payload; the projection report contains its real shared validation result.

Allocation serialization follows the public three-decimal `Perc` boundary using deterministic largest remainder, tied by stable final target numbering. The sidecar reports actual percentage/amount error per target and bounds error below 0.001 percentage points, or inventory amount × 0.00001; conservation is qualified within this tolerance.

Study P4 adds `assets/study-contract/v5/` and an independent `assets/study-renderer/v2/` package. Existing Study modules adapt explicit V5 commands and journals while preserving older codecs, renderer graphs and defaults. Scientific computation remains Worker-owned; current authorization and profile/finalization policy remain server-owned. The Study CLI contract owns exact source pins and rollback-safe historical-read semantics.

## Local Model calculation

`application/model-calculation.ts` resolves only explicit numerical dependency identities through ports. `adapters/model-calculation.ts` loads selected files/authenticated exact reads and invokes the explicitly configured native executable with bounded, shell-free IO. The local child receives system runtime variables rather than CLI authentication credentials. Commands distinguish dependency preparation, numerical completion and invalid or missing numerical inputs; normal method-specific sparse characterization is not a coverage gap. Worker owns `lca.model-input.v1`, native scientific rules and Run artifacts; no server SourceInput authorization or StudyBinding is fabricated.

## Local report presentation

`commands/report.ts` owns strict discovery/arguments and shared results. `application/report.ts` validates a lightweight presentation projection and defines its output port. `adapters/report.ts` writes a separate local artifact; `lib/report/` renders escaped text, SVG, single-language Chinese/English switching and print presentation with fixed embedded enhancements. Composition selects the writer. This path performs no remote access, calculation or hosted Study state change and never consumes or modifies signed hosted renderer assets.

The report Model view follows Platform’s LifeCycleModels title-bar, 6px node, 8px square endpoint and IO grouping conventions, with the TianGong light brand primary. CLI owns the offline SVG implementation; it does not import Platform’s React/X6 page, service adapters or editing state. Node summaries link to complete supplied details.

### Local Model installation boundary

`adapters/model-install.ts` consumes an explicitly selected local native package, reuses runtime archive/path/integrity primitives and verifies the installed engine through `model-runtime.ts` before configuration publication. Worker owns package production and scientific execution. Each installation has a private owned directory; failures remove only that directory, while existing installations and Runs are retained. No package hash becomes a research-input requirement.

## Process annual quantity compatibility

`process-annual-projection.ts` validates annual meaning independently of allocation semantics. `process-reference-unit.ts` resolves exact complete reference documents with the pinned SDK schemas and the existing Flow/UnitGroup consistency checks. The pure modules never fetch, rewrite content or infer annual production. The supported bilingual one-reference-batch declaration and user commands are defined in [Process interfaces](../interfaces/datasets/processes.md#年度量与-platform-展示兼容).

`process-annual-evidence.ts` supplies current-user exact reference reads to combined business/reference validation and ordinary write qualification. Local validation receives optional reference documents through a separate command input, never merged into the candidate. Annual evidence is recomputed on each new save; the existing mutation journal and original-result recovery remain unchanged.
