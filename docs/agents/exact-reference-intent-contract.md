---
title: Exact Reference Intent Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - when constructing an explicit reviewed exact-reference selection
  - when interpreting reference-intent verification or transporting its evidence through Foundry
whenToUpdate:
  - when intent or review wire fields, reference eligibility, content binding, or failure semantics change
checkPaths:
  - src/lib/dataset-exact-reference-intent.ts
  - src/lib/dataset-remote-verify.ts
  - src/lib/dataset-save-draft-reference-intent.ts
  - src/lib/dataset-save-draft-run.ts
  - src/lib/dataset-command.ts
  - src/cli.ts
  - test/dataset-exact-reference-intent.test.ts
  - test/dataset-save-draft-exact-reference.test.ts
lastReviewedAt: 2026-09-11
lastReviewedCommit: 577d6fdf6ffb9de594b098a166c6b1f2ac3657f1
lastReviewedNote: 'Reviewed for CLI #289: explicit consumer/reference/review binding, fresh actor identity, current latest payload observations and unchanged root/default policies.'
related:
  - ../../AGENTS.md
  - ./repo-validation.md
  - ./repo-architecture.md
---

# Exact reference intent

`dataset verify-remote --reference-intent-file <file>` checks an explicitly reviewed physical definition even when a newer visible version exists. It is read-only observation, not a write grant, database lock, schema-validation substitute or general exception to current-user RLS. Without this option, the existing latest-version and root policies retain their previous behavior and report shape.

`dataset-exact-reference-intent.ts` owns strict local selection and observation evaluation. `dataset-remote-verify.ts` owns row/reference collection, the existing fresh auth-identity receipt, RLS GET transport, payload caching and report publication. Foundry owns explicit input selection, snapshot lineage and handoff/readback binding; it must not reproduce the CLI's eligibility policy.

## Intent input

The file is UTF-8 JSON with exactly these fields:

```json
{
  "schema_version": "dataset-exact-reference-intent.v1",
  "project_ref": "abcdefghijklmnopqrst",
  "actor_user_id": "00000000-0000-4000-8000-000000000090",
  "consumers": [
    {
      "row_index": 0,
      "table": "processes",
      "id": "00000000-0000-4000-8000-000000000002",
      "version": "00.00.001",
      "payload_sha256": "<consumer payload SHA-256>"
    }
  ],
  "references": [
    {
      "row_index": 0,
      "path": "/processDataSet/exchanges/exchange/0/referenceToFlowDataSet",
      "selected": {
        "table": "flows",
        "id": "00000000-0000-4000-8000-000000000001",
        "version": "00.00.001",
        "payload_sha256": "<selected remote payload SHA-256>",
        "user_id": "00000000-0000-4000-8000-000000000091",
        "state_code": 100
      },
      "review": {
        "file": "./review.json",
        "sha256": "<review file raw-byte SHA-256>"
      }
    }
  ]
}
```

The illustrative identifiers and hash placeholders must be replaced by actual independently observed facts. Hash strings contain exactly 64 lowercase hexadecimal characters. UUIDs are normalized without changing their identity; dataset versions use the canonical `NN.NN.NNN` form. Supported tables are `contacts`, `flowproperties`, `flows`, `lciamethods`, `lifecyclemodels`, `processes`, `sources`, and `unitgroups`.

`consumers` binds every input row exactly once in its current order, with payload-derived identity/version and payload hash. Conflicting row-envelope identities fail locally. Each `references` entry binds exactly one current reference occurrence by row index, exact JSON pointer, table, UUID and version. Root occurrences, duplicate declarations, changed or unused paths, and missing versions fail before authentication or dataset reads. Undeclared references keep the default policy; they are not implicitly opted in.

Only public state `100`, or state `0` owned by the declared and freshly verified actor, is eligible in selected/reviewed snapshots. Owner UUID and state are explicit facts. Other private owners, unsupported states and unobservable ownership cannot be accepted through this protocol. The fresh identity receipt must match both `project_ref` and `actor_user_id` before reference queries run.

## Review input

Each explicitly named review file has exactly these fields:

```json
{
  "schema_version": "dataset-exact-reference-review.v1",
  "decision": "use_selected_exact",
  "reason": "Explain why this consumer retains the selected physical definition.",
  "selected": {
    "table": "flows",
    "id": "<UUID>",
    "version": "00.00.001",
    "payload_sha256": "<SHA-256>",
    "user_id": "<UUID>",
    "state_code": 100
  },
  "latest": {
    "table": "flows",
    "id": "<same UUID>",
    "version": "00.00.002",
    "payload_sha256": "<SHA-256>",
    "user_id": "<UUID>",
    "state_code": 100
  }
}
```

The selected snapshot must equal the intent's selected snapshot. Latest must describe the same table/UUID and a version at least as recent. A single reviewed version cannot claim two payload/owner/state values. A non-empty reason is required; it is review data, not authentication or write authorization.

Payload hashes use the CLI's canonical parsed-JSON algorithm: recursively sort object keys, retain array order and string contents, serialize with `JSON.stringify` without a trailing newline, then SHA-256 the UTF-8 bytes. Hash the complete unwrapped canonical dataset payload, including its dataset wrapper. Review and intent file facts instead hash their exact raw bytes; these hash domains are distinct.

Review paths may be absolute or relative to the selected intent file's directory. Files and occurrence paths preserve exact spelling without edge whitespace. Only explicitly named regular files are read; linked files, unreadable/invalid UTF-8 JSON and unsupported fields fail. Each file is limited to 8 MiB and the complete distinct-file selection to 64 MiB. At most 10,000 reference occurrences may be declared. Repeated use of the same review file reuses its captured evidence.

