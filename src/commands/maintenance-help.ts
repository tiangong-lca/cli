export function renderDatasetMaintenanceHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance plan|apply|verify|clear-account [options]

Reusable current-owner draft maintenance. Uses current-user RLS and platform dataset command paths. Planning writes maintenance-plan.json; apply is commit-only and requires exact plan/account confirmation; verify independently reads current state.
Specialized repair profiles are outside this CLI. Inspect each supported action with --help.`;
}

export function renderDatasetMaintenancePlanHelp(): string {
  return `Usage:
  tiangong-lca dataset maintenance plan --scope <file> --operation <operation> --out-dir <dir> [options]

Operations:
  delete, retire, redo-import, repair-references, rebuild-derivatives

Options:
  --scope <file>       Maintenance scope manifest
  --operation <value> Intended row-level maintenance operation
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
