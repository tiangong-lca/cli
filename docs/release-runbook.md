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
lastReviewedAt: 2026-11-11
lastReviewedCommit: a1d0248209fdae9704b316796b79291cb322b1ef
lastReviewedNote: 'Reviewed Review refusal classification by endpoint, durable recovery, and unified absence errors.'
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ./release-setup.md
  - ./agents/repo-validation.md
---

# CLI Release Runbook

## Preconditions

Concurrent-main note, 2026-09-02: PR #264 / Issue #262 subsequently merged as `f56c5349414c73a7f3f967ebd667064ce08a26e3`. Release #266 preserves that reviewed runtime and repeats validation against this new base; the release-only diff remains version/fixtures/governed evidence. The new Process draft adapter sends `p_model_version` and requires database-engine #589 / migration head `20260902104500`. Do not merge the release PR or start automatic npm publication until production RPC compatibility and the required deployment are proved. This release task does not implicitly authorize that independently owned production schema rollout.

Before starting a release:

- work from the latest `main`
- keep the release-prep change scoped to CLI package version metadata
- confirm npm has not already published the target version
- confirm any command-surface feature PRs that will be included in the release have passed the local pre-push gate, including `pnpm prepush:gate` and docpact, before preparing the version bump
- do not publish routinely from a local workstation; the canonical release path is a version-bump PR merged to upstream `main`, followed by tag creation and npm Trusted Publishing in GitHub Actions

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

The 0.2.0 candidate uses internal command/application/adapter/shared modules and installed Markdown reply templates. Package qualification includes typed Dataset/Review scenarios, template lookup and rejection of retired business/generic Dataset routes from a source-free native consumer. Package version, dependencies, exports, release authority and workflows retain their contracts; candidate validation is separate from publication evidence.
