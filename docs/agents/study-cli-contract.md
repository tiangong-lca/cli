---
title: Study CLI transport and recovery contract
docType: contract
scope: repo
status: active
authoritative: true
owner: cli
language: en
whenToUse:
  - implementing Study commands or installed consumer qualification
  - recovering an unknown Study mutation outcome
whenToUpdate:
  - Study wire versions, codec provenance, commands or request retention change
  - analysis/report/export verification or renderer provenance changes
checkPaths:
  - src/lib/study-*.ts
  - src/cli.ts
  - assets/study-contract/**
  - assets/study-renderer/**
  - test/study-*.test.ts
  - docs/agents/study-cli-contract.md
lastReviewedAt: 2026-11-03
lastReviewedCommit: 3baad6961b148422c1520bd45a55c539fb2d311c
lastReviewedNote: 'CLI #454: repinned clean committed Edge c878457 and Platform a4c0aab owner artifacts. Private verified-byte graph and safe staged publication remain; package 0.1.28 is development source, not public release or actual runtime qualification.'
related:
  - ../../AGENTS.md
  - repo-architecture.md
  - repo-validation.md
---

# Study commands

`tiangong-lca study` adapts Edge's authenticated `lca.study-api.v2` on `app_lca_study`. It does not run a compiler, calculate source/model/input fingerprints, resolve permissions or access Database/Storage directly. The existing Process/LifecycleModel/release commands retain their separate purposes. Core lifecycle selects v2. Analysis/report/export select the independently negotiated v3 contract; no silent downgrade is permitted.

## Commands and inputs

Use `study capabilities`, `create/get/list/resources/archive/select-revision`, `member set`, `model source resolve/get`, `model prepare/get`, `revision create/save/get/freeze`, `scenario create/save/get/freeze`, `run submit/get/cancel`, `task get/wait/cancel`, and `artifact download`. Except capabilities, pass operation fields in `--input <JSON-file>`. Domain fields and typed selectors come from the exact Edge codec. The CLI fills absent schema, request ID and mutation idempotency key; an explicitly supplied conflicting operation/schema is rejected. Do not reconstruct source or model hashes from response wrappers.

For example, `study create --input study-request.json --state-dir /private/study-state --json` consumes a body such as `{"title":"Comparison","scope":{"kind":"personal"}}`. A Study resource read uses its exact issued identifier. Task input is `{studyId,resource:{type,id}}` with the supported typed resource; generic job IDs are not a Study selector. Source resolution returns an acquisition to recover/poll, not an invented synchronous source snapshot. Base preparation selects exact ordered methods/cutoffs; Scenario preparation uses its frozen base semantics. The owner codec and server enforce these domain rules.

Successful machine output has `schemaVersion: tiangong.cli.study.v1`, operation, requestId and `data` containing the validated owner resource. Mutations also return the retained intent file. Artifact output returns a path, byte size and SHA-256 instead of putting base64 file contents on stdout. The existing CLI error envelope exposes stable codes and safe request/recovery identity; it omits provider messages, raw bodies and credentials. HTTP success does not mean a Worker job completed. `task wait` returns an explicit `waiting` marker; failed/cancelled/blocked/stale terminal tasks exit nonzero with the safe task projection.

Use `study analysis request/get/task get/task wait/task cancel`, `study report create/save/get/freeze/resources`, and `study export request/get` for v3. Report authoring passes the owner's closed inline content. Analysis configuration identity is derived only by the contained owner codec; conflicting caller hashes fail. `--api-version 3` selects reporting capabilities/resources/tasks/artifacts explicitly. Recovery selects the exact original schema from its saved request. Reserved v2 P2 shapes remain unavailable; command availability does not claim that a deployment enabled the capability.

## Codec provenance and installation

`assets/study-contract/v2/` and `v3/` are exact copies of the Edge-owned contained ESM/types/schema/license artifact. The loader pins the manifest SHA-256, checks every listed file and imports the verified ESM bytes, closing the pathname check/import race. There is no sibling import, runtime install, remote download, undeclared Zod dependency or use of the package root as a CLI library API. The contained codec retains its own license and source/toolchain inventory.

The bundled wire artifacts pin clean Edge source `c8784576377b4ab156e89dc4eac81014a87880f6` with `sourceStatus: committed`: v2 manifest SHA-256 `6bdde9dcad10f2bfc474dd70f0bf3deb693cb7536137ef827a71fb879d792459`, v3 manifest SHA-256 `983e4b9941e735e060dca3222d16c41018510def509615c94beaa79816e1a960`. The v3 artifact supplies request/response codecs, analysis identity, closed bundle parsing, detached signature verification, canonical receipt bytes and view-to-manifest binding checks. CLI does not duplicate those domain schemas/rules.

These committed owner bytes need no development override. Any future worktree candidate still requires an independently supplied exact digest via `TIANGONG_LCA_STUDY_CONTRACT_CANDIDATE_SHA256` (v2) or `TIANGONG_LCA_STUDY_REPORT_CONTRACT_CANDIDATE_SHA256` (v3), plus an explicit loopback destination. Tests exercise that policy with synthetic candidate metadata rather than mislabelling the clean bundled artifact. A committed codec is source provenance, not hosted API activation, remote permission, signing-key trust or public CLI publication.

The existing package `files` inventory includes `assets/` and `dist/src/`, so built/installed execution resolves the same contained artifact without a source checkout. A package consumer must prove that behavior outside the repository. Skills continues to select a qualified installed CLI through its existing public runtime expectation; this command neither changes global installed selection nor supplies another Skills runtime.

## Authentication and admission

Use the existing CLI OAuth session and official/custom profile selection. Explicit headless tokens remain process-only with an explicit destination/key. No token, password, authorization code or refresh token is accepted as a Study argument. Before domain calls the CLI selects one session and performs the existing bounded live `/auth/v1/user` read for that exact token. Its actor ID is server-observed. Only after this successful read does the CLI read the token's public subject/client metadata to bind recovery; that metadata alone is neither authentication nor a permission grant. OAuth sessions must retain the configured client identity; headless recovery binds the actual token client identity when present. Rotation within the same actor/client scope remains possible.

Domain POSTs send `x-study-schema` equal to the request schema so pre-body auth/transport errors retain the selected version. All Study authentication/domain traffic rejects redirects and shares a bounded operation deadline; Auth response bytes are bounded separately from Study responses. A non-TLS destination is permitted only for an explicitly selected literal loopback host. The high-level auth identity receipt's canonical Production/project restrictions remain unchanged; this module only reuses its internal bounded current-user reader for an explicit task fixture.

Authenticated capability read precedes an ordinary domain operation. The selected runtime must admit the operation and any requested exact profile/calculation identity. This check is advisory admission discovery, not a cached permission: Edge/Database reauthorize the actual operation. Package installation, a parsed schema or an existing token never grants `STUDY-READ-01/WRITE-01`, enables runtime flags, or authorizes a source. Task-fixture client grants and activation are separately owner-controlled; no Production/global grant changes belong here.

## Pre-dispatch intent and recovery

Every mutation publishes an immutable private `tiangong.cli.study-intent.v1` file **before** its first domain dispatch. It contains the complete canonical request and key, request-byte digest and live actor/client/endpoint binding. This canonicalization identifies local transport bytes only; it is not a source/model/calculation fingerprint or a signed authorization record. File publication uses an exclusive temporary file, flush, and non-overwriting link in a private per-intent directory. The original request file is never rewritten.

The default location follows the existing per-user CLI state root, under `study/v2/<binding-operation-key-hash>/intent.json` or the independently scoped `study/v3/` directory; `--state-dir` selects another retained private root. Existing same-key intent requires explicit recovery; changed request bytes under that identity are rejected. Per-directory public batch locks serialize dispatch/recovery, without using the batch engine's mutation-retry policy. No transport failure automatically retries a mutation or invents another key.

After a lost response or process interruption, run `study request recover --intent-file <saved-file>`. The CLI checks private-file shape/digest/path, preserves its complete request, verifies the current destination and live actor/client binding, negotiates current availability, then submits the exact original request/key through the owner's idempotent receipt/recovery path. It does not return cached success, suppress current authorization checks, reset an unknown outcome, or reconstruct scope from provider text. Server receipt replay owns the terminal result and prevents a second logical job. A revoked grant or unavailable deployment remains an explicit failure and the original intent is retained.

These files are confidential process-recovery state, not permission evidence or tamper-proof receipts against their filesystem owner. They contain no auth credentials. User output files and retained request intents are not disposable download caches; no new cleanup/prune command deletes them. Existing runtime cache pruning does not own these files. Unit fixtures clean only their own temporary directories; actual account/source/job cleanup remains coordinated with the task environment owner.

## Artifacts and proof limits

Core artifact reads accept only exact typed descriptors and current authorized `modelInput/runResult` bytes. The CLI verifies canonical base64, requested Study/descriptor, byte count and SHA-256 before private atomic publication. The 4 MiB server byte limit is enforced; larger artifacts cannot use unchecked URLs or truncation. Output overwrites require `--force`; normal publication never replaces a competing existing file. `modelSource` packets and service locators/authorization metadata cannot become user downloads. Known credentials are rejected even if maliciously placed in a returned artifact.

## Detached HTML export

`study export download --input artifact-request.json --output-dir report --anchors trusted-keys.json --expected selected-export.json` downloads an exact authorized `reportExportBundle`. `expected` is an independent closed selection `{issuerId,exportId,studyId,reportRevisionId,reportContentHash}`; anchors are independently configured issuer keys and renderer archive hashes. Neither trust input may come from the untrusted export. A signature alone never implies current access, current review, or scientific suitability.

The owner codec parses the closed bundle and verifies every signed path/hash/size, receipt and independent selection. CLI then validates the projection through the exact fixed W10 renderer, checks owner view bindings, re-renders with the signed projection hash/export ID, and requires byte-identical HTML. No report selects an import path. `assets/study-renderer/v1/` retains the immutable TGZ and exact unpacked file inventory; CLI verifies archive, manifest and every regular realpath file at invocation. It captures the verified complete JavaScript graph in private memory and loads those exact bytes through temporary Node 24 synchronous module hooks under a unique private scheme. Relative imports are limited to that captured graph; filesystem, built-in, bare and network dependencies are rejected. Hooks are removed after graph evaluation, and no mutable package file URL is executed. Renderer `artifactHash` is the TGZ bytes SHA-256, distinct from source/manifest hashes.

The bundled renderer pins clean Platform source `a4c0aabdb5a7df4ca8bec61341f81dafdfc674e1`, `sourceDirty: false`: archive SHA-256 `0eeb0ff800efed0936c221c5d68603c46d5362ff3aa1b36051c4308610a1f885`, manifest SHA-256 `be659faa2869edfe1bca735e1509f7118c44a6312c8dbef143ff461bdc6c85bd`. All 17 manifest-listed files and the manifest itself match the 18 regular archive members. The graph includes generated `documentLanguage.js`, preserving the owner locale registry without app-shell runtime imports. Clean bundled verification needs no candidate environment flag. Future dirty artifacts still require exact independent `TIANGONG_LCA_STUDY_RENDERER_CANDIDATE_SHA256` and an explicit loopback destination.

CLI package version remains `0.1.28` for this development source. A task-local tarball/installation binds its exact source commit, bytes and runtime expectation; it must not be identified with the already published version merely by this version string. Public release/provenance, actual runtime acceptance and workspace integration remain separate.

Only after all checks does CLI write exact `report.html`, `projection.json`, original `export-manifest.json` bytes and canonical `export-receipt.json` into a private sibling staging directory. Each file is written through its exclusive handle and flushed/closed before one directory rename publishes the group. No write or rollback uses the final output pathname, so replacing that final entry cannot redirect writes or delete unrelated files. Observed existing targets are refused; a racing symlink or nonempty directory causes rename failure. Failed stages are deliberately retained with `STUDY_OUTPUT_WRITE_FAILED` details `stagingDirectory` and `stagingDisposition: retained-inspect-before-cleanup`; they are not cache-pruned or automatically deleted. `stagingIdentity: unverified-after-failure` explicitly means the diagnostic pathname is not cleanup authority; inspect actual ownership before any later removal. Node has no portable atomic directory no-replace primitive: a concurrently created empty directory may be replaced on POSIX. Publication assumes a trusted local parent; it does not promise protection against an adversarial same-UID actor mutating private staging/ancestor paths. Local owners may change outputs after publication, and verification must be repeated when authenticity matters. Bundle bytes are bounded at 4 MiB; no truncation or unchecked locator is permitted.

`study export verify --directory report --anchors ... --expected ...` (or `--bundle bundle.json`) repeats all checks without any Auth/network call. Output states detached authenticity/renderer consistency and explicitly `currentAccess/currentReview: not-checked-offline`. Opening HTML offline needs no CLI; authenticity is established by the separate verifier. Edited HTML must fail verification.

Focused tests use the actual contained codec and CLI/auth/transport/filesystem with synthetic HTTP. They test immutable pre-dispatch state, exact-key restart recovery, actor/client/environment drift, codec/capability refusal, scoped tasks, byte-verified downloads and private error/output boundaries. They do not establish real GoTrue signatures, Database grants, native Worker execution, released signing-service/renderer trust, hosted deployment or business LCIA qualification. W07 remains open until the hard gate, installed real task-owned end-to-end chain, released owner artifact and independently qualified P2 runtime integrations pass.
