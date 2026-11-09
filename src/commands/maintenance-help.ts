export function renderDatasetMaintenanceHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance <clear-account|plan|apply|freeze-protected|seal-protected-approval|run-protected|verify|flow-identity> [options]

Actions:
  clear-account Dry-run or delete current authenticated account-owned lifecyclemodels, processes, flows, sources, and contacts.
  plan    Build an immutable maintenance plan from a scope manifest, visible remote snapshot, dependency impact report, and intended operation.
  apply   Execute or durably admit an ordinary approved plan through current-user RLS and platform dataset command paths.
  freeze-protected Re-read the exact production owner-draft census/support/50 derivatives and generate an unapproved freeze request.
  seal-protected-approval Record a byte-exact human response into an approval artifact with no authentication or network access.
  run-protected Run or inspect one sealed production execution with one-shot admission and terminal derivative proof.
  verify  Re-fetch rows, references, or derivative request state and report passed, pending, or failed independently of apply.
  flow-identity Run the dedicated Step 3 capture/plan/freeze/seal-approval/serial-run/independent-verify workflow.

Safety:
  plan, verify, and freeze-protected are read-only; seal-protected-approval is local-only.
  apply is commit-only and requires --commit, the exact plan SHA-256 via --approve-plan, and the current account email via --confirm.
  A sealed production merge-support-aliases execution must use run-protected; apply is not its fallback.
  freeze-protected is production-only and never calls preflight, gate, admission, execution, or mutation RPCs.
  seal-protected-approval only records the exact human-approved bytes; it never authenticates, connects, or submits execution.
  run-protected is production-only: authenticated owner context plus server-side actor/user_id/state_code=0 and exact-plan closure fences protect writes; RLS remains a defense on public and independent-read surfaces. It never falls back to dev, a legacy alias RPC, or a second admission POST.
  flow-identity never reuses the Step 2 runner. Process writes are strictly ordinal and ambiguous responses permit read-only recovery, never automatic process replay.

Required Artifact Contract:
  - maintenance-plan.json
  - rls-visible-snapshot.json
  - protected-rows.jsonl
  - reference-impact-report.json
  - dry-run-report.json
  - commit-report.json
  - readback-verify-report.json
  run-protected uses a separate immutable protected-execution seal, submission marker, append-only status ledger, and terminal report.

Examples:
  tiangong-lca dataset maintenance clear-account --out-dir ./account-clear --json
  tiangong-lca dataset maintenance clear-account --commit --confirm user@example.com --out-dir ./account-clear
  tiangong-lca dataset maintenance plan --scope ./maintenance-scope.json --operation repair-references --out-dir ./dataset-maintenance
  tiangong-lca dataset maintenance plan --scope ./derivative-rebuild-scope.json --operation rebuild-derivatives --out-dir ./derivative-rebuild
  tiangong-lca dataset maintenance apply --plan ./dataset-maintenance/maintenance-plan.json --commit --approve-plan <sha256> --confirm user@example.com
  tiangong-lca dataset maintenance freeze-protected --plan ./maintenance-plan.json --toolchain-evidence ./toolchain.json --expected-project-ref <production-ref> --confirm bafudata@126.com --out-dir ./protected-freeze
  tiangong-lca dataset maintenance seal-protected-approval --freeze ./protected-freeze/protected-execution-freeze.json --approval-request ./protected-freeze/protected-approval-request.json --human-approval ./human-approval.txt --approve-freeze-file <sha256> --approve-request <sha256> --approve-text <sha256> --confirm bafudata@126.com --approved-at <iso> --out-dir ./protected-approval
  tiangong-lca dataset maintenance run-protected --plan ./maintenance-plan.json --freeze ./protected-execution-seal.json --approval ./protected-approval.json --out-dir ./protected-run --status-only
  tiangong-lca dataset maintenance verify --plan ./dataset-maintenance/maintenance-plan.json --out-dir ./dataset-maintenance/verify
  tiangong-lca dataset maintenance flow-identity --help
