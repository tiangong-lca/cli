---
title: CLI Dependency Maintenance
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: en
whenToUse:
  - when reviewing dependency proposals or changing dependency monitoring
whenToUpdate:
  - when dependency monitoring, validation selection or manual intake changes
checkPaths:
  - .github/dependabot.yml
  - docs/agents/dependency-maintenance.md
lastReviewedAt: 2026-10-16
lastReviewedCommit: '09166a54977b87d4b2657dbfc4f1f3b92400d3ff'
lastReviewedNote: 'Reviewed command composition, enforced dependency boundaries, application writes, private journal invariants and specialized protocol preservation.'
related:
  - repo-validation.md
---

# Dependency maintenance

Dependabot monitors the single root pnpm graph through its npm ecosystem and GitHub Actions through a separate entry. Weekly Tuesday scans use Asia/Shanghai, a seven-day version cooldown, two package PRs and one Actions PR. Supabase, Oxlint and the declared development tools have related patch/minor groups; package majors and the exact internal SDK remain separately reviewable. Preserve runtime/compiler/package-manager constraints, dependency pins, overrides and install restrictions when assessing a candidate.

Keep `@types/node` on Node 24 LTS: the npm entry ignores versions `>=25.0.0`, while all 24.x patch and minor updates remain eligible under the existing monitoring policy. Revisit this exclusion only after an explicitly approved runtime/toolchain major upgrade; a newer typings major alone is not adoption approval.

The existing four-platform `quality-gate.yml` also runs automatically for main PRs touching the manifest, lock, package/runtime configuration, Dependabot configuration or Actions workflows. It checks out the exact PR head with read-only permissions, uses the frozen install and canonical `pnpm prepush:gate`, and cancels superseded runs for the same PR. Manual reproduction and reusable release invocation retain their existing matrix and job identities. Source-only feature PRs retain their existing local validation and release workflow.

Monitoring configuration does not enable security alerts or security updates; verify those repository settings and the dependency graph separately. Record the first hosted scan result and validate the first actual candidate through its frozen install and canonical checks. A missing PR is not scan-success evidence. Embedded executable versions, bootstrap locks, specification snapshots and consumer runtime manifests remain explicitly owned adoption inputs.

Proposals require manual acceptance, review and controller-managed delivery. Automatic merging is disabled for this rollout; green CI, a bot author or review service admission grants no merge or publication authority. Check independent merge services before activation. Adopt accepted proposals through the workspace controller's supported existing-PR preview and exact-head intake after that capability is available; never create a duplicate PR or use ordinary --head as an import command. Exact eligible child merge integration remains a later workspace step. To pause version proposals, set the affected entry's PR limit to zero through review and retain security settings.
