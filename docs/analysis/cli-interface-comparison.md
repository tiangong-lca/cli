---
title: CLI 现有能力与目标接口对照
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# CLI 现有能力与目标接口对照

核对基线：CLI `0.1.29`，本地 `main` 提交 `5fcde75e54220e6fca0015b85f2a5c7996c50ba4`，核对日期 2026-11-08。本次依据命令分派、帮助、关键实现及仓库契约进行静态分析，未执行生产命令，也未验证远程服务当前是否具备全部目标能力。

本文件记录现状、判断和实现差距。[目标接口目录](../interfaces/README.md)只规定设计，不承载迁移历史。本次修改仅涉及文档，不删除或重命名现有命令，不改变当前治理归属和授权。

## 设计判断与本轮范围

四类职责和 `dataset <type> <action>` 的组织方式合理。本轮补全八种对象类型的独立文档、能力范围与引用关系，不改变已确定的校验与审核分工。

- **对象覆盖需要补全**：Flow、Process、Model 之外，Source、Contact、Flow Property、Unit Group、LCIA Method 均有独立类型文档。
- **数据包需要先说明业务操作**：跨类型文件集合的转换、校验与导出不能仅凭命令层级讨论就形成新模块；本轮不确定新的数据包命令。
- **校验与审核不是目标设计缺陷**：目标已经使用 `validate` 表达规则检查、`review` 表达审核单处理。Review 的提交、重新提交及审核单能力差距属于实现工作；单对象和审核包共用入口，默认包含关联数据。
- **Release 不进入本轮优化**：保留现有命令、参数、输出及恢复契约，积累实际使用反馈后再分析。

确定性聚合、引用核验和补丁仍保留为原子能力；任务规划、证据取舍和生产队列由调用方组织。类型能力矩阵仍区分普通可编辑对象与受治理的参考数据。

## 数据包操作的具体含义

例如，一个外部 LCA 文件包同时包含 Process、它引用的 Flow、Source 和 Unit Group。这里讨论的是对这一组有关联的文件执行操作：

| 操作 | 解决的问题 | 当前对应情况 |
| --- | --- | --- |
| 格式转换 | 将整个外部格式文件包转换成 TIDAS 内容，记录字段映射、无法转换的信息与失败项。 | 已有 `dataset import-lca convert`。 |
| 整包校验 | 检查包内各对象结构，以及 Process 引用的 Flow 等对象能否在声明范围内解析。 | 已有 `validation run`；实际检查覆盖以该命令契约为准。 |
| 整包导出 | 将明确选定的多类型对象及引用清单打包成指定交付格式。 | 属于此前提出的目标扩展，不据此宣称已有通用实现。 |

它们不同于读取或保存一个 Process，也不同于依次保存多个 Process 的同类型批量操作。文件包处理不等于数据库入库或数据产品发布。

此前提出的 `dataset package` 是一种命令组织设想，尚未确定业务范围与使用需求。本轮不将其写入目标命令树，既有转换和校验入口保留。

## 能力对应

