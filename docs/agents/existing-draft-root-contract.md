---
lastReviewedAt: 2026-10-21
lastReviewedCommit: 2b2eba10c68ff66d8f018b551c6c9b853a85267f
title: Existing Draft Root Qualification
docType: contract
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - when verifying a selected existing Process owner draft below a public sibling
  - when preparing or reviewing existing-draft root qualification evidence
whenToUpdate:
  - when root qualification scope, evidence fields, observations or failure semantics change
checkPaths:
  - src/lib/dataset-existing-draft-root*.ts
  - src/lib/dataset-remote-verify.ts
  - src/cli.ts
  - test/dataset-existing-draft-root*.test.ts
related:
  - ../../AGENTS.md
  - ./exact-reference-intent-contract.md
  - ./repo-validation.md
---

# Existing draft root qualification

`dataset verify-remote --root-policy candidate --existing-draft-root-file <file>` verifies one explicitly selected existing standalone Process owner draft whose version is below a reviewed public sibling. It uses current authenticated relation GETs and does not depend on draft creation RPCs or a deployed preparation service. The ordinary `existing` and `candidate` policies retain their existing behavior when the file is absent.

This is read-only qualification. The result grants no save, version allocation, publication, deletion, server lock or consumed-attempt recovery authority. A candidate can differ from its stored before-image; scientific compatibility is an explicit reviewed decision, never inferred from version numbers. Subsequent writes still require their native fresh preflight, guarded dispatch and independent readback.

Version 1 supports exactly one input row and one `processes` root at row zero. The unwrapped candidate must contain only the `processDataSet` wrapper; additional dataset roots or top-level fields fail before remote observation. The selected root must be the sole current-user state-0 draft in its typed UUID family, with no current-user dataset review points (states 20 through 99). Its `team_id`, `model_id`, `model_version` and `review_id` must be explicitly null. The public baseline must be a strictly newer state-100 standalone Process of that same UUID, with null `model_id` and `model_version`. Foreign drafts, shared/team drafts, model-bound/resulting Processes, other tables, public roots, missing roots and ambiguous draft sets are outside this qualification.

## Inputs and hashes

The selected UTF-8 JSON file has exactly these fields. Identifiers below are synthetic; hash placeholders must be replaced with actual observed values.

```json
{
  "schema_version": "dataset-existing-draft-root.v1",
  "project_ref": "abcdefghijklmnopqrst",
  "actor_user_id": "00000000-0000-4000-8000-000000000090",
  "candidate": {
    "row_index": 0,
    "table": "processes",
    "id": "00000000-0000-4000-8000-000000000001",
    "version": "00.00.002",
    "payload_sha256": "<complete intended Process payload hash>"
  },
  "selection": {
    "strategy": "sole_current_owner_draft",
    "drafts": [
      {
        "table": "processes",
        "id": "00000000-0000-4000-8000-000000000001",
        "version": "00.00.002",
        "user_id": "00000000-0000-4000-8000-000000000090",
        "state_code": 0,
        "payload_sha256": "<complete stored json_ordered hash>",
        "row_sha256": "<ten-column before-image hash>"
      }
    ],
    "reviews": [],
    "published_baseline": {
      "table": "processes",
      "id": "00000000-0000-4000-8000-000000000001",
      "version": "00.00.004",
      "user_id": "00000000-0000-4000-8000-000000000091",
      "state_code": 100,
      "payload_sha256": "<complete public json_ordered hash>",
      "row_sha256": "<ten-column public observation hash>"
    }
  },
  "review": {
    "file": "./compatibility-review.json",
    "sha256": "<review file raw-byte hash>"
  }
}
```

`compatibility-review.json` has exactly `schema_version`, `decision`, `reason`, `candidate`, `selected` and `published_baseline`. Set `schema_version` to `dataset-existing-draft-root-review.v1`, `decision` to `revise_selected_draft`, and provide a nonempty compatibility reason of at most 8192 characters. Repeat the complete `candidate` object, the sole `selection.drafts[0]` snapshot as `selected`, and the complete `selection.published_baseline` snapshot. Every value must match. The review's bytes are bound by the outer file; the CLI checks consistency, while the caller remains responsible for the scientific assessment and reviewer independence.

All hashes are 64 lowercase hexadecimal characters. `payload_sha256` hashes the complete unwrapped dataset object, including its `processDataSet` wrapper. `row_sha256` hashes exactly this observed projection, with every field present and original values preserved:

