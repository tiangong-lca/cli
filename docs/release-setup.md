---
title: CLI Release Setup
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: en
whenToUse:
  - when configuring repository, token, or npm Trusted Publishing prerequisites for CLI releases
whenToUpdate:
  - when release workflow filenames, token names, Trusted Publishing settings, or tag semantics change
checkPaths:
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
lastReviewedAt: 2026-09-21
lastReviewedCommit: d45ffb6
lastReviewedNote: 'Reviewed for CLI #283 at head f75eda4 (second atomic stage): the metadata repair admission and retained-attempt precedence add no dependency, version, credential, provenance or publication step.'
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ./release-runbook.md
  - ./agents/repo-validation.md
---

Review note, 2026-09-17: W6b adds no Trusted Publisher, npm, token, tag, workflow or package-version change. The canonical asset sync is a source/content change and future publication remains subject to the existing release contract.

Review note, 2026-09-18: CLI #338 adds no release setup surface. The Process/LCIA Method optional review-report schema sync and temporary SDK validation bridge change neither Trusted Publisher settings, credentials, tags, workflows, package version nor publication mechanics.

Review note, 2026-09-20: CLI #344 upgrades the exact SDK dependency to released 0.3.0 without changing Trusted Publisher settings, credentials, tags, workflow names, package version, or publication mechanics. A later CLI release follows the existing separate version-bump route.

Review note, 2026-09-20: CLI #340 upgrades the exact SDK dependency to 0.2.2 and changes contract content only; Trusted Publisher settings, credentials, tags, workflow names, package version, and publication mechanics remain unchanged. A later CLI release follows the existing separate version-bump route.

Issue #278 is a feature delivery for the opt-in managed-host IPC protocol and public runtime receiver. It leaves package version, dependencies, lockfile, authentication, Trusted Publisher setup and release workflows unchanged. Publish this API only through a separately tracked version-bump PR after exact coverage, package consumers, all four native hosts and review pass; complete public provenance verification and exact workspace integration before Foundry/Skills consume it.

Issue #274 introduces runtime inspection, component manager, bootstrap and distribution contracts without changing Trusted Publisher settings, workflow names, registry credentials or the release-only main-merge path. Native component/bootstrap publication and product manifests require their complete owner workflows and qualification; adding the descriptor export alone does not publish or qualify them.

Issue #275 uses that unchanged release path for 0.1.10: a version-only main PR triggers the existing four-platform tag workflow, and the resulting immutable `cli-v0.1.10` triggers native pnpm OIDC/provenance publication. No local publish, new token, settings bypass or product component claim is introduced.

# Release Setup

This document captures the one-time repository and registry configuration required for the `tiangong-lca-cli` npm release workflows.

For the repeatable per-release operator steps, see [release-runbook.md](./release-runbook.md).

Recommended model:

- maintainers open a normal release-prep PR from `main`
- the PR updates only the `package.json` version for the next CLI release; the sole root `pnpm-lock.yaml` stays present, frozen, and unchanged when dependencies do not change
- after that PR merges, `tag-release-from-merge.yml` creates the immutable package tag
- `publish.yml` publishes the package from that tag through npm Trusted Publishing
- maintainers do not publish routinely from local workstations

Review note, 2026-08-25: Issue #224 pins repository and workflow setup to Node 24, pnpm 11.23.0, TypeScript 7.0.2, type-aware Oxlint, the sole root `pnpm-workspace.yaml` / `pnpm-lock.yaml`, and immutable `pnpm/setup` v2.0.2. The publish job uses native pnpm OIDC with provenance and no long-lived npm token or npm fallback. The feature version remains 0.0.33; the maintainer/release compatibility boundary should be shipped later as a separate 0.1.0 release-only PR after all gates pass.

Review note, 2026-08-25: Issue #226 publishes that 0.1.0 compatibility boundary through the existing setup. It adds no secret, environment, dependency, runner, Trusted Publisher setting, workflow filename, tag rule, service-role credential, or fallback client; `TIANGONG_CLI_RELEASE_AUTOMATION_TOKEN`, immutable pnpm/setup v2.0.2, Node 24, and native pnpm OIDC/provenance remain unchanged.

Review note, 2026-08-25: Issue #228 requires no GitHub secret, environment, Trusted Publisher setting, workflow filename, tag rule, dependency, service-role credential, or alternate publication path.

