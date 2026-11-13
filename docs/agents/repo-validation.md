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
lastReviewedAt: 2026-11-13
lastReviewedCommit: dd02e887a2e75d8ab8f636560736ba6b97d1d9d0
lastReviewedNote: 'Reviewed signed Model connection guidance and bounded port/amount/coefficient diagnostics; existing calculation, runtime selection and delivery contracts remain unchanged.'
related:
  - ../../AGENTS.md
  - ../../.docpact/config.yaml
  - ./repo-architecture.md
  - ../../README.md
  - ../../DEV_CN.md
  - ../release-runbook.md
  - ../release-setup.md
---

# CLI validation

Validation proves current command behavior, service adaptation and installed artifacts. Source tests, synthetic protocol fixtures, authorized actual-service integration and native platform CI provide separate evidence. A passing local suite does not establish deployment authorization, publication or four-platform execution.

## Local gates

Use the exact Node and pnpm versions declared by `.nvmrc` and `package.json`, the single workspace/lockfile and existing TypeScript/Oxlint toolchain.

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm prepush:gate
```

The complete gate verifies bundled public rules, lint/typecheck and Data API consumers, peers, the independent package lane, independent launcher/entrypoint tests, full-source coverage and its exact 100% assertion. Never add coverage exclusions, ignore pragmas or weaker assertions to pass a refactor. Only the existing Windows-native and explicitly enabled service lanes may use their documented environment gates.

`pnpm test:entrypoints` runs outside coverage instrumentation so native launcher and process IO remain independently exercised. `pnpm test:package` likewise runs independently; its source-free installed CLI uses native Node and production dependencies. The repository-only tsx loader orchestrates tests and is not a consumer runtime requirement.

The complete installed-package scenario has a five-minute aggregate test budget on all hosts, with elapsed stage diagnostics for dependency installation, packaging, launchers, recovery, business operations and reports. Per-process timeouts and all behavioral assertions remain required; this aggregate CI budget is not a product performance promise.

## Architecture and behavior regressions

`test/cli-layer-boundaries.test.mjs` checks all source-layer directions, presentation/composition ownership and the entire emitted literal runtime import graph. `test/cli-runtime-dependencies.test.mjs` rejects unreachable executable implementations; declaration-only emitted modules are not runtime workflows. New module splits must preserve both checks.

Test operation decisions through application ports and public command behavior. Keep precise parser, hash, scientific and recovery unit tests where they establish invariants. The private-journal regression binds legacy request/target key algorithms and exact receipt shapes; canonical-object and newline-bound artifact hashes are verified separately. Removing an unreachable workflow also removes only its exclusive IO tests, retaining its current algorithm assertions.

Root option tests verify leading `--json`, malformed/repeated separators and unchanged child argv. Core help/results and retained specialized protocols are tested according to the root discovery matrix, without wrapping child stdout. Existing giant protocol fixture suites are decomposed by responsibility as their assertions change; file moves do not justify weaker assertions or lower coverage.

## Validation matrix

| Change | Required proof |
| --- | --- |
| Launcher, command parsing, help or results | Valid and invalid invocations, stdout/stderr and exit semantics, bounded JSON, artifacts and no-effect help; independent entrypoint tests. |
| Dataset query/content/validation | Eight-type capability differences, explicit version selection without fallback, pagination/filter binding, exact references, pure patches/translations and real SDK findings. |
| Flow reference properties | Singleton/array and non-positional ID resolution; invalid/duplicate IDs, missing targets, nonpositive/nonfinite factors and decimal values near one; unchanged input/uncertainty, separate schema/content verdicts, zero-dispatch create/save and maintenance refusal, package and native installed-consumer checks. |
| Dataset create/save/delete | Valid five-type fixtures, create conflict/save missing refusal, actor/environment binding, content preconditions, stale state and role denial; unknown-outcome recovery without a second dispatch. |
| Model and Source operations | Exact source identities and conservation; independent create/save after generation; attachment byte snapshots, upload/readback integrity, partial references and separate Source save. |
| Review | One actual submission root and service-related scope, current role/RLS queries and materials, draft versus decision effects, rejected-record resubmission and same-request recovery. Administrator assignment/finalization stays separate. |
| Authentication/environment | Production/custom/headless destination separation, local versus live observations, OAuth/session and redaction tests, standalone identity-receipt parser and no replay after output failure. |
| Protected maintenance | Exact plan/actor/state/approval bindings, complete census, no-effect preparation, one-shot admission, original-attempt recovery and independent verification. |
| Public libraries/runtime/PCR/Study | Contract and architecture tests, exact package exports/assets, declaration and independent installed-consumer proof; preserve each specialized protocol. |
| Package/toolchain/release automation | Frozen install, rules/consumer scan, peers, package/native entrypoints, full coverage and the full gate; four-platform CI for release qualification. |
| Documentation only | Route affected paths, review current contracts, strict config and enforced staged/committed Docpact lint; verify changed executable examples. |

## Cleanup and package boundaries

Retired business roots and generic Dataset routes reject with exit 2, empty stdout and structured `UNKNOWN_COMMAND` stderr before transport. `test/cli-retired-entrypoints.test.ts` checks namespace/help/execution forms; the native installed business lane repeats the rejection alongside successful current commands.

`test/fixtures/retired-cli-modules.json` identifies removed workflow module stems. The package contract rejects their JavaScript, maps and declarations in the actual tarball. Removed workflow-only tests and fixtures are not current contracts. Tests for current validation, science, authorization and recovery stay with their actual owners; test coverage does not prove production reachability or documentation accuracy.

Contract extraction must preserve actual SDK/schema/methodology/rule content. Current `dataset <type> contract` has no retired context-pack or file-writer workflow. Field validation reports missing annual evidence without filling quantities from reference amounts or default units, and never uses historical trace metadata to waive a blocker. Malformed values and multilingual paths remain diagnosable on the unchanged payload.

## Mutation and scientific proof

The positive Dataset suite uses complete synthetic Flow/Process/Model/Source/Contact content and default schema, business and reference admission. Only HTTP responses and private intent directories are isolated; an injected passing validator is not positive-admission evidence. Preserve exact candidate bytes, identities and readbacks through create, local patch, validate, save, stale-content rejection and allowed deletion.

Process allocation checks use actual pinned SDK documents and exact Flow evidence. Prove Input/Output Product/Waste eligibility, Elementary refusal, stale/forged/missing evidence denial before mutation, and exact UUID/version/body binding. Result generation validates emitted payloads unchanged, preserves source-instance/exchange provenance and weighted allocation conservation, and reports unavailable qualification explicitly. Three-decimal allocation uses deterministic largest remainder and reports its bounded rounding error.

Create never becomes update, save never becomes insert, and missing exact reads never select latest implicitly. Ordinary save retains server content CAS. Model writes and deletes disclose preflight-only comparisons where the service offers no revision parameter. A dispatch with uncertain effect preserves its original request; neither command repetition, a new output path nor missing reply templates permit replay. Source uploads and Model generation never implicitly save content.

Ordinary maintenance tests retain complete PostgREST exact-count traversal, owner/state/target/plan closure, content drift checks, reference closure, durable progress and audited platform-command/RPC transport. Derivative rebuild admits only the reviewed exact Process scope and reports accepted/queued separately from verified completion. Retired repair entrypoints, flags, scopes and packaged modules must be absent or rejected before IO. Never substitute SQL, service-role, raw REST writes, queue calls or generic fallbacks.

## OAuth and public primitives

OAuth regressions cover PKCE/state/exact loopback callbacks, private atomic session storage, token rotation before profile success, expiry and refresh locking, terminal rejection versus transient failures, concurrent state drift and safe redacted errors. Headless tokens require explicit complete targets, online identity checks and process-only caching. Credential, provider-message and session-path leakage is forbidden. [Live-account testing](live-case-testing.md) requires separate explicit authorization; deterministic gates contain no live account credentials.

Public receipt parsing retains exact safe fields and object identity. CommandSpec execution remains shell-free and bound artifacts are rehashed. Batch scheduling retains claim-time identity/content/policy/resource binding, bounded concurrency and timers, FIFO key ordering, fatal-claim closure, awaited event delivery and drainage of in-flight work. A canonical run directory remains one cross-process lock domain; changing identity cannot bypass it. Public-library architecture, declaration and ESM/CJS/bin consumer tests stay independent of business command cleanup. The core CLI runtime import closure excludes the Batch facade and scheduler; shared lock and public lock functions/errors retain identity and lock-domain behavior.

## Specialized runtime and Study proof

Runtime/PCR qualification preserves exact manifests, trusted source and asset hashes, supported ABI/platform detection, private cache publication, leases/prune, one-use host IPC, shell-free execution and abort/drain semantics. Existing no-Node POSIX/PowerShell bootstrap pairs remain supported; local POSIX checks do not qualify Windows behavior.

Study tests exercise the contained owner codecs/renderers and exact selected API versions, explicit capabilities, private pre-dispatch intents and immutable recovery journals. Preserve actor/client/destination binding, original-request recovery after lost or rejected-success responses, current permission refusal, task polling/cancellation, original finalization and current state distinction. Signed exports use independent trusted anchors, exact owner rendering and immutable artifact publication; retain valid older journals and offline signed formats. Source-qualified fixtures do not grant hosted activation or professional approval. Unicode/config/evidence limits come from the owner validator, not a new consumer policy. The specialized [Study contract](study-cli-contract.md) owns exact formats and qualification boundaries.

## Review-result and discovery regressions

Core help must distinguish text and machine output for each advertised action, reject unavailable options before IO, expose actual action defaults and preserve canonical operation names for subgroup discovery and errors. Retained tools remain discoverable under their independent protocols. Output tests compare same-condition missing/invisible categories, unknown-count pagination, verified deletion continuations and attachment-preview templates.

Write qualification distinguishes contract-backed no-effect refusals from unconfirmed effects. Safe codes/categories and original rejected receipts must survive fresh-process recovery without replay; raw service messages and credentials never enter the result or journal. Network loss, unrecognized/malformed/5xx acknowledgments and mismatched or mixed decision receipts remain unknown. Exercise lock errors through their CLI conversion while retaining public class identity and locking tests. Source-free installed tests establish client behavior separately from actual service transaction proof.

Review refusal fixtures use the service's actual root ownership, approved dataset, and reviewer assignment codes. A reviewer decision can return HTTP 200 with a failed item bound to the requested review. Test that item's rejection and recovery through a fresh CLI process. Reference access or ownership checks can fail after earlier reference writes, so their receipts remain `unknown`.

## Actual service and installed qualification

The installed business lane runs outside the source checkout and covers five-type writes/readbacks, Review, Model generation/alias followed by independent Process create, Source transfer followed by separate save, completed-result reuse and recovery in fresh processes. Its protocol backend establishes administrator stages separately and does not represent deployed transaction or permission proof.

Actual-service testing uses an explicitly owned disposable non-production environment, unchanged Database migrations/Edge source and real Auth users. Test roles, support data and Storage policies are setup facts; CLI processes receive no service credentials. Record source identity, fixture setup, observed requests/readbacks, failures and cleanup receipts separately. Browser OAuth, hosted authorization, production deployment and four-platform CI are additional qualifications. Private inputs and raw outputs stay outside Git.

## Branch-deletion-only hook exception

The pre-push hook skips local gates only for a complete, verified stream deleting existing branch refs. Tags, source/mixed updates, malformed or empty input, TTY input and classification failure retain Docpact and the full gate. The deletion classifier and hook fixtures must prove forwarding, no source writes and fail-closed behavior; no environment shortcut selects the exception.

## Documentation and handoff

```bash
scripts/docpact validate-config --root . --strict
scripts/docpact lint --root . --staged --mode enforce
```

The pre-push wrapper resolves the actual comparison refs and runs those checks before `pnpm prepush:gate`. Refer to the wrapper for explicit base/head overrides. Record current source identity, exact commands/results, unexecuted environments, review/integration status and temporary-resource disposition in the owning Issue/PR. Documentation describes requirements and current behavior; it does not accumulate per-release execution logs.

## Version-bound source profile (CLI #312)

Each published CLI version maps to exactly one source identity; no version may choose freely between identities:

- `<= 0.1.14` (legacy): repository `tiangong-lca/tiangong-cli`, repository id `1194220834`, owner id `199785309`, tag ref `refs/tags/cli-v<version>`.
- `future versions` (current): repository `tiangong-lca/cli`, repository id `1194220834`, owner id `327771381`, tag ref `refs/tags/cli-v<version>`.

The repository id is the continuity anchor across the migration (identical on both sides); the owner id differs and the legacy owner id stays bound only to historical evidence. Mixed fields across the two profiles are rejected. `scripts/ci/release-context.sh` enforces the current profile (name, numeric repository/owner ids, tag-ref dispatch binding) and is executed against real git fixtures by `test/workflow-release-context.test.mjs`; the verifier enforces the same profile through certificate OIDs, exact SAN/issuer, signed workflow/source/event/builder fields, one tarball subject and one resolved dependency. CT and Rekor remain mandatory.

Publication floor: new-identity publication (tag creation and release) requires a version above the frozen legacy ceiling `CLI_LEGACY_LAST_VERSION` (0.1.14), as classified by the shared `scripts/ci/repository-identity.ts` helper via `scripts/ci/check-publication-floor.cjs`. The publish release-context guard rejects legacy-ceiling versions for both tag pushes and exact-tag dispatch, and the tag-creation automation enforces the same floor before creating `cli-v*` refs, so an unused lower/backport version can never be published under the current identity and become unverifiable. This rule does not select the next release version; unchanged-version main source PRs remain no-release. Historical tags and registry packages stay immutable.

The event SHA and workflow-definition SHA are separate facts (`github.sha` and `github.workflow_sha`). Both tag pushes and exact-tag dispatch must match the resolved release commit; a moved tag or divergent workflow fails before publication. The workflow regression reads the actual YAML-to-shell bindings so one SHA cannot be substituted for the other. The shared source policy is loaded as ESM by the private CommonJS helpers without requiring a build or application runtime imports.

Git-backed test fixtures must clear inherited repository routing (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, index/object paths and prefix) before running Git or release-shell commands in temporary repositories. Preserve scoped configuration/credential inputs. The release-context suite exercises a foreign Git hook environment and verifies its config, HEAD, index and files remain byte-identical. This isolation is required when the suite runs from the pre-push hook in a linked worktree.

Local Model validation must cover editable input snapshots, dependency closure without automatic providers, aggregate backgrounds without double expansion, whole-process timeout/no retry, exclusive Run directories, compact artifact replies and normal method-specific sparse characterization. Setup must verify engine/cache before saving, preserve configuration on failure, avoid forwarding credentials and support read-only checks. Saved Run retrieval must join original axes and values without recalculation or online validation, preserve full output artifacts and reject corruption. Check the native result’s existing prepared-artifact digest before joining saved axes; changing an axis while retaining the model identity must fail. This integrity check is internal to generated Runs and adds no caller-maintained hash or dependency on current runtime configuration. Private real-background probes supplement synthetic numerical oracles; neither replaces native distribution qualification.

## Local HTML report qualification

Run `node scripts/report-browser-smoke.mjs <new-output-directory>` after building, with the existing pinned Playwright Chromium installed (`pnpm exec playwright install chromium`). This separate rendered-browser check verifies offline graph selection/zoom, mutually exclusive Chinese/English content and localized page title/controls, table filtering, print restoration of all rows/details, actual PDF bytes, mobile overflow and no-JavaScript content. It retains HTML/PDF/screenshots and a receipt for review; the caller owns retention/cleanup. Package tests render the shipped synthetic example with native Node outside source, without a browser runtime dependency. Input/security/output behavior remains in the full source coverage gate. Browser proof is host-specific and does not establish other native platforms or scientific validity.

### Local Model installation

Exercise `test/model-install.test.ts` with the existing full gate. Corrupted or changed archives, unsafe paths, incomplete method-cache inventories, unsupported hosts (including musl), mismatched package targets and native-check failures must leave prior configuration intact and remove only the new owned installation. Public command tests require local filesystem/archive errors to return environment guidance, without directing callers to authentication or remote services. A native package case must start with empty CLI state and deny network plus developer library/cache paths, then install, check, prepare, calculate and inspect saved results. Synthetic foreground records and real background acquisition remain distinguishable; sparse method applicability is not an incomplete score. Exercise platform selection for macOS ARM64, Linux glibc x64/ARM64 and Windows x64, including the Windows `.exe` entrypoint and rejection before filesystem changes on unsupported hosts. Packaging and execution on one OS do not qualify the remaining targets or a public release.