| 现有入口或能力 | 实际责任 | 目标归属及处理 |
| --- | --- | --- |
| `doctor` | 配置与环境诊断。 | 环境模块保留，在线检查显式选择。 |
| `runtime describe/ensure/status/prune/lease-release/exec` | 安装身份、组件准备、缓存与进程启动。 | 保留为单独发现的运行支撑，不混入业务命令列表。 |
| `pcr snapshot ensure/status`、`pcr exec` | 方法工具内容固定和执行。 | 运行支撑保留，不作为研究或数据生产任务状态。 |
| `auth login/status/whoami/doctor-auth/logout/identity-receipt` | 会话、身份检查和绑定回执。 | Auth 保留完整能力；不凭“账号管理”扩张为组织用户 CRUD。 |
| `search flow/process/lifecyclemodel`、`flow/process get/list` | 数据检索与读取。 | 统一到 `dataset <type> search/get/list`，补齐明确版本发现。 |
| `dataset contract get`、`context-pack` | schema、规则、方法及 AI 上下文资料。 | `dataset <type> contract`；上下文展示为同一契约的投影，不另建业务对象。 |
| `dataset classification children/path` | 分类和位置目录发现。 | `dataset classification children/path` 保留跨类型目录入口。 |
| `dataset classification audit/apply` | 分类值检查与给定选择的应用。 | 分别收敛到类型 `validate` 和本地 `patch`。 |
| `dataset support-cache export`、`flow fetch-rows` | 受权限约束的真实数据读取与文件落地。 | 类型读取及显式批量能力保留分页完整性和内容身份；跨类型文件导出的新组织方式不纳入本轮定案。 |
| `dataset/process/lifecyclemodel save-draft` | 不同路径的草稿持久化，部分路径兼有创建和更新。 | 分离 `create` 与 `save`，统一意图和恢复语义，保留类型权限与并发保护。 |
| `flow publish-version/publish-reviewed-data` | Flow 内容准备及草稿创建、保存。 | 按实际效果归入本地处理与 `create/save`，不能改名为 Release 发布。 |
| `dataset validate`、`qa process/flow/lifecyclemodel`、`process verify-rows`、`lifecyclemodel validate-build` | 结构与业务规则检查，部分依赖运行目录。 | 类型 `validate` 接收内容与规则；保留科学适用性和证据，不依赖工作流目录。 |
| `validation run` | TIDAS 包验证。 | 保持现有入口；本轮只说明包级校验与单对象校验的区别。 |
| `dataset patch apply`、`bilingual extract/apply/validate` | 本地补丁、语言字段提取和给定译文回填。 | 类型 `patch`、`translations extract/apply`、`validate`；不加入自动翻译决策。 |
| `dataset references rewrite/refresh-remote`、`process refresh-references` | 引用变更、远程版本选择及部分写入组合。 | 拆为版本发现、显式引用映射、本地替换与独立保存；不隐式追新。 |
| `dataset verify-remote` | 根对象及引用的远程状态核实。 | 精确 `get` 与 `references check`；保留默认引用政策及受约束例外证据。 |
| `dataset import-lca convert` | 外部格式转换。 | 保持现有入口；跨类型转换与导出的新命令组织不纳入本轮定案。 |
| `dataset source upload-attachments` | 文件上传、回执及 Source URI 候选改写。 | Source 类型特有动作；明确上传与保存的两个结果。 |
| `flow/process identity-preflight`、`process scope-statistics/dedup-review` | 候选比对、范围统计、去重取舍材料。 | 范围计数归 `dataset process statistics`，精确比较归 `diff`；生成前准入、保留/删除决策和专题报告归调用方。 |
| `flow/process build-plan validate/materialize`、`process complete-required-fields` | 作者计划检查、内容物化及字段补齐。 | 内容校验及显式字段处理保留；作者计划和默认事实选择由调用方提供。 |
| `flow remediate/materialize-decisions/build-alias-map/scan-process-flow-refs/plan-process-flow-repairs/apply-process-flow-repairs/regen-product/validate-processes` | Flow 治理与 Process 引用修复链。 | 核验、差异和显式补丁保留；范围选择、别名决策、修复计划和轮次移到运维流程。 |
| `lifecyclemodel graph` | 图结构与连接发现。 | `dataset model graph` 保留。 |
| `lifecyclemodel build-resulting-process` | 明确模型与过程输入下的确定性聚合。 | `dataset model aggregate` 保留，移除生产目录耦合和隐式发布意图。 |
| `process auto-build/resume-build/batch-build/publish-build`、`lifecyclemodel auto-build/orchestrate/publish-build/publish-resulting-process` | 生产运行骨架、恢复交接、递归组装和发布交接。 | 编排归 Foundry/Skills；保留可单独定义的内容处理与读写原语。 |
| `dataset author` | 文档解析并准备内容契约包，返回 evidence-ready。 | 文档理解与作者流程归调用方；契约获取保留。不能将它描述为已直接生成完整科学数据。 |
| `dataset evidence-search plan/run`、`curation-queue build/next/verify` | 证据检索策略、证据充分性评估与生产队列。 | 外层研究/生产流程；不纳入核心 Dataset 业务状态。 |
| `dataset maintenance clear-account/plan/apply/verify` 及受保护流程 | 受约束写入原语与专项范围、冻结、审批、执行混合。 | 普通精确对象删除归 Dataset；通用执行与恢复保护保留，账号清理及专项计划归运维流程。现有授权不得随迁移放宽。 |
| `admin embedding-run`、维护中的衍生重建 | 管理及衍生数据运维。 | 不进入普通环境诊断或 Dataset 作者接口；保留在独立受治理运维范围。 |
| `publish run` | 收集输入、关系、校验和发布执行的组合入口。 | 按真实对象与效果拆分；不与数据产品 Release 机械合并。 |
| `release prepare/upload/finalize/approve/publish/readback-verify/unpublish` | 产品发布及证据登记。 | 现有命令及契约原样保留，本轮不优化。 |
| `release status/current/calculation-bundle/calculation-artifact/artifact-download` | 发布状态与交付产物读取。 | 现有命令及契约原样保留，不改名为 `get` 或 `download`。 |
| `study ...` | 研究产品生命周期、场景、任务、报告与分享等。 | 不纳入核心设计；远程原子接口本身仍可由独立产品接口承载。 |
| `review` | 当前入口明确返回已移除提示，指向 `qa`。 | 目标 Review 统一负责单对象和审核包的提交、重新提交及处理，需要新增服务适配，不能把 QA 换名字当作完成。 |
| `job get/wait/logs` | 帮助中列为计划入口，未实现。 | 不纳入已具备能力；异步状态归各业务对象，不补通用 Agent 任务引擎。 |
| 公共 `batch`、`command-spec`、身份回执和 `runtime` 包接口 | 安全执行、调度与恢复库。 | 保留为可复用实现原语；不要求每个库都对应顶层业务命令。 |

