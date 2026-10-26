# Historical execution evidence for PR #441

Reviewed source: `f18f94f3ce2b6e9d6877b79c03ae521af8b2ca7f`, canonical base `2b2eba10c68ff66d8f018b551c6c9b853a85267f` (`tiangong-lca/cli:main`). These retained outputs predate the subsequent PR-review correction. They prove execution at historical f18; they do not qualify a later HEAD.

## Inspectable outputs

These are actual retained execution outputs, including individual test results, timings, failures/skips and coverage, rather than reconstructed counts:

- [Full canonical gate](f18-prepush.txt): 12 package tests passed; 1,902 source tests, 1,893 passed, 9 platform skips, zero failures; final source coverage assertion passed at 100% statements, branches, functions and lines.
- [Installed packed-candidate focused suites](f18-packed-focused.txt): all 93 tests passed against the isolated emitted package.
- [Docpact enforced lint result](f18-docpact.txt) and [strict configuration result](f18-docpact-config.txt): status `ok`, no diagnostics/problems, tool version `0.1.9`.

The legacy and recovery behavior is inspectable within the complete outputs:

| Exercised behavior | Actual passing result |
| --- | --- |
| Legacy contract ordered insert/update and terminal skip | [Full gate line 872](f18-prepush.txt#L872) |
| Legacy orphan-attempt/readback-failure recovery without replay | [Full gate line 884](f18-prepush.txt#L884) |
| v2 host pin required; v1 refuses v2-only option | [Packed line 13](f18-packed-focused.txt#L13) |
| Lost response before/after write; readback-only recovery | [Packed lines 14–15](f18-packed-focused.txt#L14) |
| Consumed operation cannot downgrade by omitting the profile | [Packed line 23](f18-packed-focused.txt#L23) |
| Consumed dry-run retains evidence without reads/mutation | [Packed line 27](f18-packed-focused.txt#L27) |
| Consumed v1 cannot retrofit v2 admission | [Packed line 46](f18-packed-focused.txt#L46) |

These are synthetic authenticated-transport tests using full SDK fixtures. Their passing assertions cover the named conditions; they are not production fault-injection evidence or a claim of scientific/data acceptance.

## Commands and toolchain

Recorded qualification used Node `24.19.0`, pnpm `11.24.0`, package `0.1.28` and the frozen lockfile. The full-gate output begins with the exact `prepush:gate` expansion and records its constituent commands. Source-tree reproduction at f18:

```sh
pnpm install --frozen-lockfile
node --import tsx --test \
  test/flow-identity-admission.test.ts \
  test/flow-identity-admission-remote.test.ts \
  test/dataset-save-draft-identity-admission.test.ts
pnpm prepush:gate
scripts/docpact-gate.sh --base origin/main
```

For packed qualification, the delivery owner's execution transcript records the following invocation, with private absolute roots replaced by placeholders. The retained stdout itself does not contain this command header:

```sh
<verified-node-24.19.0> --test \
  <packed-proof>/test/dataset-save-draft-identity-admission.test.js \
  <packed-proof>/test/flow-identity-admission.test.js \
  <packed-proof>/test/flow-identity-admission-remote.test.js \
  > <retained-evidence>/packed-tests.log 2>&1
```

The tests were emitted from exact f18 using its TypeScript configuration; five emitted test/helper files were copied into the proof tree. Its `src` symlink resolved to the isolated installed package's `dist/src`, rather than the source checkout. Recorded runtime-content SHA-256: `605bb3636f482cc7413a5efe7577553ef0b5623b56c2ca763a407e9fba615641`; tarball SHA-256: `3c8832ad38f0d68574cf5b137d3a7553887023cbde83a68dd8e60df908e9d15a`. The delivery record reports that all 15 production packages matched the qualified installation byte for byte. These retained stdout files alone do not independently attest the package inventory or runtime identity.

## Original and public artifact integrity

The original locators below identify maintainer-retained engineering evidence, **not public download locations**. Private absolute roots are intentionally omitted. Privacy inspection found no personal paths, account identities, UUIDs, payloads or credentials in these four originals, so their public copies are byte-identical; raw-original and public-artifact SHA-256 are therefore the same. No test lines were removed or regenerated.

| Private original locator | Public copy | Raw original = public copy SHA-256 |
| --- | --- | --- |
| `bounds-revision/prepush.log` | `f18-prepush.txt` | `8768750b52c9e87da67fe0e6d3c1902f0366b3426f473ec13ad8b658d481bb8d` |
| `bounds-revision/f18f94f3ce2b/packed-tests.log` | `f18-packed-focused.txt` | `ad584a59c080f5db8f7a594651588f2730345b80617b4cb88c8c3d34a4ff0377` |
| `bounds-revision/docpact.json` | `f18-docpact.txt` | `9c245bb78d0c23eeea26015e14de873f34451e3855b92878fa98268012de6b95` |
| `bounds-revision/docpact-config.json` | `f18-docpact-config.txt` | `ff75ce00c6370106fde4892025c2ba141a4d3c50f80e6f5f1e63c701abcdc58c` |

These hashes bind retained bytes. The local stdout files do not embed a Git HEAD attestation; their f18 association is the delivery record. Independently hosted exact-head evidence follows.

## Hosted exact-head provenance

[Source-fork quality-gate run 39410863313](https://github.com/changmillet/tiangong-cli/actions/runs/39410863313), attempt 1, ran `.github/workflows/quality-gate.yml` through `workflow_dispatch` on `codex/cli-374-identity-admission-20261020`. GitHub reports exact head `f18f94f3ce2b6e9d6877b79c03ae521af8b2ca7f`, created `2026-10-20T10:51:24Z`, completed successfully by `2026-10-20T10:57:31Z`.

| Native job and full logs | Conclusion | Completed (UTC) |
| --- | --- | --- |
| [Linux x64, job 118588005164](https://github.com/changmillet/tiangong-cli/actions/runs/39410863313/job/118588005164) | success | 10:55:53 |
| [Linux ARM64, job 118588005181](https://github.com/changmillet/tiangong-cli/actions/runs/39410863313/job/118588005181) | success | 10:55:02 |
| [macOS ARM64, job 118588005132](https://github.com/changmillet/tiangong-cli/actions/runs/39410863313/job/118588005132) | success | 10:57:30 |
| [Windows x64, job 118588004963](https://github.com/changmillet/tiangong-cli/actions/runs/39410863313/job/118588004963) | success | 10:56:58 |

[Retained API metadata projection](f18-hosted-run.json) records the run, jobs and step conclusions. All four complete logs were retrieved read-only during this evidence preparation: each contains the exact checkout SHA, Node/pnpm versions, a successful native platform/architecture assertion and `pnpm run prepush:gate`. Windows additionally passed its bootstrap HTTP check. The links expose actual full execution logs while GitHub retains them; this repository retains selected metadata and the local full/focused outputs, not a duplicate hosted-log archive.

This is source-fork validation, not an upstream merge/release/deployment result. No production account evidence is included here.
