# Stable owner draft preparation evidence

Historical source candidate: `d053d6dcac55f7bfa8a089344c37ee0bc9075ad9`, based on canonical `main` at `2b2eba10c68ff66d8f018b551c6c9b853a85267f`. Related: [CLI #372](https://github.com/tiangong-lca/cli/issues/372), [Database #855](https://github.com/tiangong-lca/database/issues/855), [Edge #500](https://github.com/tiangong-lca/edge-functions/issues/500).

`dataset prepare-draft` observes one typed UUID under the authenticated owner. It returns a complete draft and review census, selects the unique existing draft or an explicit reviewed conflict choice, and never guesses a successor version. Explicit preparation delegates creation and request recovery to the Database contract through Edge. An owner review in states 20–99 blocks preparation and returns its exact review identity. Lost responses and consumed attempts permit only original-request lookup.

The initial-family policy, native Model/result groups, Elementary/LCIA changes and global uniqueness for excluded Model/Elementary-only paths remain outside this slice. It does not close all of #372. The new backend must be separately deployed and qualified before production preparation can be used; the ordinary read-only command requires only existing relation reads.

## Current UTF-8 repair and acceptance

Current product commit: `fd12bf27ee691d86571df585ff99c4513eeb1695`. Hosted review revision 5 confirmed the two earlier preparation findings resolved and identified malformed UTF-8 normalization in offline binding. The shared capture owner now retains raw buffers, hashes those exact bytes, rejects malformed UTF-8 before JSON parsing and compares raw buffers before patching and after awaited application. This covers proposal, preparation report, predecessor and optional semantic context inputs. Valid multibyte text and intentional U+FFFD remain intact; existing leading-BOM and JSON rejection behavior is preserved. Other preparation/recovery and SDK implementation bytes are unchanged from the historical accepted 7a candidate.

- [Retained fd12 full gate](utf8-follow-up/full-gate.txt): 12 package tests and 1,855 source tests passed, 9 existing platform skips, zero failures, and all four source coverage measures 100%, on Node 24.19.0 / pnpm 11.24.0. Only local absolute paths are redacted.
- [Installed public-bin UTF-8 proof](utf8-follow-up/native-regressions.json): 17 isolated synthetic cases: one valid multibyte/U+FFFD binding with exact input-byte hashes and unchanged scientific projection, eight malformed-input rejections, four raw-byte-drift rejections and four BOM rejections. There were zero network attempts or database access. Drift was intentionally injected into synthetic copies immediately after capture; focused source tests additionally cover drift after awaited patch application.
- Non-author review independently passed 15 focused tests and found zero remaining material issues in this repair. This is separate from hosted re-review.
- [Root acceptance summary](utf8-follow-up/original-workflow-summary.json): An independent original-data validator qualified the installed runtime and ran 23 offline public-CLI checks. The two positive examples were explicitly **original-derived isolated examples**: only version/URI were reversed and an exact predecessor composed for the binding input; scientific values and Flow bodies were unchanged. These were not unchanged positive originals or fresh online target observations. The other checks were eight malformed-input rejections, eight raw-drift rejections, four BOM rejections and one rejection of an actual unchanged zero-target original. Original bytes were preserved, with no network, credential use or remote writes.

Current runtime content SHA-256: `3c8e97aa7322b8decbd8af98bc24e5c8761638e0bc7bffc31e5696669ef046e5`; packed archive SHA-256: `889d842f9a5a67c6a8613a4d66f8a7c8dc0f4cbea93dc210444d7569b6ddc785`. The independent validator checked 600 archive files, 1,754 dependency files and 32 internal links. Root inspected the production diff and verified 26 delivery facts and 13 report bindings before accepting. Package version remains 0.1.28, an unreleased source candidate. This evidence-only update preserves the accepted candidate.

Root explicitly reused the prior 7a actual read-only selection, recovery and SDK evidence after checking source and packaged-byte equality for the unaffected paths. That is historical evidence reuse, not a fresh state observation. Root accepted fd12 for the existing PR update only. Production target availability and positive save qualification remain absent; there is no backend adoption, default-runtime switch, merge or release acceptance. Exact new-head hosted CI and review results must be read separately in the PR.

## Historical 7a review repair and acceptance

The [hosted review](https://github.com/tiangong-lca/cli/pull/442#issuecomment-6298520690) identified two additional P2 defects at the previously published head: report/target publication could replace a frozen input, and a valid preparation POST receipt was discarded before a failed lookup. Historical d053 tests and earlier green platform checks do not prove these counterexamples.

The historical accepted repair is product commit `7a81eb1eed13176cd8197cca00fdd8695f627439`. It compares exact bigint device/inode identity for the frozen input and writable report/target paths before transport/claim, after awaited work and before publication. This catches case-insensitive names and symlink-parent aliases without lossy numeric conversion or blanket case folding. Same-inode hardlinks are conservatively rejected; normal `request.json` reuse remains supported. The intermediate realpath-only candidate was superseded after a real macOS counterexample.

A validated POST receipt is retained before recovery. Failed/malformed lookup preserves historical evidence while current target stays null and `save_ready=false`; an individually valid but contradictory lookup cannot replace the known receipt. Only the contextual `replayed` flag may differ. Reports remain mutable current observations; this does not introduce a cross-invocation trusted receipt cache.

- [Full local gate](review-follow-up/full-gate.txt): 1,851 source tests passed, 9 existing platform skips, all four source coverage measures 100%; Node 24.19.0 / pnpm 11.24.0. Paths in this retained log are redacted; results are unchanged.
- [Installed native regressions](review-follow-up/native-regressions.json): 14 alias cases with zero CLI auth/relation/command traffic and unchanged input; two real valid-POST/failed-lookup cases retain a receipt independently compared with PostgreSQL. Recovery issues no repeated prepare. Native domain rows remain unchanged during reuse checks.
- Non-author final source review found no remaining material issue in the scoped repair and independently ran 41 focused tests. This is separate from hosted re-review.
- [Original-workflow acceptance](review-follow-up/original-workflow-summary.json): the new installed runtime was independently qualified and re-executed through the original role-scoped entry. Live zero/unique-draft, actual frozen-input preservation, negative binding and native proposal validation passed with zero remote mutation. Real IDs, bodies, data digests and private execution paths are omitted from this summary.

Historical 7a runtime content SHA-256: `c9be1d28e7230c2da26a2194fdd1577e2988b2168fd6ab6766e2b8678f53550e`; packed archive SHA-256: `fd79920089c22eddbdcb97130fc3d4401d3ac097ec6043aff87e1d81dceac823`. The frozen dependency graph is unchanged. These retained records were generated for 7a; the fd12 UTF-8 follow-up above has its own runtime qualification. Hosted results, including Windows alternate streams, must be read separately in the PR; earlier platform success is not new-head proof. Backend adoption and positive production writes remain unqualified.

## Historical d053 recorded checks

| Evidence | Observed result |
| --- | --- |
| [Canonical full gate](prepush.txt) | 12 package tests; 1,839 source tests passed, 9 existing platform skips, no failures. Source statements, branches, functions and lines all 100%. |
| [Installed CLI → actual Edge → local PostgreSQL integration](local-integration.json) | One real prepare POST, one draft and one receipt despite a deliberately lost success response; two read-only lookups, no save. Reusing the original request from another output directory emitted no additional prepare. |
| Review-family integration branch | No new draft; exact review conflict returned with zero dispatch. |
| Offline binding integration | Exact assigned identity and reviewed predecessor were bound without changing the scientific projection. Semantic Flow documents were preserved and only their candidate binding changed. `save_ready=false`. |
| [Independent Spec regression execution](independent-spec-tests.txt) | Nine focused tests passed after correcting two P2 findings. Frozen draft→review transitions retain review return points; unavailable/currently excluded targets retain the validated original receipt without becoming ready. Invalid receipts remain rejected. |
| Independent Standards review | No remaining material documented-standard violations; final Spec review also reports none. These are local non-author reviews, not hosted review-bot execution. |
| [Original-workflow acceptance](original-workflow-summary.json) | Independent native live read-only zero-draft and one-draft branches passed with zero writes/attempts. A missing-target bind was rejected. A bound real Process proposal passed native four-layer and allocation validation with the candidate dependencies. |

The local integration used real authenticated Edge handlers and actual PostgreSQL command functions. Two external network-only Process AFTER webhooks were temporarily disabled in that disposable fixture and restored; admission, JSON, lifecycle and review guards remained enabled. This proves the scoped preparation/binding path, not derivative execution or scientific acceptance. Database's separate real concurrent-session and populated-upgrade proofs are in its companion change.

The original-workflow summary deliberately omits real account/dataset identifiers, bodies and private execution files. Public-source ownership and current-owner draft ownership are distinct: one qualified case reused a draft owned by the editor from a public source owned by another account, without changing either owner. The observed production sources were state 100; no state-200/commercial authority is inferred.

## Historical d053 runtime binding

The isolated package retains version `0.1.28`; it is a source candidate, not a release or a default-runtime replacement.

- CLI runtime content SHA-256: `bdadf02e73076f9da5a1dd24ecbe7445469e5c71cc51017b0a44525a7f6e0ca2`
- Packed archive SHA-256: `0e28dbc2566b45d837ca608e5e124579f9bb4af624bef6c50d16d3569deac1e9`
- Node: `24.19.0`; pnpm: `11.24.0`
- Frozen dependencies include TIDAS SDK `0.5.1`, Supabase JS `2.118.0` and Zod `4.4.3`. The original maintenance installation uses Zod `4.6.7` and was left unchanged; the actual candidate combination was independently revalidated rather than assumed equivalent.

Independent qualification checked the packed file membership/bytes, all 15 production packages and 1,754 dependency files, 32 internal links, the trusted Node executable and the public runtime assertion. Evidence-only commits preserved those historical runtime bytes; the later review repair below has its own separately qualified runtime. Final preflight receipts bind the actual submitted commit and freshly fetched base; they supplement these recorded outputs.

## Reproduction and limits

```sh
pnpm install --frozen-lockfile
pnpm build
node --import tsx --test test/dataset-prepare-draft.test.ts test/dataset-prepare-draft-bind.test.ts
pnpm prepush:gate
scripts/docpact-gate.sh --base origin/main
```

The checked-in tests contain synthetic counterexamples, including actual public-bin invocation and transport counts. Read-only original-workflow qualification does not prove a production successor exists. Positive creation, recovery and binding remain local integration evidence until the backend and a separately admitted data operation are qualified.

Offline `prepare-draft bind` preserves the typed UUID and scientific projection while changing only the actual version, permanent URI and explicitly reviewed exact published predecessor. It can preserve a valid review bound to the same scientific proposal; identity rebinding alone does not require another full scientific review. It does not infer that review passed or suppress native schema/reference/owner/state/preimage failures. All outputs remain `save_ready=false`.

[Evidence index](evidence-index.json) records the retained source revision, review outcome and file hashes. Local path redactions are stated there; no test outcome was relabeled as production adoption.
