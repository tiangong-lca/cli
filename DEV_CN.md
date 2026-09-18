---
title: tiangong-lca-cli Maintainer Notes
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
whenToUse:
  - when you need Chinese maintainer context for CLI runtime, env, release, or development commands
whenToUpdate:
  - when maintainer-facing runtime, env, release, or development guidance changes
checkPaths:
  - DEV_CN.md
  - .env.example
  - README.md
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - .oxlintrc.json
  - .nvmrc
  - src/**
  - scripts/**
  - .github/workflows/**
lastReviewedAt: 2026-09-18
lastReviewedCommit: 4316c205453071c8cbb45e06480344f8eae5e041
lastReviewedNote: 'Reviewed for CLI #336: maintainers must keep the exact W8 public-rule verification in pre-push; runtime/env commands, SDK development lookup, package identity, lock, and production behavior remain unchanged.'
related:
  - AGENTS.md
  - .docpact/config.yaml
  - README.md
  - docs/agents/repo-validation.md
  - docs/agents/repo-architecture.md
  - docs/IMPLEMENTATION_GUIDE_CN.md
---

当前 #274 平台合同仅支持 macOS arm64、Linux x64/arm64、Windows x64；不通过旧版安装器回退 macOS Intel。`runtime ensure/status/prune/lease-release/exec` 已由 CLI 的 manifest、完整文件清单、锁、缓存及 lease 控制；无 Node 的 POSIX/PowerShell bootstrap 已进入 `scripts/bootstrap/`，只读取相邻的产品 lock；公开 C1 和组件资格仍待完成。运行时描述/组件分发的 owner 与验证边界见 [Runtime Distribution Contract](docs/agents/runtime-distribution-contract.md)。

# 项目配置

本项目是 TianGong 的统一 CLI 仓库，本地与 CI 运行时基线固定为 Node 24.19.0，开发工具链固定为 pnpm 11.24.0、TypeScript 7.0.2 与 type-aware Oxlint，但发布运行时只执行 `dist/` 下的构建产物。

2026-08-31 复核（Issue #256）：当前 0.1.5 依赖基线为 Supabase JS 2.112.4、精确固定的 TIDAS SDK 0.2.0、lint-staged 17.4.1、Prettier 3.9.6 与 tsx 4.23.13；Node 类型保持最新 24.x。精确固定避免未来未经审查的 0.2.x 自动进入消费者；`pnpm peers check` 是提交前门禁的一部分。Prettier 3.9 对旧文件的纯格式改写独立提交；OAuth/session、命令与公开 exports 不变，0.1.6 发布由 Issue #257 单独负责。

Review note, 2026-08-25: Issue #224 把仓库收敛为单一 Node 工具链：根 `pnpm-workspace.yaml` 与唯一根 `pnpm-lock.yaml` 管理依赖；`test:package` 拒绝其他 lockfile、旧 TypeScript/ESLint bridge、active npm 包管理命令和发布包中的开发工具泄漏；Oxlint 完全替代 ESLint 与 TypeScript Compiler API lint 路径。feature 仍保持 0.0.33；合并且全部质量门通过后，应另开只含 release metadata 的 0.1.0 PR，明确 maintainer/release compatibility 边界。

Review note, 2026-08-25: Issue #228 新增 `auth identity-receipt`。命令先在 credential decode/session/network 之前安全核对 expected canonical project，再对 redirect-disabled `/auth/v1/user` 做增量 byte cap 只读校验并要求 canonical user UUID；401/403 最多强制刷新并重读一次。公开回执只含 project、user id、脱敏展示邮箱、session/cache mode、安全请求/响应 hash 和 canonical receipt hash，严禁 credential/token/full-email/session-path 及其 fingerprint。生产 guard 必须同时带 expected project/user，并要求 `assertions.mode=intent-bound`。pnpm production case 命令先 clean-build TS7，再由 plain-Node runner 单次读取/hash source/config/lock 与 generated runtime/runner，把 exact built buffers 私有 snapshot 后才暴露 key；它不接受 alternate CLI path，只从 Foundry ignored `.env` 读取三个白名单变量，禁用 cache、使用独占创建的干净 cwd 与 argv 数组，不保存原始 stdout/stderr，也不做 dataset mutation。

Review note, 2026-08-25: Issue #230 因最新稳定 `sigstore@5.0.0` 的 Node 引擎下限，进一步把 `.nvmrc`、package engines、所有 workflow、静态契约和维护文档统一到当前最新 Node 24 LTS `24.19.0`，不再宣称支持无法运行完整开发/发布门禁的旧 24.x minor。

Review note, 2026-08-26: Issue #232 的公共 CommandSpec/batch 修复不新增 env、依赖或发布路径。batch 在 resumed acceptance 与 fresh claim 前重投影 item identity；identity getter 抛错也稳定输出 `BatchItemIdentityDriftError` / `item_identity_drift` 且零执行，已经启动的其他 worker 会 drain 后再返回。任一 scheduler/event/stop 基础设施回调逃逸时，首个错误会立即关闭新 claim，只 drain 已 claim worker，并在全部 worker settled 后拒绝。同 key 阻塞项保持 unclaimed、不占 worker，scheduler 可先执行后续 free key，stop 后精确保留未 claim 项。实现使用 per-resource FIFO cursor 与私有 minimum-ready binary heap，5,000 项结构测试拒绝旧 `12,502,500` 次线性 find，普通 ready 调度为近 `O(n log k)`。run-lock 的 PID/host/ownership time 只从当前进程与系统内部派生，公共调用方不能覆盖。CommandSpec timeout、run-lock timeout/poll、read retry/backoff 都拒绝超过 Node `2_147_483_647ms` 上限的值；公共 lock timing 另要求非负 safe integer。

Review note, 2026-08-26: Issue #233 在不改变上述行为的前提下，把 `src/batch.ts` 收缩为 62 行 facade，并把 types、errors/contracts、run-lock、projection、scheduler runtime、attempt/recovery、engine 分到 `src/lib/batch/**` 的 8 个语义模块。架构测试固定精确导出/类型/对象身份/错误与 event/result 字节、模块清单、当前 LOC ceiling、依赖方向、禁止 upward import 与零 SCC；最大内部模块为 445 行。包版本、依赖、唯一 pnpm lock 与 pnpm 11.23.0 / TypeScript 7.0.2 单轨均不变。

Review note, 2026-08-26: Issue #236 只把仓库与发布验证 consumer 的精确 pnpm 版本从 11.23.0 升级到 11.24.0。pnpm 11.24.0 的 lockfile-only reconciliation 不产生根 lock 字节变化；Node 24.19.0、唯一 TypeScript 7.0.2 图、包版本 0.1.1、依赖、公开 exports/行为、tag 与 Trusted Publishing 流程全部不变，也不新增 npm/Yarn fallback 或其他 lockfile。

Review note, 2026-08-29: Issue #240 新增 `@tiangong-lca/cli/auth-identity-receipt` 公开解析入口，直接复用既有 strict parser/类型，不公开 remote runner 或 test internals。包版本暂保持 0.1.2，深路径继续关闭，后续通过独立 patch release 发布。

Review note, 2026-06-04: `dataset curation-queue next/verify` extends the existing CLI-native dataset command family and does not change maintainer runtime, env, or release guidance.

Review note, 2026-07-23: Issue #194 在既有 `dataset save-draft` 上增加可选的 ordered owner-draft execution contract。contract 精确绑定 project、owner、state 0、行顺序、before/desired hash、操作和依赖；稳定用户状态目录中的 action ledger 让复制 contract/out-dir 也不能重放成功或模糊 action。普通 save-draft、认证环境变量和 npm 发布流程不变。

Review note, 2026-07-23: Issue #196 在 0.0.30 发布门禁中修复 Windows execution-ledger 持久化：创建与追加均在可写 descriptor 上写入、`fsync`、关闭。运行环境、认证变量、合同格式、attempt-before-dispatch 与 npm Trusted Publishing 路径均不变。

Review note, 2026-07-23: Issue #198 发布 0.0.31；`dataset save-draft` 只在深拷贝上运行 SDK 校验，原始 payload 继续作为 execution-contract hash、受保护写请求与精确 readback 的唯一目标。认证、owner/state/project 护栏、attempt-before-dispatch、无重放和 Trusted Publishing 路径均不变。

Review note, 2026-07-24: Issue #200 发布 0.0.32；`dataset save-draft --execution-contract` 新增显式 `--max-parallel 1..8`，完整 dependency prefix 仍串行，只有 table/id/version 唯一的 suffix 可有界并发。每次 DML 前通过既有 session runtime 取得当前 token 并重新核对 exact user/email，foreign renewal 在 attempt=0 阻断。环境变量、每行独立事务、durable ledger、成功/UNKNOWN 不重放和 Trusted Publishing 路径均不变。

Review note, 2026-07-24: Issue #202 发布 0.0.33；`dataset maintenance apply --max-parallel 1..8` 只接受 unique-target 的 flow delete-only plan，并在 dispatch 前以当前 owner session 完整扫描全部 RLS 可见 process，要求入边为零。每行在 protected delete RPC 前写 `PREPARED/DISPATCHED`，exact absent 才记 `COMMITTED`；成功或 UNKNOWN 不自动重放，其他无依赖行继续。无新 RPC/schema/env/依赖，也不新增 public/foreign/service-role 写面。

Review note, 2026-07-25: Issue #208 为同一 delete-only 模式增加可选 `--global-inbound-proof` 与精确 SHA 审批。证明必须在 30 分钟内由 SELECT-only 全库 process 检查产生，并绑定 project、owner、plan、完整目标集合与连续分片；任何入边、P0/P1、缺口、篡改或身份不符都在 approval/dispatch 前阻断。CLI 本身不执行 raw SQL，未提供证明时仍使用原 RLS 全可见扫描，写面和 no-replay 语义不变。

Review note, 2026-06-07: release 0.0.14 keeps maintainer runtime and release guidance unchanged. `dataset classification apply --type location` now supports explicit missing location targets for Foundry saturation workflows, and still rejects ambiguous target paths.

Review note, 2026-06-11: release 0.0.15 keeps maintainer runtime and release guidance unchanged. `dataset import-lca convert` now adapts to the tidas-tools 0.0.28 process-bundle flags (no bare `--process-bundles`, `--no-process-bundles` only when disabled) and reports bundle/mapping files from actual on-disk state.

Review note, 2026-08-20: `dataset import-lca convert` 只调用统一 Rust `tidas import`，按 `--tidas-bin`、`TIDAS_BIN`、PATH 的顺序定位 binary，并要求 `tidas.operation-report.v1` 与稳定 `0.2.x` 握手。npm 包不内置平台 binary，只包含可用于 clean-machine 验证的 SimaPro smoke fixture；binary 应来自带 checksum/provenance 的 tidas release 或 `cargo install tidas`。支持 Linux x86_64/ARM64、macOS Apple Silicon (arm64)、Windows x86_64，不支持 Windows ARM64。

Review note, 2026-07-11: `dataset maintenance plan/apply/verify` is now an implemented current-user RLS command family. It adds no environment variables or release-path changes; commit remains bound to an immutable plan hash, current account confirmation, append-only per-action logs, and independent readback verification.

Review note, 2026-07-12: BAFU `merge-support-aliases` 已改为显式 `target_mode=owner_draft`。source/target FP/UG 与全部受改 flow/process 必须属于当前账号且保持 `state_code=0`；RPC 请求、数据库审计、replay proof、本地 approval/progress 和独立 readback 都绑定 `target_visibility=owner_draft`。公开发布不再是本操作的前置或副作用。

Review note, 2026-07-13: maintenance account scan 已改为 exact-count 分页。`--page-size` 只是请求上限，服务端可返回更小页；CLI 根据实际返回行数推进 offset，核对每页 `Content-Range`、exact total 与严格 `id/version` 顺序，并在 artifact、approval 或 mutation 前要求完整性证明。该证明不是事务级/MVCC 同时点快照。

Review note, 2026-07-14: `rebuild-derivatives` 扩展现有 maintenance command family，但不新增 env 或发布路径。V1 只允许一个 current-owner state-0 process 的 `rebuild_derivatives` action，components 固定为 `extracted_md` + `embedding_ft`；apply 只记录 guarded RPC 的 `accepted`/`queued`，verify 独立输出 `pending`/`passed`/`failed`。不允许 direct Edge、`admin embedding-run`、raw queue、SQL 或 REST mutation fallback。

Review note, 2026-07-15: `dataset maintenance run-protected` 为已经冻结和人工批准的 private alias 计划提供 production-only 的一次性执行/恢复入口。受保护写入由服务器调度，以认证 owner 及精确 actor/user_id/state_code=0、plan/closure 栅栏限制范围；RLS 继续保护公开入口与独立读回。commit 路径只做一次 server preflight、在唯一 admission POST 前写 immutable attempt marker；marker 或不明确响应之后只能 `--status-only`。它不回退 dev、旧 alias RPC、发布或 state-code 修改。

Review note, 2026-07-15: `dataset maintenance freeze-protected` 与 `seal-protected-approval` 补齐 protected runner 之前的准备链。freeze 使用既有用户 session 直接对显式确认的 production project 做只读 census/support/50-target snapshot，且不会 preflight、gate、admit 或 mutate；seal 不接收 env、session 或网络 client，只按人类返回原始 UTF-8 字节及显式 hash/account/timestamp 生成 approval。二者不新增依赖、认证变量或发布路径。

Review note, 2026-07-16: Issue #175 只修正 `run-protected` 对服务端领先本机时钟的有界判断：`completed_at` 最多允许领先 5 秒，过期、时间倒序、超过 180 秒与一次性 admission 约束不变。它不新增 env、依赖、认证路径、命令面或发布机制。

Review note, 2026-07-16: Issue #182 只修正 protected 终态 verifier 的跨 JSON 序列化域比较，复用现有 plan、primary closure、RLS readback、snapshot 与 terminal proof；不新增 env、依赖、命令、认证、数据库/RPC 或发布机制。feature PR 不改包版本，后续仍通过独立 patch release、npm provenance 和 root integration 后才对既有 request 做 `--status-only`。

Review note, 2026-07-16: Issue #186 新增 `release` LCI/LCIA 数据发布命令族。它复用现有三项 `TIANGONG_LCA_API_*` 用户 session 配置，不新增 release 专用 key，更不接收 service-role；私有读取和状态迁移由 Edge/Database 再检查实时账号的 `data_product_manager` 权限。CLI 只负责文件化输入、四个 ZIP 的本地完整性校验、稳定报告及下载后的 byte-size/SHA-256 校验。

Review note, 2026-07-16: Issue #157 新增原生 `dataset maintenance flow-identity capture|plan|freeze|seal-approval|run|verify`，继续复用 Node 24、现有用户 session、authenticated Supabase RPC、私有 artifact 与独立 patch-release 流程；不新增 env、依赖、service-role、alternate bearer、本地发布或 Dev 数据回放。生产 Step 3 仍必须等待数据库能力发布、fresh live plan/freeze 和新的精确人工批准。

Review note, 2026-07-17: Issue #157 COMMON 收紧要求两个 Issue #29 derivative prerequisite 各自提供独立 `passed` readback；HTTP 200 但 body 为 `ok:false` 时按确定性数据库 domain rejection 处理。process 被拒后，本 invocation 只做一次 fresh scope read，绝不重放 process；verify 只有在数据库状态恰为 `derivatives_pending` 且没有其他硬性 readback mismatch 时才返回 `pending`。受保护 runner 现以数据库签发、每次成功写后轮换的 one-wrapper permit 作为跨机器权威，并以 create-only 本地 approval claim 作纵深防御；permit 或 preflight 响应丢失后，必须重新冻结并取得精确 recovery approval，只能经严格只读 lookup 找回原 actor-owned scope。尚未完成的是 merge、Preview 验证与 DB/CLI 协同发布，而不是协议设计缺口。

设计原则：

- 统一入口：所有 TianGong 平台能力最终收敛到 `tiangong-lca` 一个命令树
- 原生优先：优先使用 Node 24.19.0 原生能力，不默认引入高级包
- 直连 REST：不再以内置 MCP 作为 CLI 传输层
- 文件优先：输入优先走 JSON / JSONL / 本地文件，输出优先走结构化 JSON

## MCP 替代策略（明确约束）

统一 CLI 不再引入 MCP 作为内部传输层，替代策略固定为两条：

- 策略 1：优先直连 `tiangong-lca-edge-functions` 的 Edge Function / REST（适用于有明确业务语义的 API）
- 策略 2：对 Supabase 直接访问时不再经过 MCP；CLI 直接依赖官方 `@supabase/supabase-js`，并在此基础上保持 deterministic 的读写语义、URL 形状和报告契约

这两条共同目标是：不再发明新的中间 transport 实体。

当前已落地的命令：

- `tiangong-lca doctor`
- `tiangong-lca auth identity-receipt`
- `tiangong-lca search flow`
- `tiangong-lca search process`
- `tiangong-lca search lifecyclemodel`
- `tiangong-lca process get`
- `tiangong-lca process list`
- `tiangong-lca process identity-preflight`
- `tiangong-lca process auto-build`
- `tiangong-lca process resume-build`
- `tiangong-lca process publish-build`
- `tiangong-lca process batch-build`
- `tiangong-lca dataset validate`
- `tiangong-lca dataset classification children/path/audit/apply`
- `tiangong-lca dataset curation-queue build`
- `tiangong-lca dataset references rewrite`
- `tiangong-lca dataset maintenance plan/apply/freeze-protected/seal-protected-approval/run-protected/verify`
- `tiangong-lca lifecyclemodel auto-build`
- `tiangong-lca lifecyclemodel validate-build`
- `tiangong-lca lifecyclemodel publish-build`
- `tiangong-lca lifecyclemodel save-draft`
- `tiangong-lca lifecyclemodel graph`
- `tiangong-lca lifecyclemodel build-resulting-process`
- `tiangong-lca lifecyclemodel publish-resulting-process`
- `tiangong-lca lifecyclemodel orchestrate`
- `tiangong-lca release prepare/upload/finalize/approve/publish/readback-verify/unpublish/status/current/calculation-bundle/calculation-artifact/artifact-download`
- `tiangong-lca review process`
- `tiangong-lca review flow`
- `tiangong-lca review lifecyclemodel`
- `tiangong-lca flow get`
- `tiangong-lca flow list`
- `tiangong-lca flow identity-preflight`
- `tiangong-lca flow remediate`
- `tiangong-lca flow publish-version`
- `tiangong-lca flow publish-reviewed-data`
- `tiangong-lca flow build-alias-map`
- `tiangong-lca flow scan-process-flow-refs`
- `tiangong-lca flow plan-process-flow-repairs`
- `tiangong-lca flow apply-process-flow-repairs`
- `tiangong-lca flow regen-product`
- `tiangong-lca flow validate-processes`
- `tiangong-lca publish run`

review / dedup / publish 的规则 gate 元数据由 `src/lib/runtime-rulesets.ts` 统一维护，新增或修改阻断规则时需要同步稳定 ruleset id、methodology rule id、severity 与 blocker 语义，并保持 artifact 输出可被 Foundry / UI 直接消费。

- `tiangong-lca validation run`
- `tiangong-lca admin embedding-run`

## 安装依赖

需要 Node.js `24.19.0` 和 package metadata 指定的 pnpm `11.24.0`。本仓库不要求 `bash`、`nvm` 或其他 Unix-only 初始化工具。你可以使用自己平台上最稳定的 Node 安装方式，例如：

- Windows: 官方 Node.js `24.19.0` 安装器
- macOS: 官方安装器、`fnm` 或 `nvm`
- Linux: 你自己的 Node 24.19.0 安装方式

```bash
pnpm --version
pnpm install --frozen-lockfile
pnpm build
```

`pnpm --version` 必须输出 `11.24.0`。依赖解析只认根 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml`，不能增加其他 package manager 或嵌套 lockfile。

## 发布流程

这个仓库对外公开发布的 npm 包名是 `@tiangong-lca/cli`。

日常 release 采用 tag 驱动的 GitHub Actions 流程：

- 从 `main` 开一个 release-prep PR
- release-prep PR 只修改 CLI 包自己的 `package.json` 版本；依赖图不变时，唯一根 `pnpm-lock.yaml` 必须保持存在、frozen 且不变
- PR 合并后，`.github/workflows/tag-release-from-merge.yml` 自动创建 `cli-vX.Y.Z`
- `.github/workflows/publish.yml` 再从这个不可变 tag 通过 npm Trusted Publishing 发布

正式发布不能从本机发起。本机只负责版本 bump、验证和 PR；合并到 upstream `main` 之后，由 GitHub Actions 使用固定的 `pnpm/setup` v2.0.2、原生 pnpm OIDC 与 provenance 创建 tag 并完成 npm 发布。本机 npm 登录状态或个人 npm 权限不属于 release 契约。

值班发布步骤见 [docs/release-runbook.md](./docs/release-runbook.md)。

一次性的仓库 secret、workflow 文件名和 npm Trusted Publisher 配置见 [docs/release-setup.md](./docs/release-setup.md)。

发布到 npm 之后，可直接安装：

```bash
pnpm add --global @tiangong-lca/cli
```

对外 tarball 是 package-manager-neutral 的 runtime artifact，不携带 pnpm lock/workspace、TypeScript、Oxlint、测试或源码工具链；仓库自身仍只允许 pnpm。

## 配置文件

本项目会自动加载仓库根目录下的 `.env` 文件。

Review note, 2026-08-31: Issue #244 新增 `auth login|status|whoami|doctor-auth|logout`。交互登录使用注册过的 public OAuth client、S256 PKCE、随机 state、精确固定端口 `127.0.0.1` 回调与无 shell 系统浏览器；verifier/code 不落盘，OAuth access/rotating refresh token 在现有进程锁与文件锁下原子写入 schema-v2 私有 session。`status` 只读本地 metadata 且明确不是 online verification；`whoami` 复用 live redacted identity receipt；`doctor-auth` 缺少本地 session 时先返回 human login handoff，ready 后才做 live read。`TIANGONG_LCA_ACCESS_TOKEN` 是只在进程内缓存、在线校验且不自动 refresh 的 headless 入口；OAuth 失败绝不回退密码登录。

Review note, 2026-09-01: Issue #260 删除用户 API-key/password bootstrap、legacy session/mode/source、`--api-key`/env、旧 production-case runner 及相关 fixture/doc。所有用户远程命令只支持浏览器 OAuth 或显式、在线验证、仅进程内的短期 headless access token。

Review note, 2026-08-31: Issue #247 修复并发 CLI 进程交接 `session.json.lock` 时的 metadata TOCTOU。读取操作不再先检查存在性；`readFileSync` 返回 `ENOENT` 表示前一 owner 已完成释放，权限/I/O 等其他错误继续原样失败。锁创建、metadata schema、stale owner、timeout、reentrancy、cleanup、session bytes 与认证选择均不变。

Review note, 2026-08-31: Issue #250 修复 0.1.4 release matrix 的 Windows coverage gap。session cache 私有 read/write helper 可由测试显式注入 `linux`/`win32`，生产调用仍默认 `process.platform`；因此每个 runner 都能证明 POSIX private-mode 拒绝、目录/文件 chmod 以及 Windows 跳过目录 chmod。session schema、atomic rename、token、公开 API、依赖与认证行为不变。

官方 Production 无需创建 `.env`，安装后直接运行 `tiangong-lca auth login`，在浏览器完成授权，再运行 `tiangong-lca auth doctor-auth --json`。未登录时 `auth status` / `doctor-auth` 返回 `login-required`（exit 1），而不是缺少 client ID。`doctor` 的配置就绪不等于用户已登录。

`src/lib/env.ts` 是唯一 Production public profile 的来源，统一提供 URL、publishable key、CLI public client、已注册 callback 和 region。Skills 不复制这些值。只有 Dev/self-hosted/custom client 才需要按 `.env.example` 配置完整的同项目 URL/key/client；自定义 callback 也必须已注册。空白 public 字段或精确的官方 URL 别名可用默认 profile；任一不匹配的显式字段均禁止混补 Production，已知 Production client/key 不得搭配自定义 URL。`--base-url` 也不能绕过这个边界。

自定义环境使用的标准变量（下列空值只是模板，不是官方 Production 的前置要求）：

```bash
TIANGONG_LCA_API_BASE_URL=
TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY=
TIANGONG_LCA_OAUTH_CLIENT_ID=
TIANGONG_LCA_REGION=us-east-1
TIANGONG_LCA_AUTH_MODE=oauth
TIANGONG_LCA_OAUTH_REDIRECT_URI=http://127.0.0.1:49191/oauth/callback
TIANGONG_LCA_SESSION_FILE=
TIANGONG_LCA_DISABLE_SESSION_CACHE=false
TIANGONG_LCA_FORCE_REAUTH=false
```

`TIANGONG_LCA_OAUTH_CLIENT_ID` 是环境专属、已注册的 public client ID，不是 secret。先在可信终端运行 `tiangong-lca auth login`；后续 Edge Functions 与 direct Supabase 命令统一使用 OAuth access token，过期前按需旋转 refresh token。默认回调必须与 OAuth client 中登记的完整 URI 完全一致；OAuth client redirect URI 不支持 wildcard。

headless 任务必须显式设置目标 `TIANGONG_LCA_API_BASE_URL`、其 `TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY`、`TIANGONG_LCA_AUTH_MODE=access-token` 与短期 `TIANGONG_LCA_ACCESS_TOKEN`。只给 token 不会隐式选择 Production。该 token 在线校验后只在当前进程复用，不写 session 文件，也不做 refresh/replay。

此外，只有在显式启用 `tiangong-lca review process --enable-llm` 或 `tiangong-lca review flow --enable-llm` 时，才会额外使用这一组可选变量。这一整组配置默认都是 optional；只有打开 review LLM 模式时才需要填写。`TIANGONG_LCA_REVIEW_LLM_BASE_URL` 应指向一个 OpenAI-compatible Responses API 根地址，CLI 会向 `<base_url>/responses` 发请求：

```bash
TIANGONG_LCA_REVIEW_LLM_BASE_URL=
TIANGONG_LCA_REVIEW_LLM_API_KEY=
TIANGONG_LCA_REVIEW_LLM_MODEL=
```

仓库里还已经存在一组 internal/preparatory env 归一化入口，但当前没有任何公开 `tiangong-lca` 命令消费它们：

```bash
TIANGONG_LCA_KB_SEARCH_API_BASE_URL=
TIANGONG_LCA_KB_SEARCH_API_KEY=
TIANGONG_LCA_KB_SEARCH_REGION=us-east-1

TIANGONG_LCA_UNSTRUCTURED_API_BASE_URL=
TIANGONG_LCA_UNSTRUCTURED_API_KEY=
TIANGONG_LCA_UNSTRUCTURED_PROVIDER=
TIANGONG_LCA_UNSTRUCTURED_MODEL=
TIANGONG_LCA_UNSTRUCTURED_CHUNK_TYPE=false
TIANGONG_LCA_UNSTRUCTURED_RETURN_TXT=true
```

当前也不需要额外配置通用的 `SUPABASE_URL`、`SUPABASE_KEY` 或 `TIANGONG_LCA_TIDAS_SDK_DIR`。CLI 会从解析后的 `TIANGONG_LCA_API_BASE_URL` 派生原生 `@supabase/supabase-js` client，复用 OAuth/headless 解析出的 actor access token，并直接从 `package.json` 依赖加载 `@tiangong-lca/tidas-sdk`。

Data API schema 不依赖 PostgREST 的默认 `public`。默认且唯一支持的配置为 `TIANGONG_LCA_DATA_API_PROFILE=api-contract-v1`；省略变量时也解析为该冻结合同，旧 `legacy-public-v1` 会在发送前失败。九张核心实体表继续显式使用 `public`，16 个 CLI RPC 则全部显式使用 `api`。当前合同固定到 database-engine commit `1320dcc506fe37af6b625ae30fbe0bec38cf87c6`、migration head `20260902104500`，并在 manifest 中保存 migration tree 与关键 migration 的精确 hash。`private.cmd_dataset_alias_plan_guarded(jsonb)` 是不可暴露的内部 executor，不再是 CLI Data API capability；生产 alias 执行只使用 `run-protected` 的 preflight/gate/admit/read 四个 `api` façade。CLI 不接受 anon 或 service-role Data API 身份；GET/HEAD 与 manifest 明确分类为 read 的 RPC 仅在 401/403 后最多 refresh/replay 一次，relation write、mutation/unknown RPC 均不自动重放。

不再兼容旧变量名，也不再把 KB、TianGong unstructured service、MCP 相关 env 混写成当前公开命令面的必需配置。

原因很直接：

- 当前 CLI 已实现命令只直连 TianGong LCA 的 REST / Edge Functions
- `review process` / `review flow` 的可选语义审核统一走 review-only 的 `TIANGONG_LCA_REVIEW_LLM_*`，不再使用 `OPENAI_*`
- `publish run` / `validation run` 只做本地契约和执行收口，不新增远程 env
- CLI 仓库内部虽然已经有 `kb-search` / `unstructured` 模块，但当前没有任何公开命令消费这些 env
- `.env.example` 会把这类 key 标成 internal/preparatory，防止代码和文档脱节，也防止调用方误认为它们已经是稳定公开 contract

下表的“远程认证环境”指官方 Production 默认 profile + 已登录 session，或完整自定义 URL/key/client + 已登录 session，或显式 URL/key/headless token。内置 profile 不会让原本本地执行的 publish 自动选择远程 executor；该选择仍要求显式远程配置，`--commit`、remote lookup、身份与审批 gate 不变。旧 API key/password 路径已移除。

命令级 env 现实如下：

| 命令组 | 必需 env |
| --- | --- |
| `doctor` | 无 |
| `auth login` | 官方 Production 无；自定义环境需完整 URL/key/client |
| `auth status` | 远程认证环境；只检查本地 readiness，不访问网络或 refresh |
| `auth whoami` | 远程认证环境；执行 live redacted identity receipt |
| `auth doctor-auth` | 远程认证环境；local readiness + live redacted identity |
| `auth logout` | 远程认证环境；只删除匹配的本地 session，服务端 grant 在 Next Connected applications 中撤销 |
| `auth identity-receipt` | 远程认证环境；生产 guard 必须从 argv 同时给出 expected project/user，不能把 `observed` 回执当授权证明 |
| `search flow \| process \| lifecyclemodel` | 远程认证环境（`TIANGONG_LCA_REGION` 可选） |
| `admin embedding-run` | 远程认证环境（`TIANGONG_LCA_REGION` 可选） |
| `process get \| list` | 远程认证环境 |
| `process identity-preflight` | 默认无；启用 remote candidates 时需要远程认证环境（`TIANGONG_LCA_REGION` 可选） |
| `process auto-build \| resume-build \| publish-build \| batch-build` | 无 |
| `dataset validate` | 无 |
| `dataset classification children/path/audit/apply` | 无 |
| `dataset curation-queue build` | 无 |
| `dataset references rewrite` | 本地 rewrite 默认无；`--commit` 需要远程认证环境 |
| `dataset save-draft` | 本地 dry-run 默认无；`--commit`（包括 execution contract）需要远程认证环境；ledger 仍在平台用户状态目录 |
| `dataset maintenance plan/apply/freeze-protected/run-protected/verify` | 需要远程认证环境；既有 plan/approval/production/status-only 护栏不变 |
| `dataset maintenance seal-protected-approval` | 无；完全离线，只读取 canonical freeze/request 与人类返回的原始 UTF-8 文本，并要求显式 freeze-file/request/text/account/timestamp 绑定 |
| `lifecyclemodel auto-build \| validate-build \| publish-build \| graph \| orchestrate` | 无 |
| `lifecyclemodel save-draft` | 本地 dry-run 默认无；`--commit` 需要远程认证环境 |
| `lifecyclemodel build-resulting-process` | 本地默认无；开启 remote lookup 时需要远程认证环境 |
| `lifecyclemodel publish-resulting-process` | 无 |
| `review process` | 纯规则 review 默认无；若显式启用 `--enable-llm`，则需要 `TIANGONG_LCA_REVIEW_LLM_BASE_URL`、`TIANGONG_LCA_REVIEW_LLM_API_KEY`、`TIANGONG_LCA_REVIEW_LLM_MODEL` |
| `review flow` | 纯规则 review 默认无；若显式启用 `--enable-llm`，则需要 `TIANGONG_LCA_REVIEW_LLM_BASE_URL`、`TIANGONG_LCA_REVIEW_LLM_API_KEY`、`TIANGONG_LCA_REVIEW_LLM_MODEL` |
| `review lifecyclemodel` | 无 |
| `flow get` | 远程认证环境 |
| `flow list` | 远程认证环境 |
| `flow identity-preflight` | 默认无；启用 remote candidates 时需要远程认证环境（region 可选） |
| `flow remediate` | 无 |
| `flow publish-version` | 远程认证环境 |
| `flow publish-reviewed-data` | 本地 dry-run 默认无；`--commit` 需要远程认证环境 |
| `release *` | 远程认证环境；服务端仍要求 `data_product_manager`，禁止 service-role；请求体不再包含 credential fingerprint |
| `flow build-alias-map` | 无 |
| `flow scan-process-flow-refs` | 无 |
| `flow plan-process-flow-repairs` | 无 |
| `flow apply-process-flow-repairs` | 无 |
| `flow regen-product` | 无 |
| `flow validate-processes` | 无 |
| `publish run` | 无 |
| `validation run` | 无 |

## 调试项目

公开推荐的跨平台执行入口按优先级是：

- `node ./bin/tiangong-lca.js ...`
- `node ./bin/tiangong-lca.js ...`
- `node ./dist/src/main.js ...`

`pnpm start -- ...` 仍可用于本地开发时的“先构建再执行”，但它不是 skills / 文档的 canonical 公共入口。

```bash
node ./bin/tiangong-lca.js --help
node ./bin/tiangong-lca.js doctor
node ./bin/tiangong-lca.js doctor --json
node ./bin/tiangong-lca.js auth identity-receipt --expected-project-ref <project-ref> --expected-user-id <user-id> --json
node ./bin/tiangong-lca.js search flow --input ./request.json --dry-run
node ./bin/tiangong-lca.js process get --id <process-id> --version <version> --json
node ./bin/tiangong-lca.js process list --state-code 100 --limit 20 --json
node ./bin/tiangong-lca.js process identity-preflight --input ./process-identity-preflight.json --out-dir ./process-identity-preflight --json
node ./bin/tiangong-lca.js process auto-build --input ./examples/process-auto-build.request.json --out-dir /abs/path/to/process-run --json
node ./bin/tiangong-lca.js process resume-build --run-dir /abs/path/to/process-run --json
node ./bin/tiangong-lca.js process publish-build --run-dir /abs/path/to/process-run --json
node ./bin/tiangong-lca.js process batch-build --input ./examples/process-batch-build.request.json --out-dir /abs/path/to/process-batch --json
node ./bin/tiangong-lca.js dataset validate --input ./rows.jsonl --type auto --out-dir ./dataset-validate --json
node ./bin/tiangong-lca.js dataset classification audit --type location --input ./rows/rows.jsonl --out-dir ./location-audit --json
node ./bin/tiangong-lca.js dataset curation-queue build --processes ./rows/processes.jsonl --flows ./rows/flows.jsonl --support ./rows/sources.jsonl --out-dir ./curation-queue --json
node ./bin/tiangong-lca.js dataset references rewrite --input ./rows.jsonl --from flow:<old-id>@<old-version> --to flow:<new-id>@<new-version> --out-dir ./dataset-rewrite --json
node ./bin/tiangong-lca.js dataset maintenance plan --scope ./maintenance-scope.json --operation repair-references --out-dir ./dataset-maintenance --json
node ./bin/tiangong-lca.js dataset maintenance plan --scope ./derivative-rebuild-scope.json --operation rebuild-derivatives --out-dir ./derivative-rebuild --json
node ./bin/tiangong-lca.js dataset maintenance apply --plan ./dataset-maintenance/maintenance-plan.json --commit --approve-plan <sha256> --confirm <current-account-email> --json
node ./bin/tiangong-lca.js dataset maintenance apply --plan ./flow-delete-maintenance/maintenance-plan.json --commit --approve-plan <sha256> --confirm <current-account-email> --max-parallel 8 --json
node ./bin/tiangong-lca.js dataset maintenance verify --plan ./dataset-maintenance/maintenance-plan.json --out-dir ./dataset-maintenance/verify --json
node ./bin/tiangong-lca.js dataset maintenance freeze-protected --plan ./protected-step2/maintenance-plan.json --toolchain-evidence ./protected-step2/toolchain-evidence.json --expected-project-ref <production-ref> --confirm <current-account-email> --out-dir ./protected-step2/freeze --json
node ./bin/tiangong-lca.js dataset maintenance seal-protected-approval --freeze ./protected-step2/freeze/protected-execution-freeze.json --approval-request ./protected-step2/freeze/protected-approval-request.json --human-approval ./protected-step2/human-approval.txt --approve-freeze-file <sha256> --approve-request <sha256> --approve-text <sha256> --confirm <current-account-email> --approved-at <approved-at-utc-from-request> --out-dir ./protected-step2/approval --json
node ./bin/tiangong-lca.js dataset maintenance run-protected --plan ./protected-step2/maintenance-plan.json --freeze ./protected-step2/freeze/protected-execution-freeze.json --approval ./protected-step2/approval/protected-approval.json --out-dir ./protected-step2/run --status-only --json
node ./bin/tiangong-lca.js lifecyclemodel auto-build --input ./examples/lifecyclemodel-auto-build.request.json --out-dir /abs/path/to/lifecyclemodel-run --json
node ./bin/tiangong-lca.js lifecyclemodel validate-build --run-dir /abs/path/to/lifecyclemodel-run --json
node ./bin/tiangong-lca.js lifecyclemodel publish-build --run-dir /abs/path/to/lifecyclemodel-run --json
node ./bin/tiangong-lca.js lifecyclemodel save-draft --input ./lifecyclemodels.jsonl --out-dir ./lifecyclemodel-save-draft --dry-run --json
node ./bin/tiangong-lca.js dataset save-draft --input ./rows.jsonl --type auto --execution-contract ./execution-contract.json --max-parallel 8 --out-dir ./dataset-save-draft --commit --json
node ./bin/tiangong-lca.js lifecyclemodel graph --input ./lifecyclemodels.jsonl --out-dir ./lifecyclemodel-graph --format all --json
node ./bin/tiangong-lca.js lifecyclemodel orchestrate plan --input ./lifecyclemodel-orchestrate.request.json --out-dir /abs/path/to/lifecyclemodel-recursive-run --json
node ./bin/tiangong-lca.js lifecyclemodel build-resulting-process --input ./request.json --json
node ./bin/tiangong-lca.js lifecyclemodel publish-resulting-process --run-dir ./runs/example --publish-processes --publish-relations --json
node ./bin/tiangong-lca.js review process --rows-file ./process-list-report.json --out-dir ./review --json
node ./bin/tiangong-lca.js review process --run-root /abs/path/to/process-run --run-id <run_id> --out-dir ./review --json
node ./bin/tiangong-lca.js review flow --rows-file ./flows.json --out-dir ./flow-review --json
node ./bin/tiangong-lca.js review lifecyclemodel --run-dir /abs/path/to/lifecyclemodel-run --out-dir ./lifecyclemodel-review --json
node ./bin/tiangong-lca.js flow get --id <flow-id> --version <version> --json
node ./bin/tiangong-lca.js flow list --id <flow-id> --state-code 100 --limit 20 --json
node ./bin/tiangong-lca.js flow identity-preflight --input ./flow-identity-preflight.json --out-dir ./flow-identity-preflight --json
node ./bin/tiangong-lca.js flow remediate --input-file ./invalid-flows.jsonl --out-dir ./flow-remediation --json
node ./bin/tiangong-lca.js flow publish-version --input-file ./ready-flows.jsonl --out-dir ./flow-publish --dry-run --json
node ./bin/tiangong-lca.js flow publish-reviewed-data --flow-rows-file ./reviewed-flows.jsonl --original-flow-rows-file ./original-flows.jsonl --out-dir ./flow-publish-reviewed --dry-run --json
node ./bin/tiangong-lca.js flow build-alias-map --old-flow-file ./old-flows.jsonl --new-flow-file ./new-flows.jsonl --out-dir ./flow-alias-map --json
node ./bin/tiangong-lca.js flow scan-process-flow-refs --processes-file ./processes.jsonl --scope-flow-file ./flows.jsonl --out-dir ./flow-scan --json
node ./bin/tiangong-lca.js flow plan-process-flow-repairs --processes-file ./processes.jsonl --scope-flow-file ./flows.jsonl --scan-findings ./flow-scan/scan-findings.json --out-dir ./flow-repair-plan --json
node ./bin/tiangong-lca.js flow apply-process-flow-repairs --processes-file ./processes.jsonl --scope-flow-file ./flows.jsonl --scan-findings ./flow-scan/scan-findings.json --out-dir ./flow-repair-apply --json
node ./bin/tiangong-lca.js flow regen-product --processes-file ./processes.jsonl --scope-flow-file ./flows.jsonl --out-dir ./flow-regen --apply --json
node ./bin/tiangong-lca.js flow validate-processes --original-processes-file ./before.jsonl --patched-processes-file ./after.jsonl --scope-flow-file ./flows.jsonl --out-dir ./flow-validate --json
node ./bin/tiangong-lca.js publish run --input ./examples/publish-run.request.json --dry-run
node ./bin/tiangong-lca.js validation run --input-dir ./tidas-package --engine auto
node ./bin/tiangong-lca.js admin embedding-run --input ./jobs.json --dry-run
```

## process / review / publish / validation 边界

`tiangong-lca dataset maintenance plan/apply/freeze-protected/seal-protected-approval/run-protected/verify` 是错误导入后 row-level 修复和受保护衍生重建的 CLI-owned 入口。`plan` 冻结当前用户 RLS 可见快照、保护行、引用影响、desired payload 和 canonical plan SHA-256；普通操作只允许精确 `id + version` 的当前账号 `state_code=0` draft 通过 `cmd_dataset_save_draft` / `cmd_dataset_delete` 执行。BAFU alias operation 还要求 scope/plan `target_mode=owner_draft`，冻结 source/target FP/UG、52 个 changed row、59 条 exchange、118 个 amount 字段和 309 条不变 exchange。固定 protected profile 先由 `freeze-protected` 直接读取生产 owner-draft 状态并输出未批准请求，再由完全离线的 `seal-protected-approval` 记录人类逐字节批准；只有随后独立的 production-only `run-protected` 可以执行或恢复，不得回退 Dev 或旧 alias RPC。`rebuild-derivatives` V1 仍只允许一个 `table=processes` action；protected Step 2 的终态则要求精确证明 23 个 flows 与 27 个 processes。所有执行路径都把 plan/action/mode correlation 写入数据库审计与本地 durable proof。Foundry/skills 只能调用已发布 CLI 并保留报告/产物，不得读取数据库 env、直调 RPC、重算 canonical hash，或实现私有 Edge/admin/queue/SQL/service-role/raw REST mutation fallback。

显式给 `dataset maintenance apply` 传入 `--max-parallel 1..8` 时，CLI 进入 flow 物理收敛专用模式：只接受目标唯一、当前和投影入边均为零的纯 flow-delete plan，并在写前用 owner session 完整读取全部 RLS 可见 process 再做一次全局入边栅栏。每行在 protected RPC 前追加 `PREPARED`、`DISPATCHED`，精确 absent readback 后才记 `COMMITTED`；模糊行先只读恢复，不能证明成功时记 `UNKNOWN` 且不自动重放，无依赖行继续。未传该参数时保持原普通 apply 语义。

`freeze-protected` 必须提供 canonical plan、已发布 DB/CLI/根仓集成 toolchain evidence、显式 production project ref、当前账号邮箱和私有输出目录。它在任何 server token 或写入之前完成完整 account census、六份 support snapshot、projected-reference closure 与稳定排序的 23-flow + 27-process derivative baseline；报告中的 preflight、gate、admission、execution、mutation 与 approval-artifact 计数必须全部为零。`seal-protected-approval` 完全离线，逐字节保存人类返回文本，并精确核对 freeze 文件字节 hash、request identity、文本 hash、账号与批准时间；它只生成 approval，不提交 execution。

`run-protected` 的两种模式都必须提供 `--plan`、`--freeze`、`--approval` 与私有 `--out-dir`。首次提交还必须提供 `--commit`、精确 `--approve-execution <sha256>` 和 `--confirm <current-account-email>`；恢复使用互斥的 `--status-only`。CLI 在 preflight 前完成 production project、完整 RLS before-state、support closure 和 50-target derivative baseline 校验；服务器 preflight 再给出三项 gate 的期望摘要与最长 180 秒 token，CLI 对比 live gate receipt 后才允许 admission。服务器执行以认证 actor、精确 user_id/state_code=0 与 plan/closure 栅栏约束写入，独立读回继续使用 RLS。只允许一次 immutable marker 写入和一次 admission POST；marker、admission timeout、断网或不明确 admission 响应之后不得再次 admission，只能 status-only 查询。状态读取异常只可在配置的等待窗口内轮询，默认间隔 10 秒，不会触发 admission 重试。只有数据库终态证明与独立 RLS readback 同时确认 52 行、59 exchanges、55 audits 和 50 个 derivative targets（23 flows + 27 processes）时才返回 `passed`；`pending`、`failed`、`indeterminate` 都返回非零。该路径不发布、不改 `state_code`，也不触碰其他账号或公开数据。

maintenance 的 account-wide `plan`、apply preflight、`verify` 与 `clear-account` 共用 fail-closed exact-count paginator。它发送 `Prefer: count=exact`，把 `--page-size 1-5000` 当作 requested maximum；即使服务端把 5000 截成 1000，也按实际返回长度继续读取，而不是错误地跳到 offset 5000。每个表都必须证明 `Content-Range` total 恒定、range 与 body 一致、`id/version` 严格递增且无重复，汇总 proof 还必须覆盖全部预期表和 entity count。任何不完整或不一致的初始扫描都在生成快照/approval 或执行删除/更新前失败；新 plan、dry-run、approval 与 readback report 会保留相应 completeness proof。

这里的“complete”只表示在该表过滤成员与排序键保持稳定的前提下，多次 HTTP 请求完成了分页遍历；不表示所有页来自同一个 PostgreSQL transaction/MVCC snapshot。同数量的一删一增仍可能绕过 total/order 检查，apply 仍要靠 plan hash、payload/timestamp lock 和 fresh drift preflight 阻断写入；执行 plan 或 clear-account 时应避免同账号并发维护。

`apply` 是 commit-only：必须同时提供 `--commit`、精确 `--approve-plan <sha256>` 和 `--confirm <current-account-email>`，并在首写前持久化 approval、执行全计划 drift preflight。原 V1 alias adapter 只保留冻结请求与 artifact 的兼容契约，不能作为已经 seal 的 production `merge-support-aliases` 计划的执行或恢复 fallback；该计划必须走 `run-protected` 的唯一 durable attempt/admission identity。public/shared、foreign owner、mixed visibility、非 draft、不可见行和其他 support mutation 始终保护或阻断。

Derivative rebuild 的 apply 成功只表示 guarded RPC 已返回 `accepted`/`queued`，不能解释成 markdown/vector 已完成；相同 plan 重放必须恢复同一个 durable request，不能重复入队。`verify` 独立读取 request 与 action-scoped DB snapshot，只输出 `pending`、`passed`、`failed`；只有 `extracted_md`、`embedding_ft` 都已 current 且 primary process preconditions 不变才可 `passed`。

`tiangong-lca process get` 现在是统一 CLI 持有的只读 process 详情命令，负责：

- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase `/rest/v1` 读取路径
- 读取单个 process `id`
- 若显式提供 `--version`，先做精确版本查找；找不到时回退到同一 `id` 的最新版本
- 输出一个稳定的结构化 JSON 报告

这个命令当前只负责 deterministic direct-read，不负责任何远端写入、review、publish 或 workflow 编排。

`tiangong-lca process list` 现在是统一 CLI 持有的只读 process 列表命令，负责：

- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase `/rest/v1/processes` 读取路径
- 支持 `--id`、`--version`、`--user-id`、`--state-code` 过滤
- 支持 `--limit` / `--offset`，以及 `--all --page-size <n>` 的显式分页收集
- 对远端读取失败做有限重试
- 输出稳定的结构化 JSON 报告，可直接作为 `tiangong-lca review process --rows-file ...` 的输入

这个命令当前只负责 deterministic direct-read list，不负责治理修复、反向引用追踪或远端写入。

`tiangong-lca process identity-preflight` 现在承担 process 生成前的本地身份预检切片，负责：

- 读取一个 target process、本地候选 process 列表，以及显式开启的 `process_hybrid_search` 远程候选
- 对 canonical TIDAS wrapper 执行 `ProcessSchema` 校验；早期 loose target 只进入 `not_applicable` schema 状态
- 基于 `id`、version、`state_code`、名称、地理/时间/技术边界、参考 flow 和 exchange signature 给出 reuse / update_same_row / version_bump / create_new / block_duplicate / manual_review 决策
- 输出 `identity-decision.json` 和 `identity-candidates.jsonl`

这个命令当前只负责 artifact-first 的 preflight gate；远端候选检索必须由 `remote_candidate_search` 或 `--remote-candidates` 显式开启，且只用于查重/复用决策，不负责远端写入或自动替调用方决定 publish。远端检索只把 fielded `query`、`filter`、`data_source`、`match_count`/`page_size` 和 hybrid search 权重送给 `process_hybrid_search`；`remote_candidate_search.profile_hints` 只在 CLI 本地进入 target profile 和候选评分，不能作为 Edge Function 请求体字段。

`tiangong-lca process save-draft` 现在已经承担当前账号 draft process 的 state-aware 写入切片，负责：

- 读取 process rows JSON/JSONL 或 publish request 中的 canonical process payload
- 在本地先执行 `ProcessSchema` 校验，阻断 schema-invalid payload
- 对精确版本做可见性预检，区分 current-user `state_code=0` draft 与其它可见行
- 当传入 `--target-user-id` 时，写入前校验当前 CLI auth user 与目标用户一致，并要求已有 visible draft 也属于该目标用户
- 对 current-user draft 走 `cmd_dataset_save_draft`
- 把 schema-invalid 或执行失败的行写入 `outputs/save-draft-rpc/failures.jsonl`

这个命令当前只负责 current-user draft 的 save-draft/update 语义；`--target-user-id` 是批量导入时的账号/写入 guard，不能替代写后 readback verify，也不会替代 public `state_code=100` 的版本修订 publish 路径。

`tiangong-lca dataset save-draft --execution-contract` 是另一条显式 opt-in 的通用批处理契约。`dataset-save-draft-execution-contract.v1` 必须给出 project、精确 owner（含 `state_code=0`）和有序 actions；每个 action 绑定 `action_id@desired_sha256`、table/id/version、expected operation、before hash 与只指向更早 action 的依赖。`--max-parallel` 默认 1、上限 8；调度器把所有被 dependency 引用的 action 收进一个完整串行前缀，只有其后 table/id/version 唯一的 suffix 可以并发。每次 DML 前都会从既有 session runtime 取得当前 token 并再次核对 exact user/email。CLI 在调用受保护平台写入前把 attempt 持久化到稳定的 per-owner/project action ledger，随后只以精确 owner/state/payload readback 判定成功；transport 模糊、进程中断或既有 attempt 都不会自动重投。依赖失败只阻断其后继，无依赖 action 继续；任一 failed/unknown/blocked 都返回非零退出码。Unit Group / Flow Property 仍需额外显式 `--allow-account-local-support`，该模式不新增 direct-table、service-role、publication、delete 或 state/schema mutation 路径。

`tiangong-lca process auto-build` 现在已经承担 `process_from_flow` 主链的第一个 CLI 切片，负责：

- 读取单个 process-from-flow request
- 解析 `flow_file` 指向的 ILCD flow JSON
- 生成兼容旧工作流的 `run_id`
- 通过 `--out-dir` 或 request `workspace_run_root` 指定显式 run root，并在其中创建运行骨架
- 预写 `cache/process_from_flow_state.json`
- 预写 `cache/agent_handoff_summary.json`
- 产出 request / flow / assembly / lineage / invocation / run manifest / report

这个命令当前只负责本地 intake 与 scaffold，不负责继续执行后续工作流阶段。

`tiangong-lca process resume-build` 现在也已经进入可执行状态，负责：

- 从 `--run-dir` 重开一个现有 process build run；可选 `--run-id` 只做 basename 一致性校验
- 校验 `process_from_flow_state.json`、`agent_handoff_summary.json`、`run-manifest.json` 等关键产物
- 复用本地 state lock，避免并发写入同一个 run
- 清理持久化的 `stop_after` checkpoint，并把状态推进到 `resume_prepared`
- 输出 `resume-metadata.json`、`resume-history.jsonl`、更新 `invocation-index.json`
- 重写 `agent_handoff_summary.json`
- 输出 `process-resume-build-report.json`

这个命令当前也只负责本地 resume handoff，不负责继续执行后续工作流阶段。

`tiangong-lca process publish-build` 现在也已经进入可执行状态，负责：

- 从 `--run-dir` 读取一个现有 process build run；可选 `--run-id` 只做 basename 一致性校验
- 校验 `process_from_flow_state.json`、`agent_handoff_summary.json`、`run-manifest.json`、`invocation-index.json`
- 优先从 `exports/processes`、`exports/sources` 收集 canonical 数据，缺失时回退到 state 中的 `process_datasets`、`source_datasets`
- 用 `ProcessSchema` 对待发布 process payload 执行本地 schema gate
- 输出 `reports/process-publish-schema-gate.json`
- 生成 `stage_outputs/10_publish/publish-bundle.json`
- 生成 `stage_outputs/10_publish/publish-request.json`
- 生成 `stage_outputs/10_publish/publish-intent.json`
- 更新 `process_from_flow_state.json`、`invocation-index.json`、`agent_handoff_summary.json`
- 输出 `process-publish-build-report.json`

这个命令当前只负责本地 publish handoff，不负责真正的远端 publish commit；真正的 dry-run / commit 边界仍由 `tiangong-lca publish run` 负责。

`tiangong-lca process batch-build` 现在也已经进入可执行状态，负责：

- 读取单个 batch manifest
- 通过 `--out-dir` 或 request `out_dir` 指定显式 batch root，并创建聚合 report 路径
- 顺序复用 CLI 的 `process auto-build` 契约执行多个 item
- 为每个 item 生成稳定的本地 run 目录
- 在 batch report 中记录 per-item prepared / failed / skipped 结果
- 为后续 `resume-build` / `publish-build` 保留明确的 `run_root`

这个命令当前只负责本地 batch orchestration，不负责继续串接 resume / publish，也不负责远端 publish commit。

`tiangong-lca lifecyclemodel auto-build` 现在已经承担 `lifecyclemodel-automated-builder` 主链的第一个 CLI 切片，负责：

- 读取单个 local-run manifest
- 解析一个或多个 `process-automated-builder` 本地 run 目录
- 从共享 flow UUID 推断 process graph
- 选择 reference process
- 计算每个 process instance 的 `@multiplicationFactor`
- 写出原生 `json_ordered` lifecyclemodel 数据集
- 写出 `run-plan.json`、`resolved-manifest.json`、`selection/selection-brief.md`
- 写出 `discovery/reference-model-summary.json`、`models/**/summary.json`、`connections.json`、`process-catalog.json`

这个命令当前只负责本地只读 build，不负责：

- 远端 lifecyclemodel 写入
- MCP / KB / LLM reference-model discovery
- 自动串接 `validate-build` 或 `publish-build`

`tiangong-lca lifecyclemodel validate-build` 现在也已经进入可执行状态，负责：

- 从 `--run-dir` 重开一个已有 lifecyclemodel auto-build run
- 扫描 `models/*/tidas_bundle/lifecyclemodels/*.json`
- 通过统一 `validation` 模块重新执行本地校验
- 在 `reports/model-validations/` 下输出 per-model 校验结果
- 更新 `manifests/invocation-index.json`
- 输出 `reports/lifecyclemodel-validate-build-report.json`

这个命令当前只负责本地 validation handoff，不负责远端写入，也不自动触发 publish。

`tiangong-lca lifecyclemodel publish-build` 现在也已经进入可执行状态，负责：

- 从 `--run-dir` 重开一个已有 lifecyclemodel auto-build run
- 收集 `models/*/tidas_bundle/lifecyclemodels/*.json` 下的原生 lifecyclemodel payload
- 若存在 `reports/lifecyclemodel-validate-build-report.json`，则读取其中的 aggregate 校验摘要
- 输出 `stage_outputs/10_publish/publish-bundle.json`
- 输出 `stage_outputs/10_publish/publish-request.json`
- 输出 `stage_outputs/10_publish/publish-intent.json`
- 更新 `manifests/invocation-index.json`
- 输出 `reports/lifecyclemodel-publish-build-report.json`

这个命令当前只负责本地 publish handoff，不负责真正的远端 publish commit；真正的 dry-run / commit 边界仍由 `tiangong-lca publish run` 负责。

`tiangong-lca lifecyclemodel build-resulting-process` 现在仍然保持本地优先，但已经支持一个显式的 deterministic 远端补全路径：

- 只有当 request 中 `process_sources.allow_remote_lookup=true` 时才启用
- 直接从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase `/rest/v1` 读取路径
- 按 `process_id + version` 精确读取，找不到时回退到该 `id` 的最新版本
- 不走 MCP，不走语义检索，不改变本地 artifact 契约

也就是说，这个命令现在解决的是“缺 process JSON 时的 deterministic direct-read”，不是把整个 lifecyclemodel build workflow 变成远端编排。

`tiangong-lca lifecyclemodel publish-resulting-process` 现在已经进入可执行状态，负责：

- 从 `--run-dir` 重开一个已有 resulting-process run
- 汇总 projected process payload 与 resulting-process relation payload
- 输出 `publish-bundle.json`
- 输出 `publish-intent.json`
- 输出 `publish-summary.json`

这个命令当前只负责 resulting-process 的本地 publish handoff，不直接执行远端提交；真正的 dry-run / commit 仍由 `tiangong-lca publish run` 负责。

`tiangong-lca lifecyclemodel orchestrate` 现在已经进入可执行状态，负责：

- `plan`：把递归装配请求规范化为 `assembly-plan.json`、`graph-manifest.json`、`lineage-manifest.json`、`boundary-report.json`
- `execute`：只调用原生 CLI builder slices，记录 `invocations/*.json` 与执行汇总
- `publish`：重开一个已有 orchestrator run，汇总上游本地产物并输出 `publish-bundle.json`、`publish-summary.json`

这个命令的 `process_builder` 请求面已经收窄到 CLI-native 本地构建字段集合；额外的旧 builder 控制项会在请求归一化阶段直接被拒绝，不再保留任何 Python fallback 配置面。

`tiangong-lca review process` 现在也已经进入可执行状态，负责：

- 从 `--run-root` 读取 `exports/processes/*.json`
- 沿用当前 process review 的平衡核查、基础信息核查、单位疑似问题记录逻辑
- 输出 `one_flow_rerun_timing.md`
- 输出 `one_flow_rerun_review_v2_1_zh.md`
- 输出 `one_flow_rerun_review_v2_1_en.md`
- 输出 `flow_unit_issue_log.md`
- 输出 `review_summary_v2_1.json`
- 输出 `process-review-report.json`

这个命令当前保持本地 artifact-first。若显式传入 `--enable-llm`，则通过 CLI 内部统一的 `TIANGONG_LCA_REVIEW_LLM_*` 运行时做可选语义审核；即使 LLM 失败，也不会影响规则层 review 主流程。

`tiangong-lca review flow` 现在也已经进入可执行状态，负责：

- 接受 `--rows-file`、`--flows-dir`、`--run-root` 三种本地输入模式之一
- 在 `--rows-file` 模式下物化 `review-input/flows/*.json` 和 `review-input/materialization-summary.json`
- 输出 `rule_findings.jsonl`
- 输出 `llm_findings.jsonl`
- 输出 `findings.jsonl`
- 输出 `flow_summaries.jsonl`
- 输出 `similarity_pairs.jsonl`
- 输出 `flow_review_summary.json`
- 输出 `flow_review_zh.md`
- 输出 `flow_review_en.md`
- 输出 `flow_review_timing.md`
- 输出 `flow_review_report.json`

这个命令同样保持本地 artifact-first。若显式传入 `--enable-llm`，则通过 CLI 内部统一的 `TIANGONG_LCA_REVIEW_LLM_*` 运行时做可选语义审核；当前 CLI 切片明确不支持 `--with-reference-context`，也还没有接入本地 registry enrichment。

`tiangong-lca review lifecyclemodel` 现在也已经进入可执行状态，负责：

- 从 `--run-dir` 重开一个已有 lifecyclemodel auto-build run
- 扫描 `models/*/tidas_bundle/lifecyclemodels/*.json`
- 复用 `summary.json`、`connections.json`、`process-catalog.json`
- 若存在 `reports/lifecyclemodel-validate-build-report.json`，则聚合其中的 validate findings
- 输出 `model_summaries.jsonl`
- 输出 `findings.jsonl`
- 输出 `lifecyclemodel_review_summary.json`
- 输出 `lifecyclemodel_review_zh.md`
- 输出 `lifecyclemodel_review_en.md`
- 输出 `lifecyclemodel_review_timing.md`
- 输出 `lifecyclemodel_review_report.json`

这个命令当前保持本地 artifact-first，不引入 Python、LangGraph 或 skill 私有 review runtime。本地 validation 边界也已经收口到 CLI 内组装的 `@tiangong-lca/tidas-sdk` 校验器，不再依赖 sibling repo、`uv run tidas-validate` 或其他外部 fallback。

`tiangong-lca flow get` 现在已经承担 flow governance 的只读详情切片，负责：

- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase `/rest/v1/flows` 读取路径
- 按 `id` 读取单个 flow
- 可选叠加 `--version`、`--user-id`、`--state-code` 过滤条件
- 若显式提供 `--version` 但精确版本未命中，则回退到该 `id` 的最新可见版本
- 若出现多个可见候选同时命中，则直接报 ambiguous，而不是隐式猜测

这个命令当前只负责 deterministic direct-read，不负责任何治理修复、publish 或 workflow 编排。

`tiangong-lca flow list` 现在已经承担 flow governance 的只读枚举切片，负责：

- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase `/rest/v1/flows` 读取路径
- 支持重复 `--id`、`--state-code`、`--type-of-dataset` 过滤
- 默认使用 `order=id.asc,version.asc`
- 支持 `--limit` / `--offset`
- 支持 `--all --page-size <n>` 的显式 offset 分页收集
- 输出稳定的结构化 JSON 报告

这个命令当前只负责 deterministic direct-read list，不负责修复、publish 或后续产品侧再生逻辑。

`tiangong-lca flow identity-preflight` 现在承担 flow 生成前的本地身份预检切片，负责：

- 读取一个 target flow、本地候选 flow 列表，以及显式开启的 `flow_hybrid_search` 远程候选
- 对 canonical TIDAS wrapper 执行 `FlowSchema` 校验；早期 loose target 只进入 `not_applicable` schema 状态
- 基于 `id`、version、`state_code`、名称/同义词、类型、CAS、flow property、参考单位、分类和地理字段给出 reuse / update_same_row / version_bump / create_new / block_duplicate / manual_review 决策
- 输出 `identity-decision.json` 和 `identity-candidates.jsonl`

这个命令当前只负责 artifact-first 的 preflight gate；远端候选检索必须由 `remote_candidate_search` 或 `--remote-candidates` 显式开启，且只用于查重/复用决策，不负责远端写入或自动替调用方决定 publish。远端检索只把 fielded `query`、`filter`、`data_source`、`match_count`/`page_size` 和 hybrid search 权重送给 `flow_hybrid_search`；`remote_candidate_search.profile_hints` 只在 CLI 本地进入 target profile 和候选评分，不能作为 Edge Function 请求体字段。

`tiangong-lca flow remediate` 现在已经承担 flow governance 的第一个 CLI remediation 切片，负责：

- 读取单个 invalid flow JSON / JSONL 输入
- 执行 deterministic round1 remediation
- 输出历史兼容的 `remediated_all`、`ready_for_mcp`、`manual_queue`、`audit`、`report`、`prompt` 工件

这个命令当前只负责本地 round1 remediation，不负责远端 publish、round2 重试或后续产品侧再生逻辑。

`tiangong-lca flow publish-version` 现在已经承担 flow governance 的第一个 CLI 远端写入切片，负责：

- 读取单个 ready-for-publish flow JSON / JSONL 输入
- 用 `FlowSchema` 对 canonical flow payload 执行本地 publish gate
- 输出 `flow-publish-version-gate-report.json`
- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase REST 预检路径与 Edge Function dataset command 路径；支持 project root、`/functions/v1`、`/rest/v1` 三种 base URL 形态
- dry-run 通过精确版本可见性预检决定 `would_insert` / `would_update_existing` / failure；commit 则在同一条预检链上调用 `app_dataset_create` / `app_dataset_save_draft`
- 输出历史兼容的 `mcp_success_list`、`remote_validation_failed`、`mcp_sync_report`

这个命令当前只负责 remediated flow version 的 publish/update 契约，不负责 round2 失败再修复；后续产品侧再生已经由 `tiangong-lca flow regen-product` 单独承接。

`tiangong-lca flow publish-reviewed-data` 现在已经承担 flow governance 的 reviewed publish preparation 切片，负责：

- 读取 reviewed flow 和/或 reviewed process 的本地 JSON / JSONL 输入
- 可选读取 `--original-flow-rows-file`，对 unchanged reviewed rows 直接跳过，不再 version bump
- 支持 `skip | append_only_bump | upsert_current_version`
- 输出 `prepared-flow-rows.json`
- 输出 `prepared-process-rows.json`
- 输出 `flow-version-map.json`
- 输出 `skipped-unchanged-flow-rows.json`
- 在需要时重写 process `referenceToFlowDataSet` 并输出 `process-flow-ref-rewrite-evidence.jsonl`
- 输出 `publish-report.json`
- 保留历史兼容的 `mcp_success_list`、`remote_validation_failed`、`mcp_sync_report`

这个命令现在已经覆盖 flow/process 的本地 reviewed publish 准备阶段；当显式传入 `--commit` 时，prepared flow rows 和 prepared process rows 都会通过 CLI 自己共享的 “REST 预检 + dataset command” writer layer 执行远端提交，不再依赖任何 legacy skill 路径。

`tiangong-lca flow build-alias-map` 现在已经承担 flow governance 的 deterministic alias map 切片，负责：

- 读取一个或多个 old flow JSON / JSONL 输入
- 读取一个或多个 new flow JSON / JSONL 输入
- 可选读取 `--seed-alias-map`
- 输出 `alias-plan.json`
- 输出 `alias-plan.jsonl`
- 输出 `flow-alias-map.json`
- 输出 `manual-review-queue.jsonl`
- 输出 `alias-summary.json`

这个命令当前只负责本地 alias map 构建，不负责 process repair、publish 或任何远端写入。

`tiangong-lca flow scan-process-flow-refs` 现在已经承担 flow governance 的独立 process ref 扫描切片，负责：

- 读取本地 process JSON / JSONL 输入
- 读取一个或多个 scope/catalog flow JSON / JSONL 输入
- 对每个 exchange 的 `referenceToFlowDataSet` 做 scope / catalog / alias 分类
- 可选在扫描前剔除 emergy-named process
- 输出 `emergy-excluded-processes.json`
- 输出 `scan-summary.json`
- 输出 `scan-findings.json`
- 输出 `scan-findings.jsonl`

这个命令当前只负责本地 deterministic 扫描，不负责 patch、publish 或 OpenClaw 语义决策。

`tiangong-lca flow plan-process-flow-repairs` 现在已经承担 flow governance 的独立 deterministic repair plan 切片，负责：

- 读取本地 process JSON / JSONL 输入
- 读取一个或多个 scope flow JSON / JSONL 输入
- 可选读取 `--alias-map`
- 可选读取上一步 `--scan-findings`
- 显式收口 `disabled | alias-only | alias-or-unique-name` auto-patch policy
- 输出 `repair-plan.json`
- 输出 `repair-plan.jsonl`
- 输出 `manual-review-queue.jsonl`
- 输出 `repair-summary.json`

这个命令当前只负责 repair planning，不直接修改 process rows。

`tiangong-lca flow apply-process-flow-repairs` 现在已经承担 flow governance 的独立 deterministic repair apply 切片，负责：

- 复用与 repair plan 相同的 process / scope / alias / scan 输入契约
- 只应用 deterministic subset
- 输出 `patched-processes.json`
- 输出 `process-patches/<process-id__version>/before.json`
- 输出 `process-patches/<process-id__version>/after.json`
- 输出 `process-patches/<process-id__version>/diff.patch`
- 输出 `process-patches/<process-id__version>/evidence.json`
- 若传入 `--process-pool-file`，把 exact-version patched rows 同步回本地 pool，并在 `repair-summary.json` 记录 `process_pool_sync`

这个命令当前只负责本地 deterministic patch apply，不负责后续校验或远端写入；后续校验由 `tiangong-lca flow validate-processes` 承接。

`tiangong-lca flow regen-product` 现在已经承担 flow governance 的产品侧再生切片，负责：

- 读取本地 process JSON / JSONL 输入
- 读取一个或多个 scope/catalog flow JSON / JSONL 输入
- 在一个统一命令下执行 `scan -> repair plan -> optional apply -> optional validate`
- 输出 `flow-regen-product-report.json`
- 输出 `scan/`、`repair/`、`repair-apply/`、`validate/` 工件目录
- 在 `--apply` 后可选同步 `process-pool-file`

这个命令当前只负责本地 deterministic 再生产物链，不负责远端 publish/write，也不负责 round2 remote-validation retry。

`tiangong-lca flow validate-processes` 现在已经承担 flow governance repair 之后的独立 process patch 校验切片，负责：

- 读取 original / patched process rows
- 读取一个或多个 scope flow JSON / JSONL 输入
- 校验只允许 `referenceToFlowDataSet` 路径变化
- 校验 quantitative reference 保持稳定
- 可选复用 CLI 侧基于直接依赖 `@tiangong-lca/tidas-sdk` 组装的本地 TIDAS 校验器
- 输出 `validation-report.json`、`validation-failures.jsonl`

这个命令当前只负责本地 patch validation，不负责 repair 规划、apply 或远端写入。

`tiangong-lca publish run` 现在已经成为统一 publish 契约入口，负责：

- 读取 publish request
- 归一化 `bundle_paths` / 直接数组输入
- 统一 `dry-run` / `commit` 语义
- 输出 `normalized-request.json`
- 输出 `collected-inputs.json`
- 输出 `relation-manifest.json`
- 输出 `verification-report.json`
- 输出 `publish-report.json`

`publish run` 的 `out_dir` 路径规则固定如下：

- request 里的 `out_dir` / `output_dir` 与 CLI 的 `--out-dir` 覆盖值，只要是相对路径，都按 request 文件所在目录解析
- 如果希望输出位置不受 request 文件位置影响，传绝对路径，不要依赖当前 shell `cwd`

当前实现不会把旧 MCP 数据库写入逻辑重新塞回 CLI；但当提供 Supabase runtime 时，`lifecyclemodels` / `processes` / `sources` 会默认走共享的 dataset command executor：先做 REST 精确可见性预检，再调用 `app_dataset_create` / `app_dataset_save_draft`。如果调用方显式注入 executors，则仍以显式执行器为准。

Process 写入可在 `modelId` 之外携带可空的 `modelVersion`。`publish run` 会从 canonical Process 来源元数据中解析并原样持久化精确的 LifecycleModel 版本；只有旧输入缺少 `modelVersion` 时才保留“用 Process 自身版本作为 Model 版本”的兼容回退，任何路径都不允许改查最新 Model 版本。仅有 `modelVersion` 而没有 `modelId` 会在写入前失败。

`tiangong-lca validation run` 负责把本地 TIDAS 包校验统一收口到 CLI：

- `--engine auto`：走当前默认的 direct-dependency 校验路径，也就是 CLI 内基于 `@tiangong-lca/tidas-sdk` 组装的 package validator
- `--engine sdk`：显式固定到同一条 `@tiangong-lca/tidas-sdk` 校验链

这两个命令都不需要新增 `TIANGONG_LCA_*` 之外的环境变量。

## 开发模式

```bash
pnpm dev -- --help
```

说明：

- `pnpm dev` 仍可使用 `tsx` 做开发期直接运行
- 正式运行入口不再依赖 `tsx`，而是执行构建后的 `dist/` 产物

## 检查与测试

```bash
pnpm lint
pnpm peers:check
pnpm prettier
pnpm test
pnpm test:package
pnpm test:coverage
pnpm test:coverage:assert-full
pnpm prepush:gate
```

说明：

- `pnpm lint` 会执行 type-aware Oxlint、`prettier --check`、coverage-ignore 守卫、Data API consumer 扫描与 TypeScript 7 typecheck；ESLint 和 Compiler API lint 路径已经移除
- `pnpm peers:check` 要求整个 Node 24 依赖图不存在 peer mismatch
- `pnpm prettier` 用于实际改写格式
- `pnpm test` 包含普通单元测试和 `bin` / 入口 smoke test
- `pnpm test:package` 检查 pnpm/TS7/Oxlint 单轨契约、CI/release 命令、干净 tarball 与 package-manager-neutral consumer
- `pnpm test:coverage` 对 `src/**/*.ts` 执行 100% statements / branches / functions / lines 覆盖率门
- `pnpm prepush:gate` 是提交前的完整质量门，包含 lint、peer 检查、package contract、coverage 与 coverage assertion
- 不允许通过 `c8 ignore` / `istanbul ignore` / `v8 ignore` 这类 pragma 规避覆盖率；边缘情况必须在测试里覆盖

## 构建项目

当前 `build` 会把 CLI 源码编译到 `dist/`：

```bash
pnpm build
```

## 可执行入口

仓库内当前统一推荐三个稳定入口：

- `ppnpm start -- ...`
- `node ./bin/tiangong-lca.js ...`
- `node ./dist/src/main.js ...`

其中：

- `ppnpm start -- ...` 先构建，再走 `package.json` 里的 `bin["tiangong-lca"]`
- `node ./bin/tiangong-lca.js ...` 会加载 `dist/src/main.js`
- `node ./dist/src/main.js ...` 适合调试编译后的真实 runtime
- `ppnpm start -- ...` 是“先构建再运行”的开发便利脚本

## 与 skills 的联动约定

`tiangong-lca-skills` 后续不再各自维护独立 HTTP/MCP 入口，而是逐步收敛到这个 CLI。

当前建议：

- 轻量远程 skill 直接调用 `tiangong-lca search ...` 或 `tiangong-lca admin ...`
- `process-automated-builder` 已先迁入 `tiangong-lca process auto-build` 本地 scaffold；剩余阶段继续按子命令切片迁移
- `process-automated-builder` 的本地 resume handoff 也已迁入 `tiangong-lca process resume-build`；后续阶段继续按子命令切片迁移
- `process-automated-builder` 的本地 publish handoff 也已迁入 `tiangong-lca process publish-build`
- `process-automated-builder` 的本地 batch orchestration 也已迁入 `tiangong-lca process batch-build`
- `lifecyclemodel-automated-builder` 的 canonical skill 入口已切为原生 Node `.mjs` wrapper -> `tiangong-lca lifecyclemodel auto-build | validate-build | publish-build`；本地 local-run 组装、validation handoff、publish handoff 已迁入 CLI，剩余 discovery 继续按子命令切片迁移
- 其余重型 workflow 先保留原执行器，但由 `tiangong-lca` 统一调度
- 所有新脚本优先使用统一环境变量名，不再扩散旧变量名

## 示例请求文件

仓库已提供三份最小请求样例，便于 skills 和 agent 直接复用：

- `examples/process-auto-build.request.json`
- `examples/process-batch-build.request.json`
- `examples/lifecyclemodel-auto-build.request.json`
- `examples/publish-run.request.json`

## 当前目录约定

```text
tiangong-lca-cli/
  .env.example
  .nvmrc
  DEV_CN.md
  README.md
  bin/
  dist/
  docs/
  scripts/
  src/
  test/
```

## 详细说明

- [docs/IMPLEMENTATION_GUIDE_CN.md](./docs/IMPLEMENTATION_GUIDE_CN.md)