```text
id, version, user_id, state_code, modified_at, json_ordered,
team_id, model_id, model_version, review_id
```

It binds the complete stored body and supported row metadata, not unexposed database columns or derived state outside that projection. `json_ordered` is mandatory; no fallback to `json` is accepted. Embedded Process UUID/version must equal the returned row and requested identity. JSON hashes recursively sort object keys, retain arrays and strings, then SHA-256 UTF-8 `JSON.stringify` without a newline. File hashes cover exact raw bytes instead. These domains are different.

Select regular files up to 8 MiB each. Direct file symlinks, malformed UTF-8/JSON, missing or unsupported fields and changed hashes fail locally. Relative review paths resolve from the root file's directory. Preserve exact locators and bytes when staging evidence, or derive and verify a new selection before use. A previous preparation receipt can inform the selection, but cannot replace the verifier's fresh observations.

## Observation and failure behavior

The CLI verifies the authenticated project and actor, then observes the exact target, the latest state-100 public baseline, the complete owner draft census, and the complete owner review-state census. Every selected-root body GET includes the verified actor and `state_code=0` predicates before transport, including both exact observations and any optional root payload readback. Owner/state drift therefore produces no eligible body instead of fetching an out-of-scope body and rejecting it afterward. The public-baseline body request separately filters state 100; the review census requests only identity/state metadata. Census GETs use `Prefer: count=exact`, ordered versions and the existing pagination completeness checks. Missing totals, malformed/out-of-scope rows, gaps, truncation, duplicates and changing totals block qualification. Reviews are dataset relation rows in states 20–99; the CLI does not query a private review-task table or claim consistency with hidden task records.

After ordinary root/reference checks and any explicitly requested root readback, it repeats the root observations and identity check and rechecks the candidate and both control files. Both observation sets must match the selected before-image and public baseline, including owner, state, payload and row hashes. A new draft or review point, deletion, owner/state change, metadata/body drift or a newer public baseline blocks qualification. Multiple requests are observations under stable membership/order, not an atomic snapshot or a guarantee about future writes.

Only the selected root check can become `ok` through this contract. The report adds `existing_draft_root` input facts; that check retains its original status and latest-version metadata plus `existing_draft_root.applied`, `read_only: true`, `save_ready: false`, the two observation sets and a failure classification. Invalid current observations produce `existing_draft_root_mismatch`; malformed local evidence or identity mismatch fails with a specific CLI error. No passing report is published after detected local-input drift. Use a fresh output directory for every invocation so an earlier report cannot be mistaken for the current result.

`--compare-root-payload`, `--target-user-id` and `--state-code` retain their additional checks. With this qualification selected, those options cannot widen the body request beyond the selected actor/state-0 draft: a conflicting requested owner or state fails against that restricted observation. In particular, comparing a changed candidate to its old stored body still fails. Without root qualification, ordinary optional-readback behavior is unchanged. Reference occurrences retain ordinary policy unless individually covered by the separate [exact-reference intent](exact-reference-intent-contract.md). The reference format still rejects roots; neither option rewrites historical predecessor fields or changes an undeclared reference.

## Isolated caller qualification

Build the exact candidate with the repository's pinned toolchain and frozen lockfile. Obtain its supported `runtime describe --json` output and retain the exact commit, Node executable hash, package/build descriptor and input hashes in the caller's existing handoff. Select that launcher explicitly through the original caller's supported candidate-runtime path; keep installed/default runtime bindings intact.

```sh
/absolute/qualified/node /absolute/candidate/bin/tiangong-lca.js runtime describe --json
/absolute/qualified/node /absolute/candidate/bin/tiangong-lca.js dataset verify-remote \
  --input /absolute/candidate.rows.jsonl \
  --root-policy candidate \
  --existing-draft-root-file /absolute/root-selection.json \
  --out-dir /absolute/new-verification-directory --json
```

Add `--reference-intent-file` only for separately reviewed child occurrences. Restore the original unchanged evidence after a transient read failure and rerun this read-only verification; changed candidate, before-image or baseline requires renewed review and bindings. There is no attempt to consume or replay. Synthetic command tests prove local behavior; original-workflow qualification must separately validate the real wrapper, runtime, current supported read columns and RLS visibility before delivery.