`.trim();
}

export function renderDatasetMaintenanceFlowIdentityHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance flow-identity <capture|plan|freeze|seal-approval|run|freeze-recovery|seal-recovery-approval|run-recovery|verify> [options]

Actions:
  capture       Authenticated production census and one database attestation; performs zero scope/preflight/rewrite/finalize calls.
  plan          Build immutable Step 3 reference-only process templates from an approved v3 review ledger and fresh post-Step2/post-#29 live capture.
  freeze        Offline-bind one production plan/toolchain/receipt and generate this execution's byte-exact approval request.
  seal-approval Offline-record byte-exact human approval; performs zero authentication, network, or database calls.
  run           Create/read one guarded scope, serially submit only its durable next ordinal, then wait read-only for derivative readiness before at most one finalize POST. Ambiguous responses are never retried in the same invocation.
  freeze-recovery Authenticated read-only scope snapshot that freezes a new exact continuation approval after the prior in-memory permit was lost.
  seal-recovery-approval Offline-record byte-exact human approval for only that frozen durable-scope baseline.
  run-recovery  Consume that recovery approval once, obtain a fresh memory-only rotating permit, and continue the same durable scope.
  verify        Independently re-read the terminal scope, all 305 source rows, public/support rows, exact affected processes, and the complete owner-draft process reference closure.

Plan:
  --policy <file> --review-ledger <file> --live-capture <file> --out-dir <dir>

Capture:
  --policy <file> --review-ledger <file> --prerequisites <file> --toolchain-evidence <file>
  --request-id <uuid> --operation-id <value> --expected-project-ref <ref> --confirm <email>
  --sdk-version <value> --out-dir <dir>
  [--page-size <n>] [--read-concurrency <n>] [--timeout-ms <n>]

Freeze:
  --plan <file> --toolchain-evidence <file> --approved-at <iso> --expected-project-ref <ref> --confirm <email> --out-dir <dir>

Seal approval:
  --plan <file> --freeze <file> --approval-request <file> --human-approval <file>
  --approve-freeze-file <sha256> --approve-request <sha256> --approve-text <sha256>
  --confirm <email> --approved-at <iso> --out-dir <dir>

Run:
  --plan <file> --freeze <file> --approval <file> --out-dir <dir>
  (--commit --approve-execution <sha256> --confirm <email> | --status-only)
  [--wait-seconds <n>] [--poll-ms <n>] [--timeout-ms <n>]

Freeze recovery:
  --plan <file> --freeze <original-file> --approval <original-file> --run-dir <prior-run-dir>
  --toolchain-evidence <file> --approved-at <iso> --recovery-reason <reason>
  --expected-project-ref <ref> --confirm <email> --out-dir <dir> [--timeout-ms <n>]

Seal recovery approval:
  --recovery-freeze <file> --approval-request <file> --human-approval <file>
  --approve-freeze-file <sha256> --approve-request <sha256> --approve-text <sha256>
  --confirm <email> --approved-at <iso> --out-dir <dir>

Run recovery:
  --plan <file> --freeze <original-file> --approval <original-file> --run-dir <prior-run-dir>
  --recovery-freeze <file> --recovery-approval <file> --out-dir <dir>
  --commit --approve-execution <recovery-identity-sha256> --confirm <email>
  [--wait-seconds <n>] [--poll-ms <n>] [--timeout-ms <n>]

Verify:
  --plan <file> --freeze <file> --approval <file> --run-dir <dir> --out-dir <dir>
  [--page-size <n>] [--timeout-ms <n>]

Derivative failure boundary:
  A failed/stale derivative will never retry a process. This command stops. Any derivative-only compensation requires a separate plan, new freeze, and new exact human approval.

Common:
  --json
  -h, --help
`.trim();
}

export function renderDatasetMaintenancePlanHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance plan --scope <file> --operation <operation> --out-dir <dir> [options]

Operations:
  delete | retire | redo-import | repair-references | merge-support-aliases | rebuild-derivatives

Options:
  --scope <file>       Maintenance scope manifest
  --operation <value> Intended row-level maintenance operation
  --alias-v2-input <file>
                       Reviewed Time alias planning input; builds the versioned
                       dataset-alias-plan.v2 plan and batch instead of the scope-driven plan
                       (requires --out-dir and ignores --scope/--operation)
  --length-time-input <file>
                       Reviewed Length*time planning input; builds the versioned
                       dataset-length-time-plan.v1 plan instead of the scope-driven plan
                       (requires --out-dir and ignores --scope/--operation)
  --out-dir <dir>      Artifact directory
  --page-size <n>      Requested snapshot page size, 1-5000 (default: 1000); server caps are followed using exact counts
  --timeout-ms <n>     Request timeout in milliseconds
  --json               Print compact JSON
  -h, --help

