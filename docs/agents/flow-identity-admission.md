---
lastReviewedAt: 2026-10-20
lastReviewedCommit: 2b2eba10c68ff66d8f018b551c6c9b853a85267f
title: Scoped Flow Identity Admission
docType: contract
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - when preparing or consuming an explicitly reviewed new Product or Waste Flow identity
whenToUpdate:
  - when the scoped review, coverage, execution or recovery contract changes
checkPaths:
  - src/lib/flow-identity-admission.ts
  - src/lib/flow-identity-admission-remote.ts
  - src/lib/dataset-save-draft-run.ts
  - test/flow-identity-admission.test.ts
  - test/flow-identity-admission-remote.test.ts
  - test/dataset-save-draft-identity-admission.test.ts
  - docs/agents/flow-identity-admission.md
related:
  - repo-architecture.md
  - repo-validation.md
  - exact-reference-intent-contract.md
---

# Scoped Flow identity admission

`flow identity-admission prepare` binds an actual Agent review, its standing authorization evidence, a complete saved preflight and bounded candidate observations to one new Product or Waste Flow owner-draft insert. The selected `dataset save-draft` v2 profile consumes that evidence with an independently pinned contract hash and fresh checks before dispatch. It uses the existing authenticated writer and action ledger.

This is an explicit partial implementation of [CLI #374](https://github.com/tiangong-lca/cli/issues/374). Existing preflight, build-plan, v1/no-contract save and independent Process save behavior remain unchanged. It does not enforce identity policy across all clients, authenticate human reviewers, establish global catalogue uniqueness, or grant account/publication permissions.

## Trust and responsibility

The original calling host selects the exact operation, establishes the applicability of standing authorization, verifies the actual Agent review provenance and pins the generated contract's raw SHA-256 outside the mutable input package. The CLI verifies the selected files, full content, scope and current deterministic conditions. An authorization file or client boolean is not a new permission grant.

Record the Agent who actually makes the scoped identity verdict. A scientific report reused as supporting evidence keeps its real author and time; do not relabel it as a fresh human review. If a host adopts unchanged scientific findings after a bounded metadata correction, the scoped verdict must cite the original report and the actual delta/adoption evidence. The new verdict's reviewer and timestamp describe that actual adoption, not a fabricated rerun of the original scientific review.

Local hashes prove content integrity, not the truth of prose, an authenticated reviewer signature or resistance to an operator who replaces the trusted host record itself. The CLI does not interpret personal policy clause names. Each caller supplies explicit unique clause identifiers and keeps authority applicability with its existing owner.

## Prepare and select

```bash
tiangong-lca flow identity-admission prepare \
  --input preflight.request.json \
  --preflight identity-decision.json \
  --review identity-review.json \
  --coverage identity-coverage.json \
  --execution-contract insert-template.json \
  --out-dir ./new-admission --json
```

All preparation is offline. The input is exactly `{ "target": <complete Flow body>, "candidates": [<complete bodies>] }`; dynamic remote/file candidate options are unsupported here. Preparation verifies the saved report against those complete inputs and the current preflight rules. Only a schema-valid target with `manual_review`, no hard duplicate/schema blockers and an intact embedded candidate source can enter this profile. Historical candidates retain their complete original bodies even when they fail the current SDK schema; that never makes a new target schema-valid.

The template is a strict `dataset-save-draft-execution-contract.v1` with exactly one `flows` action: `expected_operation=insert`, `before_sha256=null`, no dependencies, fixed action/UUID/version/desired hash and one state-0 owner/project. It is not executed during prepare.

The owner email must already be lowercase with no edge whitespace, and `action_id` must have no edge whitespace. Preparation rejects these non-normalized values before creating artifacts, rather than emitting a pinned contract whose save consumer would normalize and reject its owner or action binding.

The output directory must be new and its parent must already exist. Files are created privately with exclusive creation and fsync:

- `create_distinct`: `identity-admission.json` and `execution-contract.json`, with their raw file hashes in the JSON result.
- `reuse`: `identity-reuse.json`, `status=no_new_insert`, the exact existing UUID/version and no executable insert contract.

The prepared receipt has `status=prepared_for_recheck`. It is not evidence that remote admission has already passed.

After the original host independently records the returned contract hash:

```bash
tiangong-lca dataset save-draft --type flow --input complete-flow.jsonl \
  --execution-contract ./new-admission/execution-contract.json \
  --execution-contract-sha256 <original-host-pinned-raw-sha256> \
  --dry-run --out-dir ./identity-preflight --json
```

The nominated writer uses the same input, contract and original hash with `--commit` only under its existing authority. Do not compute a replacement expected hash from a changed file and call it the original pin. A hash option cannot select v1; v2 without the hash, with raw in-memory rows, or with parallelism above one is rejected.

## File and hash domains

A file fact is exactly `{ "path": "...", "sha256": "<64 lowercase hex>", "bytes": <positive integer> }`. Relative evidence paths resolve from their declaring review/receipt file. Loaded facts become absolute and are rechecked before dispatch. Control files and evidence are bounded regular UTF-8 files; symlinks and unsupported file types are rejected.

Raw file hashes include whitespace and formatting. Payload hashes use the existing canonical parsed-JSON algorithm: sort object keys recursively, preserve array order and values, serialize without a trailing newline, then SHA-256. Hash the entire unwrapped `flowDataSet` payload. Changing formatting of a bound control file invalidates its raw pin even if its parsed value is equal.

## Review shape

`flow-identity-review.v1` requires exactly these fields:

| Field | Required value |
| --- | --- |
| `schema_version` | `flow-identity-review.v1` |
| `decision` | `create_distinct` or `reuse` |
| `target` | `{id, version, payload_sha256}` for the complete new Flow |
| `preflight` | `{input: FileFact, report: FileFact}` |
| `reviewer` | `{kind: "agent", source_host_thread_id, agent_id, reviewed_at_utc, report: FileFact}` |
| `authorization` | `{principles: FileFact, authorization_chain: FileFact[], assignment: FileFact, clauses: string[], scope: string}` |
| `adopted_by` | `{host_thread_id, evidence: FileFact}` |
| `scope` | `{project_ref, owner_user_id, target_mode: "owner_draft", operation: "insert"}` |
| `candidate_decisions` | One exact decision per discovered candidate, described below |
| `coverage` | `{file: FileFact, sufficiency_reason: string, limitations: string[]}` |
| `validity` | `{reviewed_at_utc, expires_at_utc}` |
| `reuse_identity` | `null` for distinct; `{id, version}` for reuse |

Each candidate decision is exactly `{id, version, payload_sha256, decision, reason, evidence: FileFact[]}`. Its decision is `distinct`, `reuse`, or `not_applicable`. Every original preflight candidate must remain present and cannot be excluded as `not_applicable`. Other discovered candidates require an explicit reason and evidence for their disposition. Reuse must select exactly one reviewed existing identity; distinct cannot contain a reuse verdict.

All arrays of authority/evidence are nonempty. Clause identifiers are unique, bounded identifiers rather than hardcoded policy names. Review limitations must exactly match the bound coverage limitations. Reviewer and validity review times agree; a review cannot precede its preflight or coverage observations. The expiry must be later than review and no more than 24 hours later. Preparation and unconsumed saves reject future-dated or expired reviews.

The synthetic fixture and public tests in `test/helpers/flow-identity-admission-fixture.ts` and `test/dataset-save-draft-identity-admission.test.ts` demonstrate complete executable examples. Their fictional actor, authorization and review files are test inputs, never live authority.

## Coverage shape and supported reads

`flow-identity-coverage.v1` is exactly:

```json
{
  "schema_version": "flow-identity-coverage.v1",
  "scope": "bounded_visible_search",
  "project_ref": "<exact project>",
  "observed_at_utc": "<UTC ISO time with milliseconds>",
  "limitations": ["<explicit limits of the searched catalogue>"],
  "queries": ["<one to twenty query objects below>"]
}
```

The example uses placeholders. Each query carries `snapshots`, an array of complete `{id, version, user_id, state_code, payload}` objects. `payload` is the original complete Product or Waste Flow body. Matching exact identities across queries must have identical owner/state/body; duplicates within a query are rejected. The total union is bounded to 1,000 candidates.

Every snapshot must match its own query's exact type, and fresh responses must satisfy the same type fence. At least one query must match the complete target's type; an empty result is still a bounded observation. Additional typed queries can retain original comparison candidates of the other supported type. Original candidates still require a complete-body decision and cannot be silently omitted or marked `not_applicable`. A reuse verdict can select only the target's same type. Elementary targets, queries and native comparison snapshots remain excluded.

Either supported adapter can provide target-type coverage; a hybrid search is not newly mandatory for Waste. The actual Agent review must justify bounded coverage sufficiency and adopt its limitations. The existing complete-body hashes already bind type, so Product receipts, coverage serialization, v2 action bindings and consumed-operation recovery retain their original formats. An older Product-only runtime rejects Waste preparation; use a separately qualified candidate without replacing an earlier consumed operation's runtime or evidence.

Two adapters are supported:

| Kind | Exact query fields in addition to `kind` and `snapshots` |
| --- | --- |
| `flow_family` | `visibility` (`"public"` or `"owner_draft"`), `ids: string[]` (1–50 unique UUIDs), `type_of_dataset` (`"Product flow"` or `"Waste flow"`) |
| `flow_hybrid_search` | `query`, `filter` with exact `flowType` (`"Product flow"` or `"Waste flow"`) and `asInput: false`, `data_source: "tg"`, `match_count`, `page_size`, `match_threshold`, `lexical_weight`, `semantic_weight`, `rrf_k`, `total_count` (number or null) |

Family scans send exact IDs and the query's exact Product/Waste type filter before reading, plus public `state_code >= 100 AND < 200`, or current owner `state_code=0`. The existing exact-count paginator verifies ordered membership and every complete page; response caps cannot silently skip rows.

The supported hybrid source is the existing public `tg` raw latest route, which searches state 100. Its exact `flowType` is Product or Waste; `asInput: false` leaves the existing Emissions exclusion inactive and is not a direction selector. Each exact-body hydration repeats that query's type and public visibility fence; a server that returns another type is rejected. All query parameters are explicit and bound: `match_count` is 1–100, `page_size` 1–100, threshold and weights 0–1 with positive combined weight, and `rrf_k` 1–1,000. Values 101–200 fail locally before authentication or search; the matched-version route's separate 200-candidate contract is not selected by this profile. `match_count` is a candidate budget, not the final result limit: the latest implementation uses `max(match_count, page_size)` to size its candidate branches, while `page_size` limits the output page. Only its original first-page bounded results are accepted. Known total counts that imply unhandled pagination are rejected; unknown totals remain explicitly unknown. Do not claim a bounded search exhausts the catalogue. The `my` hybrid source and unknown filters/options are unsupported, rather than being sent and assumed effective.

Hybrid membership is compared by exact identity, independent of ranking/score. Every result is hydrated through a publicly fenced exact body read with exact-count proof. Missing, duplicate, newly matching, changed-body, owner/state/version or hidden results invalidate the receipt. Family checks can see new versions only within the selected family IDs; no adapter promises global uniqueness or transaction-level catalogue snapshot isolation.

Every core relation GET/HEAD made through the new save profile, including reference and target reads, also receives the public-or-own-draft scope before dispatch. Existing query restrictions remain ANDed with that scope. Auth identity is checked against the contract owner/project. Remote response error bodies and arbitrary transport exception text are excluded from new-profile CLI/report errors.

## Receipt, v2 contract and observations

The receipt is `flow-identity-admission.v1`, profile `flow-identity-admitted-insert.v1`. It binds the target, owner/project, static action-core hash, input/preflight/review/coverage file facts, issuer CLI version/ruleset and validity. Its action-core hash excludes receipt/contract hashes to avoid circular binding.

Prepare emits `dataset-save-draft-execution-contract.v2`. It keeps the template's known fields and adds:

```json
{
  "profile": "flow-identity-admitted-insert.v1",
  "actions": [
    {
      "identity_admission": {
        "schema_version": "flow-identity-admission.v1",
        "receipt": { "path": "<receipt>", "sha256": "<raw sha256>", "bytes": 123 }
      }
    }
  ]
}
```

This is an excerpt, not a complete contract. V2 uses strict required keys and cannot silently drop admission fields like the legacy v1 parser. Only one independent Product or Waste Flow insert is supported. Existing exact-reference intent can be selected separately and must also pass.

The v2 action binding includes static action fields, profile-selected receipt and the externally fixed raw contract hash. Actual current observation time does not enter the action identity. A passed fresh check records a separate `identity_observation` with observed time, normalized coverage hash, query/candidate counts and bounded scope. The row report and original attempt/outcome retain that observation together with the static `identity_admission` summary. The summary's coverage hash binds raw coverage-file bytes; the observation's coverage hash binds the parsed normalized coverage, a deliberately separate hash domain.

## Dispatch, concurrency and recovery

Static file/contract bindings and live actor/project are checked before loading the original ledger. An already consumed action enters readback recovery before any new expiry or coverage admission; expiry never grants a new attempt or blocks matching historical readback. Recovery requires the original qualified runtime and evidence. A different CLI/SDK ruleset cannot reinterpret a consumed receipt as fresh admission.

An unconsumed action rechecks complete current coverage, the target's absence, references, owner and actual current time. The transport awaits immediate pre-dispatch checks, including input/receipt bytes and a new coverage observation. The clock is sampled again after awaited work; the entry's report timestamp is not the expiry clock.

V2 commits hold the existing batch operation lock around ledger load, dispatch and terminal readback. The lock path derives from the existing action ledger, and distinct invocations cannot inherit reentrant lock ownership. A busy invocation fails without mutation. Its ephemeral invocation token is not an action, receipt or replay identity. This prevents concurrent recovery from appending a terminal outcome while the original request is still pending.

The existing exclusive first attempt creation and fsync precede the single mutation. The action ID, desired hash and owner ledger addressing remain unchanged; receipt, time and output directory do not create new attempts. V2 events bind admission and observation; outcomes and recovery retain the original observation. V1 runtime/event parsing cannot downgrade a consumed v2 operation. A historical v1 attempt cannot acquire a new identity receipt retroactively.

Lost responses are resolved only by exact current owner/state/body readback of the original attempt. Terminal UNKNOWN never replays. Do not replace the contract, action, target or host pin to escape a consumed operation. The original host pin is essential before the first attempt: without it, purely local files cannot prove which earlier prepared receipt an operator discarded. Cross-channel enforcement against such replacement is outside this profile.

## Required proof

Run the focused admission suites through the actual public parser and real SDK, then the canonical `pnpm prepush:gate` and Docpact gate. Cover both SDK-valid Product and Waste targets; matching family/hybrid filters, wrong-type snapshots/responses, missing target-type coverage, retained cross-type originals and same-type-only reuse; Elementary rejection; malformed contracts, full-content and scope drift, unsupported queries, legacy behavior, expiry during awaited checks, pre-dispatch zero mutation, concurrent/nested invocation, ledger integrity, error redaction, lost responses and expired consumed recovery.

Packed-candidate qualification records the exact runtime descriptor, dependencies, source and artifact hashes separately from publication. The original independent DATA verifier must select that exact candidate through its real entry and verify the unchanged task inputs and native save/readback. Synthetic transport tests and local review cannot substitute for that evidence.
