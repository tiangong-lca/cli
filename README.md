---
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: en
whenToUse:
  - when installing or invoking the TianGong LCA CLI
  - when checking public command examples
whenToUpdate:
  - when the published CLI executable or invocation contract changes
  - when user-facing command examples change
checkPaths:
  - README.md
  - .env.example
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - bin/**
  - src/cli.ts
  - src/main.ts
  - src/auth-identity-receipt.ts
  - src/batch.ts
  - src/command-spec.ts
  - src/lib/auth-identity-receipt.ts
  - src/lib/oauth-loopback.ts
  - src/lib/oauth-pkce.ts
  - src/lib/supabase-session.ts
  - src/lib/lca-release.ts
  - test/auth-identity*.test.ts
  - test/public-auth-identity-receipt.test.ts
  - test/lca-release*.test.ts
lastReviewedAt: 2026-09-24
lastReviewedCommit: 709b4f402ddc2febe2d81b6cb61461ea15d66463
lastReviewedNote: 'Reviewed for CLI #368 at 709b4f4: the source branch accepts a non-flow Process reference with required functional text and does not publish a new CLI version or dataset.'
---

Review note, 2026-09-24: CLI #368 source accepts a Process `Other parameter` with `functionalUnitOrOther` and no Flow reference, while rejecting the opposite missing-field cases. It consumes released spec 0.2.3 and SDK 0.4.1 at unchanged CLI 0.1.21; a later reviewed release remains separate.

CLI 0.1.10 is the designated C1 release for `tiangong-lca runtime describe --json` and the explicit `@tiangong-lca/cli/runtime` API for package, asset and Node content inspection. Runtime inspection loads no project `.env`, performs no authentication and downloads nothing. See [the runtime distribution contract](docs/agents/runtime-distribution-contract.md) for exact fields and trust boundaries; verify public availability and provenance before treating the candidate version as released.

Issue #278 adds a managed Node host interface in source, for the subsequent qualified CLI release. A release manifest opts its launch into `tiangong-lca.runtime-host.v1`; the host calls `receiveRuntimeHostContext()` from `@tiangong-lca/cli/runtime` before application work. The immutable result carries the selected full manifest, work/cache directories, entry and actual host. `copyTrustedRuntimeManifestBytes(context.manifest)` supplies original verified bytes for another package instance's compatibility checks. The channel closes before the receiver returns, and ordinary task arguments or environment values cannot supply this context. See the runtime distribution contract for lifecycle and trust requirements.

# TianGong LCA CLI

Package: `@tiangong-lca/cli` Executable: `tiangong-lca` Current package version: `0.1.21` (release preparation; npm latest remains `0.1.20`) Node: `24.19.0`

Repository development is single-track on pnpm `11.24.0` and TypeScript `7.0.2`. The published package remains a clean, package-manager-neutral consumer artifact: it contains runtime files only, not pnpm, TypeScript, Oxlint, tests, source-only tooling, or repository lockfiles.

Review note, 2026-09-21: Issue #351 prepares the 0.1.19 version-only release for merged source PR #349 on branch `codex/issue-351-cli-0.1.19` (base main merge `11a074b0`). Package identity and the four live CLI-version fixtures advance; dependencies, the sole lock, runtime files, strict exports, commands and release automation stay unchanged. The source feature is merged but publication has not happened — npm latest is `0.1.18` and no `cli-v0.1.19` tag exists — so the package-version line above states the in-repository release preparation and the actually published version separately instead of claiming a release.

Review note, 2026-08-25: Issue #224 migrates repository development and release automation to the sole root `pnpm-workspace.yaml` / `pnpm-lock.yaml`, TypeScript 7.0.2, and type-aware Oxlint on Node 24. The feature change deliberately keeps version 0.0.33. A separate release-only PR should prepare 0.1.0 after the toolchain change merges and its full package/coverage/release gates pass.

Review note, 2026-09-18: CLI #338 advances the bundled Process and LCIA Method schemas to the reviewed `tidas-spec` 0.2.0 candidate. Their complete-review-report reference is optional, while any supplied reference remains strictly schema-validated; Lifecycle Model remains unchanged. The candidate SDK compatibility bridge affects validation only, changes no command, package version, public export, or release path, and is covered by the existing pre-push and release gates.

Review note, 2026-09-21: CLI #350 advances the bundled schemas to exact `tidas-spec` 0.2.2. Process `validation.review` accepts one object or a non-empty ordered array; until the corresponding SDK source is published, CLI validation checks every array member through SDK 0.3.0 and preserves indexed failures. LCIA Method remains singleton-only, and CLI package 0.1.18 is unchanged.

Review note, 2026-08-25: Issue #226 publishes that 0.1.0 compatibility boundary after merged PR #225. Version metadata and public release evidence advance to 0.1.0; the runtime JavaScript/assets surface, command behavior, Node 24 runtime, pnpm/TypeScript 7 development baseline, native pnpm Trusted Publishing/provenance, and exact released-commit workspace handoff remain unchanged from the reviewed feature delivery.

Review note, 2026-08-25: Issue #228 implements `auth identity-receipt` as a bounded read-only current-user proof. It checks expected project intent before session work, verifies the live user through `/auth/v1/user`, allows one auth-refresh replay after 401/403, and emits an exact-key canonical receipt without API keys, tokens, full email addresses, session paths, or credential-derived fingerprints. Production callers must pass both expected assertions and accept only `assertions.mode="intent-bound"`.

Review note, 2026-08-25: Issue #230 publishes the merged identity receipt as `@tiangong-lca/cli@0.1.1`. Runtime logic and published dependencies remain unchanged; the sole pnpm lock changes only for exact dev-only `sigstore@5.0.0`. Local metadata, engines, and every workflow converge on Node 24.19.0. Release automation asserts actual platform/architecture across the reusable four-platform pre-tag matrix and provides `pnpm release:verify-published` for cryptographic Fulcio/CT/Rekor provenance, registry signatures, actual tarball integrity, isolated user/global package-manager configuration, exact pnpm 11.23.0, and credential-free bin/ESM/CJS consumer proof.

Review note, 2026-08-26: Issue #232 adds two supported typed library subpaths without changing version `0.1.1`: `@tiangong-lca/cli/command-spec` owns the byte-compatible `tiangong-foundry.command-spec.v1` authority and shell-free execution adapters, while `@tiangong-lca/cli/batch` owns identity/content/policy-bound scheduling, resource-aware exclusive keys, explicit mutation readback recovery, and host-safe run-directory locks. Claim-time identity drift—including a throwing identity getter—is a stable item failure/event and every already-started worker is drained before return. Any escaping infrastructure callback error records one fatal cause, immediately closes new claims, drains only already-claimed workers, and rejects after all worker promises settle. A blocked resource stays unclaimed and consumes no worker while a later free resource may run; per-resource FIFO cursors and a private minimum-ready heap keep ordinary scheduling near `O(n log k)` rather than repeatedly scanning all pending items. Run-lock PID/host/timestamp ownership is derived internally and cannot be supplied by callers. Every public timer-backed timeout, poll, or retry delay is bounded by Node's `2_147_483_647ms` maximum. The package root remains unsupported and publication requires a later release-only delivery.

Review note, 2026-08-26: Issue #233 changes only the internal shape of the batch subpath. `src/batch.ts` is now a 62-line facade over bounded, acyclic modules for types, errors/contracts, locking, projection, scheduler runtime, attempts/recovery, and the engine. Executable budgets keep the facade below 400 lines and every internal module below 800 while locking exact public export identities, declarations, errors, event/result bytes, packed consumers, and dataset dogfood. Package version, dependencies, pnpm-only TypeScript 7 development, and runtime behavior are unchanged.

Review note, 2026-08-26: Issue #236 changes only the repository and clean-consumer package-manager requirement from exact pnpm 11.23.0 to 11.24.0. The sole root lock requires no byte change under pnpm 11.24.0; Node 24.19.0, TypeScript 7.0.2, package version 0.1.1, public commands and exports, dependencies, tags, provenance, and publication remain unchanged, with no npm/Yarn fallback.

Review note, 2026-08-26: Issue #237 releases the already reviewed bounded CommandSpec/batch runtime and pnpm 11.24 toolchain as `@tiangong-lca/cli@0.1.2`. The release changes only package metadata and four live CLI-version fixtures; runtime files, public subpaths and object identities, dependencies, the sole lock, Node 24.19.0, TypeScript 7.0.2, package-manager-neutral consumers, and automated provenance path remain unchanged.

Review note, 2026-08-29: Issue #240 adds the typed `@tiangong-lca/cli/auth-identity-receipt` public parser entry without changing package version 0.1.2 or auth behavior. It directly re-exports the existing strict parser, schema/timeout constants, and receipt types; the remote runner and test internals stay private, and the previous `dist/src/lib/**` deep path remains blocked.

Review note, 2026-08-29: Issue #242 releases that public parser as `@tiangong-lca/cli@0.1.3`. Only package identity and four existing exact-version fixtures change; `./batch`, `./command-spec`, `./auth-identity-receipt`, the executable, dependencies, pnpm lock, Node 24.19.0 / TypeScript 7.0.2 toolchain, and package-manager-neutral consumer contract are otherwise unchanged.

Review note, 2026-08-31: Issue #244 adds Supabase OAuth 2.1 Authorization Code + S256 PKCE without adding a dependency or changing package version/exports. `auth login` uses a registered public client, exact literal-`127.0.0.1` callback, state validation, and shell-free system browser; it atomically stores rotating access/refresh tokens in a private session file. `auth status` performs no network request and reveals no credential or session path; `auth whoami` and `auth doctor-auth` use the live redacted identity receipt. `auth logout` deletes only that matching local session; Connected applications owns grant revocation. `TIANGONG_LCA_ACCESS_TOKEN` is a short-lived, online-verified, memory-only headless option. The reversible API key remains only as a transition fallback and is never used by OAuth mode.

Review note, 2026-08-31: Issue #247 prevents a second CLI process from failing when the first process removes `session.json.lock` between contention and metadata read. Only an absent lock is treated as released; permission, I/O, malformed-owner, timeout, and stale-owner safety behavior is unchanged.

Review note, 2026-08-31: Issue #246 releases that OAuth runtime as `@tiangong-lca/cli@0.1.4`. Only package identity and four existing exact-version fixtures change; the executable and public subpaths, dependencies, pnpm lock, Node 24.19.0 / TypeScript 7.0.2 toolchain, auth behavior, and package-manager-neutral consumer contract are otherwise unchanged.

Review note, 2026-08-31: Issue #252 replaces the stopped-unpublished 0.1.4 attempt with `@tiangong-lca/cli@0.1.5` after platform-complete session coverage merged. Only package identity, four version fixtures, and release evidence change; executable/public subpaths, OAuth behavior, dependencies, pnpm lock, Node/TypeScript toolchain, and consumer contract stay unchanged.

Review note, 2026-08-31: Issue #256 upgrades the still-0.1.5 development/runtime graph to Supabase JS 2.112.4, lint-staged 17.4.1, Prettier 3.9.6, and tsx 4.23.13. TIDAS SDK is pinned exactly to npm-latest 0.2.0 and every stricter validation/data workflow stays in the exact-100% gate. Node 24.19.0 deliberately keeps latest 24.x typings rather than Node 26. The formatter rewrite is a separate mechanical commit; OAuth, public exports, commands, tags, and publication behavior do not change. Issue #257 owns the later version-only 0.1.6 release.

Review note, 2026-08-31: Issue #257 releases that merged dependency graph as `@tiangong-lca/cli@0.1.6`. Only package identity, four exact-version fixtures, and release evidence change; commands, executable/public subpaths, OAuth/session behavior, exact TIDAS/Supabase dependencies, pnpm lock, Node/TypeScript toolchain, and clean consumer contract remain unchanged.

Review note, 2026-09-22: CLI #359 adds the closed **Length\*time** correction profile (`dataset-length-time-plan.v1`) as a second user of the versioned protected lifecycle. `plan --length-time-input` builds the plan from the reviewed planning input: 13 owner-draft Process actions whose 39 selected occurrences move their two absolute amount leaves by the fixed factor 1000 (`kmy` to `m*a`, both leaves byte-equal before), with the 13 read-only Product flows carried as `{id, version, sha256}` evidence and no flow, text or no-op action anywhere. The profile is selected by the plan document's own `schema_version` alone — the Time plan keeps its reviewed predicate, the Length plan gets its own, and neither is widened — and the shared freeze/approval/request/admit/read envelopes, the three gates, the 180-second window and the one-admission policy are unchanged; the freeze stays one 13-key envelope and carries the wire's fixed `{flowproperty, unitgroup}` target projection for a Length plan. The source number is read only from the anchored declaration the audited corpus uses (`Source EcoSpold1 exchange number: <N>.`, one declaration, suffix preserved and never scanned), the uncertainty pair is optional and preserved byte-for-byte (13 of 39 occurrences declare no distribution, 35 declare no standard deviation), and the reviewed unit-group factors are compared as exact decimals (`1.0`, `1000.0`). A checked-in synthetic cohort fixture reproduces those real shapes and both halves read one shared source-comment vector list. Coverage stays 100% across `src/**`; production use still requires the matching database capability and a coordinated release, and nothing is deployed or executed. The CLI half passed root's real-corpus plan oracle and the database owner's joint executor run against the same emitted document.

Review note, 2026-09-21: `dataset maintenance` gains the versioned (v2) Time alias path for the fixed BAFU current-owner cohort. `plan --alias-v2-input` builds a `dataset-alias-plan.v2` plan and batch, `freeze-protected` derives the versioned freeze from that plan plus the reviewed six-key derivative baselines, `seal-protected-approval` seals it byte-exactly as it always has, and `run-protected` selects the chain from the seal's schema. The versioned path keeps the real v1 protected envelope (the twelve-key preflight request, three gates inside the unchanged 180-second window, exactly one admission POST, readback-only recovery of an unknown admission) while its `expected` block is the v1 ten flat counts with v2 values plus the versioned `text_action_count`. The CLI side is implemented and locally verified; production use still requires the matching database capability and a coordinated database/CLI release, and this path is not deployed or executed.

Review note, 2026-07-12: `dataset maintenance plan/apply/verify` provides current-user RLS-scoped exact-row maintenance with immutable plans, explicit approval, per-action logs, platform audit correlation, and independent readback. `merge-support-aliases` now runs only in `target_mode=owner_draft`: source/target support and all changed rows stay private `state_code=0`; publication is a separate future workflow.

Review note, 2026-07-13: maintenance scans now prove exact-count pagination even when PostgREST returns fewer rows than the requested `--page-size`. An incomplete or inconsistent scan fails before artifacts, approval, or mutation; under stable filtered membership/order the proof represents a complete ordered multi-request traversal, not one transaction-level/MVCC snapshot.

Review note, 2026-07-14: maintenance now includes the protected derivative-only `rebuild-derivatives` operation. V1 plans exactly one current-owner state-0 process with `action=rebuild_derivatives`, `target_mode=owner_draft`, and components `extracted_md` plus `embedding_ft`. Apply only proves guarded-RPC admission (`accepted`/`queued`); independent verify reports `pending`, `passed`, or `failed`.

Review note, 2026-07-15: `dataset maintenance run-protected` adds a production-only path for one sealed private alias execution and its exact 50-target derivative closure. The protected executor is server-dispatched and fenced by the authenticated owner plus exact actor/user_id/state_code=0 and plan-closure checks; RLS remains a defense on public and independent-read surfaces. It performs one server preflight, writes an immutable local attempt marker before one admission POST, and requires status-only recovery after any marker or ambiguous response. It has no dev, legacy-alias, publication, or state-code fallback.

Review note, 2026-07-15: `dataset maintenance freeze-protected` and `seal-protected-approval` close the preparation gap without adding a second execution path. Freeze preparation authenticates directly to the explicitly confirmed production project, performs only complete account/support reads plus the 50 derivative snapshot RPCs, and writes an unapproved canonical request. Approval sealing is entirely local and requires the exact human-returned UTF-8 bytes plus explicit freeze/request/text hashes and account confirmation. Only the later `run-protected` command can preflight or admit work.

Review note, 2026-07-16: `release ...` is the LCI/LCIA data-release command family, not the npm package release workflow. It uses the normal user-session bootstrap, requires the server to authorize `data_product_manager` for private and mutating operations, never accepts a service-role key, and keeps large Calculation Bundle or ZIP payloads in hash-verified files instead of stdout.

Review note, 2026-07-17: `dataset maintenance flow-identity capture|plan|freeze|seal-approval|run|freeze-recovery|seal-recovery-approval|run-recovery|verify` is the dedicated Step 3 workflow for approved BAFU elementary-flow identity mappings. Capture performs one complete authenticated census and one database-attestation POST; plan rejects historical authorities and binds the exact 305-source request to its immutable receipt. The write path uses a database-minted one-wrapper permit that rotates after each successful process/finalize write and is never stored in proof artifacts; a create-only local approval claim is defense in depth. A lost permit or preflight response cannot be replayed: the operator must freeze and approve an exact recovery baseline, while status/recovery may locate only the same actor-owned scope through the exact read-only lookup. Terminal verification independently proves unchanged source/public/support rows, exact desired owner-draft processes, zero approved-source residue, unchanged pending/blocker/orphan closure, and causal derivative completion. Failed/stale derivatives still require a separate derivative-only plan, freeze, and approval and never replay the process mutation. Production use remains gated on merge, Preview validation, and coordinated database/CLI release.

Review note, 2026-07-23: `dataset save-draft --execution-contract` adds an opt-in crash-safe ordered owner-draft batch. The contract binds the authenticated project/owner, state 0, exact input order and payloads, before hashes, expected insert/update operations, and dependencies. A stable per-owner/project `action_id@desired_sha256` ledger prevents replay even if the contract or output directory is copied; ambiguous attempts are recovered only by exact owner/state/payload readback. The ordinary save-draft mode is unchanged.

Review note, 2026-07-24: CLI 0.0.32 adds bounded execution-contract concurrency without changing the sealed payload or replay model. `--max-parallel 1..8` keeps the complete dependency prefix serial and exact-read-back, then overlaps only the unique-target suffix. The current owner token is renewed and revalidated before each DML dispatch so long batches do not turn token expiry into an avoidable UNKNOWN.

Review note, 2026-07-24: CLI 0.0.33 adds an explicit `dataset maintenance apply --max-parallel 1..8` profile for large owner-draft flow convergence. It accepts only unique flow delete-only plans with zero frozen and fresh visible-process inbound references, persists `PREPARED` and `DISPATCHED` before each protected RPC, requires exact absent readback for `COMMITTED`, never automatically replays success or UNKNOWN, and continues independent rows.

Review note, 2026-07-25: The complete RLS-visible process fence now paginates in the strict `(id, version)` primary-key order. It still has no `user_id` filter and retains exact-count completeness, while avoiding a redundant owner/state sort before any deletion can dispatch.

Review note, 2026-07-25: Bounded flow deletion can instead accept an explicitly SHA-approved, at-most-30-minute-old SELECT-only proof covering all process rows. The proof binds the exact project, actor, plan, ordered delete targets, and contiguous target chunks and must report zero inbound edges and zero P0/P1 findings. The CLI validates it before approval or dispatch and never executes the proof SQL itself; omitting the flags preserves the live RLS-visible scan.

## Run

One-off published run:

```bash
pnpm dlx @tiangong-lca/cli@latest --help
pnpm dlx @tiangong-lca/cli@latest auth login
pnpm dlx @tiangong-lca/cli@latest auth doctor-auth --json
pnpm dlx @tiangong-lca/cli@latest flow --help
```

Install the published CLI:

```bash
pnpm add --global @tiangong-lca/cli
tiangong-lca --help
tiangong-lca auth login
tiangong-lca auth doctor-auth --json
tiangong-lca flow --help
```

Run from this repository:

```bash
pnpm install --frozen-lockfile
pnpm build
node ./bin/tiangong-lca.js --help
```

## Typed library subpaths

The package exposes only these supported module APIs in addition to the executable launcher subpath:

- `@tiangong-lca/cli/runtime` (introduced by #274 and designated for C1 0.1.10) describes CLI package, asset and Node content and compares them against independently trusted exact expectations. It also exposes strict manifest loading, ensure/status/prune and manifest-declared execution with component locks, complete file verification and leases. These operations do not authenticate by themselves or attest a complete public production component. The no-Node bootstrap sources are checked in under `scripts/bootstrap/` and consume only an adjacent product-generated lock; C1 package verification belongs to #275; public product component qualification remains downstream.
- `@tiangong-lca/cli/auth-identity-receipt` parses the exact safe receipt projection offline and exports its schema, Node-safe timeout ceiling, and receipt types. It does not expose session resolution, network execution, or test internals; callers that need a fresh receipt still invoke the CLI command.
- `@tiangong-lca/cli/command-spec` parses, creates, artifact-binds, and executes exact `tiangong-foundry.command-spec.v1` objects. `display` is diagnostic only; executable plus argv and binding bytes/SHA-256 form the canonical authority. Sync and async execution always use `shell:false`; async callers may inject resolver, clock, sleep, spawn, timeout, and abort adapters. `timeoutMs` must fit Node's maximum timer delay.
- `@tiangong-lca/cli/batch` runs bounded generic work with an overall run contract and a required per-item `{ item_id, content_sha256, policy_sha256 }` contract. Every identity/content/policy/resource projection is validated before work starts and rechecked before resumed acceptance or a fresh claim. Identity changes or getter failures emit `item_identity_drift` with `BatchItemIdentityDriftError`, execute zero attempts, and do not let the batch return before other in-flight items drain. An escaping scheduler/event/stop callback records the first infrastructure error, closes further claims, awaits all worker settlements, then rejects. Input order, truthful resource-aware claim order, completion order, pause/stop behavior, awaited monotonic events, and exception isolation are explicit. Optional exclusive keys serialize only matching resources; a blocked key remains unclaimed and consumes no worker while later free keys may use the public ceiling of 64 workers. Per-resource FIFO queues expose only their head through an ordered binary min-heap, giving near `O(n log k)` ready scheduling for `k` resources.
- Mutation batches reject automatic retry. A consumed or ambiguous mutation can continue only through an explicitly supplied readback-recovery callback; resume requires exact run and item contracts, and each resumed or rejected result participates in stop decisions before fresh claims. Retry/backoff values must be non-negative safe integers within Node's timer limit. Exclusive keys must be runtime strings. `withBatchRunLock` gives one canonical run directory one cross-process lock domain, permits reentrancy only from a still-live scope owned by the current holder, keeps the top-level promise pending until detached nested scopes drain, rejects completed-context reentry into a later owner, preserves live or foreign-host locks, and stale-recovers only a same-host dead PID. Public lock callers cannot set PID, host, or ownership time; timeout/poll values are non-negative safe integers within Node's timer limit.

The packed ESM, CJS dynamic-import, and TypeScript consumers exercise every public subpath and generated declaration. Deep imports and `import '@tiangong-lca/cli'` remain unsupported.

## Env

Official Production requires **no environment setup**. Run `tiangong-lca auth login` from a trusted terminal and finish authorization in your browser. The CLI bundles the public Production project URL, publishable key, CLI OAuth client ID, registered loopback callback, and region as one profile in `src/lib/env.ts`. These are application configuration, not user credentials; no client secret is used. Skills and external consumers must reuse the CLI rather than copy this profile.

Before the first login, `auth status --json` and `auth doctor-auth --json` return `login-required` (exit 1), not a missing-client configuration error. `doctor --json` reports the public profile fields as `source: "default"`; this is configuration readiness, not proof of a logged-in user.

Only Dev, self-hosted, or a custom public client needs explicit configuration. Supply the complete matching tuple from that environment's administrator:

```bash
TIANGONG_LCA_API_BASE_URL=https://<your-project>.supabase.co/functions/v1
TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY=<that-project-publishable-key>
TIANGONG_LCA_OAUTH_CLIENT_ID=<that-project-registered-public-client-id>
TIANGONG_LCA_OAUTH_REDIRECT_URI=http://127.0.0.1:49191/oauth/callback
TIANGONG_LCA_REGION=us-east-1
```

Notes:

- `TIANGONG_LCA_API_BASE_URL` accepts the project root, `/functions/v1`, or `/rest/v1`.
- `TIANGONG_LCA_OAUTH_CLIENT_ID` is the environment-specific registered public CLI client; it is not a secret.
- Blank public fields and the exact official Production URL aliases use the bundled profile. Any non-Production URL, client, key, or callback disables profile completion; incomplete custom configuration fails before browser/network access. An explicit custom URL cannot be combined with the known Production key or client. Changing `--base-url` also requires a matching complete environment.
- Run `tiangong-lca auth login` once in a trusted terminal. All Edge Function and direct Supabase commands then reuse the OAuth access token and rotate the refresh token on demand.
- For approved headless execution, explicitly set the destination `TIANGONG_LCA_API_BASE_URL`, its `TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY`, and `TIANGONG_LCA_AUTH_MODE=access-token`, then inject one short-lived `TIANGONG_LCA_ACCESS_TOKEN`. A token alone never selects Production. It is verified online, kept only in process memory, and never refreshed.
- Bundled configuration does not enable implicit remote publishing. Local-first publish executor selection still requires explicit configured remote runtime; existing `--commit`, remote-lookup, identity, and approval gates are unchanged.

Optional session control:

```bash
TIANGONG_LCA_AUTH_MODE=oauth
TIANGONG_LCA_OAUTH_REDIRECT_URI=http://127.0.0.1:49191/oauth/callback
TIANGONG_LCA_SESSION_FILE=
TIANGONG_LCA_DISABLE_SESSION_CACHE=false
TIANGONG_LCA_FORCE_REAUTH=false
```

## OAuth Session Commands

```text
tiangong-lca auth login
tiangong-lca auth status --json
tiangong-lca auth whoami --json
tiangong-lca auth doctor-auth --json
tiangong-lca auth logout
```

The callback URI must exactly match the URI registered with the selected Supabase OAuth client. The default is `http://127.0.0.1:49191/oauth/callback`; OAuth client redirect URIs do not support wildcards. Login never accepts a username, password, authorization code, access token, refresh token, or PKCE verifier through argv. On POSIX, the app directory is `0700` and `session.json` is `0600`; writes and refresh-token rotation use a temporary file, atomic rename, and the existing cross-process state lock. Windows callers must keep the selected parent ACL current-user-only because chmod bits are not an ACL.

`auth status` is intentionally local-only and non-mutating. It reports whether a matching session can be used or refreshed, but sets `onlineVerified: false`; it never prints email, tokens, a session path, or a credential fingerprint. `auth whoami` performs the live redacted identity receipt. `auth doctor-auth` first checks local readiness, then performs that live check; a missing OAuth session returns `login-required` so a human can run `auth login`. An AI agent must never ask for or handle the user's password, authorization code, access token, or refresh token.

Local logout does not revoke the server grant. To invalidate every refresh token for the CLI client, open Account → Connected applications and disconnect TianGong CLI.

## Canonical support export

```sh
tiangong-lca dataset support-cache export --out-dir ./new-support-export --expected-project-ref <project-ref> --expected-user-id <user-id> --json
```

Export visible flow properties and unit groups through the CLI OAuth session. The default state filter is `100`; repeat `--state-code` to request other RLS-scoped states. The directory must be new. Two complete ordered reads must agree before private row files and an atomic `export-report.json` completion marker are published. The report includes identity, counts and file hashes; its observed stability is not a database transaction snapshot.

Limits are 100,000 rows per table, 1,000 pages per table scan, 8 MiB per response, 64 MiB total response bytes and a 120-second operation deadline. An incomplete or changed read fails without publishing a completion marker. Use a fresh directory for a new attempt; no business data is written.

## Auth Identity Receipt

Use the identity receipt before a production-backed case or any later owner-draft write gate:

```text
tiangong-lca auth identity-receipt --expected-project-ref <project-ref> --expected-user-id <user-id> --json
```

The command performs no dataset write. It resolves the selected OAuth or explicit headless session, checks the canonical Supabase project, and makes a bounded live `GET /auth/v1/user`. A refreshable cached token that receives `401` or `403` may be refreshed and retried exactly once; an explicit headless access token is never refreshed. All other transport or response failures are terminal. A valid production guard requires:

- `schema` exactly `tiangong-lca.auth-identity-receipt.v1`;
- `status: "passed"`, `operation: "current-user-read"`, and `remote_write_mode: "read-only"`;
- exact expected project/user values with `assertions.mode: "intent-bound"` and `requested_count: 2`;
- a fresh capture time and a valid recomputed `receipt_scope_sha256`.

Calling without expectations is allowed for discovery but produces `assertions.mode: "observed"`; it is not an authorization guard. The safe display email is masked and must not be used as the account key. The receipt deliberately excludes credentials, full email, session-file details, raw response metadata, and all credential/token/path-derived fingerprints.

## LCI/LCIA Data Release

The `release` command family is the authenticated transport used by the standalone release control plane. It does not introduce a TIDAS schema variant: result packages reuse the existing Process exchange structure for LCI and the existing Process LCIA result fields, with a LifecycleModel referencing the resulting Process.

The canonical publication set contains four self-contained ZIPs:

- Unit Process full closure in TIDAS and ILCD.
- Standalone LifecycleModel + Result full closure in TIDAS and ILCD. This package repeats the required canonical Unit Process and support closure, so it has no dependency on another ZIP.

Workflow:

```bash
tiangong-lca release prepare --input ./release-prepare.json --json
tiangong-lca release upload --input ./release-upload.json --output ./upload-receipt.json
tiangong-lca release finalize --input ./release-finalize.json --json
tiangong-lca release approve --input ./release-approval.json --json
tiangong-lca release publish --input ./release-publish.json --json
tiangong-lca release readback-verify --input ./release-readback.json --json
tiangong-lca release status --release-run-id <release-run-id> --json
```

`release-upload.json` contains the immutable plan identity plus exactly one artifact for each profile/format pair. Paths are resolved relative to the request file:

```json
{
  "releaseRunId": "11111111-1111-4111-8111-111111111111",
  "publishPlanHash": "<64 lowercase hex characters>",
  "artifacts": [
    {
      "profileId": "unit-process-full-closure.v1",
      "format": "tidas",
      "path": "./packages/unit-process.tidas.zip",
      "sha256": "<64 lowercase hex characters>",
      "byteSize": 1234,
      "mediaType": "application/zip"
    },
    {
      "profileId": "unit-process-full-closure.v1",
      "format": "ilcd",
      "path": "./packages/unit-process.ilcd.zip",
      "sha256": "<64 lowercase hex characters>",
      "byteSize": 1234,
      "mediaType": "application/zip"
    },
    {
      "profileId": "standalone-lifecyclemodel-result-full-closure.v1",
      "format": "tidas",
      "path": "./packages/result.tidas.zip",
      "sha256": "<64 lowercase hex characters>",
      "byteSize": 1234,
      "mediaType": "application/zip"
    },
    {
      "profileId": "standalone-lifecyclemodel-result-full-closure.v1",
      "format": "ilcd",
      "path": "./packages/result.ilcd.zip",
      "sha256": "<64 lowercase hex characters>",
      "byteSize": 1234,
      "mediaType": "application/zip"
    }
  ]
}
```

The CLI verifies every local upload against its declared byte size, SHA-256, media type, and required pair before requesting signed URLs. Upload receipts and downloads are written atomically with private file permissions. Existing outputs are preserved unless `--force` is explicit. Release requests use the resolved actor access token and `client_id`-aware database policy; no credential-derived fingerprint is accepted from local state or the request file.

Calculation results and published artifacts remain file-first:

```bash
tiangong-lca release calculation-bundle --package-id <package-id> --output ./calculation-bundle.json
tiangong-lca release calculation-artifact --package-id <package-id> --artifact-path chunks/lci-00000.jsonl.gz --output ./lci-00000.jsonl.gz
tiangong-lca release current --json
tiangong-lca release artifact-download --artifact-id <artifact-id> --output ./release.zip
```

`calculation-bundle` writes a verified manifest projection with short-lived URLs for its declared artifacts. Artifact downloads are accepted only when their exact path is present in that manifest, and downloaded bytes must match the durable size and SHA-256 before the output is exposed. Use `--dry-run` to validate inputs and inspect a credential-masked request without network writes.

Optional LLM review env, only for `qa process --enable-llm` or `qa flow --enable-llm`:

```bash
TIANGONG_LCA_REVIEW_LLM_BASE_URL=
TIANGONG_LCA_REVIEW_LLM_API_KEY=
TIANGONG_LCA_REVIEW_LLM_MODEL=
```

## Search

Minimal `search flow` request:

```json
{
  "query": "soda lime glass",
  "filter": {
    "flowType": "Product flow"
  }
}
```

Run:

```bash
tiangong-lca search flow --input ./search-flow.request.json --json
tiangong-lca search process --input ./search-process.request.json --json
tiangong-lca search lifecyclemodel --input ./search-lifecyclemodel.request.json --json
```

Empty search results should be treated as empty whether the response is `[]` or `{"data":[]}`.

## Read

```bash
tiangong-lca flow get --id <flow-id> --version <version> --json
tiangong-lca flow list --id <flow-id> --state-code 100 --limit 20 --json
tiangong-lca process get --id <process-id> --version <version> --json
tiangong-lca process list --state-code 100 --limit 20 --json
```

## Identity Preflight

Use identity preflight before generating new process or flow rows. The command compares one target against local candidate rows and emits a machine-readable `IdentityDecision` so automation can reuse, update, block, or route uncertain cases before payload generation.

```bash
tiangong-lca process identity-preflight --input ./process-preflight.json --out-dir ./process-preflight --json
tiangong-lca flow identity-preflight --input ./flow-preflight.json --out-dir ./flow-preflight --json
tiangong-lca process identity-preflight --input ./process-preflight.json --candidate-input ./exports/processes.jsonl --candidate-input ./local-process-catalog --out-dir ./process-preflight --json
tiangong-lca flow identity-preflight --input ./flow-preflight.json --remote-candidates --remote-query "electricity medium voltage" --remote-limit 20 --out-dir ./flow-preflight --json
```

Minimal input:

```json
{
  "target": {
    "name_en": "market for electricity, medium voltage",
    "reference_flow_id": "flow-electricity",
    "operation": "produce"
  },
  "candidates": [
    {
      "id": "existing-process",
      "name_en": "market for electricity, medium voltage",
      "reference_flow_id": "flow-electricity",
      "operation": "produce"
    }
  ]
}
```

Key outputs under `--out-dir`:

- `outputs/identity-decision.json`
- `outputs/identity-candidates.jsonl`
- `outputs/identity-candidate-sources.json`

`--candidate-input` is repeatable and accepts JSON, JSONL, or a directory scanned recursively for JSON/JSONL candidate rows. Embedded `candidates` from the request and local-scan candidates are evaluated together. Add `--remote-candidates` when the preflight should also call `process_hybrid_search` or `flow_hybrid_search`; `--remote-query` overrides the target-derived search text and `--remote-limit` caps returned candidate rows. Remote candidate search uses the normal OAuth session env above and optional `TIANGONG_LCA_REGION`.

When remote search is enabled, the CLI sends a compact fielded `query` string plus supported edge-search options to `process_hybrid_search` or `flow_hybrid_search`: `filter`, `match_count`, `page_size`, `data_source`, `match_threshold`, `lexical_weight`, `semantic_weight`, and `rrf_k`. `lexical_weight` controls the single database-owned `extracted_md` lexical branch. Request-level `remote_candidate_search.profile_hints` are not sent to the Edge Function. They are applied locally before scoring candidates so Foundry can provide source-derived facts such as flow type, flow property, reference unit, elementary categories, geography, reference-flow names, technology route, and system boundary without polluting the full-text/semantic query.

Exact process exchange fingerprints with matching identity context block duplicate creation, while weaker inventory-only matches still route to manual review. Flow preflight also blocks alias-equivalent flows when type, reference property, unit, and category/CAS evidence match.

## Build Plan Gate

Use build-plan gates after identity preflight and before publish handoff. These commands validate the minimum authoring contract for a process or flow build plan, write a standard `GateReport` for Foundry/skill orchestration, and materialize deterministic canonical TIDAS payloads when no explicit payload is embedded in the plan.

```bash
tiangong-lca process build-plan validate --input ./process-build-plan.json --out-dir ./process-build-plan --json
tiangong-lca process build-plan materialize --input ./process-build-plan.json --out-dir ./process-build-plan --json
tiangong-lca flow build-plan validate --input ./flow-build-plan.json --out-dir ./flow-build-plan --json
tiangong-lca flow build-plan materialize --input ./flow-build-plan.json --out-dir ./flow-build-plan --json
```

The minimum plan contract requires an automatic identity decision, EvidenceManifest sources and field bindings, name plan, and the relevant process reference-flow or flow-property fields. Plan-only materialization additionally requires an explicit canonical `classification_path`: continuous level `0..n` objects with exact locked `@classId`/`#text` for process and product/waste flow taxonomies, or `@catId`/`#text` for elementary flows. Label-only, missing, malformed, or taxonomy-spoofed classifications fail before artifact publication. Process materialization carries name, quantitative reference, exchange, source evidence, modelling, administrative, and annual supply/production fields from the plan into `processDataSet`; an explicit language array is carried through with its exact content and order, and when annual volume source evidence is not explicit the field stays unknown as the supported empty array rather than being derived from the quantitative reference amount or a reference/default unit. Required-field completion then reports `completed_with_blockers` with a row-level evidence gap; the historical `9999 missing-data-sentinel/year` value is recognized only to normalize rows written by earlier rounds, and downstream schema, authoring, curation and write gates remain the blocking owners. Flow materialization carries name, flow type, reference property, source evidence, administrative, and classification fields into `flowDataSet`. `--report-only` keeps exit code `0` while still reporting blockers.

Key outputs under `--out-dir`:

- `outputs/build-plan-gate-report.json`
- `outputs/materialized-process.json`
- `outputs/materialized-flow.json`

## Real DB Flow QA

1. Search or otherwise collect exact flow refs.
2. Materialize DB rows into local QA input.
3. Run QA on the materialized rows.
4. Materialize approved decisions into downstream artifacts.

`flow fetch-rows` input:

```json
[
  {
    "id": "7a285e9a-a9f6-4b86-ab17-6ea17367400c",
    "version": "01.01.001",
    "state_code": 100,
    "cluster_id": "cluster-0001",
    "source": "search-flow"
  }
]
```

`flow materialize-decisions` input:

```json
[
  {
    "cluster_id": "cluster-0001",
    "decision": "merge_keep_one",
    "canonical_flow": {
      "id": "7a285e9a-a9f6-4b86-ab17-6ea17367400c",
      "version": "01.01.001"
    },
    "flow_refs": [
      "7a285e9a-a9f6-4b86-ab17-6ea17367400c@01.01.001",
      "017acdd0-7fd7-44cb-a410-1d559e59c506@01.01.001"
    ],
    "reason": "approved_same_product_flow"
  }
]
```

Run:

```bash
tiangong-lca flow fetch-rows \
  --refs-file ./flow-refs.json \
  --out-dir ./flow-fetch

tiangong-lca qa flow \
  --rows-file ./flow-fetch/qa-input-rows.jsonl \
  --out-dir ./flow-qa

tiangong-lca flow materialize-decisions \
  --decision-file ./approved-decisions.json \
  --flow-rows-file ./flow-fetch/qa-input-rows.jsonl \
  --out-dir ./flow-decisions
```

Key `flow fetch-rows` outputs:

- `qa-input-rows.jsonl`
- `fetch-summary.json`
- `missing-flow-refs.jsonl`
- `ambiguous-flow-refs.jsonl`

Key `flow materialize-decisions` outputs:

- `flow-dedup-canonical-map.json`
- `flow-dedup-rewrite-plan.json`
- `manual-semantic-merge-seed.current.json`
- `decision-summary.json`
- `blocked-clusters.json`

## Other Common Commands

```bash
tiangong-lca process identity-preflight --input ./process-preflight.json --candidate-input /abs/path/to/process-candidates.jsonl --out-dir /abs/path/to/process-preflight --json
tiangong-lca flow identity-preflight --input ./flow-preflight.json --candidate-input /abs/path/to/flow-catalog --out-dir /abs/path/to/flow-preflight --json
tiangong-lca process identity-preflight --input ./process-preflight.json --remote-candidates --remote-limit 20 --out-dir /abs/path/to/process-preflight --json
tiangong-lca process build-plan validate --input ./process-build-plan.json --out-dir /abs/path/to/process-build-plan --json
tiangong-lca flow build-plan validate --input ./flow-build-plan.json --out-dir /abs/path/to/flow-build-plan --json
tiangong-lca process auto-build --input ./examples/process-auto-build.request.json --out-dir /abs/path/to/process-run --json
tiangong-lca process resume-build --run-dir /abs/path/to/process-run --json
tiangong-lca process publish-build --run-dir /abs/path/to/process-run --json
tiangong-lca process batch-build --input ./examples/process-batch-build.request.json --out-dir /abs/path/to/process-batch --json
tiangong-lca dataset validate --input ./rows.jsonl --type auto --out-dir /abs/path/to/dataset-validate --json
tiangong-lca dataset classification audit --type location --input ./rows/processes.jsonl --out-dir /abs/path/to/location-audit --json
tiangong-lca dataset classification apply --type location --input ./rows/processes.jsonl --decisions ./location-decisions.jsonl --out ./rows/processes.located.jsonl --out-dir /abs/path/to/location-apply --json
tiangong-lca dataset curation-queue build --processes ./rows/processes.jsonl --flows ./rows/flows.jsonl --support ./rows/sources.jsonl --out-dir /abs/path/to/curation-queue --json
tiangong-lca dataset curation-queue next --queue-dir /abs/path/to/curation-queue --type support --json
tiangong-lca dataset curation-queue verify --queue-dir /abs/path/to/curation-queue --type process --json
tiangong-lca dataset import-lca convert --input ./external/simapro.csv --output-dir /abs/path/to/imported --from-format simapro-csv --target both --write-mapping --json
tiangong-lca dataset save-draft --input ./rows.jsonl --type auto --execution-contract ./execution-contract.json --max-parallel 8 --out-dir /abs/path/to/dataset-save-draft --commit --json
tiangong-lca dataset evidence-search plan --query "中国2026年电力结构数据" --out-dir /abs/path/to/evidence-search --json
tiangong-lca dataset evidence-search run --input ./evidence-search.request.json --results ./search-results.json --out-dir /abs/path/to/evidence-search --json
tiangong-lca dataset references rewrite --input ./rows.jsonl --from flow:<old-id>@<old-version> --to flow:<new-id>@<new-version> --out-dir /abs/path/to/dataset-rewrite --json
tiangong-lca dataset maintenance plan --scope ./maintenance-scope.json --operation redo-import --out-dir /abs/path/to/dataset-maintenance --page-size 1000 --timeout-ms 10000 --json
tiangong-lca dataset maintenance plan --scope ./derivative-rebuild-scope.json --operation rebuild-derivatives --out-dir /abs/path/to/derivative-rebuild --json
tiangong-lca dataset maintenance apply --plan /abs/path/to/dataset-maintenance/maintenance-plan.json --commit --approve-plan <sha256> --confirm <current-account-email> --timeout-ms 10000 --json
tiangong-lca dataset maintenance apply --plan /abs/path/to/flow-delete-maintenance/maintenance-plan.json --commit --approve-plan <sha256> --confirm <current-account-email> --max-parallel 8 --timeout-ms 10000 --json
tiangong-lca dataset maintenance verify --plan /abs/path/to/dataset-maintenance/maintenance-plan.json --out-dir /abs/path/to/dataset-maintenance/verify --page-size 1000 --timeout-ms 10000 --json
tiangong-lca dataset maintenance run-protected --plan /abs/path/to/maintenance-plan.json --freeze /abs/path/to/protected-execution-freeze.json --approval /abs/path/to/protected-approval.json --out-dir /abs/path/to/protected-run --status-only --json
tiangong-lca lifecyclemodel auto-build --input ./examples/lifecyclemodel-auto-build.request.json --out-dir /abs/path/to/lifecyclemodel-run --json
tiangong-lca lifecyclemodel validate-build --run-dir /abs/path/to/lifecyclemodel-run --json
tiangong-lca lifecyclemodel publish-build --run-dir /abs/path/to/lifecyclemodel-run --json
tiangong-lca lifecyclemodel save-draft --input ./lifecyclemodels.jsonl --out-dir /abs/path/to/lifecyclemodel-save-draft --dry-run --json
tiangong-lca lifecyclemodel graph --input ./lifecyclemodels.jsonl --out-dir /abs/path/to/lifecyclemodel-graph --format all --json
tiangong-lca lifecyclemodel orchestrate plan --input ./lifecyclemodel-orchestrate.request.json --out-dir /abs/path/to/lifecyclemodel-recursive-run --json
tiangong-lca qa process --rows-file ./process-list-report.json --reference-rows-file ./flows.jsonl --reference-rows-file ./support.jsonl --out-dir ./process-qa
tiangong-lca qa process --run-root /abs/path/to/process-run --run-id <run_id> --out-dir ./process-qa
tiangong-lca process save-draft --input ./patched-processes.jsonl --out-dir /abs/path/to/process-save-draft --dry-run --json
tiangong-lca process save-draft --input ./patched-processes.jsonl --out-dir /abs/path/to/process-save-draft --commit --target-user-id <user-id> --json
tiangong-lca flow publish-version --input-file ./ready-flows.jsonl --out-dir /abs/path/to/flow-publish --dry-run --json
tiangong-lca flow publish-reviewed-data --flow-rows-file ./reviewed-flows.jsonl --out-dir /abs/path/to/reviewed-publish --dry-run --json
tiangong-lca publish run --input ./publish-request.json --dry-run
tiangong-lca doctor --json
```

For `publish run`, relative `out_dir` values from either the request body or `--out-dir` are resolved against the request file directory, not the shell `cwd`. Use an absolute path when you want a fixed destination independent of the request file location.

For `qa process`, `--rows-file` accepts either raw process rows as JSON/JSONL or the full JSON report emitted by `tiangong-lca process list --json`, as long as it contains a `rows` array.

Process mass QA defaults to `v2.2-unit-aware`. Supply exact local Flow, Flow Property and Unit Group rows through repeatable `--reference-rows-file <file>`. Each exchange resolves its exact Flow → reference Flow Property → reference Unit Group chain, including unique reference occurrences and reference conversion values. The report retains the selected file hashes, consumer payload hash and per-exchange reference payload hashes. Missing or conflicting identities, unknown/ambiguous units, contradictory unit tags, invalid quantities and arithmetic overflow remain findings; no reference files are discovered implicitly.

Unit symbols retain SI case and internal token boundaries: `Mg` and `mg` have different mass scales, and unsupported `T`, `G` or split symbols cannot be coerced into tonnes or grams. Descriptive names such as `KILOGRAM` may be case folded. Unit-tag names are case insensitive, but their captured symbols retain case.

Only comparable mass amounts are normalized to kilograms. Mass-valued fuels and all mass input/output occurrences participate; by-products, waste and other outputs remain separately visible. A count-, energy-, area-time- or other recognized nonmass reference product has `mass_balance[].status=not_applicable` and null mass totals/deviation. Canonical `m2*a` and NFKC-equivalent `m²*a` are recognized without generic composite-unit inference. Unresolved applicability also retains null totals. Zero input never fabricates a relative denominator; positive mass output with zero mass input remains a finding. `energy_excluded` stays null because heterogeneous nonmass amounts cannot form a numeric total. Cross-process totals are diagnostic only and cannot replace each process's findings or a source-model physical balance. Existing report filenames remain stable, and `--logic-version` is a diagnostic label, not an algorithm-selection or bypass option. QA changes no quantities, references or remote data.

For `process identity-preflight` and `flow identity-preflight`, canonical TIDAS wrappers are schema-checked when present. Loose target objects are accepted for early planning and produce `schema_validation.status: "not_applicable"` until materialization. Candidate rows can be embedded in the request, loaded from repeatable `--candidate-input` local files/directories, or fetched through explicit `--remote-candidates` hybrid search; `identity-candidate-sources.json` records scanned files, remote endpoints, queries, filters, edge-search options, and row counts. The remote Edge Function receives only search-safe query/options fields; local-only `profile_hints` stay in the preflight target profile and candidate scoring evidence.

For `process build-plan` and `flow build-plan`, canonical payloads embedded in the plan are schema-checked during `materialize`. Plan-only materialization creates deterministic canonical `processDataSet` / `flowDataSet` wrappers, requires an explicit canonical locked-taxonomy `classification_path`, and validates the result with the TIDAS SDK before reporting `passed`; it never invents taxonomy ids from free-form labels.

For `process save-draft`, canonical process payloads are validated locally with `ProcessSchema` before any `--commit` write. Schema-invalid rows remain in `outputs/save-draft-rpc/failures.jsonl` instead of being persisted. Batch import callers should pass `--target-user-id`; the CLI then verifies the current auth session and any visible draft owner before writing, while downstream readback verification still proves the final owner and payload.

For `dataset verify-remote`, optional `--reference-intent-file` selects a strict consumer/project/actor/content/review-bound exception for exact reference occurrences. Public state 100 or current-owner draft state 0 must match the selected payload and reviewed current latest definition. Missing, hidden, undeclared or changed evidence and all root checks remain blocking. This is read-only observation, never write authority or a database lock. The [exact-reference intent contract](docs/agents/exact-reference-intent-contract.md) defines JSON fields, hash domains, file limits, current-input rechecks and the additional report evidence.

For `dataset save-draft --execution-contract`, the JSON contract uses schema `dataset-save-draft-execution-contract.v1` and supplies `execution_id`, `project_ref`, an exact owner (`user_id`, lowercase `email`, `state_code: 0`), and ordered actions. Each action binds `action_id`, `desired_sha256`, `expected_operation` (`insert` or `save_draft`), table/id/version, `before_sha256`, and earlier `dependency_action_ids`. With `--commit` the contract dispatches guarded owner writes; without `--commit` the same contract runs a read-only dry-run preflight and can never report an executed row. Account-local Unit Group or Flow Property support rows additionally require `--allow-account-local-support`. An existing owner Unit Group or Flow Property draft may additionally be repaired through a bounded metadata admission: only a `save_draft` contract action whose fresh before image and candidate both pass every validation layer, whose dataset id/version and the stored ownership or source reference ids, versions, URIs and language structure stay identical, and whose only delta is the existing `common:shortDescription.#text` of that ownership or source reference is admitted. Its row carries the content-bound `draft_repair_admission` with policy `support-reference-metadata.v1`, keeps the ordinary `ruleVerification: true` (the row is fully valid) and dispatches through the same guarded before-image transport; every other Unit Group or Flow Property write keeps the ordinary `reference_only_type` rejection. `--max-parallel` defaults to 1, is capped at 8, and requires `--commit`. Every action through the highest referenced dependency remains on the existing serial path; only the later table/id/version-unique suffix delegates claims and fatal-stop coordination to the public batch engine. `executeAction` still exclusively owns PREPARED evidence, exact before-state checks, token renewal, dispatch, durable attempts, readback, and no-replay decisions, so report bytes and input ordering do not change. Attempts and outcomes are stored under the platform user-state directory (`$XDG_STATE_HOME/tiangong-lca-cli` when configured), not beside the contract or report. Any prior terminal or unresolved attempt is read back or retained without re-dispatch; exit status is nonzero unless every action has exact terminal success.

For every `save_draft` action the CLI sends the complete before image it read fresh in that run as `expectedJsonOrdered`. The platform compares that JSON value against the stored row under the row lock and rejects stale, changed, foreign, non-owner or non-draft content with `DATASET_BEFORE_CONTENT_CHANGED` (or the existing owner/state codes). The CLI never falls back to the unguarded save and never retries after a guard rejection: the attempt is already durable, so the outcome is resolved by exact readback only and the row is reported `UNKNOWN`. The before image is the stored JSON value itself, never a client-side hash protocol.

A contract dry-run (no `--commit`) performs real authentication plus the exact owner/state/before/content and remote-reference preflight, then stops: it dispatches no command, creates no attempt and no ledger entry, and records `visible_row` evidence only. Each action whose dependencies are `prepared` in that same preflight is verified in turn, so an existing-draft chain is fully preflighted; a drift, an unresolved reference or any other failure is reported as a blocking failure and blocks its descendants. Existing attempt state is read read-only: an action that already owns an attempt or outcome is reported `blocked` with `retained_attempt`/`retained_outcome` and is never re-authorized as `prepared`. When every still-missing remote reference is a dataset an earlier action of the same contract inserts, the action is honestly `blocked_dependency` (the preflight never invents a remote row) instead of failed or faked ready. Its report is `mode: "dry_run"` with `commit: false` and only `prepared`/`failed`/`blocked` rows, so closeout can never treat it as an executed import.

The one bounded exception is an existing owner Process draft whose only validation failure is the annual evidence gap (`annual_supply_or_production_volume_missing`) while both the stored and candidate `annualSupplyOrProductionVolume` stay the unchanged empty array `[]`. Such a candidate may change only the text of `common:shortDescription` under `...dataSourcesTreatmentAndRepresentativeness.referenceToDataSource` or `...publicationAndOwnership.common:referenceToOwnershipOfDataSet`; array lengths and order, languages, reference ids/versions/URIs and every other field must stay identical, at least one real change is required, and a missing annual field that would become `[]` is never admitted. The decision is made only after the fresh before read proved the contract's owner, state 0 and before hash, so drift, a foreign owner or a non-draft state fails first, and the stored draft itself is re-validated with the same real validator on a clone: a before with a schema, content or multilingual failure, another authoring code, or a blank/placeholder reference description is refused even when the candidate would "fix" it. An admitted row writes through the same guarded before-image transport with `ruleVerification=false` and records a content-bound `draft_repair_admission` (`dataset-draft-repair-admission.v1`, policy `process-metadata-unknown-annual.v1`, before/desired SHA-256, `changed_paths`, `publication_ready:false`); its row keeps `validation.ok=false` with the failed authoring layer, so nothing is reported ready. The admission is bound into the hashed `attempt_emitted` ledger event of that first dispatch, so after a crash between dispatch and outcome a new run returns the original admission from that attempt and resolves by exact readback only — it never re-derives the admission from a fresh read that may already hold the desired content. Legacy attempt events without the field stay valid and simply carry no admission, and any tampered, dropped or semantically drifting admission fails the ledger check instead of being trusted. Inserts, contract-less commands and every other blocker stay on the strict admission path, and a dry-run records the same admission without dispatching.

Review note, 2026-09-21: CLI #358 adds the bounded exact exponent decimal module for the versioned v2 Time alias plan (mantissa up to 64 digits, exponent within +/-30, bigint normalisation, no floating point) and its anonymized real-shape RED/GREEN tests. It is additive: the frozen v1 alias grammar, profiles, constants, plan/response shape and every historical replay identity are byte-unchanged, and the tests pin that v1 still refuses exponent quantities. The v2 wire (plan/batch schema, counts, response shape) awaits the Database #673 proposal and is not decided here.

Review note, 2026-09-22: Issue #362 prepares the 0.1.21 version-only release on branch `codex/issue-362-cli021`, refreshed by merging main `24f227a` (PR #365, CLI #364 approval-time binding) over the reviewed PR #360 (CLI #358) and PR #361 (CLI #359) source. Package identity and the live CLI-version fixtures advance; dependencies, the sole lock, runtime files, strict exports, commands and release automation stay unchanged. The source is merged but publication has not happened — npm latest is `0.1.20` and no `cli-v0.1.21` tag exists — so the package-version line above states the in-repository release preparation and the actually published version separately instead of claiming a release; the Database #674/#680 capability is deployed and integrated on main, so the remaining steps are root's push, the exact-head four-platform CI, the merge-triggered tag and Trusted Publishing.

Review note, 2026-09-21: Issue #356 prepares the 0.1.20 version-only release for merged source PR #355 on branch `codex/issue-356-cli-0.1.20` (base main merge `8cb5a10`). Package identity and the four live CLI-version fixtures advance; dependencies, the sole lock, runtime files, strict exports, commands and release automation stay unchanged. The source is merged but publication has not happened — npm latest is `0.1.19` and no `cli-v0.1.20` tag exists — so the package-version line above states the in-repository release preparation and the actually published version separately instead of claiming a release.

Review note, 2026-09-21: CLI #354 adds the bounded existing-draft support metadata repair for Unit Group and Flow Property rows. `src/lib/dataset-draft-repair-admission.ts` now owns two policies that share one artifact and one byte-identical-everything-else walker: the released Process annual-gap policy is unchanged, while the new `support-reference-metadata.v1` policy admits only a bounded `save_draft` contract action whose fresh before image and candidate both pass all four validation layers, whose ids/versions/URIs/language structure/units/factors/reference property are unchanged, and whose only delta is the existing `common:shortDescription.#text` of the row's own ownership or source reference. The write reuses the guarded before-image transport (the deployed `api.cmd_dataset_save_draft_guarded` already accepts `unitgroups` and `flowproperties` and delegates to the single existing writer) and keeps `ruleVerification: true`. The ledger reuses the same hashed `attempt_emitted` admission binding plus a policy-to-table correlation, so a tampered or cross-policy admission is refused. Ordinary reference-only rejection, inserts, published rows, science or reference retargeting, language/shape changes and non-contract commands are untouched. No dependency, version, lock or release change; this capability is not part of the version-only 0.1.19 release and needs its own later release.

Review note, 2026-09-21: CLI #283 (workspace #1432 campaign) also adds the narrow existing-Process metadata repair admission (`dataset-draft-repair-admission.ts`, with the stored draft verified by the same validator and the verified admission hash-bound into the first attempt event), and makes a retained attempt win over the validation classification: a row whose candidate the current validator rejects is reported from its ledger state (commit: readback-only `executed`/`UNKNOWN` with `attempt_consumed=true`; dry-run: `blocked` with `retained_attempt`/`retained_outcome`) instead of an unconsumed `failed` row, so a successor never reads a consumed attempt as a zero-dispatch report. No dependency, version, flag, or publication boundary changes. consumed by Foundry #171 and the contract dry-run. `saveDraftDatasetRecord` carries an optional `expectedJsonOrdered` object (absent for every legacy caller, so the legacy body stays byte-identical); `app_dataset_save_draft` routes a present before image to the guarded database facade from Database #670 / Edge #425. The execution-contract batch now runs in `commit` or `dry_run` mode with one shared before-state check; the dry-run mode reads the attempt ledger read-only (no directory, no event, no rewrite), stays serial, satisfies a dependency with an action prepared earlier in the same preflight, retains already consumed attempts as `blocked`, and additionally requires env/fetch runtime bindings.

For `dataset maintenance apply`, explicitly passing `--max-parallel 1..8` opts into the destructive flow-convergence profile. It accepts only a non-empty, unique-target, flow delete-only plan whose current and projected reference impacts are both zero. Before dispatch it completes a fresh SELECT-only scan of every process visible to the owner session and rejects any inbound edge. For a separately governed all-process check, pair `--global-inbound-proof /absolute/proof.json` with `--approve-global-inbound-proof <sha256>`; the proof must be fresh, SELECT-only, complete, zero-inbound, and bound to the exact project, actor, plan, and ordered target set, and it is validated before the live scan is skipped. The CLI never runs raw SQL. Each action writes append-only `PREPARED` and `DISPATCHED` evidence before its protected owner-session RPC, then records `COMMITTED` only after exact absent readback. An ambiguous action is read back, marked `UNKNOWN`, and never replayed automatically; independent actions continue. Omit `--max-parallel` to retain ordinary maintenance apply behavior.

For `flow publish-version`, canonical flow payloads are validated locally with `FlowSchema` before remote visibility planning or writes. The command always writes `flow-publish-version-gate-report.json`; blocked rows are written to the remote-failure JSONL without calling the remote service.

For `process publish-build`, canonical process payloads are validated locally with `ProcessSchema` before publish handoff artifacts are written. The gate report is `reports/process-publish-schema-gate.json`.

For `publish run`, `verification-report.json` is written next to `publish-report.json` and summarizes the publish ruleset status, blockers, failed entries, deferred entries, and executed entries.

Runtime rulesets use the released spec 0.2.1 public definitions at exact source identity. The CLI prefers a byte-equivalent `getTidasPublicRules` SDK contract when available and otherwise uses its hash-bound bundled fallback; severity, phases, blockers, profile membership, local finding mappings, and gate disposition remain CLI-owned. A present but malformed, stale, not-covered, or incompatible SDK response fails closed rather than falling back. `dataset contract` derives its requested ruleset/context-pack artifact from these verified definitions and CLI-owned profiles; it does not read the SDK's legacy mixed ruleset file.

For `lifecyclemodel save-draft`, canonical lifecyclemodel payloads are validated locally with `LifeCycleModelSchema` before any `--commit` write. Schema-invalid rows remain in `outputs/save-draft-bundle/failures.jsonl` instead of being persisted.

For `dataset evidence-search`, `plan` creates the field-level query matrix and search budget. `run` accepts normalized external search results from browser/web-search tools or a generic JSON provider endpoint, then writes `outputs/evidence-search-plan.json`, `outputs/evidence-search-results.jsonl`, `outputs/evidence-search-report.json`, and `outputs/evidence-search-declaration.json` when evidence is absent or only partial. The CLI records scope and normalization; Codex/skills still own semantic judgement and source selection.

For `dataset validate`, `--type auto` supports mixed support scopes containing contact/source/unitgroup/flowproperty rows as well as flow/process/lifecyclemodel rows. For `dataset classification`, `children` and `path` navigate the bundled TIDAS category schemas copied from `tidas-tools`. `audit --type location` scans local rows for schema-derived location-code fields, plus TIDAS LCIA geography and lifecyclemodel connection location fields, whose values are not in `tidas_locations_category.json`; `apply --type location` applies structured decisions to a specific `target_path` when a row has multiple location fields. When `target_path` explicitly points at a schema-derived location field such as `flowDataSet.flowInformation.geography.locationOfSupply`, location apply may create the missing parent object and field; ambiguous or non-location paths still block.

For `dataset curation-queue build/next/verify`, the CLI owns entity-level Foundry import queue state. `build` writes `outputs/curation-queue-manifest.json`, `outputs/curation-queue-tasks.jsonl`, `outputs/curation-queue-locks.json`, `outputs/curation-queue-blockers.jsonl`, and per-entity `input.jsonl`, `closure.json`, and `entity-run-plan.json`. `next` returns one runnable support/flow/process task based on checkpoint state. `verify` passes only when scoped checkpoints are complete and build blockers are absent. AI authoring must return structured patches or build plans, and remote writes remain gated by deterministic apply, schema/QA, prewrite verify, and readback.

For `dataset import-lca convert`, the CLI delegates all format detection, conversion, validation, bounded spooling, cancellation, and atomic publication to unified Rust `tidas import`; it does not reproduce import logic in TypeScript. Binary selection is `--tidas-bin`, then `TIDAS_BIN`, then `tidas` on PATH. Optional `--tidas-config` maps to native `--config`. Every run first requires a successful `tidas version --format json --progress never` handshake with `tidas.operation-report.v1` and a stable `0.2.x` binary version, then validates the native `tidas.import-execution-report.v1` summary and exact exit-class/code mapping. Native controls include explicit or automatic source format, target, mapping output, process-bundle disablement, warning failure, maximum entry size, memory budget, and queue capacity. The supported release matrix is Linux x86_64/ARM64, macOS Apple Silicon (arm64), and Windows x86_64; Windows ARM64 is unsupported. The npm package includes `assets/import-smoke/simapro.csv` for clean-machine proof but does not bundle a platform binary or require Python.

For `dataset references rewrite`, `--commit` executes the state-aware save-draft path for patched process and lifecyclemodel rows; without `--commit`, the command only writes local rewrite artifacts.

## Dataset Maintenance

`dataset maintenance plan/apply/freeze-protected/seal-protected-approval/run-protected/verify` is the row-level cleanup surface for bad imports, the fixed BAFU private alias rewrite, and protected derivative rebuilds. Ordinary planning, apply, and independent verification use the authenticated account and RLS. Protected freeze preparation reads the live production owner-draft scope directly with no Dev data replay, while approval sealing is offline. The protected executor is server-dispatched and additionally enforces the sealed actor, user_id, state_code=0, exact target set, and closure hashes on every write.

```bash
tiangong-lca dataset maintenance plan \
  --scope ./maintenance-scope.json \
  --operation repair-references \
  --out-dir ./dataset-maintenance \
  --page-size 1000 \
  --timeout-ms 10000 \
  --json

tiangong-lca dataset maintenance apply \
  --plan ./dataset-maintenance/maintenance-plan.json \
  --commit \
  --approve-plan <sha256> \
  --confirm <current-account-email> \
  --timeout-ms 10000 \
  --json

tiangong-lca dataset maintenance verify \
  --plan ./dataset-maintenance/maintenance-plan.json \
  --out-dir ./dataset-maintenance/verify \
  --page-size 1000 \
  --timeout-ms 10000 \
  --json

tiangong-lca dataset maintenance freeze-protected \
  --plan ./protected-step2/maintenance-plan.json \
  --toolchain-evidence ./protected-step2/toolchain-evidence.json \
  --expected-project-ref <production-project-ref> \
  --confirm <current-account-email> \
  --out-dir ./protected-step2/freeze \
  --page-size 1000 \
  --timeout-ms 10000 \
  --json

# After a human returns protected-approval-request.txt byte-for-byte as human-approval.txt:
tiangong-lca dataset maintenance seal-protected-approval \
  --freeze ./protected-step2/freeze/protected-execution-freeze.json \
  --approval-request ./protected-step2/freeze/protected-approval-request.json \
  --human-approval ./protected-step2/human-approval.txt \
  --approve-freeze-file <freeze-file-sha256> \
  --approve-request <approval-request-sha256> \
  --approve-text <approval-text-sha256> \
  --confirm <current-account-email> \
  --approved-at <approved-at-utc-from-request> \
  --out-dir ./protected-step2/approval \
  --json

tiangong-lca dataset maintenance run-protected \
  --plan ./protected-step2/maintenance-plan.json \
  --freeze ./protected-step2/freeze/protected-execution-freeze.json \
  --approval ./protected-step2/approval/protected-approval.json \
  --out-dir ./protected-step2/run \
  --commit \
  --approve-execution <approved-execution-sha256> \
  --confirm <current-account-email> \
  --wait-seconds 60 \
  --poll-ms 10000 \
  --page-size 1000 \
  --timeout-ms 10000 \
  --json

tiangong-lca dataset maintenance run-protected \
  --plan ./protected-step2/maintenance-plan.json \
  --freeze ./protected-step2/freeze/protected-execution-freeze.json \
  --approval ./protected-step2/approval/protected-approval.json \
  --out-dir ./protected-step2/run \
  --status-only \
  --wait-seconds 60 \
  --json
```

`run-protected` is a separate one-shot path for an already reviewed and sealed production execution; it does not replace ordinary planning. Both modes require the exact plan, freeze artifact, approval artifact, and private output directory. Commit mode additionally requires `--commit`, the exact approved execution identity through `--approve-execution`, and the authenticated account email through `--confirm`. `--status-only` is mutually exclusive with `--commit` and performs no preflight or admission.

`freeze-protected` is the only supported generator for this fixed protected profile. Its toolchain evidence must be canonical JSON with schema `dataset-alias-protected-toolchain-evidence.v1`, production project ref, released-and-read-back database commit/evidence, the currently running published CLI version/commit/evidence, and the merged root-workspace integration commit/Issue. The fixed BAFU profile also has a compiled production project allowlist; the CLI rejects a Dev or arbitrary project even if the operator supplies matching flag/evidence values. The command verifies the exact 52 actions, two batches, six support snapshots, projected reference closure, and stable 23-flow + 27-process derivative snapshots; every derivative snapshot must have the same primary-row `modified_at` as the immediately preceding complete account census. It writes the entire private immutable alias-request, full baseline, freeze, unapproved request JSON/TXT, and final report into a sibling staging directory and atomically exposes the new output directory only after every file succeeds; preflight, gate, admission, mutation, and approval-artifact counts are all zero.

`seal-protected-approval` receives no environment or HTTP client. The freeze command puts one canonical approval-authority `approved_at_utc` into the request JSON, request hash, and human-visible approval text before review; seal requires `--approved-at` to equal that already approved value. The same text therefore cannot be resealed with another timestamp to mint a second database admission identity. The seal report records its actual generation time separately from this pre-authorized identity timestamp. Both commands hash raw file bytes, reject invalid UTF-8, publish their completed output directories atomically, and reject non-canonical freeze/request files, any changed whitespace or final newline, mismatched explicit hash/account/time bindings, and all three superseded historical Step-2 plan identities. Commit-mode `run-protected` rejects the same historical identities, so an old freeze/approval cannot bypass the fresh preparation chain; status-only remains read-only and available for recovery. Seal writes the canonical approval plus a local report, but does not submit execution. Human approval, sealing, and later execution remain separate events.

Before requesting preflight, the command validates the sealed production project, full current-user RLS before-state, support closure, and exact derivative baseline. The server then returns the three expected gate digests and a token valid for at most 180 seconds; the CLI captures and compares the live gate receipts before admission. The server-dispatched write remains fenced to the authenticated actor's exact `user_id`, `state_code=0` rows and sealed plan/closure; independent readback still uses RLS. The CLI writes an immutable local submission marker and sends at most one admission POST. A marker, admission timeout, connection loss, or ambiguous admission response permanently switches that local run to status-only recovery; status-read failures may be polled only within the configured wait window and never cause a second admission or fallback to dev or the legacy whole-plan RPC. The default status polling interval is 10 seconds.

Success requires the terminal database proof and independent RLS readback to agree on the approved execution, exact row/exchange/audit closure, and exactly 50 derivative targets split into 23 flows and 27 processes. `pending`, `failed`, and `indeterminate` all return a non-zero exit status. The protected operation keeps all affected rows private to their owner, changes no `state_code`, and does not publish data.

### Versioned Time alias (v2)

The versioned Time alias path is the same protected chain with versioned science, for the fixed BAFU current-owner cohort whose source-proven before amounts are one-hour quantities written in years. It is selected explicitly and never inferred from a missing flag:

```bash
# 1. Versioned plan and batch from the reviewed planning input (no --scope/--operation):
tiangong-lca dataset maintenance plan \
  --alias-v2-input ./alias-v2/planning-input.json \
  --out-dir ./alias-v2 \
  --json

# 2. Versioned freeze; a dataset-alias-plan.v2 plan requires its reviewed derivative baselines:
tiangong-lca dataset maintenance freeze-protected \
  --plan ./alias-v2/alias-v2-plan.json \
  --toolchain-evidence ./alias-v2/toolchain-evidence.json \
  --derivative-baselines ./alias-v2/derivative-baselines.json \
  --expected-project-ref <production-project-ref> \
  --confirm <current-account-email> \
  --out-dir ./alias-v2/freeze \
  --json

# 3. Seal the human approval exactly as for v1 (still offline):
tiangong-lca dataset maintenance seal-protected-approval \
  --freeze ./alias-v2/freeze/protected-v2-execution-freeze.json \
  --approval-request ./alias-v2/freeze/protected-v2-approval-request.json \
  --human-approval ./alias-v2/freeze/protected-v2-human-approval.txt \
  --approve-freeze-file <freeze-file-sha256> \
  --approve-request <approval-request-sha256> \
  --approve-text <approval-text-sha256> \
  --confirm <current-account-email> \
  --approved-at <approved-at-utc-from-request> \
  --out-dir ./alias-v2/approval \
  --json

# 4. Run or recover; the seal's schema selects the versioned chain:
tiangong-lca dataset maintenance run-protected \
  --plan ./alias-v2/alias-v2-plan.json \
  --freeze ./alias-v2/freeze/protected-v2-execution-freeze.json \
  --approval ./alias-v2/approval/protected-v2-approval.json \
  --out-dir ./alias-v2/run \
  --commit \
  --approve-execution <approved-execution-sha256> \
  --confirm <current-account-email> \
  --wait-seconds 60 \
  --poll-ms 10000 \
  --json
```

The freeze designates one canonical approval-authority timestamp — its own clock at request time — as a field of the approval-request core, so the request digest moves with it, and the words a human approves name it as the designated approval-request timestamp accepted with those exact contents and reused unchanged by the seal. It is the timestamp the request designates, not the moment of the human approval. `seal-protected-approval` requires `--approved-at` to equal that already approved value and refuses an absent, invalid or changed timestamp before it writes anything, so the same approved words cannot be resealed with another time to mint a second approval identity; a request written before this binding is refused by name and must be regenerated with a fresh freeze. The approved words are re-rendered from the request's own facts — the designated timestamp, the capability, the plan and freeze digests, the project and the counts — and must match byte-for-byte, so editing the request's timestamp or the words never yields a seal.

The stages write `alias-v2-plan.json`, `alias-v2-batch.json`, `protected-v2-execution-freeze.json`, `protected-v2-approval-request.json`/`.txt`, `protected-v2-human-approval.txt` and then `protected-v2-approval.json`, followed by the run's `protected-v2-preflight-evidence.json`, `protected-v2-gate-receipts.jsonl`, `protected-v2-submission-marker.json`, `protected-v2-status-progress.jsonl` and `protected-v2-report-<n>.json`. Before any fetch the run re-proves the whole chain locally: the plan file and content digests, the freeze's own content digest, the approval's content identity, the operator's explicit `--approve-execution` and the confirmed account email, and the fresh authenticated actor/project — a seal that does not bind this exact plan file, content, expected counts and snapshots, or that was approved by another account, never reaches the network.

The preflight request keeps the real v1 twelve-key envelope (versioned schemas, `target_visibility: owner_draft`, the production environment enum, a client-generated request id) with the complete plan, freeze and approval documents nested inside it. Its `expected` block is the real v1 ten flat counts — actions, batches, exchanges, amount fields, unrelated exchanges, audits, flow properties, flows, processes and derivative targets — with the versioned v2 values plus `text_action_count`; a declared root/reference closure is deliberately not part of this contract, because primary and global closure stay proven by the preflight/gate/read sets and digests. Every derivative target is one of the plan's actual changed Flow/Process rows and the freeze refuses a target list that is not exactly that set.

The versioned admission carries exactly the five reviewed keys (schema version, request id, preflight token, preflight proof digest and the three gate results) and is posted at most once for an execution; the server-side queue reaches the private executor through its service-only callback, which the CLI never calls. The three gates — primary support plan, execution unused and derivative quiescence — keep their v1 names and their 180-second window; only their versioned identities differ. An unknown admission outcome, an unreadable submission marker or a corrupt one is never read as "nothing happened": the run moves to `readback_required` and only the read stage may follow, bounded by its attempt budget. A read that finds no durable evidence for the request ends in an explicit `ALIAS_V2_EXECUTION_NOT_APPLIED` refusal for review, never in an automatic resubmission, so `--status-only` always asks the server — including from a fresh output directory that holds no local evidence.

Source-unit bookkeeping is explicit in the versioned plan. `source_evidence.declared_source_unitgroup` is the unit group the source flow property declares _today_ — the same year-based "Units of time" table as the target, whose base unit `a` the before amounts are read in — while `source_evidence.original_source_unit` is the original physical unit that the content-bound campaign evidence proves. The orphan hour unit group record is historical provenance only: no row is pointed at it, it is not a write target, and the current year declaration is never read as proof that the stored amounts are already years. Before values keep their original bytes, exponent spellings included; only the desired values are canonical ordinary decimals. Flow eligibility is restricted to the reviewed `Product flow` kind, and the reviewed factor is fixed at `0.00011415525114155251`.

Production use of this path still requires the matching database capability and a coordinated database/CLI release. The CLI side is implemented and locally verified; this path has not been deployed, and no business execution has been performed with it.

For the derivative-only profile, use the same three commands with `--operation rebuild-derivatives`. Its scope must contain exactly one `processes` action with `action: "rebuild_derivatives"`, `target_mode: "owner_draft"`, expected current owner, expected `state_code: 0`, and the exact component set `extracted_md` plus `embedding_ft`.

`--page-size` accepts `1-5000` and is only the requested maximum. PostgREST may enforce a lower server-side cap. The CLI requests `Prefer: count=exact`, validates the exact total and returned range from each `Content-Range`, advances the next offset by the number of rows actually returned, and requires strict `id`/`version` ordering without missing or duplicate identities. Each accepted scan records per-table requested/effective page size, page count, rows fetched, exact total, and aggregate entity counts.

This completeness proof means the CLI traversed the filtered result while that table's membership and ordering keys remained stable. Because the tables are read through multiple HTTP requests, it is not a transaction-level or MVCC snapshot of one instant; same-cardinality delete/insert churn can evade total and ordering checks. Plan hashes and apply-time drift checks provide the later mutation guard, and operators must avoid concurrent maintenance of the same account while planning or clearing it.

The scope is intentionally narrow:

- Each requested row must name its table, exact `id`, exact `version`, expected current owner, and draft `state_code=0` state.
- `--operation` accepts `delete`, `retire`, `redo-import`, `repair-references`, `merge-support-aliases`, or `rebuild-derivatives`; it records the operator's maintenance intent and does not broaden the eligible row actions.
- Only current-user `contacts`, `sources`, `flows`, and `processes` can become `save_draft` or `delete` actions.
- `merge-support-aliases` requires top-level `target_mode: "owner_draft"` and accepts only two named batches, `time` and `length_time`. The scope must bind reviewed current-owner draft source and target FP/UG exact ids/versions to 52 `update_json_ordered` actions: 25 time rows (1 FP, 10 flows, 14 processes) and 27 length-time rows (1 FP, 13 flows, 13 processes). Process actions freeze every selected exchange index, internal id, flow id/version, direction, before hash, and both amount strings.
- The alias factors are exact decimal strings: `0.00011415525114155251` for time and `1000` for length-time. Planning requires exactly 20 and 39 selected exchanges, preserves exactly 309 other exchanges in the affected processes, and proves the fixed source-zero/target-reference postconditions. The transformation changes references and the selected `meanAmount`/`resultingAmount`; it does not delete the source FP/UG rows.
- Source alias support, target FP/UG, and every changed flow/process must all belong to the authenticated account at `state_code=0`. Public/shared, foreign-owner, mixed-visibility, non-draft, lifecyclemodel, and unsupported action/table rows remain protected.
- `rebuild-derivatives` accepts exactly one exact-version `processes` row and is bidirectionally bound to `action=rebuild_derivatives`, `target_mode=owner_draft`, and components `extracted_md` plus `embedding_ft`. It cannot target a public/shared row, a foreign owner, a non-draft row, another table, multiple actions, or a partial/different component set. It rebuilds derivatives only; the primary process payload, owner/state, and `modified_at` remain unchanged.
- The CLI classifies and executes an operator-authored scope; it does not decide whether rows are semantically duplicates, canonical replacements, or safe business-level cleanup targets.

`plan` accepts the account scan only after its exact-count proof is complete, then writes the frozen `maintenance-scope.json`, `rls-visible-snapshot.json`, `protected-rows.jsonl`, `reference-impact-report.json`, `maintenance-plan.json`, and `dry-run-report.json`. The snapshot, dry-run report, and newly generated plan carry the aggregate completeness proof, so it is bound into the plan SHA-256. Alias plans additionally write `exchange-rewrite-plan.jsonl`, freeze current-owner state-0 target FP, target UG, and source UG snapshots for each batch, derive schema-valid desired payloads with matching embedded UUID/version, and include the exact closure, `modified_at`, hashes, conversion evidence, and postconditions in the approved plan. A derivative rebuild plan additionally obtains a database-produced snapshot for only the exact target action and binds its primary and derivative preconditions into the plan; large markdown/vector fields are not added to the account-wide scan. The plan SHA-256 is the approval identity; do not edit or recompute the plan after review.

`apply` is write-disabled unless all three commit guards are present: `--commit`, `--approve-plan <sha256>`, and `--confirm <current-account-email>`. Before approval is persisted or any write runs, it requires a fresh complete exact-count account scan and re-checks the whole plan for drift; the current completeness proof is recorded in `approval-record.json`. Ordinary draft updates/deletes use their platform paths. The original V1 alias adapter retains its frozen request and artifact contract for compatibility, but it is not an authorized execution or recovery fallback for a sealed production `merge-support-aliases` plan. That plan must use `run-protected`, whose database contract replaces replay with one durable attempt/admission identity.

For `rebuild-derivatives`, apply submits the frozen single-action plan only to the authenticated guarded RPC. The database admission envelope must report `queued`; the CLI records that durable admission as an `accepted` action with queued proof. It does not mean markdown or embedding generation has completed. Replay must return the same durable request/proof rather than enqueueing a second rebuild. There is no fallback to a direct Edge call, `admin embedding-run`, a raw queue, SQL, service-role credentials, or raw REST mutation.

`verify` requires another complete exact-count account readback rather than trusting the apply report, records its completeness proof, and writes `readback-verify-report.json` in its own output directory. For alias plans it also requires both successful batch records, all 52 correlated row records, all 59 unique exchange records, unchanged support snapshots, and exact desired row payloads. It validates the RPC-returned audit ids against the local proof chain; it does not independently query `public.command_audit_log`. For derivative rebuild plans, verify reads the durable request plus a fresh action-scoped process snapshot and reports only `pending`, `passed`, or `failed`. Database statuses `queued`, `dispatching`, `markdown_pending`, and `embedding_pending` map to `pending`; `completed` maps to `passed` only when both requested derivatives are current and every frozen primary-field precondition remains unchanged; `stale` and `failed` map to `failed`. The raw status proof, including `phase` and `fence_active`, is preserved in the report. A failed rebuild does not by itself prove that the primary-row write fence has been released.

`dataset maintenance clear-account` uses the same exact-count rule for its initial five-table snapshot, per-table commit checks, and a final fresh scan of all five tables. It reports `cleared_account` only when that final aggregate proof exists with `row_count=0`; if the final proof fails after deletions begin, it still writes a `completed_with_failures` audit report. If the initial scan cannot prove completeness, it writes no snapshot or approval artifact and performs zero deletes.

Foundry and skills may prepare the scope, invoke these commands, and retain their artifacts. They must not replace the CLI with direct SQL, service-role access, raw REST mutation, or private Supabase delete/update code.

## More Docs

- `docs/IMPLEMENTATION_GUIDE_CN.md`: maintainer-facing command contract and implementation notes
- `--help`: the canonical command surface for `tiangong-lca`, `tiangong-lca qa`, `tiangong-lca flow`, `tiangong-lca process`, `tiangong-lca lifecyclemodel`, and `tiangong-lca publish`
- `tiangong-lca-skills`: use the skill-specific `SKILL.md` and wrapper docs for agent workflows; the CLI README only covers the public invocation contract

## Help

```bash
tiangong-lca --help
tiangong-lca qa --help
tiangong-lca flow --help
tiangong-lca process --help
tiangong-lca lifecyclemodel --help
tiangong-lca publish --help
```