Review note, 2026-08-25: Issue #230 publishes 0.1.1 through the existing merge-triggered tag and native pnpm Trusted Publishing workflows. `.nvmrc`, engines, release detection, quality, tag, and publish jobs all pin Node 24.19.0. `quality-gate.yml` is a reusable exact-platform pre-tag dependency, and exact dev-only `sigstore@5.0.0` cryptographically verifies public provenance. The temporary consumer fixes pnpm 11.23.0, verifies registry signatures, and replaces user/global config with private public-registry-only files. It adds no secret, environment, runner class, Trusted Publisher setting, tag pattern, published dependency, service-role credential, test-account credential, or alternate authentication/publication surface.

Review note, 2026-08-26: Issue #232 adds supported public subpaths and run-directory locking without changing release setup, secrets, dependencies, Trusted Publisher configuration, tag rules, or package version 0.1.1. Publication remains a separate release-only PR; its clean consumer must exercise launcher, CommandSpec, batch, run-lock, closed root/deep imports, and generated types.

Review note, 2026-08-26: Issue #233 only decomposes the implementation behind the existing batch subpath. It adds no secret, environment, dependency, lockfile, package-manager path, Trusted Publisher setting, workflow, tag rule, or version change. The repository remains pnpm 11.23.0 and TypeScript 7.0.2 single-track; publication remains separate.

Review note, 2026-08-26: Issue #236 changes only the exact pnpm requirement to 11.24.0. The pinned `pnpm/setup` action continues to resolve that version from root `packageManager`, frozen installs keep the existing sole root lock byte-for-byte, and the public verifier uses the same exact version. No secret, environment, runner, dependency, Trusted Publisher setting, workflow filename, tag rule, credential, version, or alternate npm/Yarn publication path is added.

Review note, 2026-08-26: Issue #237 publishes 0.1.2 through the existing merge-triggered tag and native pnpm Trusted Publishing workflows. It adds no secret, environment, runner, dependency, lockfile change, Trusted Publisher setting, workflow filename, tag rule, credential, service-role/test-account access, or alternate authentication/publication surface; only package metadata and four live CLI-version fixtures change.

Review note, 2026-08-29: Issue #240 adds a public parser subpath and requires no new secret, environment, runner, dependency, lockfile, Trusted Publisher setting, workflow, tag rule, credential, or alternate publication path. Its later patch release uses the existing release-prep PR and merge-triggered Trusted Publishing setup.

Review note, 2026-08-29: Issue #242 publishes 0.1.3 through that unchanged merge-triggered tag and native pnpm Trusted Publishing path. It adds no secret, environment, runner, dependency, lockfile change, Trusted Publisher setting, workflow filename, tag rule, service-role/test-account access, local credential, or alternate authentication/publication surface.

Review note, 2026-08-31: Issue #247 changes only local state-lock read behavior and adds no secret, environment, runner, dependency, lockfile change, Trusted Publisher setting, workflow filename, tag rule, service-role/test-account access, local credential, OAuth credential, or alternate authentication/publication surface.

Review note, 2026-08-31: Issue #246 publishes 0.1.4 through that unchanged merge-triggered tag and native pnpm Trusted Publishing path. It adds no secret, environment, runner, dependency, lockfile change, Trusted Publisher setting, workflow filename, tag rule, service-role/test-account access, local credential, OAuth credential, or alternate authentication/publication surface.

Review note, 2026-08-31: Issue #250 adds test-only platform injection and no release setup. The stopped 0.1.4 run created neither tag nor package. A later version-only PR reuses the existing merge-triggered four-platform gate and native pnpm Trusted Publishing; no manual tag, local publish, new secret, runner, environment, workflow, or recovery credential is allowed.

Review note, 2026-08-31: Issue #252 publishes replacement 0.1.5 through that existing merge-triggered four-platform/tag/native pnpm Trusted Publishing path. It adds no secret, environment, runner, dependency, lockfile, Trusted Publisher setting, workflow filename, tag rule, service/test credential, OAuth credential, or recovery surface.

Review note, 2026-08-31: Issue #256 upgrades dependency and formatter versions at package 0.1.5 without adding a secret, environment, runner, Trusted Publisher setting, workflow filename, tag rule, credential, or publication. Issue #257 later publishes 0.1.6 through the existing merge-triggered four-platform/tag/native pnpm Trusted Publishing path and likewise adds no setup surface.

Review note, 2026-08-31: Issue #257 publishes 0.1.6 through that unchanged merge-triggered four-platform/tag/native pnpm Trusted Publishing path. It adds no secret, environment, runner, dependency, lockfile change, Trusted Publisher setting, workflow filename, tag rule, service/test credential, OAuth credential, local npm authorization, or recovery surface.

