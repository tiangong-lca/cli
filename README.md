---
title: TianGong LCA CLI
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
whenToUse:
  - installing the CLI or checking implemented capabilities
whenToUpdate:
  - when the documented scope or behavior changes
checkPaths:
  - README.md
  - src/commands/**
lastReviewedAt: 2026-11-11
lastReviewedCommit: 831ecbac04bcab9b198c58c55ffb007de8b50e85
lastReviewedNote: 'Reviewed Review refusal classification by endpoint, durable recovery, and unified absence errors.'
---

# TianGong LCA CLI

为人和 AI 提供明确、原子化、可组合的 LCA 业务操作：发现数据、准备内容、执行操作并准确读取结果。AI 或调用方决定目标与操作顺序，CLI 负责执行和表达实际效果。

包名：`@tiangong-lca/cli`。命令：`tiangong-lca`。

## 当前状态

当前源码正在实施 0.2.0 重构，包版本仍为 0.1.29；源码能力不代表 npm 已发布版本。查看已安装版本和实际帮助：

```bash
tiangong-lca --version
tiangong-lca --help
tiangong-lca --help --json
```

| 范围 | 当前状态 |
| --- | --- |
| 环境与认证 | `doctor` 提供本地诊断及显式在线健康检查；Auth 返回统一上下文，并保留原始身份/会话回执。`runtime` 保留独立运行协议。 |
| Dataset 查询与内容处理 | 八种对象按能力表提供类型入口；包含契约、精确读取、分页、引用清单、校验及可编辑对象的本地处理。 |
| Dataset 写入与 Review | 适配现有业务服务：创建与保存分离、草稿删除、关联审核提交、当前审核查询、草稿意见及审核决定。服务边界见下文。 |
| Model 结果生成 | `build-resulting-process` 为主命令，`aggregate` 为同实现别名；显式输入生成候选，不自动写入。 |
| 专项与运行支撑 | 普通维护、Study、Release、runtime/PCR、分类维护与文件包工具保留各自契约。 |

## 安装与开始

使用 Node 24.19.0 或受支持的后续 Node 24 版本。当前支持的平台以[运行时契约](docs/agents/runtime-distribution-contract.md)为准。

```bash
pnpm add -g @tiangong-lca/cli
tiangong-lca --help
tiangong-lca auth login
tiangong-lca auth whoami --json
```

公共安装使用已发布包；下列新 Dataset 示例需要从当前源码构建。官方环境登录使用浏览器 OAuth。短期令牌只能通过受支持的秘密环境边界注入，不写入命令参数。身份、权限和配置说明见[认证设计](docs/interfaces/identity.md)及安装版本的 `auth --help`。

## 能力组织

| 职责 | 命令方向 |
| --- | --- |
| 环境验证和运行排查 | `doctor`、`runtime`，运行支撑单独发现。 |
| 身份认证和账号管理 | `auth`，管理当前会话及身份核验。 |
| 数据查询和发现 | `dataset <type> get/list/search/versions/contract/list-references`，按类型能力开放。 |
| 数据业务操作 | Dataset 内容处理及独立写入、Review 审核、Release 数据产品发布。 |

最终接口按对象组织，完整范围见[目标设计](docs/interfaces/README.md)。表中的命令方向不是当前全部可执行命令清单。研究、生产计划和跨阶段任务编排由调用方负责。

## 当前源码的 Dataset 入口

```bash
pnpm install --frozen-lockfile
pnpm build
node bin/tiangong-lca.js dataset process get --help --json
node bin/tiangong-lca.js dataset process get --id <process-id> --version <version> --output process.json --json
node bin/tiangong-lca.js dataset process validate --input process.json --output validation.json --json
```

`get` 必须显式选择精确版本或 `latest`，精确版本不存在时不回退。`--output` 保存完整内容，默认拒绝覆盖已有文件。未指定输出文件时 JSON 包含完整内容；人类输出只呈现摘要。

`validate` 接收单个规范对象内容，复用现有结构、业务、多语言和适用分配检查；显式 `--checks references` 执行现有远程精确引用准入校验。报告区分实际检查与未覆盖的科学适用性和跨对象定量一致性。LCIA Method 仅支持契约和 schema 校验。

Flow 业务校验按声明的内部 ID 唯一定位参考属性，要求所有属性因子为有限正数、参考因子精确等于十进制 1。`create/save` 在派发前执行相同检查；校验只报告具体字段问题，不自动归一化或修改数据。详见 [Flow 约束](docs/interfaces/datasets/flows.md#业务约束)。

Unit Group 业务校验检查单位内部 ID 及参考单位的唯一定位。`contract` 返回可验证来源的公共规则定义；执行了哪些检查以 `validate` 的实际报告为准，未选择的层明确列入 `notChecked`。

Process 支持 `get --fields exchanges` 读取交换项投影，投影不构成可直接保存的完整内容。`statistics --group-by state,classification [--owner <id>] [--state <code>]` 汇总明确可见范围；默认最多扫描 10000 条，通过 `--max-rows` 调整。扫描不完整返回部分结果，完整分组使用 `--output` 获取。

普通 `--help` 返回可读文本，`--help --json` 返回实际动作的机器契约、默认值与限制。新入口的 JSON 返回业务结果、完整性和上下文。下一步提示仅包含说明与可选命令，回复模板为安装包中的 Markdown 路径。大校验报告可通过 `--output` 保存；终端只显示有界摘要。缺少模板时仍保留真实业务结果。

## 环境与身份上下文

`doctor` 默认只读取本地配置与安装身份；`doctor --online` 增加对所选 Supabase Auth 的有界健康检查，不刷新会话、不核验账号，也不执行业务操作。其他服务连接和业务权限明确列为未检查。

Auth 的统一结果将原始身份或会话回执放在 `data.receipt`，区分本地观察与在线核验。`--output` 写出回执本体，保持现有身份回执公共解析器可接受的精确格式。退出只删除本地所选会话，不等于撤销远程授权。

```bash
tiangong-lca doctor --help --json
tiangong-lca doctor --online --timeout-ms 5000 --json
tiangong-lca auth status --json
tiangong-lca auth identity-receipt --expected-project-ref <project-ref> --expected-user-id <user-id> --output identity.json --json
```

## 现有业务服务边界

可编辑对象的 `create` 不覆盖已有版本，`save` 不创建缺失对象；写入请求显式绑定账号、环境和请求身份。普通草稿保存使用服务端内容比较，Model 使用现有事务接口；Model 保存与草稿删除的内容比较仅发生在 CLI 前检，结果明确披露此限制。服务契约可证明的拒绝保留安全错误码、类别及原拒绝结果；相同请求不会重新派发。其余派发后未知结果保留原请求，禁止自动重放。

Review 本次适配已有业务语义：`submit` 只接受一个起始对象，`includeRelated` 默认且仅支持 `true`；关联范围由服务端业务规则决定。`resubmit` 引用已驳回审核及同一精确对象，返回实际受理结果，不宣称后端建立了轮次关系。`get/list` 查询当前记录，`materials` 获取当前可读对象；它们不是历史审核包快照。

`review comment` 保存审核者当前草稿，可能覆盖该草稿，不形成决定；`review decide` 记录当前审核者的通过或驳回决定，Process/Model 通过需要已有审核草稿。审核者分配和最终批准或驳回仍由现有管理员业务处理，当前 CLI 不提供这些独立动作。调用方查询实际状态后才能判断是否可修改或重新提交，不能将 decide 成功解释为审核单已结束。整包多起始对象、关闭关联、历史包、追加式独立意见及审核撤回属于后续目标设计，未开放的行为会明确拒绝。

环境、认证、目录发现与业务能力使用统一结果；旧入口的移除范围与替代方式见迁移对照；[服务能力对照](docs/analysis/cli-interface-comparison.md#现有业务服务与本次实施基线)记录实施基线，不把协议模拟描述为真实账号或部署验证。

## 保留接口

数据业务仅通过 `dataset <type> <action>` 和 `review <action>` 访问。原 `search/flow/process/lifecyclemodel/qa/publish` 及通用 Dataset 旧入口已移除，调用会返回 `UNKNOWN_COMMAND`，不会转接或执行。旧生产编排由调用方组合原子操作；下游升级在 Release 后独立进行，不作为移除入口的前置条件。

`dataset model aggregate` 是 `build-resulting-process` 的正式别名，继续保留。普通维护、Study、Release、runtime/PCR、分类维护及文件包工具保留独立契约；公共库接口与当前能力共用的规则、安全设施继续保留。已退役工作流的实现、专属测试和示例不进入当前安装包。具体清单及替代方式见[迁移对照](docs/analysis/cli-interface-comparison.md#旧入口处置与保留边界)。

LCA 计算使用 `tiangong-lca study --help`。登录后用 `study capabilities` 查询可用操作。核心流程使用 v2 创建计算项目、准备模型、冻结情景、提交运行并读取结果。写入响应丢失时，使用 `study request recover --intent-file <saved-file>` 恢复原请求。分析、报告、审核和导出使用对应的协议版本，详见 [Study 契约](docs/agents/study-cli-contract.md)。

## 开发与文档

```bash
pnpm lint
pnpm prepush:gate
```

仓库开发使用 `.nvmrc` 和 `package.json` 指定的 Node/pnpm，保持唯一根锁文件。详细验证要求见[验证契约](docs/agents/repo-validation.md)。

- [AGENTS](AGENTS.md)：开发入口、目录职责和约束。
- [架构](docs/agents/repo-architecture.md)：新旧代码边界和依赖方向。
- [接口设计](docs/interfaces/README.md)：最终能力和行为。
- [实施计划](docs/plans/cli-0.2.0-refactor-plan.md)：阶段范围与进度。
- [能力对照](docs/analysis/cli-interface-comparison.md)：旧能力与目标入口。

下游迁移在 CLI 正式 Release 后由调用方分别推进，其完成状态不作为 CLI 验收条件。

`lib` 按能力划分；Alias、Length×time、Flow-identity 专项修复流程不随包提供。Batch 调度保留在 `@tiangong-lca/cli/batch` 公共库，CLI 内部直接使用共享并发锁设施。
