---
title: CLI Runtime Distribution Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: tiangong-lca-cli
language: en
whenToUse:
  - when describing an installed CLI or implementing the component manager and bootstrap
whenToUpdate:
  - when runtime descriptors, manifests, host admission, cache or bootstrap contracts change
checkPaths:
  - src/runtime.ts
  - src/lib/runtime/**
  - src/main.ts
  - assets/runtime/**
  - scripts/bootstrap/**
  - test/runtime-*.test.ts
  - package.json
lastReviewedAt: 2026-09-18
lastReviewedCommit: 4316c205453071c8cbb45e06480344f8eae5e041
lastReviewedNote: 'Reviewed for CLI #336: public-rule assets are contract inputs, not managed runtime components. Descriptor, manifest, host admission, cache, bootstrap, platform and component-release contracts remain unchanged.'
related:
  - docs/agents/repo-architecture.md
  - docs/agents/repo-validation.md
  - docs/release-runbook.md
---

# Runtime distribution

The CLI owns generic component installation and runtime identity for workspace #980/W07. Foundry owns its task state, profiles and product compatibility manifest. Skills carry the CLI-owned minimal bootstrap and a product-selected immutable lock. The CLI package has no static Foundry dependency, and installation never grants data permissions.

## Current public inspection surface

`tiangong-lca runtime describe --json` and `@tiangong-lca/cli/runtime` describe the current built CLI package through the same implementation. The public library exports `describeCliRuntime`, `assertCliRuntimeMatches`, schema identifiers, supported platform tuples and types. The package root and private runtime subpaths remain closed. This API was introduced by #274. Version 0.1.10 is the designated first public C1 package; callers must still verify registry availability, integrity and provenance before trusting that release.

Inspection creates no files, authenticates nowhere and makes no network request. Runtime commands bypass CWD `.env` loading. The CLI launcher rejects retired/unsupported OS/architecture tuples before loading user configuration. Source development describes its built distribution; installed execution needs no source tree or Git.

The descriptor schema is `tiangong-lca.cli-runtime-descriptor.v1`, published in `assets/runtime/cli-runtime-descriptor.schema.json`. It includes:

- exact package name/version, canonical root and package-manifest SHA-256;
- current Node version, canonical executable path, byte count and SHA-256;
- the OS/architecture tuple and shell-free executable plus launcher argv;
- the TIDAS schema root and asset inventory fingerprint;
- a sorted portable-path/size/SHA-256 inventory of `package.json`, `bin/**`, `dist/src/**` and `assets/**`, and its SHA-256.

Inventory identities hash compact UTF-8 `JSON.stringify` bytes in the declared field order. Paths in the inventory are package-relative and use `/`; machine-local roots and invocation paths are deliberately outside the content hash. Each file uses an open descriptor, bounded incremental hashing and before/after identity/size/modification checks. Descendant symlinks and non-regular files are rejected; a normal package-manager symlink at the package root is resolved once to its physical root. The inventory is bounded to 50,000 files and 2 GiB, with 512 MiB per file. Changed or incomplete observations fail instead of silently accepting cached metadata.

`assertCliRuntimeMatches` accepts a strict `tiangong-lca.cli-runtime-expectation.v1` from an **independent trusted release manifest**, then re-inspects the current installation and compares exact package version, platform, CLI content, Node version and Node content. Invalid expectations fail before package inspection. The returned observation is deeply immutable. Copying hashes out of the same untrusted observation does not establish release trust.

The descriptor's scope is `cli-package`. It does not attest transitive dependencies, a registry signature or the complete software component. The release-built component manifest must separately bind its frozen production dependency graph and every deployed file. The descriptor does not claim task authorization, data completion, OS minimum/ABI readiness or download qualification; the manager's host/manifest checks own those additional gates. Explicit Node 24.19+ within the stable Node 24 line and the four architecture tuples are the current package inspection admission boundaries.

## Manager and bootstrap contract

`runtime ensure/status`, immutable manifest validation, bounded downloads/archive handling, installation locks, atomic publication, verified warm/offline cache reuse, leases and owned-cache-only prune are required before W07 is complete. This inspection API alone is not a runtime manager or a zero-setup installer.

The compatibility manifest must bind exact component versions, archive/content digests, frozen production-lock identity, asset/protocol fingerprints and distinct workspace read/write schema-feature support. Unsupported host/ABI, unknown schemas, untrusted alternate sources, unsafe archive paths/links and mutable versions fail before installation. Existing task attempts and workspaces are never rewritten or reset by runtime operations.

POSIX/PowerShell bootstrap scripts are generic C1 release assets and require no Node/pnpm. Their adjacent skill-delivered `bootstrap-lock.json` separately binds script bytes, bootstrap protocol and the already published product manifest URL/digest. C1 scripts must not embed an unpublished F1 digest. Neither task input nor an environment variable can replace the trust anchor. Rosetta selection requires actual Apple Silicon hardware proof and must select native arm64; Intel Mac, Windows arm64 and Linux musl do not receive a fallback.

Full release qualification requires all four supported CI hosts, no-global-Node/pnpm copied bootstrap cases, interruption/concurrency/corruption tests, exact 100% source coverage and an independently verified public C1 package. Foundry F1/component/cold-start qualification follows in its owning repository and the workspace integration task. No local routine registry publish or new credential fallback is introduced.

## Managed components and execution

The merged #274 manager exposes `runtime ensure`, `status`, `prune`, `lease-release` and `exec`. They require an explicitly selected local manifest plus its independently trusted SHA-256. `status` is read-only; missing installations do not create a cache or access a registry. `ensure` installs only selected-host components. The manifest schema is `assets/runtime/runtime-manifest.schema.json`; status/prune/lease output uses `assets/runtime/runtime-command-result.schema.json`; the public parser additionally enforces cross-field identity, canonical file order/hash, path collisions, metadata references and read/write compatibility. Serialized objects are not verified manifests: the loader/byte verifier returns a branded immutable value.

A manifest binds product/version, bootstrap protocol, per-platform minimum OS release and glibc, workspace read/write schemas and features, components and declared launches. `os_release` uses the platform's `os.release()` version, not a marketing release name. Linux requires a present, compatible runtime glibc; the host collector projects only that diagnostic header and never serializes the report or its environment. A write-compatible schema/feature set must also be readable. Foundry must still check its own task schema and execution gates.

Every component binds a stable id/version/platform, immutable distribution URL, compressed byte count/SHA-256, complete sorted unpacked file inventory and its content digest, and inventory references to the frozen production lock, SBOM, license and provenance artifacts. These artifacts are release-produced evidence; the installer does not turn a self-written provenance JSON into cryptographic publication authority. The independent product-manifest trust anchor and release qualification remain mandatory.

The canonical `tar-gzip-ustar-v1` interchange has only regular files, declared 0644/0755 modes, UTF-8 portable paths, zero file padding and exactly two terminating blocks. There are no directory, symlink, hard-link, device, sparse, PAX or executable-install-script entries. Parents are created from the validated inventory. Builders materialize the production dependency graph first; pnpm's documented `nodeLinker: hoisted` supplies a symlinkless layout where appropriate. The release-side writer packages only explicit content-bound files, and tests also read its output with the OS tar implementation. Consumer extraction uses bounded Node gzip streams and the declared inventory, with no tar/package-manager/compiler dependency after bootstrap.

Download sources are HTTPS release assets on GitHub, versioned Node distributions or exact npm tarballs. Redirects are bounded and permit only those origins plus GitHub artifact delivery hosts; credentials and server error bodies are never forwarded or logged. The archive is incrementally hashed and must match exact size/SHA before decoding. Only classified connection, stream or transient HTTP reads may retry once. User cancellation and integrity failures do not replay. Failed cleanup may remove only the download file owned by that attempt; an existing destination is preserved.

POSIX bootstrap extracts the already verified regular-file archive with permission preservation (`tar -xpzf`) while retaining `umask 077` for its private cache and staging directories. The installed files must keep the manifest-declared 0644/0755 modes; masking those modes to 0600/0700 makes later manager adoption fail. The cold-install regression checks every extracted file's size, digest and exact mode alongside the private 0700 cache boundary. Warm reuse and corruption rejection retain the same complete inventory checks.

The owned cache marker is `tiangong-lca.runtime-cache.v1`. Component directories are keyed by the complete canonical component description, so changed metadata cannot reuse a different installation. Each contains `root/` and a final receipt. Separate initialization/component/lease locks use the existing public batch run-lock owner. An installation is assembled privately, checked completely and atomically renamed; partial or corrupt published directories are not overwritten. Bootstrap may publish a full tree before Node can write its receipt, but adoption rechecks every inventory byte/mode and rejects extra files first.

Persistent leases pin exact component keys for an explicit non-secret id and owner. Changed owner/component sets require an explicit release, and malformed lease state blocks pruning. `prune --apply` removes only receipt-owned selected components with no active leases; source inputs, workspaces, account sessions and unknown data are outside its ownership. Cache, authentication and project/task lifecycles remain independent.

`exec` resolves only a manifest-declared executable/argv prefix, appends bounded application argv, rejects credential flags and requires an existing explicit work directory outside runtime/skill installation roots. It reuses CommandSpec, holds an execution lease and waits for child closure even after cancellation or output overflow. It never retries the application. Persistent task leases may coexist. Child environments contain essential platform paths only unless the trusted launch explicitly selects `cli-auth`, which forwards only the CLI's existing public/auth configuration and process-only access-token contract. Passwords, user API keys, `NODE_OPTIONS` and unrelated secrets are excluded. A child exit or an installed cache is not evidence of Foundry business completion.

Managed Node package hosts may opt in through the launch field `context_protocol: "tiangong-lca.runtime-host.v1"`. The source implementation for issue #278 exposes `receiveRuntimeHostContext()` and `copyTrustedRuntimeManifestBytes()` through the public `./runtime` subpath. Hosts call the receiver before interpreting task input or performing application work. It takes no caller-provided manifest, source, digest, environment or argv override. Launches without the field retain ordinary process transport and the existing three-argument spawn-adapter invocation.

The manager snapshots the three admitted host fields and bounded application argv before asynchronous component installation. Its manifest verifier retains an owned copy of the exact original bytes used for both digest verification and parsing. Retrieving those bytes returns a fresh copy; caller-buffer mutation, returned-buffer mutation, JSON normalization and object spreading cannot change or recreate the verified object. Hosts can use the copied bytes plus the inherited trusted digest when another installed package instance needs to verify the same manifest. Component receipts and leases remain component evidence, not a source for reconstructing a selected manifest.

The host channel is a dedicated Node IPC descriptor. A receiver-generated 32-byte nonce and actual parent/child PIDs bind every frame to one execution. The receiver requests context; the manager sends the original manifest as canonical base64 with its already trusted SHA-256, cache directory, work directory and entry; the receiver validates and accepts it; the manager confirms readiness. The receiver then closes IPC before returning the immutable context. This close order lets the owning manager observe process and output closure before releasing its execution lease. Each endpoint has a 30-second handshake deadline, and one process can consume the receiving handshake only once. A manifest remains bounded to 32 MiB before encoding; selection strings and exact message keys are also checked.

The receiving boundary verifies the manifest bytes again, checks its actual host/ABI and declared protocol/entry, re-inspects every selected cached component and verifies that its running executable is the declared managed Node file. The shared work-directory checks reject cache/skill directories; the received directory must also match the process's current physical directory. `RuntimeHostContext` contains the branded manifest, canonical cache/work directories, entry and actual host. Existing public component inspection, compatibility and manager APIs provide the remaining component/workspace operations. No account credential or permission is carried in the IPC payload; existing environment selection and product authorization still apply.

Missing, malformed, mismatched, changed, repeated or prematurely closed handshakes fail. Cancellation and output failure close the handshake before stopping the child, including a request arriving during the termination grace period. The parent retains leases until process and output streams close, and a transport failure cannot become success merely because the child exits with code zero. `runtime exec` emits a host-context diagnostic when such a failure has no child stderr. Applications are never replayed. Trusted custom spawn adapters receive the immutable context as a fourth argument only for opted-in launches; they must preserve the same transport and drain obligations.

These APIs require the separately qualified CLI release after issue #278. They are not part of the immutable public 0.1.10 baseline. Foundry and Skills update their pins and copied assets only after the new release's provenance, package consumers and exact workspace integration have passed.

The no-Node bootstrap implementations live in `scripts/bootstrap/tiangong-runtime-bootstrap.sh` and `.ps1`. They pin system tools, verify their own bytes against an adjacent `tiangong-lca.runtime-bootstrap-lock.v1`, select only the four supported tuples, verify the cached/downloaded manifest and complete base component, and start its Node/CLI with a cleared environment and exact argv. The source repository deliberately has no product `bootstrap-lock.json`: Skills creates that adjacent lock only after the F1 manifest and four base components exist, preventing a C1/F1 publication cycle. The 0.1.10 C1 package verifier closes the CLI-owned publication slice; public F1 product components, all-platform product cold starts, Skills locks and final integration remain downstream. The private live proof installs actual Node 24.19 and public CLI 0.1.9 production files from a verified local seed, invokes real account identity through that managed pair, checks offline reuse and lease/prune behavior, and preserves original inputs. It does not claim that a public runtime component has already been released.

## Bootstrap behavior

The POSIX script fixes its tool search path to system directories, disables curl configuration, permits HTTPS only, enforces declared download limits and verifies SHA-256 before archive use. It detects Linux glibc x64/arm64 and native macOS arm64. An x64 macOS process may choose arm64 only when both Apple Silicon capability and translated-process checks pass. Intel Mac, musl and unknown hosts fail before network or cache installation.

The PowerShell script uses the system `tar.exe`, `RuntimeInformation.OSArchitecture`, manual HTTPS redirects and bounded streaming. Windows arm64 fails before downloads. It checks archive names/types before full extraction, uses atomic cache marker and file locks, verifies all checksum entries, and launches through `ProcessStartInfo` with a cleared allowlisted environment and Windows argument quoting. Tests execute the POSIX source on this host and the Windows branch on Windows CI; both scripts have static no-eval/no-credential/no-execution-policy-bypass checks and source-copy byte equality.

The HTTP owner loads the system `System.Net.Http` assembly for Windows PowerShell compatibility and reads `Content-Length` as a scalar or `$null`, as exposed by PowerShell. Present lengths must equal the trusted size; an absent header still requires the exact bounded stream byte count. Native Windows qualification tests the unchanged owner against a real public response in both system Windows PowerShell and PowerShell Core, plus real .NET known/absent header objects and mismatched-size refusal. Cached bootstrap success alone does not cover this download path.

The flattened `assets/runtime/runtime-bootstrap-lock.schema.json` is intentionally simple enough for POSIX extraction without Node or `jq`. It binds both script SHA-256 values, bootstrap protocol, product manifest URL/bytes/SHA, launch id, and each platform base component/archive/checksum/file-count/Node/CLI path. Scripts always read `bootstrap-lock.json` beside themselves; no flag, environment variable, task file or downloaded document may replace it. Existing verified base components and manifests support warm/offline launch with no curl call; component adoption remains subject to the Node manager's independent full manifest check before other components or applications run.