## Verification and reports

For eligible occurrences, the existing current-user RLS client reads the current visible latest version and its complete payload/owner/state together. The selected exact payload is read separately when it is not that same version. Observations are cached within one invocation. Metadata failures, hidden/missing versions and root failures remain blocking; a review cannot replace them with an `ok` check.

Selected and latest observations must match the reviewed UUID/version, owner, state and canonical payload hash. Payload identity must agree with the observed row's table/UUID/version. Failed pins replace their original occurrence check with `reference_intent_mismatch`; they never leave a separate acceptable check alongside an error. Matching uses row, role and path, so a reference sharing a root's path cannot alter root verification. Successful checks retain the newer-version observation and original status.

The usual report gains `reference_intent` only when explicitly selected. It contains the intent file fact (`path`, raw `sha256`, `bytes`), verified actor/project binding, normalized consumers and reference selections, and deduplicated `review_files`. The companion checks contain `reference_intent.applied`, original status, intent/review hashes, observed selected/latest content facts and failure classification. No token or raw payload is copied into that evidence projection.

Before publishing the report, the CLI rechecks current consumer content and intent/review bytes. File or consumer drift prevents a passing report. This still does not claim an atomic snapshot across database requests or protect future writes from later changes. Precommit evidence and subsequent independent readback must each satisfy their owning gate; consumed mutations are never replayed to manufacture a matching receipt.

Moving a control file changes relative path resolution. A host that stages reviewed inputs must preserve or explicitly derive those locators, verify the staged bytes through this command, and bind the resulting file facts. It must not relabel an old report as verification of rewritten inputs or alter consumed historical records.

## Guarded Flow owner drafts

`dataset save-draft --type flow --input <rows> --execution-contract <contract> --reference-intent-file <intent> --dry-run|--commit` selects the same strict v1 intent and review files. Select exactly one nonempty option. This path requires a Flow-only execution contract; it adds no fields to `dataset-save-draft-execution-contract.v1`. Every complete ordered input consumer is bound, including consumers without a selected occurrence. Ordinary save-draft and contracts without this selection keep their existing policy.

The CLI evaluates every selected reference occurrence. Repeated table/UUID/version observations may share transport reads within one action's admission pass, but one selected path never exempts another undeclared path. Selected and visible-latest complete bodies, embedded identities, owner and state must match the reviewed facts; exact reads must return one row. The explicit visible-latest observation is distinct from default latest-published lookup. Roots, malformed or unused declarations, private foreign rows and unsupported states remain ineligible.

Both preflight and immediate pre-dispatch verify the current authenticated actor/project and fresh reference bodies. Immediate pre-dispatch uses a new observation cache, rechecks the exact insert absence or owner-draft before image, renews the dispatch token with owner checks, and synchronously rechecks complete input and intent/review bytes. The transport awaits this gate, then the CLI durably appends the attempt before the one mutation request. A failed gate emits no request or attempt. Reference observations are not a database lock or an atomic transaction across requests; guarded writes and subsequent independent exact readback remain required.

The summary adds `reference_intent`, the normalized `LoadedExactReferenceIntent` already documented above. Each admitted row has `reference_intent_admission`:

| Field | Binding |
| --- | --- |
| `schema_version` | `dataset-save-draft-reference-admission.v1` |
| `selection_sha256` | Canonical parsed-JSON hash of the complete normalized summary `reference_intent`, including all consumers, occurrences and captured file facts |
| `intent_file` | Original selected intent's exact `path`, raw-byte `sha256`, and `bytes` |
| `project_ref`, `actor_user_id` | Same project and owner as the execution contract and freshly authenticated identity |
| `consumer` | This action's original `row_index`, `table`, `id`, `version`, complete `payload_sha256` |
| `references` | All selected pins for that row, with original `row_index`, exact `path`, `selected` snapshot and `review: { file, latest }`; an unselected row has an empty array |

The per-row admission is a content-bound record of a passed check, not a grant. Dry-run returns it with `prepared`/`would_sync`, zero consumed attempts and no ledger. Commit puts the same admission in the existing hash-chained `attempt_emitted` and `outcome` events and in the row report. Ledger lookup remains keyed by the existing owner scope and action identity (`action_id` plus `desired_sha256`); changing evidence never selects a fresh ledger. Stored admission shape, owner, complete action content and attempt/outcome equality are checked before recovery.

A consumed action requires the same explicit normalized selection. Omitting or changing it, or trying to add evidence to a historical attempt without it, returns a consumed binding failure (`DATASET_SAVE_DRAFT_REFERENCE_RECOVERY_MISMATCH`): `unknown` for commit, `blocked` for dry-run, with the original admission retained and no new request. Restore the original files/selection to use the ordinary readback-only recovery. Malformed or unavailable selected files fail parsing; they cannot grant a new attempt. Matching recovery returns the original admission without re-evaluating or replacing historical observations. An unresolved attempt can resolve by independent exact owner/state/body readback; terminal UNKNOWN stays terminal and never replays. A previous success whose desired body no longer reads back exactly is reported unknown.

Callers must snapshot and bind the complete rows, execution contract, intent and every selected review in their existing command artifact protocol, and pass the explicit selection to both owner preflight and commit. If locators change before the first attempt, derive and reverify the staged intent; do not relabel prior reports or move a consumed selection. Native owner finalization, grant/attempt state and runtime candidate adoption remain caller-owned contracts. A successful read-only `verify-remote` report alone cannot authorize or close a write.
