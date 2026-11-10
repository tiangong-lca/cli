---
title: Task PCR snapshot contract
docType: contract
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - when preparing or consuming task-pinned offline PCR snapshots
whenToUpdate:
  - when PCR release compatibility, cache ownership, task pins or execution selection change
checkPaths:
  - src/lib/pcr-snapshot-*.ts
  - src/cli.ts
  - src/main.ts
  - test/pcr-snapshot.test.ts
lastReviewedAt: 2026-10-05
lastReviewedCommit: '09166a54977b87d4b2657dbfc4f1f3b92400d3ff'
lastReviewedNote: 'Reviewed command composition, enforced dependency boundaries, application writes, private journal invariants and specialized protocol preservation.'
related:
  - runtime-distribution-contract.md
  - repo-architecture.md
---

# Task PCR snapshots

A consuming PCR Skill explicitly prepares a new PCR workflow task or its first use with `snapshot ensure`, retaining the returned task directory for subsequent operations. The CLI owns published content discovery, bounded transport, a separate owned data cache and immutable task selection. PCR owns the offline reader, projection semantics and canonical methodology. Consumer workflows own creating tasks and deciding applicability. Preparing a library grants no data-write authority.

```text
tiangong-lca pcr snapshot ensure --task-dir <absolute-task-dir> --tool-root <explicit-installed-PCR-package> --json
tiangong-lca pcr snapshot status --task-dir <absolute-task-dir> --json
tiangong-lca pcr exec --task-dir <absolute-task-dir> -- guidance --pcr <id> --format json
```

The initial explicit installed tool selection is retained for the task. Subsequent executions require no tool flags. Selection uses an explicit installed package; preparation performs no executable provisioning or account operation. Every bundled package’s declared dependencies, optional dependencies and peers are resolved again on preparation and use; executable resolutions must stay within the pinned tree. Missing optional edges remain usable only while rechecks prove no external resolution. Declaration-only packages must have a pinned local declaration entry and no executable package files; they never become executable entry evidence. The tool package must be the compiled `@tiangong-lca/pcr` distribution with matching package/product identity, declared compiled entry and complete bundled dependencies. A bounded full file inventory, including dependencies, binds the installed bytes. The sole link exception is an npm-generated top-level `node_modules/.bin/<name>` file link that resolves inside the selected tool to the exact bin declared by a bundled dependency. Link target text and target bytes are bound; directory links and other descendant links fail. PCR dispatch never uses these links. This observation records the caller's selected installation; it is not cryptographic publisher authentication. Missing or changed tools fail, and copying a task to another machine does not provision its selected tool.

New connected tasks enumerate bounded complete stable published releases from the canonical `tiangong-lca/pcr` GitHub repository and compare numeric SemVer. Drafts, prereleases, unassociated tags and incomplete publication identities cannot be selected. Exceeding the 1000-release discovery budget fails rather than claiming latest. Only supported product/snapshot contracts and selected-reader capabilities qualify. An exact `--version` bypasses latest discovery. `--offline` makes no network request and selects the requested exact or highest compatible verified cached snapshot; it does not claim confirmed publisher latest. `status` is read-only and creates no cache or task state.

PCR release compatibility is `compatibility: {schema: 1, libraryFormat: 1, projectionContracts: ["1", "2"], minimumReaderVersion: "0.4.1", commandProtocol: 1}`. Installed readers declare `reader-capabilities.json` with schema 1, kind `pcr-reader-capabilities`, `libraryFormats`, `projectionContracts` and `commandProtocol`. Content requires every declared projection contract, the same command protocol, a supported library format and a reader version at least the minimum. Tool and content versions need not be equal. An installed reader lacking its capability declaration is accepted only for the audited legacy 0.4.1 source commit `dc0638e2814c7108a6e4dea6d701c02824b3658d` and product fingerprint `sha256:79e28dac12e712c30cc77e1cb0a86f3ed63a06e10a1fb22602213456ef906090`.

Explicit local selection requires an absolute `--library` and independently trusted `--library-sha256 sha256:<hex>`. The database and adjacent sidecar are copied into the owned cache; source files are preserved. Local selection admits the audited 0.4.1 snapshot profile and the exact historical 0.3.1 content snapshot: source `4226d2ab97d53682c967dd29a2a04d97debfc15e`, database 40,386,560 bytes / `a2ddd7717f8df3651100c4f08cb97a65e6c8fa2a5b2699f25560b92b4e7a85de`, and original 918-byte sidecar / `6a3771c6b6a77090494ef2d4f52fec8fa3baf20e735c8ff88b1e4280df5c3a58`. Historical 0.3.1 content requires the supported reader 0.4.1 or newer and projection contract 1; reader 0.3.1 is rejected. Published historical selection additionally requires its audited product fingerprint and exact release-manifest hash. Other content requires declared release compatibility through release selection or a retained verified cache.

The canonical publisher HTTPS release channel is the trust boundary for automatically discovered release metadata. SHA-256 checks establish integrity against that metadata, not independent publisher authenticity. The CLI downloads only raw `library.sqlite` and its sidecar; it never executes code named by release metadata. Metadata streams are bounded to 1 MiB, databases to 512 MiB, redirects are bounded and HTTPS origins allowlisted, and credentials are not forwarded. Sidecar bytes must match the sealed release proof. Snapshot version/source commit/database size and digest must match the release. Release `sourceFingerprint` and snapshot `source_sha256` describe different inventories and are bound separately.

The cache uses `tiangong-lca/pcr-snapshots/v1` under the platform cache directory, separate from runtime components, sessions and task directories. Its ownership marker is `tiangong-lca.pcr-snapshot-cache.v1`. Content keys bind the complete snapshot/release/compatibility identity. Installations are privately staged under locks and atomically published; immutable receipts and unknown content are never overwritten. Cancellation or failure removes only the current staging tree. Corrupt retained snapshots fail closed. No automatic pruning is implemented, so completed task snapshots remain deliberately retained for reproducibility.

Each task has immutable `pcr-snapshot-lock.json` and, when selected, `pcr-tool-lock.json`. A retained snapshot wins before any release discovery, with zero network access. Conflicting selectors fail. Continuing work never upgrades its snapshot or tool. A new task is the supported selection boundary. Each use rechecks complete database, sidecar, release metadata and selected tool content. Existing lost/corrupt data requires explicit recovery; the CLI does not silently choose another release.

Preparation with a tool runs its native `library verify` and retains `pcr-library-verification.json` bound to the normalized task pin and complete tool fingerprint. Only a matching receipt and current bytes yield `task_usable: true`; every public execution requires that receipt. A failed native verification retains the exact snapshot/tool pins in partial state and permits only ensure to rerun verification against those same bytes, with no latest discovery. Without a selected verified tool the result is `snapshot-ready`, which is transport readiness only. Library verification establishes reader format and SQLite/file integrity, not scientific approval or complete projection semantics.

`pcr exec` rejects caller source overrides and appends the task's exact `--library` and `--library-sha256`. Native input-only `inspect` and `calculate` omit library arguments while retaining task/tool verification. Execution uses the existing shell-free CommandSpec, an explicit task CWD, bounded output, and essential platform environment paths. `PCR_LIBRARY`, `NODE_OPTIONS`, unrelated credentials and authorization configuration are excluded. The complete regular tool closure, database, sidecar, task artifacts and successful verification receipt are rehashed before spawn. Application execution is never retried.
