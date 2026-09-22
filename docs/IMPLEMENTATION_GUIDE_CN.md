---
title: TianGong LCA CLI Implementation Guide
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
whenToUse:
  - when you need deeper historical implementation context for CLI command families, runtime design, or env behavior
whenToUpdate:
  - when implemented command families, runtime design conclusions, or maintainer guidance change materially
checkPaths:
  - docs/IMPLEMENTATION_GUIDE_CN.md
  - .env.example
  - DEV_CN.md
  - README.md
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - .oxlintrc.json
  - src/**
  - test/**
lastReviewedAt: 2026-09-21
lastReviewedCommit: 83189e2
lastReviewedNote: 'Reviewed for CLI #358 at head 83189e2: 实施指南补充 v2 有界精确指数十进制模块（无浮点、v1 不变），v2 wire 待 Database #673 提案。'
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ../DEV_CN.md
  - ./agents/repo-architecture.md
  - ./agents/repo-validation.md
---

#274 新增 `runtime describe --json` 与公开 `@tiangong-lca/cli/runtime` 模块，检查 CLI 包、资产和 Node 文件内容。runtime 命令不加载项目 `.env`，不登录、不下载；启动入口拒绝 macOS Intel，同时保留 Linux/Windows x64。组件 manifest、安装缓存、离线复用、lease/prune 和受控执行已由 #274 实现；无 Node 的 POSIX/PowerShell bootstrap 已实现并由相邻 lock 固定；公开组件和四平台 C1 仍需发行资格验证，见 [Runtime Distribution Contract](./agents/runtime-distribution-contract.md)。该 API 尚未随现有公开 0.1.9 发布。

# TianGong LCA CLI 实施指南

Review note, 2026-09-20: CLI #340 将 SDK 精确锁升级至已发布 0.2.2，公共规则绑定至 spec 0.2.1。`dataset contract/context-pack` 保留显式请求的 ruleset 文件、manifest 摘要和 AI 上下文路径，但内容由 CLI profile 与已验证公共定义组合；不再读取 SDK 的旧混合规则文件。Process Version 说明采用正式规范修正后的 NN.NN 与可选 NN.NN.NNN 语义。

Review note, 2026-09-21: CLI #358 新增 v2 Time alias 计划所需的**有界精确指数十进制**模块（mantissa ≤64 位、指数 ±30、bigint 归一、无浮点）及其匿名真实 shape 的 RED/GREEN 测试；纯增量，冻结的 v1 grammar/profile/常量/计划与响应形状/历史重放身份逐字节不变（测试同时钉住 v1 仍拒绝指数形态）。v2 wire（schema/计数/响应）待 Database #673 提案，不在本次决定。

Review note, 2026-09-21: CLI #350 将内置 18 份 schema 同步到 `tidas-spec` 0.2.2 精确候选 `8a9470a7dd4c074ae246bb9967b3bfae3e371e32`。Process 的 `validation.review` 可为单对象或非空有序数组；在 SDK #147 正式发布前，CLI 通过现有 SDK 0.3.0 逐项校验数组成员，保持输入与顺序不变，并把错误定位恢复到对应数组索引。LCIA Method 仍只接受单对象，CLI 包版本仍为 0.1.18。

Review note, 2026-09-18: CLI #338 将 Process 与 LCIA Method 的 `common:referenceToCompleteReviewReport` 收敛为可选字段；若提供，仍由 TIDAS schema 严格校验，Lifecycle Model 不变。CLI 在已发布 SDK 尚未同步候选 schema 的过渡窗口内，仅对“缺失该引用”的 Process/LCIA Method 校验做内存兼容重试；原始输入不修改，非法或已提供引用不放宽。该桥接不改变命令、公共包导出、版本或发布路径。

Review note, 2026-08-31: Issue #256 keeps package 0.1.5 and the existing implementation architecture while refreshing Supabase JS/tooling to the latest Node 24-compatible releases. TIDAS SDK is pinned exactly to npm-latest 0.2.0, peer checks join the pre-push gate, and Prettier 3.9's mechanical rewrite is isolated. Issue #257 owns the later version-only 0.1.6 publication.

Review note, 2026-08-25: Issue #224 把实现与验证工具链固定为 Node 24.19.0、pnpm 11.23.0、TypeScript 7.0.2 与 type-aware Oxlint。依赖只由根 `pnpm-workspace.yaml` / `pnpm-lock.yaml` 决定；不保留 TypeScript 5/6、ESLint 或 Compiler API 兼容路径。`test:package` 同时验证单轨工具链、干净 tarball 和 package-manager-neutral consumer。feature 版本保持 0.0.33；合并和完整门禁通过后，建议用单独的 release-only PR 准备 0.1.0。

Review note, 2026-08-25: Issue #228 把生产 case 前的认证边界收口为 `auth identity-receipt`。命令在 credential decode/session/network 前安全断言 canonical Supabase project，通过既有 API key/session runtime 获取 token，并对 redirect-disabled `/auth/v1/user` 做增量 byte cap 只读验证且要求 canonical UUID；401/403 只允许 force-refresh 后重读一次。回执 exact-key parser 只接受 safe projection 和 canonical hash，不包含 credential、token、完整邮箱、session path 或其 fingerprint。无 expected 参数是 `observed`，只有 expected project/user 都由 argv 提供才是 `intent-bound`。pnpm case 命令先 clean-build TS7；plain-Node runner 拒绝 alternate entrypoint，单次读取/hash source/config/lock 与 generated runtime/runner，把 exact built buffers 私有 snapshot 后才从 ignored Foundry env 选取三项变量、禁用 cache、使用独占干净 cwd 与 `shell:false` argv spawn，不保存 raw child output。

Review note, 2026-08-25: Issue #230 把本地、engines 和所有 Node workflow 的单轨版本从宽泛 Node 24 收敛为最新稳定 Node 24.19.0；这样 dev-only Sigstore 验证器、TS7/Oxlint、package test 与发布自动化共享同一个可复现的 minor 版本。

Review note, 2026-08-26: Issue #232 在不新增依赖、不改 0.1.1 版本的前提下增加 `@tiangong-lca/cli/command-spec` 与 `@tiangong-lca/cli/batch`。前者保持 Foundry v1 exact-key/canonical SHA/artifact bytes 与 `shell:false` 执行兼容，并在注入 spawn 同步抛错时清理外部 abort listener；后者在任何工作前完成全部 item identity/content/policy/resource projection，并在 resumed acceptance 与 fresh claim 前重投影 identity/content/policy/resource。identity 变化或 getter 抛错都稳定输出 `BatchItemIdentityDriftError` / `item_identity_drift` 且零执行，其他已启动 worker 必须 drain 后 batch 才返回。任一 worker 的 scheduler/event/stop 基础设施异常会同步设置 fatal/stop、禁止后续 claim；聚合器以 `allSettled` 排空已 claim worker，再抛首个记录错误。exclusive key 阻塞项保持 unclaimed、不占 worker，后续 free key 可先 claim，因此 claim order 反映真实资源调度，stop/pause 后的 `unclaimed_item_ids` 仍按输入顺序精确保留。每个资源使用 FIFO cursor，只把当前 head 放入私有 binary min-ready heap；完成或 pre-claim rejection 的 stop 判断结束后才暴露同 key 后继，使普通调度从反复全表扫描收敛到近 `O(n log k)`。mutation 自动重试仍被禁止。

`withBatchRunLock` 以 canonical run directory 作为唯一跨进程锁域，只允许当前 holder 所属且仍存活的 scope 嵌套重入；顶层 Promise 等待 detached nested scope 全部排空，已完成 scope 遗留的 async context 不能重入后来的 owner；live/foreign-host 锁不回收，本地 waiter 只在物理锁清理后接棒。公共 options 不暴露 PID、host 或 ownership clock，metadata 只从 `process.pid`、`os.hostname()` 与当前系统时间内部派生，强制注入额外字段也不能伪造 foreign-host stale recovery。CommandSpec timeout、run-lock timeout/poll、read retry policy/backoff 全部限制在 Node `2_147_483_647ms` timer 上限内；公共 lock timing 还必须是非负 safe integer。

Issue #247 将 OAuth/session 与普通状态文件共用的 `readStateLockMetadata()` 从 `existsSync` + `readFileSync` 改为一次读取：读取时 `ENOENT` 只表示并发 owner 已完成物理释放；权限、I/O 等其他错误继续原样抛出。空/损坏 metadata、stale owner、reentrancy、timeout、unlink cleanup 与文件权限合同均不变。

Issue #250 为 `readCachedSessionRecord()` / `writeCachedSessionRecord()` 增加仅内部可用的可选 platform 参数，默认仍为 `process.platform`。测试在所有 host 上显式执行 `linux` 与 `win32`，从而同时覆盖 POSIX public-mode 拒绝、目录/文件 chmod 与 Windows 跳过目录 chmod；运行时代码不传该参数，session schema、atomic rename、token、公开 API、依赖及认证语义均不变。

`dataset save-draft --execution-contract` 只把 unique-target parallel suffix 的 resource-aware claim/fatal-stop 调度接入公共 batch engine。依赖 prefix 仍逐项串行；`executeAction` 继续独占 before-state、PREPARED、token renewal、DML、append-only attempt/outcome、exact readback 与 no-replay 判断。因此 rows 的输入顺序、progress/failures/summary 字节和 fatal worker 传播保持原契约；blocked target 不消耗 worker 或越过 stop claim 窗口。

Review note, 2026-09-21: CLI #354 在执行合同内新增有界的既有草稿 support 元数据修复。仅 `save_draft` 合同 action 可进入；fresh before 与 candidate 必须同时通过全部四层校验，数据集 id/version、引用 id/version/URI、语言结构与单位/因子/引用性质保持完全一致，唯一允许的改动是该行自身 ownership/source 引用的既有 `common:shortDescription.#text`。写入复用同一 guarded before-image 传输、attempt/no-replay ledger 与 exact readback，行报告 policy 为 `support-reference-metadata.v1` 且 `ruleVerification` 保持 `true`；ledger 中的 admission 必须与其表所属 policy 匹配。其余 support 行的 reference-only 拒绝、insert、已发布行、科学/引用改写与非合同命令完全不变。部署侧 guarded facade 已支持两张 support 表并复用同一 writer，无需新的 Edge/Database 能力。本次为 source 变更，不属于 0.1.19 版本发布。

Review note, 2026-09-21: CLI #283（workspace #1432 战役）追加两件事。(1) 窄 existing Process draft metadata admission（新模块 `dataset-draft-repair-admission.ts`）：仅 execution-contract 的 `save_draft` 可进入；必须 fresh 读取完整 before 并验证 owner/state0/before_sha 后才判定。before 与 candidate 的 schema/content/multilingual 必须 passed，authoring 失败只能是 `annual_supply_or_production_volume_missing`，且双方 `annualSupplyOrProductionVolume` 必须严格为 `[]` 且不变；唯一允许的 delta 是两个既有引用节点的 `common:shortDescription.#text`（单节点或数组皆可，但数组长度/顺序、lang、引用 ID/version/URI、其余字段必须完全一致，且至少一处真实变化）；names/amount/units/exchanges/geography/classification 一律不准入，缺失 annual 字段自动变 `[]` 也不属于例外。准入的行仍走完整 before 的 guarded 传输，但 `ruleVerification=false`（仅此例外），并在行报告写入内容绑定的 `draft_repair_admission`（schema `dataset-draft-repair-admission.v1`、policy `process-metadata-unknown-annual.v1`、before/desired SHA-256、`changed_paths`、`publication_ready:false`）；报告保留 `validation.ok=false` 与 authoring failed，不伪造 ready。insert、无合同命令与其它任何 blocker 仍严格走原准入；dry-run 同样在 fresh before 后给出 admission 但零派发。(2) before 侧真实校验 + admission 的 ledger 绑定：准入判定除结构 diff 外，还会用**同一个真实 validator**（对 clone，保证 fresh before 字节与哈希不变）复核 stored draft——before 若 schema/content/multilingual 失败、authoring 含 annual 以外的 code、或引用描述为空/占位（即便 candidate 文本能"修好"它），一律拒绝；admission 不再只看结构相似。已验证的 admission 在首次 `attempt_emitted` 事件前写入该事件并纳入其哈希绑定（可选字段，旧事件严格兼容）；恢复（crash-after-dispatch-before-outcome、或已有 outcome 的重跑）从原 attempt 读回原 admission 并带回行报告，绝不用当前已是 desired 的 fresh before 重新发明原 before；篡改/丢失/语义漂移（before/desired 与 action 不符、`publication_ready` 非 false、未知 schema/policy、空 `changed_paths`）都会被 ledger 校验拒绝，历史无 admission 的普通 attempt 依然兼容且不伪造 admission。(3) attempt ledger 优先于 validation 分类：当前 validator 拒绝的候选若已有 attempt/outcome，不再报 `attempt_consumed=false` 的 failed 行，而是按 ledger 只读表达（commit：按读回判 `executed`/`UNKNOWN` 且 `attempt_consumed=true`；dry-run：`blocked` + `retained_attempt`/`retained_outcome`），报告字节与既有 ledger 均不被掩盖；无 attempt 的行分类完全不变。

Review note, 2026-09-21: CLI #283（workspace #1432 战役）加入 guarded before-image 运输与 execution-contract dry-run。每个 `save_draft` action 把本轮 fresh read 且通过 owner/state0/before_sha 校验的**完整 before JSON** 作为 `expectedJsonOrdered` 交给 `saveDraftDatasetRecord`；平台在行锁内做 JSON 值比较，stale/变更/非 draft 一律拒绝（`DATASET_BEFORE_CONTENT_CHANGED` 等）。禁止 guard 失败后 fallback 到旧 RPC 或重试：attempt 已持久化，结果只由 exact readback 判定，行状态为 `UNKNOWN`。缺省 `expectedJsonOrdered` 时 legacy body 逐字节不变。合同在执行合同模式下新增 `commit` / `dry_run` 两种运行：dry-run 需要真实 auth 与 env/fetch 绑定，执行 owner/state/before/content/reference preflight，但不派发任何命令、不创建 attempt 与 ledger、不进入 parallel suffix 调度。依赖语义按模式区分：commit 仍要求前置 action `executed`；dry-run 接受前置 action 在本轮 preflight 中 `prepared`，因此两个现存 owner draft 的依赖链可完整逐项验证；根 action 失败仍阻断后代。dry-run 只读加载 ledger：已有 attempt/outcome 的 action 报 `blocked` + `retained_attempt`/`retained_outcome`，绝不退回 `prepared`。当前置 insert 尚未执行、后续 action 的远程引用因此缺失时，明确报 `blocked_dependency`（绝不伪造远端存在），其余缺失引用仍按真实失败处理。报告为 `mode: dry_run` + `commit: false`，closeout 永远无法把它当作已执行导入。

Review note, 2026-08-26: Issue #233 对公共 batch 做纯移动式模块化。`src/batch.ts` 只从内部 owner 逐项 re-export，因此函数/类对象身份与 `instanceof` 不变；`types`/`errors` 为叶层，`canonical-contracts` 向上提供 JSON/hash/contract，`run-lock` 与 `scheduler-runtime` 相互独立，`item-projection`/`attempt-recovery` 复用叶层，`engine` 是唯一协调顶层。`test/public-batch-architecture.test.mjs` 与 shrink-only budget fixture 固定 62 行 facade、最大 445 行内部模块、精确 allowed edges、禁止回引 facade/CLI/dataset owner、零 SCC，以及公开 runtime/type/declaration/error/event/result 契约。无新依赖、版本、lockfile、npm/yarn 或发布路径；pnpm 11.23.0 与 TS7 单轨不变。

Review note, 2026-08-26: Issue #236 只更新精确 package-manager contract：manifest、engine、release verifier、静态测试和 active docs 统一到 pnpm 11.24.0。使用该版本执行 lockfile-only reconciliation 后唯一根 lock 无字节变化；Node 24.19.0、唯一 TypeScript 7.0.2 图、包版本 0.1.1、dependencies、public exports/runtime、tag 与 publication 均保持不变，且不新增 npm/Yarn 或 alternate lock。

Review note, 2026-07-30: Issue #214 将 identity preflight 的远程检索参数收敛为单一 `lexical_weight`，并把 derivative snapshot/readback 依赖收敛到 `extracted_md`、`embedding_ft` 与 `embedding_ft_at`。既有 owner-draft、一次性 admission、独立 readback 与 fail-closed 规则保持不变。

Review note, 2026-09-22: CLI #364 绑定版本化（v2）protected 批准时间：`src/lib/dataset-alias-v2-protected.ts` 的 approval-request core 新增由 freeze 时钟指定的 canonical `approved_at_utc`（参与 `request_sha256`），人类可见文本把它命名为 request 指定的批准时间戳、与精确内容一同被接受、seal 必须原样复用；`sealAliasV2Approval` 校验并通过 `ALIAS_V2_PROTECTED_APPROVAL_TIME_INVALID` / `..._TIME_MISMATCH` 拒绝非法或不同的时间戳，`parseAliasV2ApprovalRequest` 对绑定前缺少该字段的 request 以 `ALIAS_V2_PROTECTED_APPROVAL_REQUEST_UNBOUND_TIME` 明确拒绝（要求重新 freeze，不静默升级）。批准文本由唯一 renderer 依据 request 自身字段重建，builder/parser/seal 共用；文本与字段不一致（含 root 复核中"重算 request 摘要但保留原文字"的自洽改时）以 `ALIAS_V2_PROTECTED_APPROVAL_TEXT_MISMATCH` 拒绝。已封存 approval 形状不变、旧 sealed 仍可 status-only 恢复；服务端信封、计数、一次性 runtime、v1、依赖、版本、workflow 与发布规则不变，无数据库迁移。

Review note, 2026-09-22: CLI #359 新增封闭的 **Length\*time** 修正 profile（`dataset-length-time-plan.v1`），作为版本化 protected 生命周期的第二个使用者。`plan --length-time-input` 由 reviewed 规划输入构建 plan：13 个 owner-draft Process action 的 39 个选中 occurrence 按固定因子 1000 移动其两个绝对量叶子（`kmy` → `m*a`，改动前两叶子字节相等），13 个只读 Product flow 仅作为 `{id, version, sha256}` 证据随 plan 传递，不产生任何 flow/text/no-op action。profile 只由 plan 文档自身的 `schema_version` 选择——Time plan 保留其 reviewed 判定、Length plan 使用自己的判定，互不放宽；共享的 freeze/approval/request/admit/read 信封、三项 gate、180 秒窗口与单次 admission 策略完全不变，freeze 仍为 13 键信封，Length plan 使用 wire 固定的 `{flowproperty, unitgroup}` target 投影。源编号只从真实语料的锚定声明读取（`Source EcoSpold1 exchange number: <N>.`，仅一次声明，后缀原样保留且从不扫描数字），不确定度两项为可选且逐字节保留（39 个 occurrence 中 13 个无分布、35 个无标准差），单位组因子按 exact decimal 比较（`1.0`、`1000.0`）。仓库内共享合成 cohort fixture 复现这些真实形状，两侧共享同一份 source comment 向量表。`src/**` 覆盖率保持 100%；生产使用仍需数据库侧对应能力与协同发布，未部署、未执行。CLI 侧已通过 root 的真实语料 plan oracle 与数据库 owner 对同一份产出文档的联合执行。

Review note, 2026-09-21: `dataset maintenance` 增加版本化（v2）Time alias 路径：`plan --alias-v2-input` 构建 `dataset-alias-plan.v2` plan/batch，v2 plan 的 `freeze-protected` 要求 reviewed 六键 `--derivative-baselines` 并派生版本化 freeze，`seal-protected-approval` 保持字节级离线封装，`run-protected` 由 seal schema 选择链路。v2 沿用真实 v1 protected 信封（十二键 preflight、180 秒窗口三项 gate、单次 admission POST、unknown 只能经有界 read 恢复），`expected` 为真 v1 十个 flat count 加版本化 `text_action_count` 且不再有调用方声明 closure，derivative target 必须逐行对应 plan 改动身份；源单位区分在 plan 中显式命名为 declared vs original。CLI 侧已实现并本地验证，生产仍需数据库侧能力与协同发布。

Review note, 2026-07-12: `dataset maintenance plan/apply/verify` 已把 BAFU `time` / `length_time` FP alias 迁移固化为两个不可拆分的 owner-draft guarded batch。scope/plan 强制 `target_mode=owner_draft`，RPC/审计/replay/readback 强制 `target_visibility=owner_draft`；52 行、59 条 exchange、精确十进制换算、309 条无关 exchange、owner/state、payload/modified_at/hash 与目标引用 postcondition 都属于不可变计划契约。该操作不再依赖或执行 FP/UG 发布。

Review note, 2026-07-13: maintenance account scan 已统一为 fail-closed exact-count paginator。requested page size 可以大于 PostgREST 实际 cap，offset 以实际返回行数推进；只有 `Content-Range` exact total、range/body、严格排序、行身份和全表汇总全部证明完整后，plan/approval/readback artifact 或 mutation 才能继续。该多请求证明不等于事务级/MVCC 同时点快照。

Review note, 2026-07-14: `rebuild-derivatives` 已进入 maintenance v1 固定契约。它只接受一个 current-owner、`state_code=0`、`table=processes`、`action=rebuild_derivatives`、`target_mode=owner_draft` 的 exact row，components 必须恰好为 `extracted_md` 与 `embedding_ft`。plan 冻结 action-scoped DB snapshot；apply 只通过 guarded RPC 获得 durable `accepted`/`queued`，不宣称重建完成；verify 独立输出 `pending`/`passed`/`failed`。本路径不写 primary process，也不允许 Edge/admin/raw queue/SQL/REST mutation fallback。

Review note, 2026-07-15: `dataset maintenance run-protected` 为 seal 绑定且已经人工批准的 private alias 计划增加 production-only 的一次性执行与恢复契约。受保护写入由服务器调度，并以认证 owner 及精确 actor/user_id/state_code=0、plan/closure 栅栏限制范围；RLS 继续保护公开入口与独立读回。它在 preflight 前完成完整扫描，随后使用服务器给出的三项 gate 期望摘要与最长 180 秒 token 捕获 live receipt，写入 immutable attempt marker 后最多发送一次 admission POST；marker 或不明确 admission 响应之后只能 `--status-only`。终态必须精确证明 52 行、59 exchanges、55 audits 与 50 个 derivative targets（23 flows + 27 processes），且不回退 dev、旧 alias RPC、发布或 state-code 修改。

Review note, 2026-07-15: `dataset maintenance freeze-protected` 与 `seal-protected-approval` 把生产只读冻结和人工批准记录拆成两个不可混淆的命令。前者只对显式确认的 production project 做完整 owner-draft census/support/projected-reference 与 23+27 derivative snapshot 读取，输出未批准请求，绝不 preflight/gate/admit/mutate；后者不接收 env 或 HTTP client，只按原始 UTF-8 字节核对人类返回文本及 freeze/request/text/account/timestamp 后生成 approval。真正执行仍只属于后续 `run-protected`。

Review note, 2026-07-16: `run-protected` 的 preflight proof 客户端时间校验允许服务端 `completed_at` 最多领先本机 5 秒，仅用于吸收正常时钟偏差。过期、时间倒序、超过 180 秒、foreign 或 malformed proof 仍在 gate/marker/admission 前阻断；数据库继续用 server clock 强制 token 到期与一次性消费。错误只输出 `completed_at`、`expires_at`、观察时间和差值等无 token 诊断，不持久化或暴露 preflight token。

Review note, 2026-07-16: `dataset maintenance flow-identity capture|plan|freeze|seal-approval|run|verify` 是 BAFU Step 3 的独立原生 CLI 工作流，不复用 Step 2 runner 或 generic apply。capture 对 owner-draft process 做一次完整 census，但只持久化 reviewed reference closure，并仅发送一次 semantic attestation POST；不在客户端抓取 derivative baseline。plan 只接受 post-Step2/post-#29 的 305-source v3 review、精简 capture 与不可变 DB receipt。run 的 process 请求只含 ordinal/scope proof/process-intent proof/request hash，具体 rewrite 与 derivative baseline 由 DB receipt/ledger 持有；并发固定为 1。primary batch 后先只读等待 derivative causal/current closure：pending、failed 或 compensation 状态都不发送 finalize，只有 ready 才在本 invocation 最多发送一次 finalize；歧义或 readiness race 不自动重放 process/finalize。verify 独立证明 source/public/support 不变、目标 process 精确、approved-source residue 为 0、protected closure 不变且 derivative causal terminal。derivative failed/stale 必须停机，任何补偿都要另建 derivative-only plan、重新 freeze 并取得新的精确批准。

Review note, 2026-07-17: Step 3 COMMON 契约进一步 fail-closed。`dataset-flow-identity-prerequisites.v2` 必须分别携带 Step 2、Issue #29 target 1、Issue #29 target 2 的 `status=passed`、readback SHA-256 与完成时间；两个 #29 derivative target 不能合并成一个证明。authenticated RPC 的 HTTP 请求成功但 JSON body 为 `ok:false`、且含合法 `code`/`status` 时，是确定性 domain rejection，不是 transport ambiguity：capture/preflight/process/finalize 都写不可变 rejection 证据且不自动重投。process rejection 后只执行一次 fresh `readScope` 并校验已完成 request；读失败为 `indeterminate`，已有 primary write 时只能做 fresh status read 与 operator-approved scope recovery，不能重新 capture，零完成也必须 operator review。独立 verify 仅在数据库状态恰为 `derivatives_pending` 且没有其他硬性 readback mismatch 时报告 `pending`，其余未通过结果为 `failed`。

finalize request 绑定 fresh whole-scope proof，attempt/domain-rejection/proof/transport-error 文件都以 restricted request SHA-256 固定寻址。数据库现在为唯一 live wrapper 签发 permit，并在每次成功 process/finalize 后轮换；CLI 只在内存持有 permit，proof/artifact 不落 bearer。create-only 本地 approval claim 仅作纵深防御。permit 或 preflight 响应丢失后，必须重新冻结并取得精确 recovery approval，并可通过 exact read-only lookup 找回同一 actor-owned scope。尚余 merge、Preview 验证和 DB/CLI 协同发布门禁。

Review note, 2026-07-16: Issue #182 修正 protected 终态验证中的 JSON hash 域混用。独立 RLS row 继续用 CLI canonical hash 对齐 approved plan；已经过 closure SHA 校验的 primary `action_evidence` 用 PostgreSQL `jsonb::text` hash 对齐 fresh derivative snapshot；snapshot SHA 再对齐 terminal completed proof。不同序列化域不直接比较，证据缺失、重复、身份/owner/state/JSON 标志错误或任一同域 hash 漂移仍 fail-closed；数据库/RPC 与一次性 admission 契约不变。

Review note, 2026-07-16: Issue #186 将 LCI/LCIA 数据发布的远程执行面收口为 `release` 命令族，但不把 20-stage release workflow、TIDAS identity/version 规则或包闭包算法复制进 CLI。CLI 复用用户 API key 换 session，服务端检查 `data_product_manager`，本地严格校验 Unit Process 与 standalone LifecycleModel+Result 两类包的 TIDAS/ILCD 四个 ZIP，并对 Calculation Bundle/ZIP 下载执行 exact-path、byte-size 与 SHA-256 校验。service-role 不属于该命令契约。

Review note, 2026-07-23: Issue #194 为通用 `dataset save-draft` 增加 opt-in execution contract。V1 将 session project/owner/state 0、有序 input rows、before/desired hashes、insert/update 操作和依赖绑定为一个离线 JSON 合同；每个 `action_id@desired_sha256` 使用稳定的用户状态 action ledger。首次 dispatch 前落盘 attempt，之后的模糊响应、孤立 attempt 或进程恢复只允许 exact owner readback，不允许自动重放；失败依赖不会阻止无依赖 action 继续。

Review note, 2026-07-23: Issue #196 在发布 0.0.30 前补齐 Windows 持久化兼容性。execution ledger 的首次创建和后续追加均在可写文件描述符上完成写入与 `fsync` 后再关闭，不再重新以只读方式打开后执行 Windows 会拒绝的 `fsync`。attempt-before-dispatch、每行事件顺序、exact readback 恢复及成功行不重放语义保持不变。

Review note, 2026-07-23: Issue #198 发布 0.0.31 并将 SDK schema/entity 校验隔离到 payload 深拷贝。原始 JSON 不再被校验器隐式补默认值，execution-contract SHA、受保护 command dispatch 与 exact owner readback 始终引用同一输入；无效行仍在 prepared failure 阶段被拦截，owner/state/project、attempt-before-dispatch 与不重放语义不变。

Review note, 2026-07-24: Issue #200 发布 0.0.32，为大规模 execution contract 增加显式 `--max-parallel 1..8`。调度器先找出所有 dependency 所引用 action 的最大序号，该序号及其之前的完整前缀严格串行并完成 exact readback；只有后续 table/id/version 唯一的 suffix 可以有界并发。每次 DML 前通过既有 session runtime 取得当前 token，并再次核对 user/email；续期成 foreign owner 时在 attempt=0 阻断。每行独立 protected transaction、ledger、UNKNOWN/成功不重放与全部写入禁止项不变。

Review note, 2026-07-24: Issue #202 发布 0.0.33，为 BAFU flow 物理收敛增加显式 `maintenance apply --max-parallel 1..8`。该模式只接受 flow delete-only、目标唯一、current/projected impact 为零的计划；dispatch 前完成全部 RLS 可见 process 的 fresh SELECT-only 入边复核。`PREPARED/DISPATCHED/COMMITTED/UNKNOWN` 逐行留痕，exact absent 才成功，成功和 UNKNOWN 均不自动重放，独立行继续。

Review note, 2026-07-24: Issue #204 将上述全可见 process 入边复核固定为每页 250 行，以避免大 JSON 页触发生产语句超时；查询仍不带 `user_id` 过滤，必须完成 exact-count 全量分页后才允许 dispatch。

Review note, 2026-07-25: Issue #206 将该完整 RLS 可见 process 扫描的稳定顺序收敛为全局唯一主键 `(id, version)`，让数据库直接走既有索引，避免冗余 owner/state 全结果排序；无 `user_id` 过滤、exact-count 完整性和首写前全局入边阻断均不变。

Review note, 2026-07-25: Issue #208 允许同一纯 flow-delete 模式显式接收 30 分钟内的全库 process SELECT-only 入边证明。文件字节必须以 SHA-256 精确审批，并绑定 project、actor、plan、完整有序目标集合和连续分片；任何入边、P0/P1、身份/哈希/时效/覆盖异常都在 approval 和 dispatch 前 fail-closed。CLI 不执行证明 SQL，未提供证明时保持原 RLS 全可见扫描。

## 1. 目标

`tiangong-lca-cli` 是 TianGong 的统一执行面。

它解决的不是“有没有脚本”，而是：

- agent 的动作空间过大
- skills、shell、HTTP、MCP、Python 执行器的入口过碎
- 同类能力缺少统一参数风格和环境变量约定
- 质量门没有收敛到一个稳定仓库

本仓库的设计结论很明确：

- 用 TypeScript 直接实现 CLI
- 不把 MCP 作为 CLI 内部传输层
- 优先 Node 24.19.0 原生能力
- 优先文件输入、结构化 JSON 输出
- 把 `tiangong-lca-skills` 收敛成这个 CLI 的调用方，而不是并行产品面

MCP 替代策略也固定为两条：

- 策略 1：对业务 API 直接调用 `tiangong-lca-edge-functions`（Edge Functions / REST）
- 策略 2：对 Supabase 直接访问时不再经过 MCP；CLI 直接依赖官方 `@supabase/supabase-js`，并在此基础上保持 deterministic 的读写语义、URL 形状和报告契约

database-engine Issue #422 将策略 2 收口为 `src/lib/supabase-data-api-contract.ts` 的单一冻结 manifest/adapter；Issue #589 在同一合同内加入 Process 精确 Model 版本写入。九张 core relation 明确固定在 `public`，16 个 authenticated RPC 必须使用 exact `api` signature 和显式 profile header；默认且唯一支持的 profile 是 `api-contract-v1`。`scripts/scan-data-api-consumers.ts` 是静态 consumer-zero gate，任何 raw RPC route、硬编码 public profile、未登记 relation/RPC 或退休的 private alias executor 消费都会失败。合同精确绑定 database-engine commit `1320dcc506fe37af6b625ae30fbe0bec38cf87c6`、migration head `20260902104500`、migration tree 及关键 migration SHA-256，且 `contractReady=true`。GET/HEAD 与 manifest 中显式标为 read 的 RPC 仅可在 401/403 后 refresh/replay 一次；relation write、mutation/unknown RPC 不自动重放。`private.cmd_dataset_alias_plan_guarded(jsonb)` 不对 CLI 暴露，alias production path 仅使用受保护 execution 四个 façade；未冻结的新签名仍不得在 CLI 猜测。

Process dataset command 还可以随 `modelId` 传入可空的 `modelVersion`。新 resulting Process 必须保留来源 LifecycleModel 的精确 id/version；旧输入缺少版本时才由数据库继续使用 Process 自身版本回退。版本不能脱离 id 单独出现，也不能通过“查询最新 Model”补齐。

这两条是并行可选策略，不再引入新的 MCP 中间层。

## 2. 当前落地范围

### 2.1 已实现命令

```text
tiangong-lca
  doctor
  auth
    identity-receipt
  search
    flow
    process
    lifecyclemodel
  flow
    get
    list
    identity-preflight
    remediate
    publish-version
    publish-reviewed-data
    build-alias-map
    scan-process-flow-refs
    plan-process-flow-repairs
    apply-process-flow-repairs
    regen-product
    validate-processes
  process
    get
    identity-preflight
    auto-build
    resume-build
    publish-build
    batch-build
  dataset
    validate
    curation-queue build
    curation-queue next
    curation-queue verify
    references rewrite
    maintenance plan
    maintenance apply
    maintenance freeze-protected
    maintenance seal-protected-approval
    maintenance run-protected
    maintenance verify
  lifecyclemodel
    auto-build
    validate-build
    publish-build
    save-draft
    graph
    build-resulting-process
    publish-resulting-process
    orchestrate
  qa
    process
    flow
    lifecyclemodel
  publish
    run
  validation
    run
  release
    prepare
    upload
    finalize
    approve
    publish
    readback-verify
    unpublish
    status
    current
    calculation-bundle
    calculation-artifact
    artifact-download
  admin
    embedding-run
```

对应关系：

| CLI 命令 | 当前后端能力 |
| --- | --- |
| `tiangong-lca doctor` | 本地环境诊断、`.env` 加载、统一 env 合同检查 |
| `tiangong-lca auth identity-receipt` | 既有用户 API key/session bootstrap + bounded live `/auth/v1/user` 只读证明；输出 secret-free canonical receipt，生产必须同时绑定 expected project/user argv |
| `tiangong-lca search flow` | `flow_hybrid_search` |
| `tiangong-lca search process` | `process_hybrid_search` |
| `tiangong-lca search lifecyclemodel` | `lifecyclemodel_hybrid_search` |
| `tiangong-lca flow get` | 统一 CLI 持有的只读 flow 详情读取面；从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase 目标并通过原生 `@supabase/supabase-js` 按 `id/version/user/state` 读取 |
| `tiangong-lca flow list` | 统一 CLI 持有的只读 flow 枚举面；通过原生 `@supabase/supabase-js` 保持稳定过滤/排序/分页语义 |
| `tiangong-lca flow identity-preflight` | 本地 flow 生成前身份预检入口；比较 target 与候选 flow rows，输出 `IdentityDecision`、candidate match evidence 和 blocker/manual-review 状态 |
| `tiangong-lca flow build-plan` | 本地 flow build plan gate；校验 identity/evidence/name/flow-property 合同，并在 materialize 时输出 `GateReport` 与 deterministic canonical `flowDataSet` artifact |
| `tiangong-lca flow remediate` | 本地 flow governance round1 deterministic remediation、artifact-first 输出 |
| `tiangong-lca flow publish-version` | 统一 CLI 持有的 remediated-flow publish/update 入口；先用 `FlowSchema` 写出 `flow-publish-version-gate-report.json`，通过后再执行 REST 精确可见性预检 + Edge Function dataset command (`app_dataset_create` / `app_dataset_save_draft`) 并写出稳定 success/failure artifacts |
| `tiangong-lca flow publish-reviewed-data` | 统一 CLI 持有的 reviewed publish preparation 入口；支持 flow unchanged skip、flow/process append-only bump / current-version upsert、process flow-ref rewrite、本地 `publish-report.json`、flow gate 摘要与兼容的 flow success/failure artifacts，并在 commit 时复用共享 dataset command writer |
| `tiangong-lca flow build-alias-map` | 独立 deterministic alias map 入口；从 old/new flow snapshots 与可选 seed alias map 生成 alias plan、manual queue 与稳定 alias map |
| `tiangong-lca flow scan-process-flow-refs` | 独立 process ref 扫描入口；对 local process rows 做 scope/catalog/alias 分类并写出 scan artifacts |
| `tiangong-lca flow plan-process-flow-repairs` | 独立 deterministic repair planning 入口；从 process/scope/alias/scan 契约生成 repair plan |
| `tiangong-lca flow apply-process-flow-repairs` | 独立 deterministic repair apply 入口；应用 deterministic subset、写出 patch evidence，并可同步本地 process pool |
| `tiangong-lca flow regen-product` | 本地治理后 process-side 再生产物入口；在一个命令下执行 scan / repair / apply / validate 并输出稳定 artifacts |
| `tiangong-lca flow validate-processes` | 本地治理后 patched process rows 的独立校验入口；校验 flow ref-only diff、quantitative reference 稳定性，并可选复用 `tidas-sdk` |
| `tiangong-lca process get` | 统一 CLI 持有的只读 process 详情读取面；从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase 目标并通过原生 `@supabase/supabase-js` 按 `id/version` 读取 |
| `tiangong-lca process identity-preflight` | 本地 process 生成前身份预检入口；比较 target 与候选 process rows，输出 `IdentityDecision`、exchange fingerprint evidence 和 blocker/manual-review 状态 |
| `tiangong-lca process build-plan` | 本地 process build plan gate；校验 identity/evidence/name/reference-flow 合同，并在 materialize 时输出 `GateReport` 与 deterministic canonical `processDataSet` artifact |
| `tiangong-lca process auto-build` | 本地 `process_from_flow` intake、run-id 生成、artifact scaffold 和初始 `process-build-plan.json` 预写 |
| `tiangong-lca process resume-build` | 本地 `process_from_flow` resume handoff、state-lock/manifest 收口、resume 元数据与报告输出 |
| `tiangong-lca process publish-build` | 本地 `process_from_flow` publish handoff；先用 `ProcessSchema` 写出 `reports/process-publish-schema-gate.json`，通过后再产出 publish bundle/request/intent 并更新 state/invocation/handoff |
| `tiangong-lca process batch-build` | 本地 `process_from_flow` batch manifest 编排、批量调用 auto-build、batch report 输出 |
| `tiangong-lca dataset validate` | 本地 support / flow / process / lifecyclemodel rows 的统一 TIDAS SDK validation 与稳定报告输出 |
| `tiangong-lca dataset classification` | 本地 TIDAS 分类/位置编码治理入口；从 bundled schema 步进列子类、解析 path、审计 `tidas_locations_category.json` 位置编码，并可 deterministic apply AI/human decision |
| `tiangong-lca dataset curation-queue build/next/verify` | 本地 Foundry external dataset import 的 entity-level curation queue 状态机；`build` 输出 manifest、tasks、locks、blockers、per-entity input/closure/run-plan artifacts，`next` 基于 checkpoint 返回下一条 runnable entity task，`verify` 校验 scoped checkpoint 完成度；不执行 AI、不写远端 |
| `tiangong-lca dataset import-lca convert` | 外部 LCA 包导入入口；只调用统一 Rust `tidas import`，先验证 `tidas.operation-report.v1` 与稳定 `0.2.x` 版本，再消费 `tidas.import-execution-report.v1`。格式检测、转换、validation、bounded spool、cancellation 与 atomic publish 均属于 Rust；TypeScript 只做 binary/config 发现、参数翻译和稳定 exit/report 适配 |
| `tiangong-lca dataset references rewrite` | 本地 process / lifecyclemodel rows 的 flow reference rewrite、patch evidence 输出，并可选走 state-aware save-draft commit |
| `tiangong-lca dataset save-draft` | 通用 canonical dataset dry-run/save-draft 入口；可选 `--execution-contract` 将 project/owner/state 0、输入顺序、before/desired hashes、预期 insert/update 与依赖绑定到稳定 action ledger，并以 exact owner readback 收口模糊响应且不重放 |
| `tiangong-lca dataset maintenance clear-account` | 已实现的当前账号 draft 清理入口；先生成当前用户 RLS 可见 snapshot，默认 dry-run，只有显式 `--commit --confirm <当前账号邮箱>` 才按 `lifecyclemodels -> processes -> flows -> sources -> contacts` 顺序执行。普通 dataset rows 通过 `app_dataset_delete` / `cmd_dataset_delete` 删除，读回验证剩余行数；`unitgroups` / `flowproperties` 默认保护不删 |
| `tiangong-lca dataset maintenance plan/apply/freeze-protected/seal-protected-approval/run-protected/verify` | 已实现的 row-level 维护入口；版本化（v2）Time alias 选择由 `plan --alias-v2-input`（`dataset-alias-plan.v2` plan/batch）、v2 plan 必备的 `freeze-protected --derivative-baselines`、离线 `seal-protected-approval` 与按 seal schema 分派的 `run-protected` 组成，其 `expected` 为真 v1 十个 flat count 加 `text_action_count`，无调用方声明 closure，且 derivative target 必须恰好是 plan 改动的行身份。普通 V1 维护通过当前账号 RLS 冻结 exact draft rows 并走平台 `save_draft` / `delete`；固定 BAFU protected profile 先由 `freeze-protected` 直接读取 production owner-draft 状态并生成未批准请求，再由完全离线的 `seal-protected-approval` 记录人类逐字节批准，最后只能由服务器调度的 `run-protected` 以唯一 durable attempt/admission identity 执行和恢复。写入以 actor/user_id/state_code=0 与精确 plan/closure 栅栏保护，RLS 用于公开入口和独立读回；`rebuild-derivatives` V1 仍只允许一个 owner-draft process。所有路径共享不可变 plan、显式审批、durable proof 与独立 readback，且不发布 FP/UG |
| `tiangong-lca lifecyclemodel auto-build` | 本地 lifecyclemodel local-run intake、graph 推断、reference process 选择、`json_ordered` artifact 输出 |
| `tiangong-lca lifecyclemodel validate-build` | 本地 lifecyclemodel build run 校验重跑、per-model 校验报告与 aggregate report 输出 |
| `tiangong-lca lifecyclemodel publish-build` | 本地 lifecyclemodel publish handoff、publish bundle/request/intent 产出、validation 摘要复用 |
| `tiangong-lca lifecyclemodel save-draft` | 本地 lifecyclemodel rows 的 schema validation、dry-run bundle 输出与可选远端 save-draft 写入 |
| `tiangong-lca lifecyclemodel graph` | 本地 lifecyclemodel graph / DOT / SVG artifact 输出与连接检查报告 |
| `tiangong-lca lifecyclemodel build-resulting-process` | 本地 lifecycle model resulting process 聚合、内部 flow 抵消、artifact 输出 |
| `tiangong-lca lifecyclemodel publish-resulting-process` | 读取 resulting-process run，生成 `publish-bundle.json` / `publish-intent.json` 本地交付物 |
| `tiangong-lca lifecyclemodel orchestrate` | 递归装配的 plan / execute / publish-handoff 命令；写出 graph/lineage/publish bundle 工件，并只调用原生 CLI builder slices |
| `tiangong-lca qa process` | 本地 process QA、artifact-first 报告输出、可选 CLI LLM 语义审核 |
| `tiangong-lca qa flow` | 本地 flow governance QA、rows-file 物化、artifact-first 报告输出、可选 CLI LLM 语义审核 |
| `tiangong-lca publish run` | 本地 publish 契约归一化、dry-run/commit、`verification-report.json` 与 `publish-report.json` 输出；当提供 Supabase runtime 时默认通过共享 dataset command executor 提交 `lifecyclemodels` / `processes` / `sources` |
| `tiangong-lca validation run` | 本地 `@tiangong-lca/tidas-sdk` 直接依赖校验收口 |
| `tiangong-lca release ...` | LCI/LCIA 数据发布的 authenticated Edge transport；写入/私有读取由服务端 `data_product_manager` 权限保护，upload 固定校验四个 self-contained TIDAS/ILCD ZIP，Calculation Bundle 与 release artifact 固定落盘并执行大小/SHA-256 读回校验；不持有 service-role，也不重做 release control plane 的 identity/version/package 逻辑 |
| `tiangong-lca admin embedding-run` | `embedding_ft` |

此外，CLI 现在已经正式引入 `tiangong-lca lifecyclemodel ...` 一级命名空间，其中：

- `tiangong-lca lifecyclemodel auto-build` 已可执行
- `tiangong-lca lifecyclemodel validate-build` 已可执行
- `tiangong-lca lifecyclemodel publish-build` 已可执行
- `tiangong-lca lifecyclemodel save-draft` 已可执行
- `tiangong-lca lifecyclemodel graph` 已可执行
- `tiangong-lca lifecyclemodel build-resulting-process` 已可执行
- `tiangong-lca lifecyclemodel publish-resulting-process` 已可执行
- `tiangong-lca lifecyclemodel orchestrate` 已可执行

`tiangong-lca qa ...` 也已经开始进入统一命令树，其中：

- `tiangong-lca qa process` 已可执行
- `tiangong-lca qa flow` 已可执行
- `tiangong-lca qa lifecyclemodel` 已可执行

`tiangong-lca flow ...` 也已经开始承接 flow-governance 主链迁移，其中：

- `tiangong-lca flow get` 已可执行
- `tiangong-lca flow list` 已可执行
- `tiangong-lca flow identity-preflight` 已可执行
- `tiangong-lca flow remediate` 已可执行
- `tiangong-lca flow publish-version` 已可执行
- `tiangong-lca flow publish-reviewed-data` 已可执行
- `tiangong-lca flow build-alias-map` 已可执行
- `tiangong-lca flow scan-process-flow-refs` 已可执行
- `tiangong-lca flow plan-process-flow-repairs` 已可执行
- `tiangong-lca flow apply-process-flow-repairs` 已可执行
- `tiangong-lca flow regen-product` 已可执行
- `tiangong-lca flow validate-processes` 已可执行

`tiangong-lca process ...` 也已经开始承接 `process_from_flow` 主链迁移，其中：

- `tiangong-lca process get` 已可执行
- `tiangong-lca process identity-preflight` 已可执行
- `tiangong-lca process auto-build` 已可执行
- `tiangong-lca process resume-build` 已可执行
- `tiangong-lca process publish-build` 已可执行
- `tiangong-lca process batch-build` 已可执行

`tiangong-lca dataset ...` 现在已经开始承接跨 dataset 的本地治理切片，其中：

- `tiangong-lca dataset validate` 已可执行
- `tiangong-lca dataset classification children/path/audit/apply` 已可执行
- `tiangong-lca dataset curation-queue build` 已可执行
- `tiangong-lca dataset curation-queue next` 已可执行
- `tiangong-lca dataset curation-queue verify` 已可执行
- `tiangong-lca dataset references rewrite` 已可执行
- `tiangong-lca dataset save-draft` 已可执行；`--execution-contract` 为显式 opt-in 的 ordered owner-draft 模式
- `tiangong-lca dataset maintenance plan` 已可执行
- `tiangong-lca dataset maintenance apply` 已可执行
- `tiangong-lca dataset maintenance freeze-protected` 已可执行（production 只读）
- `tiangong-lca dataset maintenance seal-protected-approval` 已可执行（完全离线）
- `tiangong-lca dataset maintenance run-protected` 已可执行
- `tiangong-lca dataset maintenance verify` 已可执行

注意：

- `process get` 当前固定为 CLI 内部共享的 deterministic direct-read 面，内部执行已收口到原生 `@supabase/supabase-js`，供 lifecyclemodel resulting-process 和后续 review/governance 迁移复用
- 已实现的 `process identity-preflight` 是本地只读、artifact-first 的生成前 gate；输入为 target + embedded candidates，并可通过 repeatable `--candidate-input` 读取 JSON/JSONL 文件或递归扫描本地目录。需要查正式库时，输入可设置 `remote_candidate_search`，CLI 也可传 `--remote-candidates --remote-query ... --remote-limit ...`，通过 `process_hybrid_search` 拉取远程候选并合并进入同一套 identity / exchange fingerprint 判定。CLI 传给 Edge Function 的是 fielded `query`、`filter`、`data_source`、`match_count`/`page_size` 和 hybrid search 权重；`remote_candidate_search.profile_hints` 只在本地补强 target profile 与候选评分，不会送入 Edge Function。输出 `identity-decision.json` / `identity-candidates.jsonl` / `identity-candidate-sources.json`；当 exact exchange fingerprint 与 reference/geography 等身份上下文同时命中时输出 `block_duplicate`，只有 inventory-only 弱命中时才进入 `manual_review`。
- 已实现的 `process build-plan` 是 identity preflight 后、payload 生成前的本地 gate；输入为 BuildPlan，输出 `build-plan-gate-report.json`，并在 `materialize` 时输出 canonical `materialized-process.json`。如果 plan 内已提供 canonical payload，则直接校验该 payload；如果没有 payload，则必须提供 level `0..n` 连续、包含 locked taxonomy 精确 `@classId` / `#text` 的 canonical `classification_path` objects，再从 name plan、quantitative reference、exchange plan、source evidence、modelling/admin 字段确定性生成 `processDataSet`。缺失、字符串标签、乱序或伪造 taxonomy 会在产物发布前阻断。`annualSupplyOrProductionVolume` 使用 build plan/evidence 的显式源语言值，显式语言数组按原内容与原始顺序原样保留；缺失时不按 quantitative reference 金额、reference/default unit 或遗留 `tiangongfoundry:unresolvedTrace` 自动伪造业务真值，而是保留为受支持的未知表示 `[]` 并在报告中记录行级 evidence gap，报告状态为 `completed_with_blockers`。历史值 `9999 missing-data-sentinel/year` 仅作为只读历史识别标记，用于规范化早期写入的行。后续 schema、authoring、curation 与写入 gate 仍是阻塞责任方，不属于 Foundry 导入任务。
- 已实现的 `process auto-build` 在调用方显式提供的 run root 内保留旧 `cache/process_from_flow_state.json`、`cache/agent_handoff_summary.json` 等运行布局，不再推断 repo 本地 `./artifacts/...` 默认路径
- `process auto-build` 当前只负责本地 request intake、flow 归一化、run scaffold、初始 `manifests/process-build-plan.json` 和 manifest/report 预写，不继续执行后续阶段。该 build plan 是 scaffold_only，后续必须由 identity preflight、evidence replacement、build-plan validate/materialize、schema/QA gate 决定是否可写入。
- 已实现的 `process resume-build` 保留同一套 run 布局，并把本地 state-lock、run-manifest 校验、resume metadata/history、invocation index 更新统一收口到 CLI
- `process resume-build` 当前只负责本地 resume handoff，不直接执行 route / split / exchange / QA / publish 阶段
- 已实现的 `process publish-build` 继续保留同一套 run 布局，并把本地 publish-bundle/request/intent、state/invocation/handoff 更新统一收口到 CLI
- `process publish-build` 当前只负责本地 publish handoff，不直接执行远端 publish commit 或数据库写入
- 已实现的 `process batch-build` 继续走本地优先、artifact-first 路径，并把批量 item 编排、聚合 report、显式 batch root 下的 item run_dir 分配统一收口到 CLI
- `process batch-build` 当前只负责本地 batch orchestration，不直接串接 resume / publish 或远端执行器
- 已实现的 `dataset validate` 把 contact / source / unitgroup / flowproperty / flow / process / lifecyclemodel 本地 rows 的 TIDAS SDK 校验收口到一个 dataset 级入口，并输出 type summary、validation report 与 failures jsonl；`--type auto` 可用于 mixed support scope
- 已实现的 `dataset classification` 从 CLI bundled TIDAS schema 提供分类/位置编码治理：`children` 支持按 parent code 步进列子类，`path` 解析 code 的规范 path，`audit --type location` 按 bundled TIDAS schema 派生位置编码字段，并覆盖 TIDAS LCIA geography 和 lifecyclemodel connection location 字段，检查其值是否属于 `tidas_locations_category.json`；`apply --type location` 把 AI/human structured decision 确定性写回 rows 并输出 evidence，当 decision 明确给出 schema-derived location 字段的 `target_path`（如 `flowDataSet.flowInformation.geography.locationOfSupply`）时可创建缺失父对象和字段，缺少 target 或非 location 路径仍保持阻断
- 已实现的 `dataset curation-queue build/next/verify` 把 Foundry external dataset import 的 support / flow / process rows 收口成 entity-level queue artifact contract：`build` 生成 `curation-queue-manifest.json`、`curation-queue-tasks.jsonl`、`curation-queue-locks.json`、`curation-queue-blockers.jsonl`，以及每个 entity 的 `input.jsonl`、`closure.json`、`entity-run-plan.json`；`next` 读取 task checkpoint 并返回下一条 runnable entity task；`verify` 确认目标 scope 的 checkpoint 完成且没有 build blocker。CLI 只负责稳定状态机、依赖闭包、锁和 blocker；AI authoring 仍必须通过 skill/Codex 输出 structured patch 或 build plan，并在 deterministic apply、schema/QA、prewrite verify、readback 后才允许进入远端写入。
- 已实现的 `dataset references rewrite` 把 process / lifecyclemodel rows 中的 flow reference rewrite 收口到一个 deterministic 本地入口，默认只写 patch artifacts，只有显式 `--commit` 时才调用 state-aware save-draft 写入路径
- 已实现的 `dataset save-draft --execution-contract` 读取 `dataset-save-draft-execution-contract.v1`，逐 action 校验 authenticated project/owner、state 0、input identity/order、desired payload hash、expected operation、before hash 与 earlier-only dependencies。账本不放在 contract/out-dir 旁，而放在稳定的 per-owner/project 用户状态根下，并以 `action_id@desired_sha256` 寻址；复制输入或输出目录不会获得新的 attempt。`--max-parallel` 默认 1、上限 8：dependency prefix 保持串行，只有 target 唯一的 suffix 可并发；每次 DML 前重新取得并核对 exact owner token。attempt 之后只做 exact owner/state/payload readback，terminal/unknown action 均永不重投；dependency 只阻断后继，independent unresolved actions 仍可继续。每个远端调用继续使用现有 protected platform dataset transaction，不新增 raw SQL/direct-table/service-role/publication/delete/state/schema 写面。
- 已实现的 `dataset maintenance clear-account` 只覆盖当前认证账号的 draft 清空场景：CLI 必须先以 exact-count 分页证明五个可删除表的 RLS 可见快照完整，才写出 `rls-visible-snapshot.json` / `dry-run-report.json`；commit 时要求 `--confirm` 匹配当前账号邮箱，并逐行调用平台 `app_dataset_delete`。除逐表检查外，结束时必须重新扫描全部五表，只有完整 aggregate proof 且 `row_count=0` 才报告成功；若终检失败而之前已有删除，仍写出 `completed_with_failures` 审计报告。初始扫描不完整时不生成快照/approval，且零删除。该命令不绕过 RLS，不直接 REST DELETE，不删除默认保护的 `unitgroups` / `flowproperties`。
- 已实现的 `dataset maintenance plan/apply/freeze-protected/seal-protected-approval/run-protected/verify` 是错误导入清理、redo 与受保护衍生重建的 row-level 归属面。`plan` 先证明当前用户 account scan 完整，再固化 scope manifest、RLS 可见快照、completeness proof、引用影响、保护行、不可变 plan 和 dry-run。普通 `apply` 只接受 plan SHA-256 与当前账号邮箱都匹配的显式 commit；固定 production alias profile 必须依次经过 production 只读 `freeze-protected`、人类逐字批准、完全离线 `seal-protected-approval`，然后才可进入 `run-protected`，其 `--status-only` 恢复不做 preflight 或 admission。`verify` 以新的完整 account readback 或 action-scoped DB readback 独立检查结果，不依赖 apply 的内存或报告结论。Foundry 只调用已发布 CLI、保存 task ledger/报告/产物，不读取数据库 env、直调 RPC 或重算 canonical hash。
- `merge-support-aliases` 不是通用 alias 合并器：当前只接受 BAFU `time` 与 `length_time` 两个 batch。计划必须精确覆盖 25 + 27 行和 20 + 39 条 exchange，并保留受影响 process 中的 309 条其他 exchange。原 V1 adapter 只保留冻结请求/artifact 兼容契约，不能作为 seal 绑定 production 执行的 fallback；受保护路径绝不降级为旧 `cmd_dataset_alias_plan_guarded`、逐 dimension 或逐行 `save_draft`。
- 已实现的 `lifecyclemodel auto-build` 走本地只读、artifact-first 路径，输入固定为 local run manifest，不依赖 Python、MCP、KB、LLM 或远端 CRUD
- `lifecyclemodel auto-build` 当前负责 graph 推断、reference process 选择、`@multiplicationFactor` 计算与 `json_ordered` lifecyclemodel 产物输出，并保留 `run-plan.json`、`resolved-manifest.json`、`selection/selection-brief.md`、`discovery/reference-model-summary.json`、`connections.json`、`process-catalog.json` 等 CLI 契约
- `lifecyclemodel auto-build` 当前明确不负责 reference-model discovery、任何远端 lifecyclemodel 写入，也不会自动串接 validate-build / publish-build
- 已实现的 `lifecyclemodel validate-build` 继续保留同一套 run 布局，并把模型扫描、统一 validation 模块调用、per-model report 与 aggregate report 输出统一收口到 CLI
- `lifecyclemodel validate-build` 当前只负责本地 validation handoff，不直接触发 publish，也不做任何远端写入
- 已实现的 `lifecyclemodel publish-build` 继续保留同一套 run 布局，并把本地 publish-bundle/request/intent、validation 摘要复用、invocation index 更新统一收口到 CLI
- `lifecyclemodel publish-build` 当前只负责本地 publish handoff，不直接执行远端 publish commit 或数据库写入；真正的 dry-run / commit 边界仍由 `tiangong-lca publish run` 负责
- 已实现的 `lifecyclemodel save-draft` 读取 lifecyclemodel rows JSON/JSONL，先用 `LifeCycleModelSchema` 做本地校验，再按 dry-run / commit 边界输出 selected、progress、failures 与 summary artifacts
- 已实现的 `lifecyclemodel graph` 从本地 lifecyclemodel rows 生成 graph report、JSON graph、DOT 与 SVG artifacts，并可检查连接问题
- 已实现的 `build-resulting-process` 和 `publish-resulting-process` 都走本地优先、artifact-first 路径，不依赖 Python 或 MCP
- `build-resulting-process` 现在还支持一个显式的 deterministic direct-read 补全路径：当 request 打开 `process_sources.allow_remote_lookup=true` 时，CLI 会从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase 目标，并通过原生 `@supabase/supabase-js` 按 `process_id/version` 直接补齐缺失的 process dataset
- `publish-resulting-process` 当前负责生成本地 publish handoff 产物，还没有把提交语义直接并入 `publish run`
- 已实现的 `lifecyclemodel orchestrate` 把递归装配的 `plan | execute | publish` 三个动作统一收口到 CLI，并直接复用原生 `process auto-build`、`lifecyclemodel auto-build`、`lifecyclemodel build-resulting-process` slices
- `lifecyclemodel orchestrate` 的 `process_builder` request schema 已删除旧 builder 控制项，只保留 CLI-native 本地构建字段，并在归一化阶段拒绝额外键；不再保留任何 Python fallback 配置面
- 已实现的 `qa process` 保留本地 artifact-first QA contract，把规则核查、报告输出和可选 LLM 语义审核统一收口到 CLI；语义审核只使用 `TIANGONG_LCA_REVIEW_LLM_*`，不再透出 `OPENAI_*`
- 已实现的 `qa flow` 保留本地 artifact-first governance QA contract，把 flow 摘要、相似对、规则 findings、可选 LLM findings 和双语 markdown 报告统一收口到 CLI；语义审核同样只使用 `TIANGONG_LCA_REVIEW_LLM_*`
- review / dedup / publish 相关 gate 现在统一通过 `src/lib/runtime-rulesets.ts` 映射稳定 ruleset id、methodology rule id、severity 与 blocker 语义，供 Foundry / UI / publish handoff 不解析本地实现细节也能识别阻断原因
- `qa flow` 当前明确不支持 `--with-reference-context`，也还没有接入本地 registry enrichment；这部分仍需后续迁移切片单独落地
- 已实现的 `flow get` 保留 deterministic direct-read 边界，但内部执行已经收口到原生 `@supabase/supabase-js`；支持 `id` + 可选 `version/user_id/state_code` 读取；若精确版本 miss，则回退到最新可见版本；若出现多个同版本可见候选，则直接报 ambiguous
- 已实现的 `flow list` 保留 deterministic direct-read 边界，但内部执行已经收口到原生 `@supabase/supabase-js`；支持稳定 `id/state_code/type_of_dataset` 过滤、显式 `order=id.asc,version.asc` 默认值，以及 `--all --page-size` 的 offset 分页
- 已实现的 `flow identity-preflight` 是本地只读、artifact-first 的生成前 gate；输入为 target + embedded candidates，并可通过 repeatable `--candidate-input` 读取 JSON/JSONL 文件或递归扫描本地目录。需要查正式库时，输入可设置 `remote_candidate_search`，CLI 也可传 `--remote-candidates --remote-query ... --remote-limit ...`，通过 `flow_hybrid_search` 拉取远程候选；若 target 有 flow type，CLI 会作为 remote filter 写入请求。CLI 传给 Edge Function 的是 fielded `query`、`filter`、`data_source`、`match_count`/`page_size` 和 hybrid search 权重；`remote_candidate_search.profile_hints` 只在本地补强 target profile 与候选评分，不会送入 Edge Function。输出 `identity-decision.json` / `identity-candidates.jsonl` / `identity-candidate-sources.json`；对 type、reference property、unit、CAS/category 和 alias/name 等价的 flow 输出 `block_duplicate`，避免 process 引用新建同义 flow。
- 已实现的 `flow build-plan` 是 flow 生成前的本地 BuildPlan gate；输入为 BuildPlan，输出 `build-plan-gate-report.json`，并在 `materialize` 时输出 canonical `materialized-flow.json`。如果 plan 内没有 payload，必须先提供 exact locked taxonomy `classification_path` objects：Product/Waste 使用 `@classId`，Elementary 使用 `@catId` 并生成 `common:elementaryFlowCategorization`；CLI 不再从任意文本生成 UUID 分类。随后 CLI 才从 name plan、flow type、reference property、source evidence、admin/compliance 字段确定性生成 `flowDataSet` 并立即跑 `FlowSchema` 校验。
- 已实现的 `flow remediate` 保留旧 invalid-flow 输入与 round1 artifact 契约，但运行时已经收口到 CLI，不再需要 skill 私有 Python remediation 入口
- 已实现的 `flow publish-version` 先用 `FlowSchema` 执行本地 gate 并输出 `flow-publish-version-gate-report.json`，通过后再做 `/rest/v1/flows` 精确版本可见性预检，并通过 `app_dataset_create` / `app_dataset_save_draft` 提交远端写入；`TIANGONG_LCA_API_BASE_URL` 可传 project root、`/functions/v1` 或 `/rest/v1`，同时继续保留 `mcp_success_list`、`remote_validation_failed`、`mcp_sync_report` 这些历史文件名
- 已实现的 `flow publish-reviewed-data` 负责 reviewed publish preparation 阶段：支持 `--original-flow-rows-file` unchanged skip、flow/process `skip | append_only_bump | upsert_current_version`、`prepared-flow-rows.json` / `prepared-process-rows.json` / `flow-version-map.json` / `skipped-unchanged-flow-rows.json` / `process-flow-ref-rewrite-evidence.jsonl` / `publish-report.json` 输出，并在 `--commit` 时通过同一条共享 dataset command writer layer 同时执行 prepared flow rows 与 prepared process rows 的远端写入；commit flow path 复用 `flow publish-version` 的 FlowSchema gate 与 gate report
- 已实现的 `flow build-alias-map` 把治理链中的 deterministic alias-map 构建切片收口到 CLI，固定 old/new flow snapshots 与可选 `seed-alias-map` 输入契约，并直接写出 `alias-plan.json` / `flow-alias-map.json` / `manual-review-queue.jsonl` / `alias-summary.json`
- 已实现的 `flow scan-process-flow-refs` 把治理链中的独立 process ref scan 切片收口到 CLI，固定 process/scope/catalog/alias 输入契约，并直接写出 `scan-summary.json` / `scan-findings.json` / `scan-findings.jsonl`
- 已实现的 `flow plan-process-flow-repairs` 把治理链中的独立 deterministic repair planning 切片收口到 CLI，固定 process/scope/alias/scan 输入契约，并直接写出 `repair-plan.json` / `manual-review-queue.jsonl` / `repair-summary.json`
- 已实现的 `flow apply-process-flow-repairs` 把治理链中的独立 deterministic repair apply 切片收口到 CLI，固定与 planning 相同的输入契约，直接写出 `patched-processes.json` / `process-patches/**`，并可在 `--process-pool-file` 下同步本地 pool
- 已实现的 `flow regen-product` 把治理后的 process-side 再生产物链收口到 CLI，在一个命令下固定 `scan -> repair plan -> optional apply -> optional validate` 契约，并把退出码 `1` 保留给 `--apply` 之后的本地校验失败
- 已实现的 `flow validate-processes` 把治理后 patched process rows 的独立校验切片收口到 CLI，固定 original/patched/scope 三类输入契约，并直接写出 `validation-report.json` / `validation-failures.jsonl`
- 现有命令族里已经没有残留的 Python / shell validation fallback；review / build / publish 与 `auth login|status|whoami|doctor-auth|logout|identity-receipt` 已进入可执行状态，未实现的只剩 `job` placeholder surface
- 这样做的目的不是“假装已完成”，而是先固定命令树，再逐个把 workflow 迁入 TypeScript CLI

### 2.1.1 `dataset maintenance plan/apply/freeze-protected/seal-protected-approval/run-protected/verify` v1 契约

CLI #312 的仓库身份迁移保留 `dataset-alias-protected-toolchain-evidence.v1` 及历史封存字节。证据仍须绑定运行中的已发布 CLI 版本、production project、精确 commit、摘要及 workspace integration。`<=0.1.14` 的历史版本继续要求 `tiangong-lca/tiangong-cli` 与 `tiangong-lca/database-engine`；未来版本要求 `tiangong-lca/cli` 与 `tiangong-lca/database`，拒绝跨版本混搭。该名称分类不授予 production 写入、重放或新的批准权限。

公开命令面固定为：

```bash
tiangong-lca dataset maintenance plan \
  --scope ./maintenance-scope.json \
  --operation <delete|retire|redo-import|repair-references|merge-support-aliases|rebuild-derivatives> \
  --out-dir ./dataset-maintenance \
  [--page-size <n>] \
  [--timeout-ms <n>] \
  [--json]

tiangong-lca dataset maintenance apply \
  --plan ./dataset-maintenance/maintenance-plan.json \
  --commit \
  --approve-plan <sha256> \
  --confirm <current-account-email> \
  [--max-parallel <1-8>] \
  [--timeout-ms <n>] \
  [--json]

tiangong-lca dataset maintenance freeze-protected \
  --plan ./protected-step2/maintenance-plan.json \
  --toolchain-evidence ./protected-step2/toolchain-evidence.json \
  --expected-project-ref <production-project-ref> \
  --confirm <current-account-email> \
  --out-dir ./protected-step2/freeze \
  [--page-size <n>] \
  [--timeout-ms <n>] \
  [--json]

tiangong-lca dataset maintenance seal-protected-approval \
  --freeze ./protected-step2/freeze/protected-execution-freeze.json \
  --approval-request ./protected-step2/freeze/protected-approval-request.json \
  --human-approval ./protected-step2/human-approval.txt \
  --approve-freeze-file <freeze-file-sha256> \
  --approve-request <approval-request-sha256> \
  --approve-text <approval-text-sha256> \
  --confirm <current-account-email> \
  --approved-at <approved-at-utc-from-request> \
  --out-dir ./protected-step2/approval \
  [--json]

tiangong-lca dataset maintenance run-protected \
  --plan ./protected-step2/maintenance-plan.json \
  --freeze ./protected-step2/freeze/protected-execution-freeze.json \
  --approval ./protected-step2/approval/protected-approval.json \
  --out-dir ./protected-step2/run \
  --commit \
  --approve-execution <approved-execution-sha256> \
  --confirm <current-account-email> \
  [--wait-seconds <n>] \
  [--poll-ms <n>] \
  [--page-size <n>] \
  [--timeout-ms <n>] \
  [--json]

tiangong-lca dataset maintenance run-protected \
  --plan ./protected-step2/maintenance-plan.json \
  --freeze ./protected-step2/freeze/protected-execution-freeze.json \
  --approval ./protected-step2/approval/protected-approval.json \
  --out-dir ./protected-step2/run \
  --status-only \
  [--wait-seconds <n>] \
  [--poll-ms <n>] \
  [--page-size <n>] \
  [--timeout-ms <n>] \
  [--json]

tiangong-lca dataset maintenance verify \
  --plan ./dataset-maintenance/maintenance-plan.json \
  [--out-dir ./dataset-maintenance/verify] \
  [--page-size <n>] \
  [--timeout-ms <n>] \
  [--json]
```

Scope 与保护规则：

- `maintenance apply --max-parallel 1..8` 是显式 opt-in 的 flow delete-only 模式。它要求非空且目标唯一的纯 flow 删除计划、current/projected reference impact 均为零，并在 dispatch 前完整读取全部 RLS 可见 process 复核全局入边为零。若治理层已生成覆盖所有 process 的 fresh SELECT-only 证明，可成对传入 `--global-inbound-proof <absolute-file>` 和 `--approve-global-inbound-proof <sha256>`；CLI 在跳过 live scan 前严格验证 project/actor/plan/目标集合/连续分片/时效与零入边，且自身不执行 raw SQL。每个 action 的 `PREPARED/DISPATCHED/COMMITTED/UNKNOWN` 写入 append-only execution log；只有 exact absent readback 才成功，UNKNOWN 和成功行都不会自动重放，其他独立 action 继续执行。
- 普通维护的远端读写使用当前认证用户 session 与数据库 RLS，不接受 target user 覆盖；固定 BAFU profile 除显式确认 production project ref、toolchain evidence 与账号邮箱外，还在 CLI 内置 production project allowlist，Dev 或任意其他 project 即使三者自洽也不能 freeze 或 commit；远端准备只允许表级读和 `cmd_dataset_derivative_rebuild_snapshot`，不经过 Dev 数据回放；`seal-protected-approval` 完全离线；三个已废弃的历史 Step-2 plan identity 在 freeze、seal 与 commit-mode `run-protected` 三处都被拒绝，旧 approval 不能绕过新冻结/新审批；`run-protected` 的写入由服务器调度，但必须同时匹配认证 actor、精确 user_id/state_code=0、冻结目标集与 plan/closure 栅栏，公开入口和独立读回继续受 RLS 保护。
- freeze 在请求人工 review 前先把唯一 canonical approval-authority `approved_at_utc` 写入 request JSON、request hash 与人类可见文本；seal 的 `--approved-at` 必须等于这个已被逐字批准的值，不能在批准后另换时间生成第二个 identity。seal report 另用 `generated_at_utc` 记录真实封存时间，不把 authority timestamp 冒充为 seal 时刻。artifact SHA 按原始文件字节计算，非法 UTF-8 直接拒绝；因此空格、末尾换行、编码字节或时间变化都不能绕过 `(actor, approval_identity)` 的 one-shot 唯一性。
- 每条 scope row 必须给出表、exact `id`、exact `version`、expected owner、expected `state_code=0` 与 operator-authored intended action/reason；`--operation` 只接受 `delete`、`retire`、`redo-import`、`repair-references`、`merge-support-aliases`、`rebuild-derivatives`，且不允许只按 broad `state_code=0` 或其他宽过滤器清理。
- `contacts`、`sources`、`flows`、`processes` 的普通维护只允许 `save_draft` 与 `delete`；`merge-support-aliases` 只允许固定 BAFU closure 内的 `flowproperties`、`flows`、`processes` 执行 `update_json_ordered`。
- `merge-support-aliases` 与 `rebuild-derivatives` scope 必须显式给出 `target_mode: "owner_draft"`，其他 operation 禁止携带该字段。计划、审批、本地 proof 与 RPC request 都保留该 mode；数据库只接受匹配的 owner-draft visibility。
- `merge-support-aliases` 与 `update_json_ordered` 双向强绑定。scope 必须提供恰好两个 batch：`time` 因子 `0.00011415525114155251`，含 1 FP、10 flows、14 processes、20 exchanges；`length_time` 因子 `1000`，含 1 FP、13 flows、13 processes、39 exchanges。每个 process selector 必须冻结 exchange index、internal id、flow id/version、direction、before exchange SHA-256、before mean/resulting amount。
- alias 计划使用任意精度十进制字符串同时换算 `meanAmount` 和 `resultingAmount`，不经过 JavaScript `number`。计划还必须证明 309 条未选择 exchange 不变，source UG incoming refs 与 source FP flow refs 都归零，以及 time / length-time 的 target flow/exchange refs 分别达到 `106/441` 与 `32/3216`。
- 每个 batch 冻结 current-owner draft target FP、target UG、source UG 的 exact payload、`modified_at`、row hash 与 owner/state；所有 52 个 desired payload 都必须通过对应 TIDAS schema，且 payload 内嵌 `common:UUID` 与 version 必须继续匹配数据库 row。该 operation 只重写 source FP 的 UG 引用、23 个 flow 的 FP 引用和 59 个 exchange 的 amount，不删除 support rows、不改变 `state_code=0`。
- `rebuild-derivatives` 与 `rebuild_derivatives` 双向强绑定。V1 scope 必须恰好有一个 `table=processes` action，目标必须是当前认证账号的 exact-version `state_code=0` draft，components 必须恰好为 `extracted_md` 与 `embedding_ft`。多 action、其他表、public/shared、foreign owner、非 draft、缺一项或多一项 component 都阻断。该 operation 不修改 primary JSON、owner/state 或 `modified_at`。
- `lifecyclemodels`、不匹配的 action/table、public/shared、foreign owner、mixed visibility、非 draft、不可见或 exact version 不一致的 rows 一律进入 protected/blocked，不会降级成可执行 action。
- CLI 只执行人工/上游已经做出的清洗决策，不判断 public canonical、语义重复、引用替代或 redo 内容是否正确。

Account scan 与分页证明：

- `plan`、apply preflight、`verify` 和 `clear-account` 使用 `src/lib/dataset-maintenance-pagination.ts` 的同一 fail-closed paginator。请求带 `Prefer: count=exact`；`--page-size` 允许 `1-5000`，但只表示 requested maximum，不假定 PostgREST 会返回同样大的页。
- 每个表按 `id.asc,version.asc` 读取。下一页 offset 使用当前页实际返回行数推进；例如请求 5000、服务端 cap 1000 时，offset 必须是 `0,1000,2000...`，不能跳到 5000。
- 每页必须有可解析的 exact `Content-Range`；total 在所有页保持不变，range 必须与 offset/body 长度一致，行身份必须存在并严格递增。累计行数恰好达到 exact total 才结束；提前空页、缺失/变化的 total、重复/乱序身份、超出 total、缺表或聚合计数不一致都抛出 `DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE`。
- 完整 proof 记录 strategy、requested/effective page size、page count、rows fetched、exact total、终止原因、range/order/duplicate 检查，以及全表 aggregate entity counts。新 `maintenance-plan.json` 将 proof 纳入 canonical hash；snapshot、dry-run、apply approval 和 verify/readback artifacts 也保留适用的 proof。
- proof 的语义是“在该表过滤成员与排序键稳定的前提下完成了多请求分页遍历”，不是“所有行来自同一个 PostgreSQL transaction/MVCC snapshot”。total 与顺序校验可发现截断及部分并发变化，但同数量的一删一增仍可能绕过检查；mutation 仍依赖 fresh preflight、plan hash、payload/`modified_at` locks 与 RPC transaction，且操作期间应避免同账号并发维护。

`plan` 在任何 mutation 之前写出并固定：

- `maintenance-scope.json`
- `rls-visible-snapshot.json`
- `protected-rows.jsonl`
- `reference-impact-report.json`
- `maintenance-plan.json`
- `dry-run-report.json`
- alias operation 额外输出 `exchange-rewrite-plan.jsonl`
- derivative rebuild operation 额外固化目标 action 的数据库 primary/derivative snapshot 与 guarded-request preconditions；不得把 markdown/vector 大字段加入 account-wide snapshot

`maintenance-plan.json` 的 canonical SHA-256 是后续审批身份。plan 生成后不得原地编辑；需要变更 scope 或 action 时重新运行 `plan` 并重新审批。

`apply` 的 commit gate 同时要求 `--commit`、`--approve-plan <sha256>` 与 `--confirm <current-account-email>`。执行顺序固定为：

1. 重新认证当前用户并校验账号邮箱。
2. 先完成新的 exact-count account scan，再对整份计划重新抓取 exact rows 与引用；分页不完整或任何 drift 都在 approval 与首写前阻断。
3. 在首写前持久化 `approval-record.json`。
4. 普通 action 按 `save_draft`、`delete` 的固定顺序执行；derivative rebuild V1 只把冻结的单 action 计划提交给 authenticated guarded RPC，并只把 durable `accepted`/`queued` 作为 apply 成功。seal 绑定的 production alias operation 不进入 generic apply，而由 `run-protected` 执行。所有远端动作都通过平台 dataset command path，而不是 raw REST mutation。
5. 为每条尝试的 action 向 `apply-progress.jsonl` 追加 durable log，并在平台命令的 `p_audit` 中带入 plan/action correlation id。每行至少记录 `plan_sha256`、`operation_id`、`action_id`、table/id/version、actor、started/finished、`before_sha256`、`after_sha256`、result/error 与 rollback。
6. 任一 action 失败即停止后续动作并写出 `commit-report.json`；已成功 action 保留在日志中，重跑时据此识别已完成状态，避免盲目重复写入。

Alias plan RPC 在同一事务中锁定 target/source support 与全部 action rows，逐行比较 authenticated actor、expected owner/state 0、`modified_at`、payload，并再次计算 submitted flow/process closure；少一条或多一条 source-flow / exchange 引用都阻断。两个 dimension 中任一失败都会回滚另一个。成功与 replay 结果必须回显 plan identity、`target_visibility=owner_draft`、plan request SHA-256、plan summary audit id，以及两个 batch 的 request hash、summary audit id 和每行 audit id。数据库将 bigint audit id 显式转换为 text，CLI 只接受正整数字符串，避免 JavaScript number 精度损失。CLI 将 52 条 `apply-progress.jsonl`、59 条 `alias-exchange-progress.jsonl`、2 条 `alias-batch-progress.jsonl` 全部绑定到 `alias-plan-progress.jsonl` 的 plan proof。若事务已经提交但响应或本地派生日志丢失，只允许提交同一整计划请求进行 audit-proven replay，并逐项比对既有 plan/batch audit id 与 after hash。

上述 alias plan RPC/replay 描述属于原 V1 artifact 兼容契约，不再是 seal 绑定 production 执行的授权路径。`run-protected` 的执行顺序固定为：校验 plan/freeze/approval 与 production project；在 preflight 前完成完整 current-user RLS before-state、support 与 50-target baseline 校验；只调用一次 server preflight，接受服务器派生的三项 gate 期望摘要和最长 180 秒 token；捕获并核对 live gate receipt；以私有 immutable 文件写入 submission marker；立即发送最多一次 admission POST；服务器以认证 actor、精确 user_id/state_code=0、冻结目标集与 plan/closure 栅栏约束写入；之后状态读取只调用带 `auth.uid`、actor 与 plan 栅栏的受保护 RPC，独立表级读回才使用 RLS。`--status-only` 永远不调用 preflight/admit。marker 已存在、admission timeout、响应丢失或服务器记录不明确时，结果为 `indeterminate` 或后续只读状态，绝不再次 admission；状态读取异常仅在配置等待窗口内按默认 10 秒间隔重试，不会触发 admission 重试。

`run-protected` 只有在数据库终态与独立 RLS readback 同时证明 approved identity、唯一 attempt/dispatch、52 row + 2 batch + 1 plan 的 55 条 audit closure、59 条 exchange closure、精确 23 flows + 27 processes derivative targets，以及 markdown/embedding 因果与同域 hash 证据链一致时才输出 `passed`。其中 RLS live row 的 CLI canonical hash 必须等于 approved payload，primary closure 中 exact/unique/valid action evidence 的 PostgreSQL-domain desired/live hashes 必须彼此相等并等于 fresh snapshot 的 `json_ordered` hash，fresh snapshot SHA 必须等于 terminal completed snapshot proof；CLI 与 PostgreSQL 两种序列化 hash 不直接相等比较。任一 target 未完成但 proof 结构有效为 `pending`；明确 stale/failure/mismatch 为 `failed`；传输、schema/status 或 marker/server 记录不明确为 `indeterminate`。四态中只有 `passed` 返回 0。

Derivative rebuild guarded RPC 必须在 admission 时重新校验 authenticated actor、owner-draft state、exact identity 与 plan-bound action snapshot，并返回 durable request/proof。相同计划重放必须复用原 request，不得生成第二个任务。`accepted`/`queued` 只表示重建请求已受理，不能写成 `completed`；CLI 没有 direct Edge、`admin embedding-run`、raw queue、SQL、service-role 或 raw REST mutation 降级路径。

`verify` 必须启动独立 remote readback，重新读取受影响 rows 和 references，并写出 `readback-verify-report.json`；它不能把 apply report 当作数据库事实。Alias verify 还要求 target/source support 未漂移、52 行 desired payload 全部匹配、两条 batch success proof 完整、59 条 exchange proof 唯一且与 frozen rewrite 一致。Derivative rebuild verify 则读取 durable request 与新的 action-scoped DB snapshot，只输出 `pending`、`passed`、`failed`；只有两项 requested derivative 都已变为 current 且冻结的 primary preconditions 未改变时才允许 `passed`。CLI 校验 RPC 返回 audit id 与本地 proof chain 的关联，但当前不会独立查询 `public.command_audit_log`；audit row 创建与 replay 证明仍由 guarded RPC 负责。

安全边界是强约束：不允许 direct SQL、service-role credential、raw REST mutation 或 Foundry 私有 DB maintenance 代码。Derivative rebuild 还明确禁止 direct Edge、`admin embedding-run` 和 raw queue fallback。Foundry 和 skills 只能准备 scope、编排 CLI、保存 task ledger 与上述 artifacts。

### 2.2 已经固定的工程约束

- 运行时：Node 24.19.0
- 源码：TypeScript
- 包管理：pnpm 11.24.0（唯一根 workspace/lock）
- 测试：`node:test`
- 覆盖率：`c8`
- 构建产物：`dist/`
- 开发期运行器：`tsx`

这里的边界现在很明确：

- 运行时不再依赖 `tsx`
- `bin` 入口只加载 `dist/src/main.js`
- `tsx` 只保留给开发期和测试期

## 3. 目录职责

```text
tiangong-lca-cli/
  bin/
    tiangong-lca.js
    tiangong-lca.d.ts
  dist/
  src/
    cli.ts
    main.ts
    lib/
  test/
  scripts/
    assert-full-coverage.ts
  docs/
```

职责边界：

- `bin/`：稳定启动器，只负责把 `tiangong-lca` 命令接到 `dist/src/main.js`
- `dist/`：构建产物，供正式运行路径使用
- `src/cli.ts`：命令分发、参数解析、命令帮助、错误出口
- `src/main.ts`：进程入口源码，构建后输出到 `dist/src/main.js`
- `src/lib/`：纯功能模块
- `test/`：单元测试和 smoke test
- `scripts/assert-full-coverage.ts`：覆盖率硬门源码，构建后输出到 `dist/scripts/`

## 4. 命令设计原则

### 4.1 不按 skill 名直接暴露命令

不推荐：

```bash
tiangong-lca flow-hybrid-search
tiangong-lca process-hybrid-search
tiangong-lca embedding-ft
```

推荐：

```bash
tiangong-lca search flow
tiangong-lca search process
tiangong-lca admin embedding-run
```

这能显著降低 agent 的搜索空间和误操作概率。

### 4.2 读操作偏通用，写操作必须带业务语义

这个仓库没有实现“万能 CRUD”。

原因很简单：

- 搜索是搜索
- 发布是发布
- review/build 是 workflow
- 长任务是 job

如果为了“统一”再做一个泛化 CRUD 协议，只会重新制造熵。

具体执行上：

- 有现成业务语义和服务边界的能力，统一走 edge-functions / REST
- 只需数据层 CRUD 且无需新服务抽象时，直接走 `@supabase/supabase-js`
- 不再设计“CLI -> MCP -> DB”的第三条路径

### 4.3 文件优先

优先形式：

```bash
tiangong-lca search flow --input ./request.json --json
tiangong-lca publish run --input ./publish-request.json --dry-run
tiangong-lca validation run --input-dir ./tidas-package --engine auto
tiangong-lca dataset evidence-search plan --query "中国2026年电力结构数据" --out-dir ./evidence-search --json
tiangong-lca admin embedding-run --input ./jobs.json --dry-run
```

而不是长自然语言参数和不稳定的 shell 拼接。

### 4.3.0 `auth identity-receipt` 的最小 contract

`tiangong-lca auth identity-receipt` 是 production-backed case 的身份前置证明，不是泛化 auth 管理器。运行顺序固定为：解析受控 auth runtime；从 canonical `https://<ref>.supabase.co` base 派生 project；在任何 session/network 前核对 `--expected-project-ref`；复用 OAuth/headless session；对 `/auth/v1/user` 做大小和 JSON shape 有界的 live GET；核对 session email 与 live email；最后核对 `--expected-user-id`。第一次 live GET 的 401/403 只在 OAuth session 可 refresh 时续期并重读一次，其他失败不重试。

回执 schema 固定为 `tiangong-lca.auth-identity-receipt.v1`。公开字段只包含 CLI 版本、project ref/base、live user id、masked display email、session source/cache mode/force-reauth/expiry、安全投影 request/response SHA、expected assertions、capture time 与 receipt scope SHA。parser 要求 exact keys，并独立重算三类 hash；额外 metadata、`ok:false`、完整 email、API/publishable key、access/refresh token、session path，以及它们的 fingerprint 一律不能进入回执。无 expected 是 `observed`，只给一项是 `partial`，两项都给且通过才是 `intent-bound`；Foundry 只能把最后一种作为 production guard。

### 4.3.1 `search flow` 的最小 contract

`tiangong-lca search flow` 现在固定的是“CLI 持有的 edge-function 请求转发契约层”。

它负责：

- 从 `--input` 读取一个 JSON 请求体
- 用 OAuth refresh session（或显式、在线验证的短期 headless token）取得 user access token
- 把请求体原样转发到 `flow_hybrid_search`
- 原样返回 edge-function 的 JSON 响应，而不是在 CLI 里做本地 UI 映射

最小请求体：

```json
{
  "query": "soda lime glass",
  "filter": {
    "flowType": "Product flow"
  }
}
```

更完整的请求体示例：

### 4.3.2 `dataset evidence-search` 的最小 contract

`dataset evidence-search` 固定的是字段级证据检索留痕契约，不是答案生成器。

它负责：

- `plan` 生成 query matrix、source tier 和预算；
- `run` 接收 browser/web-search 工具导出的规范化结果，或调用一个通用 JSON provider endpoint；
- 去重、打分、归类 source tier；
- 记录 evidence-search report；
- 当没有足够证据，或当前年只能找到阶段性/预测性证据时，写出 declaration。

它不负责判断 LCA 字段最终该写什么。Codex/skill 必须读取 evidence-search artifacts 后，再结合 TIDAS/ILCD/PEF 语境和 process/flow review 规则做语义判断。

最小请求体：

```json
{
  "question": "中国2026年电力结构数据",
  "field": {
    "dataset_type": "process",
    "field_path": "/processInformation/time/referenceYear"
  },
  "preferred_domains": ["stats.gov.cn", "nea.gov.cn", "chinapower.org.cn"],
  "required_evidence": {
    "temporal_scope": "2026 full-year electricity generation mix",
    "require_complete_year": true
  },
  "budget": {
    "max_queries": 8,
    "max_results_per_query": 8
  }
}
```

输出：

```text
outputs/evidence-search-plan.json
outputs/evidence-search-results.jsonl
outputs/evidence-search-report.json
outputs/evidence-search-declaration.json
```

```json
{
  "query": "methylbutane",
  "filter": {
    "flowType": "Elementary flow",
    "asInput": false,
    "flowDataSet": {
      "flowInformation": {
        "dataSetInformation": {
          "CASNumber": "541-28-6"
        }
      }
    }
  }
}
```

当前已确认的请求要点：

- `query` 必填
- `filter` 可选
- `filter.flowType` 是最常用的 real-DB review 过滤项
- `filter.asInput` 会被原样透传
- `filter.flowDataSet...` 这种嵌套条件也会被原样透传

当前已确认的返回要点：

- 非空结果通常是 `{ "data": [...] }`
- `data` 中的原始 row 常见字段包括 `id`、`version`、`modified_at`、`json`
- 某些部署还可能带出额外字段，例如 `team_id`
- 空结果当前可能直接返回裸 JSON 数组 `[]`
- `400` 常见于缺少可用 `query`
- `500` 常见于 embedding 或 `hybrid_search_flows` RPC 失败

它现在还不负责：

- 把搜索结果直接物化为 `qa flow` 的本地 rows 输入
- 对 edge-function 返回做本地字段重命名或 UI 适配
- 用搜索结果替代 deterministic `flow get` / `flow list` 详情读取
- 任何 “synthetic rows” 自动补位

因此，当任务要求“基于真实 DB flow 做 review 判断”时，`search flow` 只能负责找候选 refs，后续仍应进入 CLI 的真实 row 物化链路，而不是直接手工拼接 review 输入。

### 4.4 process / review / publish / validation 的当前边界

`process auto-build` 现在固定的是“本地 process-from-flow intake 与 scaffold 契约层”。

它负责：

- 读取单个 request JSON
- 解析 `flow_file` 指向的 ILCD flow payload
- 兼容旧 `pfw_<flow_code>_<flow_uuid8>_<operation>_<UTC_TIMESTAMP>` run-id 规则
- 创建本地 run root、`input/`、`exports/`、`cache/`、`reports/` 等目录
- 预写 `process_from_flow_state.json`
- 预写 `agent_handoff_summary.json`
- 写出 normalized request、flow summary、assembly plan、lineage manifest、invocation index、run manifest、report

它现在还不负责：

- 执行 route / split / exchange / QA / publish 等后续阶段
- 远程检索、LLM、OCR、publish commit
- `resume-build`、`publish-build`、`batch-build`

`process resume-build` 现在固定的是“本地 process-from-flow resume handoff 契约层”。

它负责：

- 从 `--run-id` 或 `--run-dir` 重开已有 run
- 校验 `run-manifest.json`、`process_from_flow_state.json`、`agent_handoff_summary.json`
- 使用 CLI 的 state lock 保护本地状态更新
- 清除历史 `stop_after` checkpoint，并将状态推进到 `resume_prepared`
- 写出 `resume-metadata.json`、追加 `resume-history.jsonl`
- 更新 `invocation-index.json`
- 重写 `agent_handoff_summary.json`
- 产出 `process-resume-build-report.json`

它现在还不负责：

- 执行 route / split / exchange / QA / publish 等后续阶段
- 远程检索、LLM、OCR、publish commit
- 直接触发后续 `batch-build` 或远端 publish executor

`process publish-build` 现在固定的是“本地 process-from-flow publish handoff 契约层”。

它负责：

- 从 `--run-id` 或 `--run-dir` 读取已有 run
- 校验 `run-manifest.json`、`process_from_flow_state.json`、`agent_handoff_summary.json`、`invocation-index.json`
- 优先读取 `exports/processes/`、`exports/sources/`，缺失时回退到 state 中的 `process_datasets`、`source_datasets`
- 用 `ProcessSchema` 校验待发布 process payload
- 写出 `reports/process-publish-schema-gate.json`
- 写出 `stage_outputs/10_publish/publish-bundle.json`
- 写出 `stage_outputs/10_publish/publish-request.json`
- 写出 `stage_outputs/10_publish/publish-intent.json`
- 更新 `process_from_flow_state.json`
- 更新 `invocation-index.json`
- 重写 `agent_handoff_summary.json`
- 产出 `process-publish-build-report.json`

它现在还不负责：

- 直接执行远端 publish commit 或数据库 CRUD
- 重新实现历史 MCP transport
- `batch-build`

`process batch-build` 现在固定的是“本地 process-from-flow batch orchestration 契约层”。

它负责：

- 读取单个 batch manifest
- 生成 batch root、normalized request、invocation index、run manifest、aggregate report
- 顺序复用 `process auto-build` 为多个 item 准备本地 run
- 给每个 item 分配稳定的默认 `run_root`
- 输出 per-item `prepared` / `failed` / `skipped` 状态
- 为后续 `resume-build` / `publish-build` 保留明确的 `run_root`

它现在还不负责：

- 直接串接 `resume-build` / `publish-build`
- 并发调度、daemon、远端 CRUD、历史 Python orchestrator 复刻
- `process get`

`lifecyclemodel auto-build` 现在固定的是“本地 lifecyclemodel local-run 组装契约层”。

它负责：

- 读取单个 request JSON
- 解析一个或多个 `process-automated-builder` 本地 run
- 从共享 flow UUID 推断 process graph
- 选择 reference process
- 计算各 process instance 的 `@multiplicationFactor`
- 写出原生 `json_ordered` lifecyclemodel 数据集
- 写出 `run-plan.json`、`resolved-manifest.json`、`selection/selection-brief.md`
- 写出 `discovery/reference-model-summary.json`、`models/**/summary.json`、`connections.json`、`process-catalog.json`
- 产出 `lifecyclemodel-auto-build-report.json`

它现在还不负责：

- reference-model discovery
- 任何远端 lifecyclemodel CRUD
- MCP / KB / LLM / OCR runtime

`lifecyclemodel validate-build` 现在固定的是“本地 lifecyclemodel validation handoff 契约层”。

它负责：

- 从 `--run-dir` 重开已有 lifecyclemodel auto-build run
- 扫描 `models/*/tidas_bundle/lifecyclemodels/*.json`
- 通过统一 `validation` 模块重跑每个 model bundle 的本地校验
- 在 `reports/model-validations/` 下输出 per-model 校验报告
- 更新 `manifests/invocation-index.json`
- 产出 `reports/lifecyclemodel-validate-build-report.json`

它现在还不负责：

- 远端 lifecyclemodel CRUD
- 自动触发 `publish-build`
- MCP / KB / LLM / OCR runtime

`lifecyclemodel publish-build` 现在固定的是“本地 lifecyclemodel publish handoff 契约层”。

它负责：

- 从 `--run-dir` 重开已有 lifecyclemodel auto-build run
- 收集 `models/*/tidas_bundle/lifecyclemodels/*.json` 下的原生 lifecyclemodel payload
- 若存在 `reports/lifecyclemodel-validate-build-report.json`，则复用其中的 aggregate 校验摘要
- 写出 `stage_outputs/10_publish/publish-bundle.json`
- 写出 `stage_outputs/10_publish/publish-request.json`
- 写出 `stage_outputs/10_publish/publish-intent.json`
- 更新 `manifests/invocation-index.json`
- 产出 `reports/lifecyclemodel-publish-build-report.json`

它现在还不负责：

- 直接执行远端 publish commit 或数据库 CRUD
- 重新实现历史 MCP transport
- reference-model discovery

`dataset verify-remote --reference-intent-file` 接受显式、绑定消费者/项目/当前账户/内容/评审文件的精确引用意图。它只对实际匹配的 reference occurrence 应用例外；root、未声明引用、缺失/不可见版本及变化后的 owner/state/payload/latest 证据仍阻断。现有身份凭据和 RLS GET 传输归 CLI 所有，Foundry 只负责选择、快照、传递与 handoff/readback 绑定。完整字段、哈希域及失败语义见 [精确引用意图契约](agents/exact-reference-intent-contract.md)。

`qa process` 现在固定的是“本地 process QA 契约层”。

它负责：

- 从 `--run-root` 读取 `exports/processes/*.json`
- 以 v2.2-unit-aware 做基础信息和量纲有效的质量平衡核查：显式重复 `--reference-rows-file` 选择 Flow、Flow Property、Unit Group 精确版本证据，沿参考属性和参考单位解析 kg；质量型燃料仍计入输入
- 计数、规范面积时间（`m2*a` / `m²*a`）等已知非质量参考产品报告 `not_applicable`，质量与偏差为 null；缺失、冲突、未知单位、无效数量和溢出保留待处理 finding，不猜测任意复合单位
- `mass_balance` 保留过程 payload 哈希和逐 exchange 的精确引用哈希，`reference_evidence` 保留显式输入文件哈希；不修改数量或引用，跨过程合计仅为诊断，独立 source-model 物理平衡仍必需
- 写出中英文 markdown review、timing、unit issue log、summary 和 report
- 在显式启用 `--enable-llm` 时，通过 CLI 的 `TIANGONG_LCA_REVIEW_LLM_*` 运行时做可选语义审核

它现在还不负责：

- flow governance QA
- lifecycle model QA
- 远端 remediation / publish
- 任何 skill 私有的 `OPENAI_*` 调用路径

`qa flow` 现在固定的是“本地 flow governance QA 契约层”。

它负责：

- 接受且只接受一种输入模式：`--rows-file`、`--flows-dir`、`--run-root`
- 在 `--rows-file` 模式下物化 `qa-input/flows/*.json` 与 `qa-input/materialization-summary.json`
- 输出 `rule_findings.jsonl`、`llm_findings.jsonl`、`findings.jsonl`
- 输出 `flow_summaries.jsonl`、`similarity_pairs.jsonl`
- 输出 `flow_qa_summary.json`、`flow_qa_zh.md`、`flow_qa_en.md`、`flow_qa_timing.md`
- 输出 `flow_qa_report.json`
- 在显式启用 `--enable-llm` 时，通过 CLI 的 `TIANGONG_LCA_REVIEW_LLM_*` 运行时做可选语义审核

它现在还不负责：

- flow remediation / publish-version / regen-product
- `--with-reference-context`
- 本地 registry enrichment
- 任何 skill 私有的 `OPENAI_*` 或 MCP review runtime

`flow get` 现在固定的是“deterministic direct-read detail 契约层”。

它负责：

- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase `/rest/v1/flows` 路径
- 按 `id` 读取单个 flow row
- 可选叠加 `version`、`user_id`、`state_code` 过滤
- 若显式提供 `version` 且精确版本 miss，则回退到同一 `id` 的最新可见版本
- 若最新版本或精确版本存在多个同版本可见候选，则直接报 ambiguous

它现在还不负责：

- 任意 flow 搜索或语义检索
- 远端 publish/write
- remediation / regen-product
- 任何 skill 私有 MCP 读路径

`flow list` 现在固定的是“deterministic direct-read list 契约层”。

它负责：

- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase `/rest/v1/flows` 路径
- 支持 `id`、`version`、`user_id`、`state_code`、`type_of_dataset` 过滤
- 默认使用 `order=id.asc,version.asc`
- 支持显式 `limit` / `offset`
- 支持 `--all --page-size <n>` 的 offset 分页汇总
- 输出稳定的结构化 JSON 报告

它现在还不负责：

- 任意修复或 publish
- `regen-product`
- skill 私有 transport / env parsing
- MCP-only list/runtime

`flow remediate` 现在固定的是“本地 deterministic remediation 契约层”。

它负责：

- 读取 invalid flow JSON / JSONL 输入
- 统一 round1 deterministic remediation 规则
- 保留历史 `remediated_all`、`ready_for_mcp`、`manual_queue`、`audit`、`report`、`prompt` 工件

它现在还不负责：

- 任何远端 publish/write
- round2 remote-validation retry
- regen-product
- 任何 skill 私有 Python remediation runtime

`flow publish-version` 现在固定的是“remediated-flow remote publish/update 契约层”。

它负责：

- 读取 ready-for-publish flow JSON / JSONL 输入
- 用 `FlowSchema` 校验每条 canonical flow payload
- 写出 `flow-publish-version-gate-report.json`
- 从 `TIANGONG_LCA_API_BASE_URL` 推导 Supabase REST 预检路径与 Edge Function dataset command 路径；支持 project root、`/functions/v1`、`/rest/v1`
- dry-run 通过精确版本可见性预检执行 `would_insert`、`would_update_existing` 或失败判定
- commit 通过同一条预检链调用 `app_dataset_create` / `app_dataset_save_draft`，并在需要时落到 `insert`、`update_existing`、`update_after_insert_error`
- 输出 `flows_tidas_sdk_plus_classification_mcp_success_list.json`
- 输出 `flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl`
- 输出 `flows_tidas_sdk_plus_classification_mcp_sync_report.json`

它现在还不负责：

- round2 remote-validation retry
- reviewed-data publish contract
- 其他治理后处理
- 任何 MCP transport

`flow build-alias-map` 现在固定的是“治理链中的独立 deterministic alias-map 构建契约层”。

它负责：

- 读取一个或多个 old flow JSON / JSONL 输入
- 读取一个或多个 new flow JSON / JSONL 输入
- 可选读取 `seed-alias-map`
- 对每个 old flow 生成 `no_alias_needed | alias_map_entry | manual_review` 决策
- 输出 `alias-plan.json`
- 输出 `alias-plan.jsonl`
- 输出 `flow-alias-map.json`
- 输出 `manual-review-queue.jsonl`
- 输出 `alias-summary.json`

它现在还不负责：

- process ref 扫描
- repair planning / apply
- 任何远端 publish/write
- 任何 MCP transport

`flow scan-process-flow-refs` 现在固定的是“治理链中的独立 process ref scan 契约层”。

它负责：

- 读取 process JSON / JSONL 输入
- 读取一个或多个 scope flow JSON / JSONL 输入
- 可选读取 catalog flow 与 alias map
- 对每个 exchange 的 `referenceToFlowDataSet` 做 deterministic 分类
- 可选先剔除 emergy-named process
- 输出 `emergy-excluded-processes.json`
- 输出 `scan-summary.json`
- 输出 `scan-findings.json`
- 输出 `scan-findings.jsonl`

它现在还不负责：

- 修复计划
- patch apply
- 后续本地校验
- 任何远端 publish/write
- 任何 MCP transport

`flow plan-process-flow-repairs` 现在固定的是“治理链中的独立 deterministic repair planning 契约层”。

它负责：

- 读取 process JSON / JSONL 输入
- 读取一个或多个 scope flow JSON / JSONL 输入
- 可选读取 alias map
- 可选读取 `scan-findings`
- 显式执行 `disabled | alias-only | alias-or-unique-name` auto-patch boundary
- 输出 `repair-plan.json`
- 输出 `repair-plan.jsonl`
- 输出 `manual-review-queue.jsonl`
- 输出 `repair-summary.json`

它现在还不负责：

- 真正修改 process rows
- 后续本地校验
- 任何远端 publish/write
- 任何 MCP transport

`flow apply-process-flow-repairs` 现在固定的是“治理链中的独立 deterministic repair apply 契约层”。

它负责：

- 复用 planning 相同的 process / scope / alias / scan 输入契约
- 只应用 deterministic subset
- 输出 `patched-processes.json`
- 输出 `process-patches/<process-id__version>/before.json`
- 输出 `process-patches/<process-id__version>/after.json`
- 输出 `process-patches/<process-id__version>/diff.patch`
- 输出 `process-patches/<process-id__version>/evidence.json`
- 若显式传入 `--process-pool-file`，把 exact-version patched rows 同步回本地 pool，并在 `repair-summary.json` 记录 `process_pool_sync`

它现在还不负责：

- 后续本地校验
- 任何远端 publish/write
- round2 remote-validation retry
- 任何 MCP transport

`flow regen-product` 现在固定的是“治理后 process-side 再生产物契约层”。

它负责：

- 读取 process JSON / JSONL 输入
- 读取一个或多个 scope flow JSON / JSONL 输入
- 可选读取 catalog flow 与 alias map
- 在一个命令下执行 `scan -> repair plan -> optional apply -> optional validate`
- 输出 `scan/`、`repair/`、`repair-apply/`、`validate/` 工件目录
- 输出顶层 `flow-regen-product-report.json`
- 在 `--apply` 后可选同步 `process-pool-file`

它现在还不负责：

- 任何远端 publish/write
- reviewed-data publish contract
- round2 remote-validation retry
- 任何 MCP transport

`publish run` 现在固定的是“稳定 publish 契约层”，不是历史 MCP 写库脚本的 TypeScript 复刻。

它负责：

- 吞入 `publish-bundle.json` 和直接数组输入
- 统一 `dry-run` / `commit` override
- 识别 canonical process payload 与 projection payload
- 产出结构化 `verification-report.json`
- 产出结构化 `publish-report.json`
- 在提供 Supabase runtime 时，默认通过共享 dataset command executor 提交 `lifecyclemodels` / `processes` / `sources`
- 允许调用方继续为其他类别或自定义链路注入显式 executor

这样做的好处是：

- CLI 先稳定输入/输出合同
- 不把旧 MCP transport 重新带回命令树
- REST 预检、Edge Function 提交、artifact 报告都复用同一条 writer 链
- 即使后续扩充更多 dataset 类别，也不需要再改调用方契约

`validation run` 则固定“统一校验报告层”：

- `auto` 模式走当前默认的 direct-dependency 校验路径，也就是 CLI 内基于 `@tiangong-lca/tidas-sdk` 组装的 package validator
- `sdk` 模式显式固定到同一条 `@tiangong-lca/tidas-sdk` 校验链

这保证后续 workflow 只依赖 `tiangong-lca validation run`，而不需要在 skill 里自己判断到底调哪个校验器。

## 5. 环境变量策略

### 5.1 统一命名

当前 active session 使用 Supabase OAuth 2.1。`auth login` 使用 public client、S256 PKCE、state、固定 `127.0.0.1` 回调和无 shell 浏览器；token refresh 在原有进程/文件锁下原子更新 schema-v2 私有文件。headless 可显式注入短期 actor access token；旧 API key/password bootstrap 已移除，OAuth 失败不回退密码。

Issue #263 将官方 Production public profile 统一收口到 `src/lib/env.ts`。安装后的首次 `auth login` 无需 `.env`；auth、remote adapters 和 doctor 使用同一 URL/key/client/callback/region 来源。未登录 `status` / `doctor-auth` 返回 `login-required`（exit 1），不触发远程调用。只有完整自定义环境才能覆盖默认值；非 Production URL/client/key/callback 禁止混补，已知 Production key/client 与自定义 URL 的组合显式失败。空白模板与精确 Production URL 别名可以使用默认 profile。Skills 不复制生产常量。

`auth status` 只读取当前 project/client 绑定的本地 session metadata，不发网络请求、不 refresh，并明确输出 `onlineVerified: false`；`auth whoami` 复用 live redacted identity receipt；`auth doctor-auth` 先做 local status，缺失 session 时直接返回 `login-required` 并把终端交还人类，ready 时才做 live receipt。三者都不输出完整邮箱、token、session path 或 credential fingerprint，也不接受密码/code/token argv。

自定义环境的标准变量名（官方 Production 不需要填写）：

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

其中：

- `TIANGONG_LCA_OAUTH_CLIENT_ID` 是环境专属 public client ID；官方 Production 内置，先运行 `tiangong-lca auth login`
- authorization code、PKCE verifier/state 不进入 argv 或磁盘；access/refresh token 不进入 stdout/report
- 运行时统一使用 actor access token，既用于 Edge Functions，也用于 direct Supabase
- `TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY` 是 public 配置，官方 Production 从 profile 解析，自定义环境必须显式给出
- `TIANGONG_LCA_SESSION_FILE`、`TIANGONG_LCA_DISABLE_SESSION_CACHE`、`TIANGONG_LCA_FORCE_REAUTH` 是可选 session cache 控制项
- headless 必须显式配置目标 URL/publishable key，再使用 `TIANGONG_LCA_AUTH_MODE=access-token` + `TIANGONG_LCA_ACCESS_TOKEN`；仅 token 不得默认投递 Production，只在进程内复用且不 refresh
- `hasSupabaseRestRuntime` 保留 configured-only 探测，不因内置 profile 自动启用原本本地的 publish executor；显式 remote lookup 和 commit/审批边界不变

按需启用的可选 QA-only 变量：只有显式启用 `tiangong-lca qa process --enable-llm` 或 `tiangong-lca qa flow --enable-llm` 时才需要配置。`TIANGONG_LCA_REVIEW_LLM_BASE_URL` 应指向 OpenAI-compatible Responses API 根地址，CLI 会向 `<base_url>/responses` 发请求。

```bash
TIANGONG_LCA_REVIEW_LLM_BASE_URL=
TIANGONG_LCA_REVIEW_LLM_API_KEY=
TIANGONG_LCA_REVIEW_LLM_MODEL=
```

仓库中已归一化、但当前没有任何公开 `tiangong-lca` 命令消费的 internal/preparatory 变量：

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

测试/质量脚本还会使用一个内部开关：

```bash
TIANGONG_LCA_COVERAGE=0
```

规则是：

- 公开命令只暴露当前已实现、且真实消费的 env
- internal/preparatory 和 test-only env 也要在 `.env.example` 里显式列出，避免代码与文档脱节
- 不为了历史实现或未来猜测保留 alias
- 不引入 `SUPABASE_URL`、`SUPABASE_KEY`、`TIANGONG_LCA_TIDAS_SDK_DIR` 这类额外兼容层；原生 Supabase client 一律从 `TIANGONG_LCA_API_BASE_URL` 派生，actor session 只走 OAuth 或显式 headless 两种受控模式，`@tiangong-lca/tidas-sdk` 一律走直接依赖
- `qa process` 的可选语义审核统一走 QA-only 的 `TIANGONG_LCA_REVIEW_LLM_*`，不再引入 `OPENAI_*`
- `qa flow` 的可选语义审核也统一走 QA-only 的 `TIANGONG_LCA_REVIEW_LLM_*`，不再引入 `OPENAI_*`
- `publish run` / `validation run` 都是本地契约与执行收口，不新增远程 env
- `release *` 复用同一 actor session；不读取/持久化 API key，不在请求体生成 credential fingerprint，也不接受 service-role
- `TIANGONG_LCA_KB_SEARCH_*` 与 `TIANGONG_LCA_UNSTRUCTURED_*` 目前只属于 internal/preparatory 层，不属于公开命令契约

下表“远程认证环境”指官方 Production profile + 已登录 session，完整自定义 URL/key/client + 已登录 session，或显式 URL/key/短期 headless access token。

命令级 env 矩阵：

| 命令组 | 必需 env |
| --- | --- |
| `doctor` | 无 |
| `auth login` | 官方 Production 无；自定义环境需完整 URL/key/client |
| `auth status` | 同一远程认证环境；只检查本地 session readiness |
| `auth whoami` | 同一远程认证环境；执行 live redacted identity receipt |
| `auth doctor-auth` | 同一远程认证环境；local readiness + live redacted identity |
| `auth logout` | 远程认证环境；只清理本地 session，grant 在 Next Connected applications 撤销 |
| `auth identity-receipt` | 远程认证环境；生产 guard 还必须通过 argv 同时给出 expected project/user |
| `search flow \| process \| lifecyclemodel` | 远程认证环境（region 可选） |
| `dataset evidence-search` | 默认无；若使用 `--provider-url`，认证由 `--provider-key` 显式传入 |
| `admin embedding-run` | 远程认证环境（region 可选） |
| `process get` | 远程认证环境 |
| `dataset save-draft` | dry-run 无；`--commit` 需要远程认证环境，ledger 位置不变 |
| `process identity-preflight` | 默认无；remote candidates 需要远程认证环境 |
| `process build-plan` | 无 |
| `process auto-build \| resume-build \| publish-build \| batch-build` | 无 |
| `lifecyclemodel auto-build \| validate-build \| publish-build \| orchestrate` | 无 |
| `lifecyclemodel build-resulting-process` | 本地默认无；remote lookup 需要远程认证环境 |
| `lifecyclemodel publish-resulting-process` | 无 |
| `qa process` | 纯规则 QA 默认无；若显式开启 `--enable-llm`，则需要 `TIANGONG_LCA_REVIEW_LLM_BASE_URL`、`TIANGONG_LCA_REVIEW_LLM_API_KEY`、`TIANGONG_LCA_REVIEW_LLM_MODEL` |
| `qa flow` | 纯规则 QA 默认无；若显式开启 `--enable-llm`，则需要 `TIANGONG_LCA_REVIEW_LLM_BASE_URL`、`TIANGONG_LCA_REVIEW_LLM_API_KEY`、`TIANGONG_LCA_REVIEW_LLM_MODEL` |
| `qa lifecyclemodel` | 无 |
| `flow get` | 远程认证环境 |
| `flow list` | 远程认证环境 |
| `flow identity-preflight` | 默认无；remote candidates 需要远程认证环境 |
| `flow build-plan` | 无 |
| `flow remediate` | 无 |
| `flow publish-version` | 远程认证环境 |
| `flow publish-reviewed-data` | dry-run 无；`--commit` 需要远程认证环境 |
| `flow build-alias-map` | 无 |
| `flow scan-process-flow-refs` | 无 |
| `flow plan-process-flow-repairs` | 无 |
| `flow apply-process-flow-repairs` | 无 |
| `flow regen-product` | 无 |
| `flow validate-processes` | 无 |
| `publish run` | 无 |
| `validation run` | 无 |
| `release *` | 远程认证环境；服务端仍要求 `data_product_manager`，禁止 service-role |

## 6. 质量门

### 6.1 当前质量门

```bash
pnpm lint
pnpm prettier
pnpm test
pnpm test:package
pnpm test:coverage
pnpm test:coverage:assert-full
pnpm prepush:gate
```

`pnpm lint` 以 type-aware Oxlint 为唯一 lint engine，并串联格式、coverage-ignore、Data API consumer 与 TypeScript 7 typecheck。`pnpm prepush:gate` 必须包含 package contract 以及 `src/**/*.ts` 的 100% statements / branches / functions / lines 证明。

### 6.2 为什么覆盖率门只卡 `src/**/*.ts`

这是一个有意设计，不是偷懒。

原因：

- `bin/tiangong-lca.js` 是极薄启动器
- 运行时真正执行的是由 `src/**/*.ts` 编译出来的 `dist/` 产物
- 它的价值主要在 smoke test，而不是复杂业务逻辑

所以当前做法是：

- `src/**/*.ts` 必须 100% lines / branches / functions / statements
- `bin` 入口由普通测试做 smoke 保证

这比“把所有文件都硬塞进 coverage，结果统计失真”更可靠。

### 6.3 发布自动化

CLI 现在额外有一条独立于质量门的 npm 发布链路：

- release-prep PR 只修改 `package.json` 版本；依赖图不变时，唯一根 `pnpm-lock.yaml` 保持存在、frozen 且不变
- 合并到 `main` 后，`tag-release-from-merge.yml` 自动创建 `cli-vX.Y.Z`
- 所有 Node workflow 通过固定的 `pnpm/setup` v2.0.2 配置 Node 24.19.0，并以 frozen 根 lock 安装
- `publish.yml` 从该 tag 通过原生 pnpm OIDC/provenance 触发 npm Trusted Publishing
- 例行发布不从本机发起；本机只做版本修改、质量门、未发布校验和 `pnpm --filter @tiangong-lca/cli --fail-if-no-match pack --dry-run`
- tarball 必须只含 runtime files；不能携带 pnpm workspace/lock、TypeScript、Oxlint、测试或源码工具，consumer 不能依赖 pnpm 特性

每次发版的 operator runbook 见 [release-runbook.md](./release-runbook.md)。

一次性的仓库 secret 和 npm Trusted Publisher 配置见 [release-setup.md](./release-setup.md)。

## 7. 与 `tiangong-lca-skills` 的关系

### 7.1 定位分工

- `tiangong-lca-cli`：统一执行面
- `tiangong-lca-skills`：agent 安装面、任务包装面

### 7.2 第一批迁移对象

最适合先迁移到统一 CLI 的，是当前的薄远程 skill：

| 当前 skill                     | 目标 CLI                             |
| ------------------------------ | ------------------------------------ |
| `flow-hybrid-search`           | `tiangong-lca search flow`           |
| `process-hybrid-search`        | `tiangong-lca search process`        |
| `lifecyclemodel-hybrid-search` | `tiangong-lca search lifecyclemodel` |
| `embedding-ft`                 | `tiangong-lca admin embedding-run`   |

### 7.3 已完成 CLI 收口的 workflow skills

当前 canonical path 已经固定为 `skill -> 原生 Node .mjs wrapper -> tiangong-lca CLI`：

- `process-automated-builder`
  - `tiangong-lca process auto-build`
  - `tiangong-lca process resume-build`
  - `tiangong-lca process publish-build`
  - `tiangong-lca process batch-build`
  - skill 侧不再保留 Python / LangGraph / MCP / KB / OCR fallback
- `lifecyclemodel-automated-builder`
  - `tiangong-lca lifecyclemodel auto-build`
  - `tiangong-lca lifecyclemodel validate-build`
  - `tiangong-lca lifecyclemodel publish-build`
  - skill 侧不再保留 shell 兼容壳或 Python / MCP runtime
- `lifecycleinventory-review`
  - `tiangong-lca qa process`
  - `tiangong-lca qa lifecyclemodel`
- `flow-governance-review`
  - `tiangong-lca qa flow`
  - `tiangong-lca flow get`
  - `tiangong-lca flow list`
  - `tiangong-lca flow remediate`
  - `tiangong-lca flow publish-version`
  - `tiangong-lca flow publish-reviewed-data`
  - `tiangong-lca flow build-alias-map`
  - `tiangong-lca flow scan-process-flow-refs`
  - `tiangong-lca flow plan-process-flow-repairs`
  - `tiangong-lca flow apply-process-flow-repairs`
  - `tiangong-lca flow regen-product`
  - `tiangong-lca flow validate-processes`
  - OpenClaw / dedup / legacy Python orchestration 已从 supported path 中移除
- `lifecyclemodel-recursive-orchestrator`
  - `tiangong-lca lifecyclemodel orchestrate`
  - skill wrapper 只保留对 `plan | execute | publish` 的薄调用
- `lca-publish-executor`
  - `tiangong-lca publish run`
  - publish contract 已不再保留私有 Python 实现

当前更合理的扩展路径是：

1. 先在 CLI 命令树定义稳定动作
2. 再让 skill 只做薄调用
3. 最后才判断是否值得继续下沉成 REST/Edge Function 能力

## 8. 推荐的 skills 调用方式

在 workspace 内部，skill wrapper 应优先把 CLI 仓库作为相邻 repo 调用。

推荐约定：

- 默认路径：`${WORKSPACE_ROOT}/tiangong-lca-cli`
- 可覆盖路径：`TIANGONG_LCA_CLI_DIR`
- skill wrapper 直接使用原生 Node `.mjs`，不再保留 shell 兼容壳

调用方式优先顺序：

1. `node "${TIANGONG_LCA_CLI_DIR}/bin/tiangong-lca.js" ...`
2. `node "${TIANGONG_LCA_CLI_DIR}/dist/src/main.js" ...`

不要再在 skill 内部重复实现一套 `curl` 参数解析和环境变量规则。

## 9. 下一阶段路线

### 当前已经完成

- 统一 CLI 命令树已经固定
- skills 已切为原生 Node `.mjs` 薄 wrapper
- 旧 Python / MCP / shell runtime 已不再是 supported path
- publish / validation / governance / orchestrate 都已经有统一 CLI 边界

### 后续只保留原生增量，不再叫“遗留迁移”

- lifecyclemodel 的 discovery / AI 选择逻辑，只有在产品面确认需要时才继续抽象成新的 CLI 子命令
- `auth identity-receipt`、`auth status`、`auth whoami` 与 `auth doctor-auth` 已由 OAuth/agent human-handoff 场景实现；`job` placeholder 仍只在出现独立真实场景时补齐，而不是为了对称性先做
- 任何新增能力都必须先定义成 `tiangong-lca <noun> <verb>`，再决定是否要进一步服务化

## 10. 结论

这次实施的核心不是“又做一个工具”，而是收敛执行面：

- CLI 负责统一能力抽象
- skills 负责任务包装
- REST 负责明确远程边界
- MCP 不再进入 CLI 内部

如果后续继续扩能力，也必须遵守同一条原则：

先判断它是不是稳定的业务动作，再决定它是不是应该进入 `tiangong-lca` 命令树。