## 设计边界与实现注意事项

### 创建与保存

底层已经区分 `app_dataset_create` 和 `app_dataset_save_draft`，因此外层拆分有自然依据。但部分现有外层会根据查询结果选择 insert/save，重构时必须取消这种意图推断，不能只改帮助名称。

模型现有 `syncLifecyclemodelBundleRecord` 还会在创建遇到 `VERSION_CONFLICT`、重读可见后转成更新（`update_after_create_conflict`）。目标设计明确禁止这种自动转换；实现时必须保留原始创建意图并返回冲突。

目标 `create` 创建不存在的精确数据版本；新业务版本也必须显式指定。`save` 只修改已有草稿，缺失和不可见都不能降级为创建。前置修订、来源版本与创建请求身份是目标契约的要求，不表示当前所有路径都已满足。

### 单对象与关联写入

现有模型草稿保存走关联 bundle 路径。目标类型入口不能以“原子化”为由丢掉服务端一致性要求。设计规定单对象操作显式表达关联身份，不承诺模型与结果 Process 的通用混合事务；无法通过现有服务保证的操作必须拒绝。

因此，关联 bundle 的最小业务接口需要在实现阶段按现有服务契约验证。如果现有服务要求不可拆分的模型与结果提交，应交付独立且有清晰意图的关联操作，而不能绕过服务约束或宣称普通批量保存等价。

### 支持类型与权限

参考属性、单位组和方法 schema 的存在不等于开放 CRUD。目标矩阵将 Source、Contact 与普通只读参考数据分开。Source、Contact 与 Flow、Process、Model 均可通过 Review 独立提交或组成审核包；只读参考数据作为关联材料保留。受保护的账号内支持数据写入仍需独立治理，不通过公共 create/save 扩权。

### 审核的实现差距

目标设计已经区分规则校验与审核单处理，不需要因当前 CLI 的缺口而重新划分。当前 `review` 入口指向 QA 的移除提示，真正的审核单服务适配需要在实现阶段补齐。CLI 源码不能证明后端已经提供全部目标状态、材料、决定和恢复协议。

Release 是独立领域，本轮不优化或调整其契约。

### 核心能力与支撑层

不应直接删除 runtime、PCR 固定和安全批处理等底层能力，它们有可复用的执行价值。设计将其从主要业务发现路径中分组展示，而不是把它们改成数据业务动作。

Study 排除基于核心范围收敛；确定性聚合保留基于清楚的输入和效果。两者不矛盾。研究目标、专业判断与多阶段工作流仍由调用方拥有。

## 实现差距

以下是已确定的目标要求与现状之间的差距，不是设计正文中的待选方案：

