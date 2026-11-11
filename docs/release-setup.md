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
lastReviewedAt: 2026-11-11
lastReviewedCommit: 899fe12a507c2cc3a454011c0918a57d65588968
lastReviewedNote: 'Reviewed Review refusal classification by endpoint, durable recovery, and unified absence errors.'
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ./release-runbook.md
  - ./agents/repo-validation.md
---

# CLI Release Setup

## GitHub Repository

GitHub Actions must be enabled for the repository.

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
- every Node workflow uses immutable `pnpm/setup` v3.1.1 with Node 24.19.0, cache enabled, and `pnpm install --frozen-lockfile`; the publish job receives `id-token: write` and invokes native pnpm provenance publication
- The release-prep PR should ordinarily update only the intended package version and must not churn `pnpm-lock.yaml` when the graph is unchanged. Issue #230 is an explicit reviewed exception: exact dev-only `sigstore@5.0.0` regenerates the sole lock for cryptographic verification while published runtime dependencies remain unchanged.
- Local workstations may run `pnpm --filter @tiangong-lca/cli --fail-if-no-match pack --dry-run` for package validation, but routine npm publication belongs to GitHub Actions Trusted Publishing after the upstream `main` merge.
- `pnpm test:package` must prove the tarball contains only the declared runtime surface and that a clean package-manager-neutral consumer can install and execute it without repository workspace state or leaked TypeScript/Oxlint/test tooling.
- `pnpm release:verify-published -- --version <x.y.z> --expected-git-head <release-merge-sha>` performs cryptographic Sigstore certificate/CT/Rekor proof, registry-signature and tarball verification, then an exact-version pnpm bin/ESM/CJS consumer with isolated user/global configuration and no registry or TianGong credential.
- Adding CLI command families such as dataset or lifecyclemodel maintenance commands does not require release setup changes by itself; those feature PRs are covered by the normal quality and docpact gates before a later version bump.

## Local Docpact Push Gate

The repository now includes a local pre-push gate that runs `scripts/docpact-gate.sh` and then `pnpm prepush:gate`. It is the ordinary local validation path for source pushes. Only verified pure branch deletions skip both local gates, as defined in the validation guide; tag and release qualification are unchanged. Release automation additionally requires the reusable four-platform pnpm matrix before tag creation and retains an independent tag-bound gate before npm publishing.

## Runner allocation

All CI jobs use GitHub-hosted runners. The quality matrix covers Linux x64, Linux ARM64, Windows x64 and macOS Apple Silicon. Issue #298 reverses the CodeBuild routing after the benchmark showed limited total-wait benefit; no AWS runner is required. Existing-tag recovery continues through workflow_dispatch and the direct canonical gate from the tagged checkout.

The 0.2.0 candidate uses internal command/application/adapter/shared modules and installed Markdown reply templates. Package qualification includes typed Dataset/Review scenarios, template lookup and rejection of retired business/generic Dataset routes from a source-free native consumer. Package version, dependencies, exports, release authority and workflows retain their contracts; candidate validation is separate from publication evidence.