Outputs written under --out-dir include the immutable maintenance-plan.json, visible snapshot,
protected-row ledger, reference-impact report, and dry-run report. rebuild-derivatives additionally
freezes one action-scoped database snapshot without expanding the account scan with vector data.
`.trim();
}

export function renderDatasetMaintenanceApplyHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance apply --plan <file> --commit --approve-plan <sha256> --confirm <email> [options]

Behavior:
  Commit-only. The command rejects dry-run mode, a missing --commit flag, a plan hash mismatch,
  or a confirmation email that does not match the current authenticated account.
  For rebuild-derivatives, success means guarded admission is queued; it never means derivatives completed.
  Sealed production merge-support-aliases executions must use run-protected; this command is not a fallback.

Options:
  --plan <file>          Immutable maintenance-plan.json
  --commit               Execute the approved plan
  --approve-plan <sha256> Exact SHA-256 recorded for the plan
  --confirm <email>      Current authenticated account email
  --timeout-ms <n>       Request timeout in milliseconds
  --max-parallel <1-8>   Opt into bounded flow delete-only execution with durable dispatch ledger
  --global-inbound-proof <file> Absolute path to a fresh all-process SELECT-only zero-inbound proof
  --approve-global-inbound-proof <sha256> Exact SHA-256 of --global-inbound-proof; requires --max-parallel
  --json                 Print compact JSON
  -h, --help

Outputs include approval-record.json and commit-report.json alongside an append-only action or admission ledger.
`.trim();
}

export function renderDatasetMaintenanceFreezeProtectedHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance freeze-protected --plan <file> --toolchain-evidence <file> --expected-project-ref <ref> --confirm <email> --out-dir <dir> [options]

Behavior:
  Authenticates directly to the explicitly confirmed production project and re-reads the complete
  owner-draft account census, six support snapshots, projected reference closure, and the stable
  23-flow + 27-process derivative snapshot set. It writes a canonical protected freeze and an
  unapproved byte-exact human approval request. It never emits an approval artifact.

Required:
  --plan <file>                 Ready owner-draft merge-support-aliases maintenance plan
  --toolchain-evidence <file>   Canonical released DB/CLI/root-integration evidence
  --expected-project-ref <ref>  Explicit production Supabase project ref
  --confirm <email>             Exact authenticated owner email
  --out-dir <dir>               New private immutable artifact directory

Options:
  --derivative-baselines <file> Reviewed six-key derivative baselines; required when --plan is a
                                dataset-alias-plan.v2 (versioned Time alias) plan, whose freeze is
                                then derived from the plan, the toolchain evidence and these
                                baselines under the authenticated owner's own account
  --page-size <n>               Complete account scan page size, 1-5000
  --timeout-ms <n>              Positive authentication/read timeout in milliseconds
  --json                        Print compact JSON
  -h, --help

Remote safety:
  This command uses only authenticated table reads and cmd_dataset_derivative_rebuild_snapshot.
  Preflight, gate, admission, execution, save-draft, delete, state change, and all mutation calls are zero.
`.trim();
}

export function renderDatasetMaintenanceSealProtectedApprovalHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance seal-protected-approval --freeze <file> --approval-request <file> --human-approval <file> --approve-freeze-file <sha256> --approve-request <sha256> --approve-text <sha256> --confirm <email> --approved-at <iso> --out-dir <dir> [options]

Behavior:
  Records a human-provided approval text only when every UTF-8 byte, freeze-file hash, request hash,
  text hash, account, and canonical timestamp matches the unapproved request. It writes the approval
  artifact needed by a later, separate run-protected command; it does not submit that execution.

Required:
  --freeze <file>               Canonical protected freeze generated by freeze-protected
  --approval-request <file>     Canonical unapproved approval request JSON
  --human-approval <file>       Human-returned text, read byte-for-byte without trimming
  --approve-freeze-file <sha256> Explicit SHA-256 of the exact freeze file bytes
  --approve-request <sha256>    Explicit request identity SHA-256
  --approve-text <sha256>       Explicit byte-exact approval text SHA-256
  --confirm <email>             Exact frozen account email
  --approved-at <iso>           Exact approval-authority timestamp already embedded in the request
  --out-dir <dir>               New private immutable artifact directory

Options:
  --json                        Print compact JSON
  -h, --help

Versioned selection:
  A dataset-alias-execution-freeze.v2 freeze seals the versioned approval request the versioned
  freeze-protected run produced; the byte-exact text, freeze-file hash, request hash and account
  checks are the same ones v1 has always enforced.

Offline safety:
  This command receives no environment or HTTP client and performs zero authentication, network,
  database, preflight, gate, admission, execution, or mutation calls.
`.trim();
}

export function renderDatasetMaintenanceRunProtectedHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance run-protected --plan <file> --freeze <file> --approval <file> --out-dir <dir> --commit --approve-execution <sha256> --confirm <email> [options]
  tiangong-lca dataset maintenance run-protected --plan <file> --freeze <file> --approval <file> --out-dir <dir> --status-only [options]

Behavior:
  Runs one sealed, server-dispatched production maintenance execution fenced to the authenticated actor's
  exact owner-draft target set, or reads durable status through an auth.uid-, actor-, and plan-fenced RPC
  without admitting work; only the independent table readback uses RLS.
  Commit and status-only modes are mutually exclusive. The commit path validates the full private
  before-state, accepts only server-derived gates within the 180-second preflight window, writes an immutable
  local submission marker, and sends at most one admission POST. After a marker or ambiguous response,
  use --status-only; the command never retries admission or falls back to dev or the legacy alias RPC.

Required in both modes:
  --plan <file>             Immutable maintenance-plan.json
  --freeze <file>           Protected production execution seal/freeze artifact
  --approval <file>         Exact human-approval binding artifact
  --out-dir <dir>           Private protected-run artifact directory

Commit-only guards:
  --commit                  Submit the sealed execution exactly once
  --approve-execution <sha256> Exact approved execution identity SHA-256
  --confirm <email>         Current authenticated account email

Recovery:
  --status-only             Read/poll and independently verify the sealed request; never preflight or admit

Options:
  --wait-seconds <n>        Maximum terminal-status wait in seconds; 0 performs one status read
  --poll-ms <n>             Positive polling interval in milliseconds; default 10000
  --page-size <n>           Requested RLS readback page size, 1-5000
  --timeout-ms <n>          Positive request timeout in milliseconds
  --json                    Print compact JSON
  -h, --help

Versioned selection:
  The seal decides the chain. A dataset-alias-execution-freeze.v2 seal runs the versioned Time
  alias lifecycle (preflight, the three gates, one admission, then the read stage) with the same
  180-second window, the same single-admission policy and the same durable local evidence; a v1
  seal runs the frozen v1 chain unchanged. Unknown admission outcomes are recovered only by the
  read stage, and the sealed plan's expected counts are checked against the server's proof.

Only a terminal passed proof exits successfully. pending, failed, and indeterminate return non-zero.
`.trim();
}

export function renderDatasetMaintenanceVerifyHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance verify --plan <file> [options]

Options:
  --plan <file>       Immutable maintenance-plan.json
  --out-dir <dir>     Optional verification artifact directory
  --page-size <n>     Requested readback page size, 1-5000 (default: 1000); server caps are followed using exact counts
  --timeout-ms <n>    Request timeout in milliseconds
  --json              Print compact JSON
  -h, --help

Outputs include readback-verify-report.json. rebuild-derivatives reports pending, passed, or failed;
pending and failed both return a non-zero exit status.
`.trim();
}

export function renderDatasetMaintenanceClearAccountHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance clear-account [options]

Behavior:
  Dry-run by default. With --commit, deletes only rows visible to the current authenticated user and filtered by user_id through RLS.
  Tables are deleted in reference-safe order: lifecyclemodels, processes, flows, sources, contacts.
  Unit groups and flow properties are not deleted by this command because they are treated as protected support data.

Options:
  --state-code <n>    Optional repeatable state_code filter. Omit to clear all state codes for the current account.
  --out-dir <dir>     Artifact directory (default: ./dataset-maintenance/clear-account)
  --page-size <n>     Requested snapshot page size, 1-5000 (default: 1000); server caps are followed using exact counts
  --timeout-ms <n>    Request timeout in milliseconds (default: 10000)
  --commit            Execute deletion. Without this flag the command only writes a dry-run report.
  --dry-run           Explicit dry-run mode
  --confirm <email>   Required with --commit; must match the current authenticated account email
  --json              Print compact JSON
  -h, --help

Outputs written under --out-dir:
  - rls-visible-snapshot.json
  - dry-run-report.json
  - approval-record.json       (commit only)
  - commit-report.json         (commit only)
  - readback-verify-report.json (commit only)

Every snapshot/readback must prove complete exact-count pagination before an artifact or delete is accepted.
`.trim();
}