- 统一命令层级及类型能力发现；补齐目标读取、版本和内容处理入口。
- 在本轮核心接口范围内统一请求、输出、退出码、分页与能力 schema；Release 不纳入该项变更。
- 分离创建与保存，并逐路径验证服务端并发、身份和恢复保证。
- 新增 Review 的提交、重新提交和审核单服务适配，支持五种对象、审核包及默认关联范围；Dataset 保留内容操作。
- 消除任务目录和阶段文件对通用数据处理的强制依赖。
- 保留运行支撑和受保护写入的独立状态与授权边界；Release 全部沿用现有接口。
- 受影响 Foundry、Utilities、Skills 等调用方需要分别完成迁移及验收，不能通过文档改写视为已经迁移。

## AI Friendly 上下文参考

参考仓库为独立的 `release-workflows`，核对提交 `e29a2bfa11f307cbbbe0ad429e91aeae57cbcf03`。本轮只借鉴其上下文与表达方式，不修改该仓库，也不优化 CLI 现有 Release 入口。

| 已核实的设计 | CLI 目标采用方式 |
| --- | --- |
| Calculation 按实际状态生成 `nextActions`，使用精确资源和不依赖调用目录的命令。 | 每项仅返回说明和可选命令；未知结果先恢复，已受理先查询。 |
| Calculation 的模板注册表按命令和错误结果返回稳定 ID、路径、占位符语法及必需事实。 | 仅返回本次 Markdown 模板的文件引用；安装包自带模板，按需读取，不移植其注册字段和占位符协议。 |
| Release Candidate 区分推荐动作和 `nextDecision`，复用已有明确选择。 | 缺少输入或选择时直接在下一步说明中表达，不增加独立决定对象，不重复确认已有决定。 |
| Publication 的 Portal LCIA recipe 按沟通语义复用模板，事实来自当前结果及证据。 | 跨类型共享十类 Markdown 回复指导；AI 根据真实结果组织回复，模板不新增业务状态或审批要求。 |

CLI 进一步明确了实际默认值与范围披露、有界摘要、分页继续命令、模板缺失时的事实回复，以及保存单次结果即可交接的最小上下文。这些均为目标接口设计，未修改运行代码。

参考源：

- [Calculation 的推荐与回复契约](https://github.com/tiangong-lca/release-workflows/blob/e29a2bfa11f307cbbbe0ad429e91aeae57cbcf03/workflows/calculation/AGENTS.md)。
- [Calculation 模板注册表](https://github.com/tiangong-lca/release-workflows/blob/e29a2bfa11f307cbbbe0ad429e91aeae57cbcf03/workflows/calculation/reply-template-registry.mjs)。
- [Release Candidate 的上下文与选择](https://github.com/tiangong-lca/release-workflows/blob/e29a2bfa11f307cbbbe0ad429e91aeae57cbcf03/workflows/release-candidate/README.md)。
- [Publication 的模板复用边界](https://github.com/tiangong-lca/release-workflows/blob/e29a2bfa11f307cbbbe0ad429e91aeae57cbcf03/workflows/publication/README.md)。

## 证据入口

- [命令帮助和分派](../../src/cli.ts)：主帮助 `renderMainHelp`、各类型帮助、`executeCli`、`removedReviewCommand`。
- [Dataset 命令传输](../../src/lib/dataset-command.ts)：独立创建、草稿保存与删除。
- [通用草稿保存](../../src/lib/dataset-save-draft-run.ts)：创建/更新选择和受约束执行。
- [Flow 版本写入](../../src/lib/flow-publish-version.ts)：`insert_flow_version` 与 `update_flow_version` 调用的是 Dataset 创建/保存。
- [模型聚合](../../src/lib/lifecyclemodel-resulting-process.ts)、[模型 bundle 保存](../../src/lib/lifecyclemodel-bundle-save.ts)：本地内容计算与关联持久化边界。
- [内容契约](../../src/lib/dataset-contract.ts)：八种类型的内容契约与上下文投影。
- [来源解析](../../src/lib/dataset-author.ts)、[证据搜索](../../src/lib/dataset-evidence-search.ts)：证据准备与研究策略。
- [Release 适配器](../../src/lib/lca-release.ts)：完整动作集合和文件完整性约束。
- [架构契约](../agents/repo-architecture.md)、[仓库契约](../../AGENTS.md)：当前实现及治理边界。
