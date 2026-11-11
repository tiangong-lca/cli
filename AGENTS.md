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
  - assets/study-contract/**
  - assets/study-renderer/**
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
lastReviewedAt: 2026-11-11
lastReviewedCommit: 188b901c08aea4787090e8f3ad5e6df757920b61
lastReviewedNote: 'Reviewed Review refusal classification by endpoint, durable recovery, and unified absence errors.'
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

# CLI development contract

This repository provides atomic, composable LCA operations for people and AI. The CLI owns command discovery, explicit inputs, domain-service adaptation and truthful results. Callers own task goals, evidence selection and workflow sequencing.

## Read first

1. [README](README.md): working capabilities and how to run them.
2. [Target interfaces](docs/interfaces/README.md): intended command boundaries and semantics; capability tables are not proof of implementation.
3. [Implementation plan](docs/plans/cli-0.2.0-refactor-plan.md): current milestone, dependencies and deferred work.
4. Run `scripts/docpact route --root <absolute-repository-root> --paths <changed-paths> --format json`; read the returned governed documents.
5. Read [architecture](docs/agents/repo-architecture.md) and [validation](docs/agents/repo-validation.md) for implementation work. Read [existing runtime safeguards](docs/agents/existing-runtime-contract.md) before reusing or changing legacy runtime behavior.
6. Follow [documentation guidance](docs/AGENTS.md) when writing or reviewing documents under `docs/`.

The workspace AGENTS.md governs delivery, branch policy and integration. Resolve the current branch and delivery target from the applicable workspace policy and task records. Keep task-specific branch selections and authorization scope in delivery records rather than this contract.

## Directory responsibilities

| Location | Owns |
| --- | --- |
| `bin/`, `src/main.ts` | Installed executable, platform admission, environment and process IO. |
| `src/cli.ts`, `src/cli-composition.ts` | Root routing and the single selection of production dependencies; parsing and execution delegate to `src/commands/`. |
| `src/commands/ports.ts`, `src/cli-deps.ts` | Typed command dependencies and internal facade; optional overrides are resolved only by composition. |
| `src/commands/` | Command paths, argument validation, help and translation between CLI IO and operations. |
| `src/application/` | Atomic business operations and typed ports; no argv, filesystem or network transport. |
| `src/adapters/` | Implement ports using existing auth, data access and validation helpers. |
| `src/shared/` | Small reusable result, file and reply-template facilities; no domain workflow. |
| `src/lib/` | Protocol, scientific and data helpers; command argument/help handling belongs to `src/commands/`, with capability owners in dedicated subdirectories. |
| `assets/reply-templates/` | Markdown guidance included in installed packages. |
| `test/` | Behavioral, adapter, architecture and installation tests. |
| `docs/interfaces/` | Final target interface design, not progress logs. |
| `docs/plans/`, `docs/analysis/` | Implementation state, decisions, gaps and migration notes. |

Dependency direction: entry/composition -> commands -> application; adapters implement application ports and may reuse `src/lib/`. Shared result types may be used by application and commands. Application must not import commands, adapters, filesystem/network APIs or CLI presentation. Library helpers must not depend on command presentation or composition. Only the pure `shared/errors.ts` and `shared/state-directory.ts` leaves may be imported from library owners; the source boundary test enforces this allowlist. `test/cli-layer-boundaries.test.mjs` checks all source owners and emitted runtime cycles; the package-root observation used by shared template lookup is its explicit read-only primitive dependency. Type-only modules must use `import type` so they do not create runtime initialization edges. Do not create empty domain directories or a plugin framework for unimplemented capabilities.

## File size and cohesion

Hand-maintained code files, including tests and scripts, should normally stay within 1,000 physical lines, including comments and blank lines. Split files by responsibility as they approach this size; preserve cohesive modules and readable formatting rather than compressing code or splitting it arbitrarily to meet the number.

Refactor existing oversized files incrementally when changing the relevant responsibilities, and place new independent responsibilities in separate modules. Generated code and generated fixtures are excluded. Record the reason and intended decomposition in the task or PR when a hand-maintained file needs to exceed the guideline.

## Adding a command

1. Confirm the object/action exists in the target type capability table and identify its actual service contract.
2. Define explicit inputs and a typed operation/port. Reuse validated helpers through an adapter; do not copy auth or domain rules.
3. Add strict arguments and help in a bounded command module. Reject unsupported flags/checks; do not silently fall back to another action or version.
4. Return the shared result, including actual scope and incomplete checks. Derive human output from the same facts; JSON stdout contains only the result.
5. Add behavioral tests for success, invalid input, failure and effects. Verify output artifacts and template paths outside the source checkout when packaging is affected.
6. Update implementation status in README and the plan. Route and review documentation, then run appropriate checks and preserve a scoped commit.

Use `list-references` for reference discovery, precise `get` for target existence, `validate` for relationship constraints, and editing/`patch` plus `save` for changes. Model `build-resulting-process` has the formal alias `aggregate`; both use one operation and canonical result name when implemented.

## Results and AI context

Follow [conventions](docs/interfaces/conventions.md) and [AI context](docs/interfaces/ai-context.md). Business facts remain structured. `nextActions` contains descriptions and optional complete commands; `replyTemplate` is a Markdown path. Do not add a template registry protocol, workflow scheduler or automatic approval stage.

A missing template never changes business facts or repeats an operation. Declare semantic error categories explicitly; new error codes must not derive their category from name substrings. Missing evidence is not success. A successful validation invocation can still report invalid content. A partial implementation must state unsupported checks in help and documentation, and refuse them at runtime.

## Runtime safeguards

- `create` and `save` remain distinct intentions; conflicts and missing targets never trigger an upsert. Unknown mutations are readback-only without a proven idempotency contract. Contract-backed no-effect refusals retain a safe error code/category and original rejected result; HTTP status alone does not prove refusal, and a rejected request is not automatically replayed.
- Never broaden current-user RLS, actor/environment binding, exact references or ordinary maintenance authorization. CLI carries no service-role credential and performs no raw database mutation fallback.
- Preserve OAuth/PKCE, private session storage, credential redaction, identity receipts, run locks and bounded batch recovery. Credentials never enter argv, logs, templates or results.
- Reuse scientific rules from their owners. Missing evidence and unsupported calculations remain explicit; AI-facing convenience must not invent numerical facts.
- Keep the four public library subpaths and their consumers intact. New internal directories are not package exports. Application use cases own Dataset/Review preconditions and acknowledgment interpretation; adapters own authentication, transport and private journal IO. Commands derive continuations from returned facts. Common journal storage never decides replay or readback policy.
- Release commands and runtime/PCR child-process protocols retain their current contracts. Downstream adoption belongs to later, independent work after CLI release.

Alias, Length×time and Flow-identity repair workflows are outside the CLI. Do not restore their entrypoints or reinterpret their historical plans through ordinary maintenance. Generic maintenance and scientific validation keep their existing safeguards. Batch scheduling remains a public library API; core commands consume shared concurrency primitives directly.

Detailed existing command and runtime invariants are in [existing runtime safeguards](docs/agents/existing-runtime-contract.md). Specialized [Study](docs/agents/study-cli-contract.md), [exact-reference](docs/agents/exact-reference-intent-contract.md), [runtime](docs/agents/runtime-distribution-contract.md) and [PCR](docs/agents/pcr-snapshot-contract.md) contracts continue to govern their retained paths.

## Toolchain and verification

Use the repository's exact Node version from `.nvmrc`, pnpm from `package.json`, one root lockfile, TypeScript and type-aware Oxlint. No dependency additions, upgrades, alternate package managers or orchestration frameworks without scoped justification and required authorization.

`pnpm lint` is the minimum code gate. Run focused tests while implementing and `pnpm prepush:gate` before source push; retain the existing 100% coverage requirement and installation proof. Never add coverage ignores or weaken assertions to complete a refactor. Use the [validation contract](docs/agents/repo-validation.md) for current commands and required evidence. Live-account testing requires the [explicit authorization contract](docs/agents/live-case-testing.md).

## Delivery and release

Use the workspace lifecycle controller for tracked Issue/Project/PR updates. A locally validated commit is a checkpoint, not merged delivery. Preserve scoped commits on the selected branch; do not change root gitlinks as part of child implementation.

Routine publication requires a separate version-bump PR merged to upstream main and the existing four-platform, tag and Trusted Publishing workflows. Never publish from the workstation. See [release runbook](docs/release-runbook.md) and [release setup](docs/release-setup.md). Child merge, publication and workspace integration are separate outcomes.
