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
  - src/lib/dataset-command.ts
  - src/cli.ts
  - test/dataset-exact-reference-intent.test.ts
lastReviewedAt: 2026-11-09
lastReviewedCommit: '09166a54977b87d4b2657dbfc4f1f3b92400d3ff'
lastReviewedNote: 'Reviewed command composition, enforced dependency boundaries, application writes, private journal invariants and specialized protocol preservation.'
related:
  - ../../AGENTS.md
  - ./repo-validation.md
  - ./repo-architecture.md
---

# Exact reference intent

The retained internal `runDatasetRemoteVerify({ referenceIntentFile, ... })` operation checks an explicitly reviewed physical definition even when a newer visible version exists. It is read-only observation, not a write grant, database lock, schema-validation substitute or general exception to current-user RLS. Without this selection, the existing latest-version and root policies retain their previous behavior and report shape.

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

## Current write boundary

Reviewed reference observations grant no authority to create or save an object. Typed writes retain their own validation, actor/environment binding, content preconditions and unknown-outcome recovery. Retired generic Flow execution contracts and their admission journals belong to their matching historical CLI version and are not a current recovery or exception interface.
