# Product/Waste extension execution evidence

This continuation of #374 / PR #441 expands the existing opt-in Agent profile from Product-only targets to Product and Waste. Elementary remains excluded. Each coverage query binds the exact type of its snapshots and remote reads; at least one query covers the target type. Additional typed queries retain original cross-type comparison evidence, while reuse requires the same target type. Artifact schemas, Product normalization, host pins and the existing ledger remain unchanged.

[Actual full gate output](waste-extension-prepush.txt) is a byte-identical copy of retained stdout screened for private paths, account identities, dataset UUIDs and credentials. It records `pnpm prepush:gate` under verified Node 24.19.0 / pnpm 11.24.0: 12 package passes; 1,926 source tests, 1,917 passed, 9 existing platform skips, zero failures; 100% statements, branches, functions and lines. The output includes the real-SDK public Waste family and hybrid prepare/save paths, exact query/response type fences, wrong-type and Elementary rejection, expired consumed and lost-response recovery, Product and legacy regression tests.

An independent non-author review found no material defect and ran the 116 focused tests present at that point; it separately checked and executed the subsequently added successful public Waste hybrid test. The complete gate then covered all 117 focused tests as part of the repository suite. These are synthetic transport checks, not production fault injection or scientific approval of actual datasets.

The successful gate ran before the extension commit on the following exact source/test bytes. Retained stdout does not itself attest Git HEAD. Installed-package qualification, original DATA validation and final pre-submission freshness checks remain separate evidence stages.

| Artifact | SHA-256 |
| --- | --- |
| `src/cli.ts` | `dfa841febbdf18bb516eb52130079d74dc9fe63f5905a0ed96d3ae0f65c2fc01` |
| `src/lib/flow-identity-admission.ts` | `45aa08da2f8153c0f2600ef64a6883d09549e9bf9654d2ae9e216588c9945769` |
| `src/lib/flow-identity-admission-remote.ts` | `96875ae5b1b2ba6b0b755c695ffb532199be68244ba2ea4609ee1cba4a75a84a` |
| `test/dataset-save-draft-identity-admission.test.ts` | `ef543e2b1953b1fa2536d3004af428528dd62c44ae2a5ded1e11267da5676d2e` |
| `test/flow-identity-admission.test.ts` | `6e9082d4462cac14afb1c688869df077cf57c9417526e9c0aae0a1f815f95e26` |
| `test/flow-identity-admission-remote.test.ts` | `2035c5aead03a0146761dba7d0af4b0835d76a3bb5c5657475093156e307955a` |
| `test/helpers/flow-identity-admission-fixture.ts` | `1311ee6861c6b0530a72ddf7c49d28ce5d8cace263a9caa6a8c00add960dba29` |
| `waste-extension-prepush.txt` | `cc10b841ed20153591e6a65acf131c04f3bb2d1d9df869fe61184e6649341521` |