Current workflow files:

- `.github/workflows/quality-gate.yml`
- `.github/workflows/tag-release-from-merge.yml`
- `.github/workflows/publish.yml`

Review note, 2026-06-04: `dataset curation-queue next/verify` does not change release workflow files, token names, Trusted Publishing settings, or tag semantics.

Review note, 2026-07-14: Issue #165's guarded derivative-rebuild command requires no new release secret, token, Trusted Publisher setting, workflow file, or tag rule. Database RPC deployment remains a cross-repo runtime prerequisite, not npm release setup.

Review note, 2026-07-15: Issue #168's protected owner-draft runner requires no new npm secret, GitHub environment, Trusted Publisher setting, workflow filename, or tag rule. The released database-engine#262 production contract is a runtime prerequisite for the later CLI patch release, not a change to release setup.

Review note, 2026-07-15: Issue #171's protected freeze/seal commands require no new npm secret, GitHub environment, Trusted Publisher setting, workflow filename, tag rule, database service-role credential, or alternate CLI authentication variable. Freeze reuses the existing user-session contract; seal receives no authentication or network input. The feature still follows a normal feature PR, separate version-bump PR, automated tag, and npm Trusted Publishing path.

Review note, 2026-07-16: Issue #175's bounded preflight clock-skew fix requires no new secret, environment, Trusted Publisher setting, workflow, tag rule, credential, or database change. It follows the unchanged feature-then-patch-release path.

Review note, 2026-07-16: Issue #177's test-only Windows portability changes require no new secret, environment, runner configuration, Trusted Publisher setting, workflow, tag rule, credential, or database change.

Review note, 2026-07-16: Issue #178 publishes 0.0.27 through the existing merge-triggered tag and npm Trusted Publishing workflows. It requires no new secret, environment, runner, Trusted Publisher setting, workflow, tag rule, credential, or database change.

Review note, 2026-07-16: Issue #182's protected-verifier hash-domain fix requires no new secret, environment, runner, Trusted Publisher setting, workflow, tag rule, credential, or database change. It follows the unchanged feature-then-patch-release path.

Review note, 2026-07-16: Issue #184 publishes 0.0.28 through the existing merge-triggered tag and npm Trusted Publishing workflows. It requires no new secret, environment, runner, Trusted Publisher setting, workflow, tag rule, credential, or database change.

Review note, 2026-07-16: Issue #186 requires no new GitHub secret, npm token, Trusted Publisher setting, workflow, or tag rule. The LCI/LCIA data-release runtime uses the shared OAuth actor session and publishable key outside GitHub Actions; a service-role key must not be configured in the CLI or standalone release project.

Review note, 2026-07-17: Issue #191 is a test-only Windows portability prerequisite for CLI 0.0.29. It requires no new secret, runner, environment, Trusted Publisher setting, workflow, tag rule, credential, or database change.

Review note, 2026-07-17: Issue #189 publishes 0.0.29 through the existing merge-triggered tag and npm Trusted Publishing workflows. It requires no new secret, environment, runner, Trusted Publisher setting, workflow filename, tag rule, service-role credential, or alternate CLI authentication variable.

Review note, 2026-07-16: Issue #157's flow-identity workflow requires no new npm secret, GitHub environment, Trusted Publisher setting, workflow filename, tag rule, service-role credential, or alternate CLI authentication variable. It follows the unchanged feature PR, separate version-bump PR, automated tag, and Trusted Publishing path.

Review note, 2026-07-17: Issue #157 COMMON hardening still requires no new npm secret, GitHub environment, Trusted Publisher setting, workflow filename, tag rule, or release credential. The DB/CLI contract now supplies the cross-machine one-wrapper rotating permit, a create-only local claim as defense in depth, and a separately frozen and approved recovery path with read-only scope lookup. Production remains gated on merge, Preview validation, and coordinated DB/CLI release.

Review note, 2026-07-23: Issue #194 requires no new npm secret, GitHub environment, Trusted Publisher setting, workflow filename, tag rule, service-role credential, or alternate CLI authentication variable. Its stable user-state execution ledger is local runtime state, not release infrastructure; the feature follows the unchanged feature PR, separate version-bump PR, automated tag, and Trusted Publishing path.

Review note, 2026-07-23: Issue #196 publishes 0.0.30 through the existing merge-triggered tag and npm Trusted Publishing workflows. Its Windows-compatible write-descriptor `fsync` repair requires no new secret, environment, runner, Trusted Publisher setting, workflow filename, tag rule, service-role credential, or alternate CLI authentication variable.

