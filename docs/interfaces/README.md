---
title: CLI 目标接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
whenToUse:
  - checking the target CLI interface boundaries
whenToUpdate:
  - when the documented scope or behavior changes
checkPaths:
  - docs/interfaces/**
lastReviewedAt: 2026-11-12
lastReviewedCommit: e5dcfaf578033019a80f470e0b02dd249f18d56d
lastReviewedNote: 'CLI #477: reviewed local runtime setup, saved calculation retrieval and normal sparse LCIA applicability; no hosted activation or automatic native distribution is claimed.'
---

# CLI 目标接口设计

本目录定义 CLI 的目标接口设计基线：能力范围、命令归属、输入输出责任和操作边界。正文使用规范性表述，作为实现与验收的依据；它不表示全部目标命令已上线。已发布版本的可执行行为以该版本帮助及现行执行契约为准。现状盘点、实现差距与迁移计划在本目录之外维护。

本目录覆盖 Dataset 对象、审核及 Model 计算的目标接口。Model 计算按来源选择线上任务或本地执行；背景输入选择状态 100 的 Process，并通过独立结果通道准备完整聚合 LCI。其后续实施与已发布的 0.2.0 重构范围分别记录。Release 沿用现有接口，不纳入本轮优化；跨类型数据包操作不在本轮确定新的命令组织方式。

## 核心目标

CLI 提供高效、原子化、可组合的业务操作，让 AI 能够发现能力、准确指定对象、执行操作并验证结果。

AI 决定任务目标、选择证据与操作顺序。CLI 执行明确动作，检查领域约束，返回实际效果、完整性和可继续操作的身份。一次调用必须说明操作对象、必要输入、产生的效果、成功条件及失败后的恢复方式。

## 四类职责

| 职责模块 | 能力范围 | 接口组织 |
| --- | --- | --- |
| 环境验证与运行诊断 | 安装身份、组件兼容性、配置和连接检查。 | `doctor`、`runtime`；运行支撑与业务操作分别发现。 |
| 身份认证与账号管理 | 登录、会话检查、在线身份确认、当前账号切换和本地退出。 | `auth`；不承担组织用户管理或数据授权。 |
| 数据查询与发现 | 检索、列表、读取、版本、引用、分类和输入契约发现。 | 挂在相应业务对象下，遵守共同查询契约。 |
| 数据业务操作 | 数据集创建和修改、确定性处理、校验、模型计算、审核申请、审核单处理、数据产品发布。 | `dataset`、`calculation`、`review`、`release`；Study 保留计算项目及报告接口。 |

四类职责是能力分类，不是四个顶层命令。查询与修改可以属于同一业务对象；例如 `dataset process get` 和 `dataset process save` 分别承担查询与修改。

## 命令层级

| 入口 | 对象 | 责任 |
| --- | --- | --- |
| `dataset <type> <action>` | 某一类型的数据集。 | 查询、校验、创建、保存和类型特有操作；Model 包含计算入口。 |
| `report render` | 本地报告 JSON。 | 生成离线交互式 HTML，内嵌模型；中英文切换且每次只显示一种语言，PDF 使用浏览器打印。 |
| `calculation <action>` | 一次模型计算及其结果。 | 查询状态、获取绑定输入和引擎身份的结果；执行位置由模型来源决定。 |
| `study <action>` | 计算项目、情景及报告。 | 为 Study Skill 提供项目持久化、运行、分析和报告原语；完整建模研究由 Skill 组织，既有协议保持独立。 |
| `dataset classification <action>` | 分类或地理位置目录。 | 按明确目录和版本导航。 |
| `review <action>` | 审核申请、审核包与审核单。 | 提交、重新提交、查询进度、获取材料、记录意见和决定、撤回申请。 |
| `release <action>` | 数据产品 Release 及交付产物。 | 沿用现有接口，本轮不调整命令和行为。 |

`dataset` 下的类型为 `flow`、`process`、`model`、`source`、`contact`、`flowproperty`、`unitgroup`、`lciamethod`。命令使用单数；`model` 表示生命周期模型。分类目录是公共查询资源，不归入某一种数据类型。

同名动作保持共同语义，具体类型只暴露其能力表允许的动作。存在某种 schema 不等于具备该类型的远程写入能力。Model 的“生成模型结果过程”使用 `build-resulting-process` 主命令，同时提供 `aggregate` 别名；两者是同一操作，示例、推荐命令和结果动作名称统一使用主命令。

```text
tiangong-lca dataset process get
tiangong-lca dataset process create
tiangong-lca dataset process save
tiangong-lca review submit
tiangong-lca review resubmit
tiangong-lca review get
tiangong-lca release publish
```

## 领域边界

- `create` 创建新草稿，`save` 更新精确定位的已有草稿。目标冲突或缺失不改变调用意图。
- `validate` 执行规则检查；`review` 记录授权主体对明确内容的审核。自动检查通过不等于审核通过。
- `review submit` 和 `review resubmit` 统一提交及重新提交审核，支持 Flow、Process、Model、Source、Contact 的单对象或审核包。默认包含关联数据，`includeRelated: false` 限定所选内容；提交者与审核者共享同一命令树。
- Release 面向产品版本、内容清单和交付产物。数据入库、草稿保存、数据审核、发布批准和公开发布具有不同的成功条件。
- Model 是计算对象，Run 是独立计算记录；Study 是组织资料、建模、背景选择和分析的研究对象，对独立 Model 计算保持可选。线上模型默认提交线上任务，本地模型默认本地执行；输入不完整时显式准备，不自动跨位置执行。详见[Model 计算](calculations.md)。
- 本地处理生成候选内容，远程写入显式使用 `create` 或 `save`。转换、聚合、补丁和附件上传不隐式保存数据集。
- 环境与账号管理不承担业务修复。业务状态查询归属相应对象；安装缓存和会话状态不能替代业务结果。
- 专项数据修复流程的范围选择、审批批次与任务编排由调用方工作流承担。CLI 保留通用维护原语及其安全约束；Batch 调度是公共库能力，不建立业务命令入口。

## 原子操作与组合

一个命令表达一个独立业务意图。必要的校验、权限检查、并发保护和结果确认可以属于同一操作；跨阶段的任务计划不属于操作内部。

| 操作              | 成功边界                                                        |
| ----------------- | --------------------------------------------------------------- |
| 创建 Process 草稿 | 返回服务端接受的精确身份和内容验证结果。                        |
| 保存已有 Process  | 目标及前置状态匹配，更新成功且可确认；冲突不覆盖。              |
| 应用本地补丁      | 明确输入上的全部补丁通过前置检查并生成新文件。                  |
| 生成模型结果过程  | 在显式模型、引用和聚合规则下生成可追溯的结果 Process 候选内容。 |
| 提交审核          | 返回被受理的审核单及绑定内容；不代表审核通过。                  |

批量是同类原子操作的执行形式，必须保留逐项身份、结果和未知状态。跨对象一致性依赖领域服务声明的事务保证，不能由 CLI 命令名称推导。

## 核心接口之外的职责

| 职责 | 所属边界 |
| --- | --- |
| 数据生产计划、AI 生成、证据取舍、修复队列、任务交接与完成判断 | Foundry 或调用方工作流；可复用 Agent 流程由 Skills 提供。 |
| 专项生产修复的范围、审批、轮次和执行编排 | Utilities 等受治理的运维流程；调用 CLI 的受约束读写原语。 |
| Study 的研究引导、资料处理、前景建模、背景选择及结果解释 | Study Skill 编排，子 Skill 提供可复用资料能力；CLI 执行明确业务操作。完整边界见 [Study 总体设计](study.md)。 |
| Study 项目持久化、分析及报告审核与分享 | 独立产品接口；Model 计算通过明确身份关联，不强制先创建项目。现行协议不因目标设计自动迁移。 |
| 计算内核、线上队列调度与 Worker 重试 | 所属计算及任务服务；CLI 适配明确操作，本地执行无需复制线上数据库和队列。 |
| 组件安装、缓存租约、固定 PCR 工具执行 | 运行支撑层，单独发现，不成为数据生产阶段。 |
| 数据库权限、审核状态转换、发布资格、科学规则 | 所属领域服务或规则包；CLI 消费并准确表达，不另建权威规则。 |

确定性的数据处理应保留。判断是否进入 CLI 的标准是输入、效果和验证边界是否清晰，而不是实现是否复杂或是否由 AI 调用。通用批处理与恢复库也不需要包装为顶层任务管理命令。

## AI Friendly 上下文

每次操作同时返回业务事实、继续操作的上下文和回复模板。AI 应能从本次结果准确解释状态，并直接构造下一次调用。

- `nextActions` 每项只包含简短说明和可选命令；命令带有真实参数，可直接复制。
- 缺少输入或需要选择时，在提示中直接说明；已有适用决定直接复用，不增加重复确认。
- `replyTemplate` 只返回一份 Markdown 文件引用，指导 AI 根据实际结果回复，不使用额外的模板协议。
- 实际输入、采用的默认值、数据范围和未执行检查明确返回；大型内容通过文件或分页按需读取。
- 推荐不授予权限、不自动启动后继流程；本次目标已完成时允许没有下一步。

字段与行为见 [AI Friendly 上下文设计](ai-context.md)，模板见[回复模板目录](reply-templates/README.md)。本轮完善核心接口的上下文表达，Release 继续沿用现有契约。

## 文档导航

| 文档 | 规定内容 |
| --- | --- |
| [通用约定](conventions.md) | 参数、能力发现、结果、错误、批量与恢复。 |
| [AI Friendly 上下文](ai-context.md) | 下一步提示、回复指导、上下文预算与交接。 |
| [回复模板](reply-templates/README.md) | 按结果选择的轻量 Markdown 回复指导。 |
| [环境诊断](environment.md) | 环境观察及运行支撑边界。 |
| [身份与账号](identity.md) | 会话、账号选择与身份核验。 |
| [查询与发现](discovery.md) | 读取、检索、版本、分类与契约发现。 |
| [Dataset](datasets/README.md) | 类型能力矩阵、创建与保存、与审核的边界。 |
| [Flow](datasets/flows.md) | 流、属性和单位引用。 |
| [Process](datasets/processes.md) | 交换项、引用及业务校验。 |
| [Study 总体设计](study.md) | 从资料到前景、背景模型与计算分析的流程、产物及职责。 |
| [Model 计算](calculations.md) | 模型来源、完整输入、引擎与执行器、运行结果及恢复边界。 |
| [Model](datasets/models.md) | 模型图、生成模型结果过程与关联数据。 |
| [Source](datasets/sources.md) | 来源记录、附件传输与引用。 |
| [Contact](datasets/contacts.md) | 联系人和机构记录，与登录账号的边界。 |
| [Flow Property](datasets/flowproperties.md) | 流属性及参考单位组关系。 |
| [Unit Group](datasets/unitgroups.md) | 单位、参考单位及组内转换关系。 |
| [LCIA Method](datasets/lciamethods.md) | 方法内容契约与结构校验。 |
| [数据处理](datasets/processing.md) | 单类型内容的差异、补丁、引用和翻译处理。 |
| [审核](reviews.md) | 单对象与审核包的提交、查询及处理。 |
| [发布](releases.md) | 现有 Release 接口的保留范围，本轮不优化。 |
