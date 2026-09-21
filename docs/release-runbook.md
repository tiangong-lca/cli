---
title: CLI Release Runbook
docType: runbook
scope: repo
status: active
authoritative: false
owner: cli
language: en
whenToUse:
  - when preparing, verifying, or handing off an `@tiangong-lca/cli` release
whenToUpdate:
  - when per-release commands, tag verification, npm verification, or workspace follow-up changes
checkPaths:
  - docs/release-runbook.md
  - docs/release-setup.md
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - scripts/ci/**
  - .github/workflows/quality-gate.yml
  - .github/workflows/publish.yml
  - .github/workflows/tag-release-from-merge.yml
  - .githooks/pre-push
  - scripts/docpact
  - scripts/docpact
  - scripts/docpact-gate.sh
  - scripts/install-git-hooks.sh
lastReviewedAt: 2026-09-22
lastReviewedCommit: 53a53b82686eefc53c04f7a6e8e0b975db099eed
lastReviewedNote: 'Reviewed for CLI #362: the version-only 0.1.21 release preparation for merged source PRs #360 and #361 changes only package identity and the live CLI-version fixtures; the pre-mutation npm/tag absence, RED/GREEN fixture evidence, unchanged package/Docpact/pre-push gates, the held merge/publication for the Database #674/#680 capability, and the unchanged post-merge tag, Trusted Publishing/provenance, consumer and workspace-integration path are recorded in the runbook.'
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ./release-setup.md
  - ./agents/repo-validation.md
---

Review note, 2026-09-22: Issue #362 is the dedicated 0.1.21 release preparation for merged source PRs #360 (CLI #358 Time alias, main merge `e69592e32c98d6b73c3f08c8db35b3ebd73538bb`) and #361 (CLI #359 Length*time, main merge `53a53b82686eefc53c04f7a6e8e0b975db099eed`). It changes only `package.json` identity and the live CLI-version fixtures (three in `test/cli.test.ts`, one in `test/dataset-maintenance-flow-identity-coverage-cli-remote.test.ts`, one in `test/dataset-alias-v2-protected-cli.test.ts`, one in `test/dataset-length-time-cli.test.ts`, plus the explicit-parameter constant in `test/dataset-alias-v2-public-stages.test.ts`), and keeps the sole lock, dependencies, runtime files, strict exports, workflows and release automation byte-unchanged. The source is merged but publication has not happened: npm latest is 0.1.20 (published and integrated), no `cli-v0.1.21` tag exists locally or on `origin`, and `scripts/ci/release-version.cjs assert-unpublished --version 0.1.21` passes before any mutation while `next-version --part patch` resolves 0.1.21 from published 0.1.20. The six genuinely bound fixtures were RED against the bumped identity (actual 0.1.21 against the stale 0.1.20 expectation, and `Toolchain evidence does not bind the running published CLI version.` for the two protected toolchain fixtures) and GREEN afterwards; the seventh supplies the expected version explicitly, stayed GREEN, and was advanced so no stale previous-version fixture remains. Merge and publication are held until the Database #674/#680 capability and current-closure guards are promoted to qualified main and canonically deployed. Before merge this preparation requires the unchanged package/Docpact/pre-push gates with exact 100% coverage, the pack dry-run and the exact-head four-platform matrix; after merge it requires the automatic `cli-v0.1.21` tag, native pnpm Trusted Publishing with cryptographic provenance, registry integrity and `gitHead` binding, fresh credential-free consumers, and exact release-merge workspace integration. Local publication and manual tag creation remain forbidden, and publishing this software does not publish any dataset.

Review note, 2026-09-22: CLI #359 adds no release surface. The closed Length*time profile is a source capability that reuses the reviewed protected lifecycle and the existing tag/Trusted-Publishing route; it adds no dependency, lock, workflow, tag rule or publication change, and it must not be slipped into a version-only release. Its own release still requires the unchanged package/Docpact/pre-push gates with exact 100% coverage, the four-platform tag workflow, native pnpm Trusted Publishing with provenance, and exact workspace integration.

Review note, 2026-09-21: Issue #356 is the dedicated 0.1.20 release preparation for merged source PR #355 (main merge `8cb5a100d59463c08e009089da8ce9707fe98aef`), which carries the bounded existing-draft support metadata repair of #354 and the already-merged Process review-array adoption of #350 / PR #353 as existing source. It changes only `package.json` identity and the four live CLI-version fixtures (three in `test/cli.test.ts`, one in `test/dataset-maintenance-flow-identity-coverage-cli-remote.test.ts`), and keeps the sole lock, dependencies, runtime files, strict exports, workflows and release automation byte-unchanged. The source is merged but publication has not happened: npm latest is 0.1.19 (published and integrated), no `cli-v0.1.20` tag exists locally or on `origin`, and `scripts/ci/release-version.cjs assert-unpublished --version 0.1.20` passes before any mutation while `next-version --part patch` resolves 0.1.20 from published 0.1.19. The four fixtures were genuinely RED against the bumped identity (actual 0.1.20 against the stale 0.1.19 expectation) and GREEN afterwards. Before merge this preparation requires the unchanged package/Docpact/pre-push gates with exact 100% coverage, the pack dry-run and the exact-head four-platform matrix; after merge it requires the automatic `cli-v0.1.20` tag, native pnpm Trusted Publishing with cryptographic provenance, registry integrity and `gitHead` binding, fresh credential-free consumers, and exact release-merge workspace integration. Local publication and manual tag creation remain forbidden, and publishing this software does not publish any dataset.

Review note, 2026-09-21: CLI #354 adds the bounded existing-draft support metadata repair in source only. It must not be slipped into the version-only 0.1.19 release: npm 0.1.19 and `cli-v0.1.19` belong to the merged #349 foundation, while this capability needs its own separate release-prep PR, four-platform tag, Trusted Publishing/provenance verification and exact workspace integration before any consumer may rely on it. It adds no dependency, lock, workflow, tag rule or publication change.

Review note, 2026-09-21: Issue #351 is the dedicated 0.1.19 release preparation for merged source PR #349 (main merge `11a074b072022d1c566f25edcc9ee7fa1c629e8c`). It changes only `package.json` identity and the four live CLI-version fixtures (three in `test/cli.test.ts`, one in `test/dataset-maintenance-flow-identity-coverage-cli-remote.test.ts`), and keeps the sole lock, dependencies, runtime files, strict exports, workflows and release automation byte-unchanged. The source feature is merged but publication has not happened: npm latest is 0.1.18, no `cli-v0.1.19` tag exists locally or on `origin`, and `scripts/ci/release-version.cjs assert-unpublished --version 0.1.19` passes before any mutation. The four fixtures were genuinely RED against the bumped package identity and GREEN after the fixture update, and local npm/tag absence was re-proved with the existing helper rather than by a new check. Before merge this preparation requires the unchanged package/Docpact/pre-push gates with exact 100% coverage and the pack dry-run; after merge it requires `cli-v0.1.19`, native pnpm Trusted Publishing with cryptographic provenance, registry integrity and `gitHead` binding, fresh credential-free consumers, and exact release-merge workspace integration. Local publication and manual tag creation remain forbidden.

Review note, 2026-09-17: W6b converges the static schema assets but does not authorize a release or package publication. Any new CLI version must still use the existing release gates, provenance and version/content review.

Review note, 2026-09-18: CLI #338 is a schema/validation feature delivery only. It advances bundled Process and LCIA Method assets to the reviewed `tidas-spec` 0.2.0 candidate and adds no package-version, tag, publication, or provenance claim; the existing four-platform, Docpact, coverage, release and workspace gates remain required for any later release.

Review note, 2026-09-20: CLI #344 advances the exact dependency to published SDK 0.3.0, which omits the old mixed-ruleset files and getter. This remains a source PR with CLI package version 0.1.17 unchanged; a separate version-only CLI release PR, four-platform tag, Trusted Publishing/provenance check, clean installed consumer, and root integration are required before W11/A14 closure.

Review note, 2026-09-21: CLI #350 adds spec 0.2.2 Process review-array compatibility while keeping package 0.1.18 and exact SDK 0.3.0. SDK PR #147 publication, later CLI dependency adoption, version-only release qualification, provenance, installed-consumer proof, and root integration remain separate tracked steps.

Review note, 2026-09-20: CLI #340 pins published SDK 0.2.2 and released spec 0.2.1 public definitions and removes the SDK mixed ruleset input from `dataset contract`. It remains a feature PR with no CLI version change. A separate version-bump PR, four-platform tag, Trusted Publishing/provenance check, clean installed consumer, and root integration are required before treating the replacement as publicly released.

Issue #278 is a feature delivery for the opt-in managed-host IPC protocol and public runtime receiver. It leaves package version, dependencies, lockfile, authentication, Trusted Publisher setup and release workflows unchanged. Publish this API only through a separately tracked version-bump PR after exact coverage, package consumers, all four native hosts and review pass; complete public provenance verification and exact workspace integration before Foundry/Skills consume it.

Issue #274 delivered the C1 `./runtime` API, machine schemas, component manager, generic no-Node bootstrap sources and `runtime describe` to main merge `20cf32fd45ae1072bb67db27c74d3d81629206f4`. Issue #275 designates 0.1.10 as the separate release-only publication. Its public verifier must bind registry integrity and provenance independently of the package self-description; a CLI descriptor still does not substitute for a frozen product component manifest.

Review note, 2026-09-05: Issue #275 changes only package identity, four live version fixtures and governed release evidence after the #274 merge. It preserves dependency and lock bytes, runtime implementation and workflows; requires the exact four-platform PR head before merge; and after merge requires `cli-v0.1.10`, Trusted Publishing/provenance, fresh `./runtime` consumers, private read-only published-C1 proof and exact workspace integration.

# CLI Release Runbook

This document is the operator runbook for each `@tiangong-lca/cli` release.

Review note, 2026-09-01: Issue #260 ships CLI 0.1.7 as the OAuth-only user-authentication boundary. It removes the reversible user API-key/password bootstrap, schema-v1 session compatibility, retired flags/env, and the local production-case runner; it retains browser PKCE, private rotating refresh sessions, explicit online-verified process-only headless access tokens, the exact 100% gate, four-platform release validation, merge-created tag, Trusted Publishing/provenance verification, fresh public consumers, and exact workspace integration. Local publication and manual tag creation remain forbidden.

Review note, 2026-08-25: Issue #224 keeps the feature branch at 0.0.33 while replacing the repository toolchain with Node 24, pnpm 11.23.0, TypeScript 7.0.2, and Oxlint. Because that migration changes maintainer and release compatibility, prepare 0.1.0 in a separate release-only PR after the feature PR merges and `test:package`, exact 100% coverage, package inspection, Docpact, and release automation all pass. Historical npm-era notes below are retained only as dated evidence and are not current commands.

Review note, 2026-08-25: Issue #226 is that dedicated 0.1.0 release-only delivery for merged Issue #224 / PR #225. It updates package version metadata and the four live CLI-version fixtures, and adds test-only proof for ESM/CJS hosts importing the existing explicit bin launcher subpath, while keeping runtime files, package-root exports, dependencies, and `pnpm-lock.yaml` unchanged. Before merge it must prove npm/tag absence, package/prepush/audit/Docpact and the exact four-platform matrix; after merge it must prove `cli-v0.1.0` identity, native pnpm Trusted Publishing/provenance, the public-registry consumer, and exact released-commit workspace integration.

Review note, 2026-08-25: Issue #230 is that separate 0.1.1 release. It keeps the published runtime dependency graph unchanged while adding exact `sigstore@5.0.0` to the dev-only verification graph and regenerating the sole pnpm lock for that reviewed change. `.nvmrc`, engines, all workflows, tests, and active docs pin latest-stable Node 24.19.0. The four-platform workflow is reusable, asserts actual platform/architecture, and blocks tag creation. `release:verify-published` cryptographically verifies the SLSA bundle against the GitHub OIDC issuer, exact workflow/tag certificate identity, certificate transparency and Rekor, binds its `gitCommit` and tarball sha512, runs pnpm registry-signature verification, isolates user/global package-manager configuration, pins pnpm 11.23.0, scans all production dependency sections, and exercises clean bin/ESM/CJS consumers. The child finish continuation owns root integration create/reuse and child completion; operators never create a parallel task or finish the child twice. Local publication and manual tag creation remain forbidden.

Review note, 2026-08-26: Issue #232 is a feature delivery for typed CommandSpec/batch/run-lock subpaths and keeps package version 0.1.1. It adds no dependency, secret, tag, or alternate publish path. A later release-only PR must advance the version and rerun the existing matrix, provenance, registry, packed ESM/CJS/TS public-subpath consumer, and exact workspace-integration gates before downstream repositories pin the new API.

Review note, 2026-08-26: Issue #233 is an internal move-only prerequisite for that later release. It keeps version 0.1.1, package exports, dependencies, the sole pnpm lock, tag automation, and publication mechanics unchanged while decomposing the batch implementation behind the same public subpath. The later release must consume the same packed ESM/CJS/TypeScript and provenance gates; no release or local publish belongs to Issue #233.

Review note, 2026-08-26: Issue #236 updates only the exact repository and public-release consumer pnpm requirement from 11.23.0 to 11.24.0. A pnpm 11.24.0 lockfile-only reconciliation confirms the sole root lock needs no byte change. Package version 0.1.1, Node 24.19.0, TypeScript 7.0.2, dependencies, runtime/exports, tag detection, native OIDC/provenance publication, registry state, and workspace follow-up remain unchanged; local publication and npm/Yarn fallback remain forbidden.

Review note, 2026-08-26: Issue #237 is the dedicated 0.1.2 release for the bounded batch/CommandSpec implementation after pnpm 11.24 convergence. It changes only package metadata and four live CLI-version fixtures, keeps the sole lock, dependencies, runtime, exports, workflows, and setup unchanged, and must prove pre-mutation npm/tag absence plus local package/prepush/audit/Docpact gates. After merge it must prove `cli-v0.1.2`, native pnpm Trusted Publishing/provenance, registry integrity/attestation and exact `gitHead`, fresh credential-free bin/ESM/CJS/TypeScript consumers, and exact release-merge workspace integration. Local publication and manual tag creation remain forbidden.

Review note, 2026-08-29: Issue #240 is a feature delivery for the bounded public auth receipt parser and keeps package version 0.1.2. After it merges and all public/tarball/coverage/Docpact gates pass, publish the repair only through a separate patch version-bump PR (expected 0.1.3), the unchanged four-platform merge-tag workflow, Trusted Publishing/provenance verification, fresh public consumers, and exact workspace integration.

Review note, 2026-08-29: Issue #242 is that dedicated 0.1.3 patch release. It changes only package identity and four live CLI-version fixtures, keeps the sole lock, dependencies, runtime, strict exports, workflows, and setup unchanged, and must prove pre-mutation npm/tag absence plus local package/prepush/audit/Docpact gates. After merge it must prove `cli-v0.1.3`, native pnpm Trusted Publishing/provenance, registry integrity, fresh credential-free bin/ESM/CJS/TypeScript consumers for `./batch` and `./auth-identity-receipt`, and exact release-merge workspace integration. Local publication and manual tag creation remain forbidden.

Review note, 2026-08-31: Issue #247 is a release-blocking runtime prerequisite discovered by the 0.1.4 full gate. It fixes only concurrent state-lock metadata disappearance, keeps package version 0.1.3, dependencies, lock bytes, exports, and workflows unchanged, and must merge with exact 100% proof before Issue #246 rebases and resumes the normal 0.1.4 release path.

Review note, 2026-08-31: Issue #246 is the dedicated 0.1.4 patch release for merged OAuth Issue #244. It changes only package identity and four live CLI-version fixtures, keeps the sole lock, dependencies, runtime, strict exports, workflows, and setup unchanged, and must prove pre-mutation npm/tag absence plus local package/prepush/audit/Docpact gates. After merge it must prove `cli-v0.1.4`, native pnpm Trusted Publishing/provenance, registry integrity, fresh credential-free bin/ESM/CJS/TypeScript consumers including OAuth help/status, the immutable Skills 0.1.4 pin, and exact release-merge workspace integration. Local publication and manual tag creation remain forbidden.

Review note, 2026-08-31: Issue #250 records the 0.1.4 attempt as failed before tag creation because Windows coverage was 95,430/95,434 lines even though all tests passed; npm 0.1.4 and `cli-v0.1.4` remain absent. The coverage repair itself keeps package version 0.1.4 and does not tag. After it merges, use a new version-only release so the normal push detector, four-platform matrix, tag, Trusted Publishing, provenance, consumer, Skills, and workspace gates bind one new merge commit; do not manually create or backfill the failed tag.

Review note, 2026-08-31: Issue #252 is that new version-only release, advancing 0.1.4 to 0.1.5 after coverage merge `ca15e0ed17e82c6ef169614fe86ee6efbbd284ef`. It must prove 0.1.4 remains absent, 0.1.5/tag are absent pre-mutation, local exact 100%, and all four remote platforms before the normal workflow creates `cli-v0.1.5`. Then verify Trusted Publishing/provenance, registry integrity, fresh OAuth consumers, Skills 0.1.5, and workspace integration. Manual tag/local publish/backfill remain forbidden.

Review note, 2026-08-31: Issue #256 is a dependency feature PR and deliberately keeps package 0.1.5, so its merge must not create a tag or publish. After exact-100%/four-platform merge, Issue #257 creates a clean release-only branch, records npm/tag absence plus RED fixtures, advances only package/version evidence to 0.1.6, and reuses the existing merge-tag, Trusted Publishing, cryptographic verifier, OAuth/TIDAS public consumer, and workspace integration sequence.

Review note, 2026-08-31: Issue #257 is that dedicated 0.1.6 release, based on dependency merge `490eb08990bf339935f7a5402add063618d844d2`. It changes package identity and four exact-version fixtures only, keeps lock bytes, dependencies, runtime, strict exports, workflows, and setup unchanged, and must prove pre-mutation npm/tag absence plus local package/prepush/audit/Docpact gates. Before merge, manually dispatch the exact-head four-platform matrix. After merge, verify `cli-v0.1.6`, native pnpm Trusted Publishing, cryptographic provenance/integrity/signatures, fresh OAuth/TIDAS consumers, and exact workspace integration. Local publication and manual tag creation remain forbidden.

Review note, 2026-07-14: Issue #165 adds the guarded `dataset maintenance rebuild-derivatives` command profile but does not change the release procedure. Its command, contract, remote-adapter, asynchronous verification, and no-fallback tests must pass the existing pre-push/docpact gate before a later version-bump PR; the feature PR itself must not publish locally or alter package version metadata.

Review note, 2026-07-15: Issue #168 adds the production-only protected alias runner without changing package-version, tag, Trusted Publishing, or workspace follow-up mechanics. The feature PR must pass docpact and the full pre-push gate without changing package metadata. A separate patch release may start only after database-engine#262 reaches production and its schema/function/ACL readback passes; the release is still a dedicated version-bump PR and never a local publish.

Review note, 2026-07-15: Issue #171 adds production-read-only protected freeze generation and completely offline human-approval sealing without changing release mechanics. Its feature PR must keep package metadata at the current released version and pass focused contract/zero-write tests, exact 100% coverage, docpact, and the full pre-push gate. Only after that feature PR merges may a separate patch version-bump PR publish through the existing tag/Trusted Publishing workflows. A fresh production freeze is not permitted until the published package provenance/registry integrity is verified and the exact release commit is merged into root-workspace integration Issue #406.

Review note, 2026-07-16: Issue #175 fixes bounded client clock-skew validation without changing release mechanics. The feature PR keeps package metadata unchanged and must pass focused timing/one-shot tests, exact coverage, docpact, and the full pre-push gate. Recovery then requires a separate patch version-bump PR, Trusted Publishing verification, and a new root-workspace integration before any fresh protected freeze.

Review note, 2026-07-16: Issue #177 changes only cross-platform tests needed to make the existing four-platform quality matrix authoritative. It does not alter package metadata, tag creation, Trusted Publishing, release eligibility, protected-execution behavior, or the requirement for a separate 0.0.27 release PR after all matrix jobs pass.

Review note, 2026-07-16: Issue #178 is that separate 0.0.27 release PR. It must prove the version is unpublished, retain exact coverage and all four platform results, and use the existing merge-triggered tag plus tag-triggered Trusted Publishing workflows. Local publish or manual tag creation remains forbidden; npm provenance and `gitHead` must match the immutable release merge commit before workspace integration starts.

Review note, 2026-07-16: Issue #182 fixes the protected terminal verifier without changing package metadata or release mechanics. Its feature PR must pass the production-shaped cross-hash-domain regression, exact coverage, docpact, and the full pre-push gate. Only after it merges may a separate patch version-bump PR use the existing tag and Trusted Publishing workflows; npm provenance and exact root-workspace integration must be verified before the existing protected request receives one status-only readback.

Review note, 2026-07-16: Issue #184 is that separate 0.0.28 release. It must prove the version and tag are absent, retain exact coverage and all four platform results, pass AI Doc Lint and Docpact, and use only the existing merge-triggered tag plus tag-triggered Trusted Publishing workflows. Local publish or manual tag creation remains forbidden; npm provenance and `gitHead` must match the immutable release merge commit before workspace integration and status-only verification.

Review note, 2026-07-16: Issue #186 adds an LCI/LCIA data-release command family but does not change this npm package-release procedure. The feature PR keeps package metadata unchanged and must pass focused release command tests, exact coverage, docpact, and the full pre-push gate; any later npm publication remains a separate version-bump PR through the existing tag and Trusted Publishing workflows.

Review note, 2026-07-17: Issue #191 fixes two Windows-only permission-test assumptions before the 0.0.29 release without changing package metadata or release mechanics. The test-only prerequisite must pass all four quality-matrix platforms before the existing dedicated version-bump PR is updated and merged.

Review note, 2026-07-17: Issue #189 is that separate 0.0.29 release. It must prove the version and tag are absent, retain exact coverage, pass AI Doc Lint and Docpact, and use only the merge-triggered tag plus tag-triggered npm Trusted Publishing workflows. Local publish and manual tag creation remain forbidden; npm provenance and `gitHead` must match the immutable release merge commit before workspace integration.

Review note, 2026-07-16: Issue #157 adds the Step 3 flow-identity feature without changing package metadata or release mechanics. Its feature PR must pass the exact DB contract, production-scale Preview capture timing, 100% CLI coverage, Docpact, and the full pre-push gate. A separate patch version-bump PR may begin only after database-engine #235 is promoted and deployed; production capture/plan/freeze still requires the released CLI plus a fresh exact human approval.

Review note, 2026-07-17: Issue #157 COMMON hardening now includes the DB/CLI one-wrapper rotating permit, strict create-only local claim as defense in depth, fresh exact recovery approval, and exact read-only scope lookup after response loss. This closes the protocol design boundary without changing version, tag, or Trusted Publishing mechanics. The Step 3 patch release remains gated on feature merge, database Preview validation/promotion, focused cross-contract evidence, and the separate coordinated DB/CLI release; local publish and manual tag creation remain forbidden.

Review note, 2026-07-23: Issue #194 adds the generic ordered owner-draft execution contract without changing package metadata or release mechanics. Its feature PR must pass focused ledger/recovery tests, exact 100% coverage, docpact, and the full pre-push gate. Any npm publication remains a separate version-bump PR through the existing merge-triggered tag and Trusted Publishing workflows; local publish and manual tag creation remain forbidden.

Review note, 2026-07-23: Issue #196 is the separate 0.0.30 release for merged Issue #194 / PR #195. It must prove the version and tag are absent, retain exact coverage, pass Docpact and the four-platform quality gate, including Windows durable-ledger creation/append/recovery, and use only the merge-triggered tag plus tag-triggered npm Trusted Publishing workflows. Local publish and manual tag creation remain forbidden; npm provenance and `gitHead` must match the immutable release merge commit before workspace integration.

Review note, 2026-07-23: Issue #198 is the 0.0.31 hotfix release for side-effect-free dataset save-draft validation. It must prove the exact input remains unchanged through contract binding and dispatch preparation, keep exact coverage, pass Docpact and the four-platform quality gate, and use only the merge-triggered tag plus tag-triggered npm Trusted Publishing workflows. Local publish and manual tag creation remain forbidden; npm provenance and `gitHead` must match the immutable release merge commit before workspace integration.

Review note, 2026-07-24: Issue #200 is the 0.0.32 hotfix release for bounded ordered-batch concurrency and current-owner token renewal. It must prove serial dependency-prefix completion, unique-target suffix concurrency no greater than 8, exact owner revalidation before dispatch, and unchanged durable attempt/no-replay behavior. Publication remains merge-triggered tag creation plus npm Trusted Publishing; local publish/manual tags remain forbidden, and npm provenance plus `gitHead` must match the release merge before workspace integration.

Review note, 2026-07-24: Issue #202 is the 0.0.33 release for bounded delete-only flow convergence. It must prove a complete visible-process inbound barrier, target uniqueness, owner/state exactness, durable dispatch-before-request evidence, exact absent readback, ambiguity no-replay, and independent-row continuation at concurrency no greater than 8. Publication remains merge-triggered tag creation plus npm Trusted Publishing; local publish/manual tags remain forbidden, and npm provenance plus `gitHead` must match the release merge before workspace integration or production deletion.

Review note, 2026-07-24: Issue #204 is a main-commit operational fix for the all-visible process preflight page size. The BAFU topology run binds the exact merged commit and built-file fingerprint; no package version, manual tag, local publish, or alternate release path is introduced by this fix.

Review note, 2026-07-25: Issue #206 is a main-commit operational fix that changes only the stable order of the same all-visible preflight to `(id, version)`. The BAFU topology run must bind the exact merged commit and built-file fingerprint; no package version, tag, publish, credential, or alternate release path is introduced.

Review note, 2026-07-25: Issue #208 is a main-commit operational fix that admits a separately captured, SHA-approved all-process SELECT-only proof before bounded flow deletion. Production use must bind the exact merged commit, built-file fingerprint, proof file SHA, capture time, project/actor/plan, and target binding. No package version, tag, publish, credential, raw-SQL CLI path, or alternate mutation path is introduced.

Use this document for:

- per-release prechecks
- version bump PR execution
- post-merge release verification
- workspace follow-up

Do not use this document for one-time repository or npm registry setup. For one-time setup, see [release-setup.md](./release-setup.md).

## Preconditions

Review note, 2026-09-02: Issue #266 releases the Production bootstrap from merge `d74edd8ed22f78056784326fb26e11741a1363b8` as 0.1.8. npm/tag absence was proved before RED fixture checkpoint `17d920d`; package checkpoint `3254d61` changes only version identity. Keep the lock, dependencies, runtime, and workflows byte-identical, prove all four platforms before and after merge, then verify signed registry provenance and fresh zero-config browser/installed Skills consumers. Skills #91 and public Docs #180 join the exact workspace handoff.

Concurrent-main note, 2026-09-02: PR #264 / Issue #262 subsequently merged as `f56c5349414c73a7f3f967ebd667064ce08a26e3`. Release #266 preserves that reviewed runtime and repeats validation against this new base; the release-only diff remains version/fixtures/governed evidence. The new Process draft adapter sends `p_model_version` and requires database-engine #589 / migration head `20260902104500`. Do not merge the release PR or start automatic npm publication until production RPC compatibility and the required deployment are proved. This release task does not implicitly authorize that independently owned production schema rollout.

Before starting a release:

- work from the latest `main`
- keep the release-prep change scoped to CLI package version metadata
- confirm npm has not already published the target version
- confirm any command-surface feature PRs that will be included in the release have passed the local pre-push gate, including `pnpm prepush:gate` and docpact, before preparing the version bump
- do not publish routinely from a local workstation; the canonical release path is a version-bump PR merged to upstream `main`, followed by tag creation and npm Trusted Publishing in GitHub Actions

Review note, 2026-06-02: dataset curation queue command additions follow the existing feature-then-release flow; release prep still remains a separate package metadata bump.

Review note, 2026-06-04: `dataset curation-queue next/verify` follows the same feature-then-release flow; no release command or tag semantics changed.

Review note, 2026-07-13: exact-count maintenance pagination follows the same feature-then-release flow. It changes runtime completeness checks and artifacts but does not change version-bump, tag, npm Trusted Publishing, or workspace follow-up semantics.

Historical npm-era release 0.0.11 note (retired; do not use as current instructions), 2026-06-02: prechecks were `node ./scripts/ci/release-version.cjs assert-unpublished --version 0.0.11`, `npm run prepush:gate`, and `npm pack --dry-run`.

Historical npm-era release 0.0.12 note (retired; do not use as current instructions), 2026-06-05: prechecks were `node ./scripts/ci/release-version.cjs assert-unpublished --version 0.0.12`, `npm run prepush:gate`, and `npm pack --dry-run`; no tag or publish workflow semantics changed.

Historical npm-era release 0.0.13 note (retired; do not use as current instructions), 2026-06-06: prechecks were `node ./scripts/ci/release-version.cjs assert-unpublished --version 0.0.13`, `npm run prepush:gate`, and `npm pack --dry-run`; this release added `process save-draft --target-user-id` account/write guard support for batch import handoff.

Historical npm-era release 0.0.14 note (retired; do not use as current instructions), 2026-06-07: prechecks were `node ./scripts/ci/release-version.cjs assert-unpublished --version 0.0.14`, `npm run prepush:gate`, and `npm pack --dry-run`; this release let `dataset classification apply --type location` create explicit missing location fields such as flow `locationOfSupply` while keeping ambiguous paths blocked.

Historical npm-era release 0.0.15 note (retired; do not use as current instructions), 2026-06-11: prechecks were `node ./scripts/ci/release-version.cjs assert-unpublished --version 0.0.15`, `npm run prepush:gate`, and `npm pack --dry-run`; this release adapted `dataset import-lca convert` to the tidas-tools 0.0.28 process-bundle CLI surface (no bare `--process-bundles` flag, `--no-process-bundles` forwarded when disabled) and derived report bundle/mapping file fields from on-disk state.

Historical npm-era Issue #210 packaging note (retired; do not use as current instructions), 2026-07-27: feature PRs did not bump or publish the CLI package. The later release PR used `npm pack --dry-run` to prove `assets/import-smoke/simapro.csv` was included and Python packages, tidas-tools checkouts, venvs, and native executables were absent. The current pnpm package gate preserves that artifact contract.

Useful commands:

```bash
git fetch origin
git checkout main
git merge --ff-only origin/main

pnpm install --frozen-lockfile
pnpm test:package
pnpm prepush:gate
node ./scripts/ci/release-version.cjs next-version --part patch
node ./scripts/ci/release-version.cjs assert-unpublished --version <x.y.z>
pnpm --filter @tiangong-lca/cli --fail-if-no-match pack --dry-run >/dev/null
```

`next-version` is only a helper for choosing the next version. The generic example above shows a patch bump; the separate post-Issue-#224 compatibility release should use `--part minor` to propose 0.1.0. The actual release version is whatever the tracked release decision puts into `package.json`.

## Release-Prep PR

1. Create a dedicated branch from `main`.
2. Update the CLI package version metadata:
   - `package.json`
   - keep the sole root `pnpm-lock.yaml` present and unchanged because a version-only bump does not change the dependency graph
   - if an independently reviewed release-control dependency changes, pin it exactly, regenerate the sole lock with pnpm, prove it remains dev-only, and record that exception explicitly; Issue #230 adds only `sigstore@5.0.0` for cryptographic post-publish verification
3. Keep the PR focused on the release bump.
4. Open a normal PR with local pre-push gate evidence. Before merge, manually dispatch `quality-gate` on the exact release head and record all four successful jobs. After merge, `Tag Release From Merge` independently invokes that same reusable matrix on the exact merge commit and cannot create a tag unless it succeeds.
5. Merge the PR into `main`.

Release automation starts only after the version bump PR is merged into upstream `main`. A local workstation may run `pnpm --filter @tiangong-lca/cli --fail-if-no-match pack --dry-run` for package validation, but it must not publish the package; local npm authentication and personal registry permissions are intentionally outside the release contract. `pnpm test:package` must also prove the tarball is clean and its consumer does not depend on pnpm-specific workspace behavior.

## Post-Merge Checks

After the PR merges, verify the release in this order.

### 1. Tag workflow

The merge to `main` should trigger:

- `.github/workflows/tag-release-from-merge.yml`

Check:

```bash
gh run list --repo tiangong-lca/cli --workflow "Tag Release From Merge" --limit 3
gh api repos/tiangong-lca/cli/git/ref/tags/cli-v<x.y.z>
```

Expected result:

- the workflow finishes successfully
- release detection runs before expensive validation and starts the reusable pnpm quality matrix only when the CLI version changed
- macOS arm64, Ubuntu x64, Ubuntu arm64, and Windows x64 all pass on the exact merge commit, and each job fail-closes unless `process.platform`/`process.arch` matches its exact matrix declaration
- the release detector and every later job run only after the same exact Node 24.19.0 pnpm setup
- the `tag-release` job depends on both release detection and the successful four-platform matrix, then reruns the Ubuntu release/docpact gates before tag creation
- tag `cli-v<x.y.z>` exists

### 2. Publish workflow

The release tag should trigger:

- `.github/workflows/publish.yml`

Check:

```bash
gh run list --repo tiangong-lca/cli --workflow "Publish Package" --limit 3
gh run watch <publish-run-id> --repo tiangong-lca/cli
```

Expected result:

- `Publish Package` finishes successfully

If a pnpm-era tag exists but the publish workflow needs to be re-run with the current workflow definition, dispatch at the exact release tag ref (CLI #312):

```bash
gh workflow run publish.yml --repo tiangong-lca/cli --ref cli-v<x.y.z> --field tag_name=cli-v<x.y.z>
```

Manual replay supports only tags whose tagged commit contains the root `pnpm-lock.yaml`. The release-context guard requires the dispatch to run at `refs/tags/<requested cli-v tag>` with `GITHUB_SHA` and the workflow SHA equal to the resolved release head, so a dispatch from `main` fails before install/build/publish and cannot publish provenance the strict verifier would reject. A pre-pnpm `cli-v*` tag is rejected before install/build/publish; the workflow intentionally has no npm fallback. Recover a historical release from its original immutable workflow evidence instead of replaying it through the current pnpm workflow.

### 3. npm registry

Confirm npm has the expected version:

```bash
pnpm view @tiangong-lca/cli version
pnpm view @tiangong-lca/cli dist-tags --json
pnpm release:verify-published -- --version <x.y.z> --expected-git-head <release-merge-sha>
```

Expected result:

- `version` equals `<x.y.z>`
- `latest` points to `<x.y.z>` unless this release intentionally uses a different dist-tag strategy
- `release:verify-published` returns `ok: true`, verifies an optional registry `gitHead` when the registry exposes it, and always requires the cryptographically verified SLSA provenance `gitCommit` to equal `<release-merge-sha>`
- Sigstore verifies the Fulcio certificate against the GitHub OIDC issuer, an anchored exact `publish.yml@refs/tags/cli-v<x.y.z>` identity, certificate transparency, and Rekor before any decoded statement is trusted
- the verified statement has exact in-toto/SLSA types and binds the canonical repository, tag, workflow, GitHub Actions invocation, and independently downloaded tarball sha512
- the temporary consumer proves exact pnpm 11.24.0 and registry signatures, overrides both user and global package-manager configuration with private public-registry-only files, exercises the bin, `auth identity-receipt --help` for 0.1.1 and later, explicit ESM/CJS launcher imports, and scans dependencies, optional dependencies, and peers for production TypeScript

The verifier intentionally reports `registryGitHead: null` when npm omits that legacy metadata field; this is not a bypass because the signed provenance `gitCommit` remains mandatory. Do not update the workspace pointer until the complete verifier returns `ok: true`.

## Workspace Follow-Up

If the workspace tracks the CLI submodule, bump the workspace pointer only after:

- the child PR is merged
- the release tag exists
- the publish workflow succeeds
- npm resolves to the new version
- `pnpm release:verify-published` succeeds for the exact release merge commit

From the workspace root, first run the child completion preflight:

```bash
scripts/workspace-ops task finish tiangong-lca/cli#<cli-issue-number>
```

Read the complete result and follow the exact `Next` command. The first finish call is non-mutating; execute only the short-lived continuation it returns. That continuation creates or reuses the required root integration task, completes the child task, and returns the integration task's exact start action. Do not independently create a root task and do not rerun finish on the now-complete child.

Follow the integration task's returned start/update/submit sequence, use the workspace integration runbook for the exact gitlink and PR target, and bind the child Issue/PR, `cli-v<x.y.z>`, release merge SHA, successful tag/publish runs, and verifier output. After the root integration PR merges, finish the integration task itself:

```bash
scripts/workspace-ops task finish tiangong-lca/workspace#<integration-issue-number>
```

Use only that task's successful preflight continuation to complete delivery. Do not reconstruct lifecycle transitions with direct GitHub writes.

## Failure Handling

- If the version bump PR is not merged, no release should happen.
- If tag creation fails, fix the workflow or repository secret/config first. Do not manually continue the workspace bump.
- If publish fails, inspect the failed GitHub Actions run and npm/Trusted Publisher configuration before retrying the release flow.
- If a pnpm-era tag exists and points to the intended merge commit but publish did not run, re-run `publish.yml` with `tag_name=cli-v<x.y.z>`.
- If manual dispatch reports that the tagged commit has no root `pnpm-lock.yaml`, stop: the tag predates the pnpm contract and is not replayable through the current workflow.
- If npm does not show the expected version yet, wait for registry propagation before treating the release as failed.

## Operator Checklist

- only the intended package version and explicitly reviewed release-control dependency changed; Issue #230 pins dev-only `sigstore@5.0.0`, regenerates the sole pnpm lock, and leaves published runtime dependencies unchanged
- release-prep PR merged into `main`
- `Tag Release From Merge` succeeded
- `cli-v<x.y.z>` exists
- `Publish Package` succeeded
- `pnpm view @tiangong-lca/cli version` equals `<x.y.z>`
- `pnpm release:verify-published` returns `ok: true` for the immutable release merge commit
- published provenance `gitCommit` and optional registry `gitHead` resolve to the immutable release merge commit
- Sigstore certificate/CT/Rekor verification, independently downloaded tarball integrity, registry signatures, isolated user/global config, and the credential-free public pnpm ESM/CJS/bin consumer pass
- the child finish preflight's short-lived continuation owns integration-task create/reuse and child completion; no independent create or second child finish occurs
- the root integration task follows its returned lifecycle and its own finish preflight/continuation after merge
- workspace pointer updated only after all checks above passed

## Local Docpact Push Gate

The repository now includes a local pre-push gate that runs `scripts/docpact-gate.sh` and then `pnpm prepush:gate`. It is the ordinary local validation path for source pushes. Only verified pure branch deletions skip both local gates, as defined in the validation guide; tag and release qualification are unchanged. For a detected CLI version change, the merge-triggered tag workflow additionally calls the reusable four-platform pnpm matrix and makes tag creation depend on its success; the publish workflow retains its independent tag-bound release gate.

Review note, 2026-09-21: independently reviewed CLI #283 annual-volume commit d45ffb6. Existing values and language order are preserved; unknown annual evidence remains [] and an authoring gap, never a reference-flow/default-unit quantity. The separate schema, content and multilingual layers retain their own results. This document requires no additional annual-volume or release-policy change.