Review note, 2026-07-23: Issue #198 publishes 0.0.31 through the same merge-triggered tag and npm Trusted Publishing workflows. Isolating SDK validation on a deep clone requires no new secret, environment, runner, Trusted Publisher setting, workflow filename, tag rule, service-role credential, or alternate CLI authentication variable.

Review note, 2026-07-24: Issue #200 publishes 0.0.32 through the unchanged merge-triggered tag and npm Trusted Publishing workflows. Bounded execution-contract concurrency and owner-token renewal reuse the existing CLI session runtime and add no dependency, secret, environment variable, runner, Trusted Publisher setting, workflow filename, service-role credential, or alternate authentication surface.

Review note, 2026-07-24: Issue #202 publishes 0.0.33 through the unchanged merge-triggered tag and npm Trusted Publishing workflows. Bounded flow delete-only maintenance reuses the existing user session, RLS REST reads, and protected delete RPC and adds no dependency, secret, environment variable, runner, Trusted Publisher setting, workflow filename, service-role credential, or alternate authentication surface.

Review note, 2026-07-24: Issue #204 changes only the main-commit all-visible preflight page size and requires no new secret, environment variable, runner, Trusted Publisher setting, workflow, tag rule, service-role credential, or alternate authentication surface.

Review note, 2026-07-25: Issue #206 changes only that preflight's indexed ordering and requires no new secret, environment variable, runner, Trusted Publisher setting, workflow, tag rule, service-role credential, or alternate authentication surface.

Review note, 2026-07-25: Issue #208 validates a user-supplied, explicitly SHA-approved SELECT-only proof file with existing local primitives. It adds no secret, environment variable, dependency, runner, Trusted Publisher setting, workflow, tag rule, service-role credential, or alternate authentication/mutation surface.

Review note, 2026-07-13: exact-count maintenance pagination requires no repository secret, Trusted Publisher, environment, workflow filename, or tag-semantics change.

Important constraint:

- if tag creation is automated, do not rely on the default workflow `GITHUB_TOKEN` for those tag pushes
- use a GitHub App token or fine-grained PAT so the downstream tag-triggered publish workflow can run as expected

Required secret:

- in `tiangong-lca/cli`: `TIANGONG_CLI_RELEASE_AUTOMATION_TOKEN`

The current workflows expect a token that can:

- create tag refs in `tiangong-lca/cli`
- read repository contents needed by the release automation

## GitHub Repository

GitHub Actions must be enabled for the repository.

Review note, 2026-06-02: adding the dataset curation queue command does not change Trusted Publishing, release token, tag, or workflow setup.

Historical npm-era release 0.0.11 note, 2026-06-02: `package.json` version bump only; no repository secret, Trusted Publisher, tag, or workflow setup change was required.

Historical npm-era release 0.0.12 note, 2026-06-05: `package.json` version bump only; no repository secret, Trusted Publisher, tag, workflow filename, or GitHub environment setup change was required.

Historical npm-era release 0.0.13 note, 2026-06-06: `package.json` and `package-lock.json` version metadata changed; no repository secret, Trusted Publisher, tag, workflow filename, or GitHub environment setup change was required. The operator path was PR merge to upstream `main`, then GitHub Actions tag and publish.

Historical npm-era release 0.0.14 note, 2026-06-07: `package.json` and `package-lock.json` version metadata changed; no repository secret, Trusted Publisher, tag, workflow filename, or GitHub environment setup change was required. The release included a deterministic location apply fix and used the same PR merge to upstream `main`, tag, and npm Trusted Publishing path.

Historical npm-era release 0.0.15 note, 2026-06-11: `package.json` and `package-lock.json` version metadata changed; no repository secret, Trusted Publisher, tag, workflow filename, or GitHub environment setup change was required. The release included the `dataset import-lca convert` adaptation to tidas-tools 0.0.28 process-bundle flags and used the same PR merge to upstream `main`, tag, and npm Trusted Publishing path.

Issue #210 setup note, 2026-07-27: unified Rust import adds no npm secret, Trusted Publisher setting, tag rule, or release workflow. Operators install `tidas` separately from a checksum/provenance-verified release artifact or crates.io and select it with `--tidas-bin`, `TIDAS_BIN`, or PATH. The npm tarball intentionally contains the smoke fixture but no platform executable.

The publish workflow file is fixed at:

- `.github/workflows/publish.yml`

Do not rename that workflow file without updating the npm Trusted Publisher configuration.

`npm-release` is optional. The current publish job uses npm Trusted Publishing without a GitHub deployment environment. Only create `npm-release` if you later decide to gate npm publishes with a GitHub environment, and update the npm Trusted Publisher configuration to match.

## npm Trusted Publisher

Configure Trusted Publishing for `@tiangong-lca/cli` on npm with:

- organization or user: `tiangong-lca`
- repository: `cli`
- workflow filename: `publish.yml`

Migration note, 2026-09-13 (CLI #312): update the npm Trusted Publisher repository value to `cli` in the same tracked step as the next release. Versions published through 0.1.14 were released under the `tiangong-cli` Trusted Publisher configuration and stay valid as historical artifacts; the npm-side change is not applied retroactively by this source migration.

The publish job expects tags named `cli-vX.Y.Z`.

Leave the environment name unset unless the workflow is explicitly updated to use a GitHub environment for npm releases.

## Repository Settings

- GitHub-hosted runners must be used for trusted publishing.
- Maintainers should avoid long-lived `NPM_TOKEN` secrets once Trusted Publishing is configured.
- If the package name or repository name changes later, update both the workflow and the npm Trusted Publisher configuration before the next release.

## Operational Notes

- `publish.yml` validates that the Git tag matches the package version before upload and supports `workflow_dispatch` only for pnpm-era tags whose tagged commit contains the root `pnpm-lock.yaml`. A pre-pnpm `cli-v*` tag fails fast; historical-tag replay has no legacy npm fallback.
- `tag-release-from-merge.yml` detects a CLI version change under exact Node 24.19.0 before expensive validation, invokes the reusable four-platform `quality-gate.yml`, and permits its tag job only after every exact platform/architecture assertion and matrix gate succeeds. It then reruns the Ubuntu Docpact/release gates before creating the tag. If the expected tag already points at the current merge commit, the tag step is idempotent; if it points elsewhere, the workflow fails.
- every Node workflow uses immutable `pnpm/setup` v2.0.2 with Node 24.19.0, cache enabled, and `pnpm install --frozen-lockfile`; the publish job receives `id-token: write` and invokes native pnpm provenance publication
- The release-prep PR should ordinarily update only the intended package version and must not churn `pnpm-lock.yaml` when the graph is unchanged. Issue #230 is an explicit reviewed exception: exact dev-only `sigstore@5.0.0` regenerates the sole lock for cryptographic verification while published runtime dependencies remain unchanged.
- Local workstations may run `pnpm --filter @tiangong-lca/cli --fail-if-no-match pack --dry-run` for package validation, but routine npm publication belongs to GitHub Actions Trusted Publishing after the upstream `main` merge.
- `pnpm test:package` must prove the tarball contains only the declared runtime surface and that a clean package-manager-neutral consumer can install and execute it without repository workspace state or leaked TypeScript/Oxlint/test tooling.
- `pnpm release:verify-published -- --version <x.y.z> --expected-git-head <release-merge-sha>` performs cryptographic Sigstore certificate/CT/Rekor proof, registry-signature and tarball verification, then an exact-version pnpm bin/ESM/CJS consumer with isolated user/global configuration and no registry or TianGong credential.
- Adding CLI command families such as dataset or lifecyclemodel maintenance commands does not require release setup changes by itself; those feature PRs are covered by the normal quality and docpact gates before a later version bump.

## Local Docpact Push Gate

The repository now includes a local pre-push gate that runs `scripts/docpact-gate.sh` and then `pnpm prepush:gate`. It is the ordinary local validation path for source pushes. Only verified pure branch deletions skip both local gates, as defined in the validation guide; tag and release qualification are unchanged. Release automation additionally requires the reusable four-platform pnpm matrix before tag creation and retains an independent tag-bound gate before npm publishing.

## Runner allocation

All CI jobs use GitHub-hosted runners. The quality matrix covers Linux x64, Linux ARM64, Windows x64 and macOS Apple Silicon. Issue #298 reverses the CodeBuild routing after the benchmark showed limited total-wait benefit; no AWS runner is required. Existing-tag recovery continues through workflow_dispatch and the direct canonical gate from the tagged checkout.

Review note, 2026-09-21: independently reviewed CLI #283 annual-volume commit d45ffb6. Existing values and language order are preserved; unknown annual evidence remains [] and an authoring gap, never a reference-flow/default-unit quantity. The separate schema, content and multilingual layers retain their own results. This document requires no additional annual-volume or release-policy change.
