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
lastReviewedAt: 2026-11-13
lastReviewedCommit: 64cf39d4cdd938225609814d2b494dbcec0b7d3a
lastReviewedNote: 'CLI #479: reviewed version-only 0.2.1 release; commands, dependencies and publication boundaries remain unchanged.'
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ../DEV_CN.md
  - ./agents/repo-architecture.md
  - ./agents/repo-validation.md
---

# CLI 实现结构

本文件说明当前候选源码如何实现原子业务接口。命令及真实服务限制见 [README](../README.md)，确定的目标设计见 [interfaces](interfaces/README.md)，实施差距见[能力对照](analysis/cli-interface-comparison.md)。旧版本实现及交付过程从 Git 历史和原始记录追溯；当前安装包不包含已退役的生产工作流。

## 入口与职责

| 层         | 位置                            | 责任                                             |
| ---------- | ------------------------------- | ------------------------------------------------ |
| 安装与启动 | `bin/`、`src/main.ts`           | 平台准入、环境加载、进程 IO。                    |
| 组合       | `src/cli.ts`、`src/cli-deps.ts` | 当前命令路由、内部依赖、结果类型和统一错误投影。 |
| 命令       | `src/commands/`                 | 严格参数、help、文件输入输出与结果呈现。         |
| 业务       | `src/application/`              | 身份、查询与内容变更规则、原子业务端口。         |
| 适配       | `src/adapters/`                 | 既有认证、数据服务、校验器、写入意图与恢复。     |
| 共享       | `src/shared/`                   | 小型结果、文件、模板设施。                       |
| 已有实现   | `src/lib/`                      | 当前能力复用的领域算法、授权和专用协议。         |

依赖从组合流向命令、业务与适配。业务层不导入 argv、文件或网络 API。Auth 服务、Release、admin、包工具、分类维护和普通维护分模块承载，不回填到主入口。代码文件原则上不超过 1000 行；按职责拆分，不压缩代码凑行数。

## 数据业务

Dataset 按八种类型的能力表开放命令：Flow、Process、Model、Source、Contact、Flow Property、Unit Group 和 LCIA Method。可写与只读类型有明确区别，不把未实现能力伪装为通用成功。

查询通过同一类型入口使用精确身份、明确的 latest 选择、分页和引用位置清单。`list-references` 是本地引用发现，目标是否存在由 get 确认；关系有效性由 validate 检查。patch 和翻译应用产生候选内容，save 读取显式写入请求，二者不互相代替。

Flow 参考属性规则由纯模块 `src/lib/validation/flow-reference-properties.ts` 统一实现，供类型化业务校验、create/save 准入、维护计划与新写入前检、维护保存和整包校验复用。规则遵循随包公共规则来源，按唯一内部 ID 解析指针，以精确十进制判断参考因子等于 1，并检查全部因子为有限正数。诊断保留字段路径；模块不修正数据或编排工作流。既有成功记录的恢复仍只核对原结果，不重新派发历史写入。

Unit Group 内部 ID 与参考单位关系检查由纯校验器同时接入类型入口和包校验。Source 附件字段不参与数据集引用清单。Review 在调用业务端口前验证输入/输出文件分离，文件写出时仍检查同一文件及硬链接，避免输出覆盖请求。

Process 的交换项投影与统计选择通过类型命令发现。统计由适配层执行有界可见范围扫描，复用既有纯汇总算法；选择和分类分组属于 application，命令、模板和续页呈现属于 commands/shared。大模型图不进入身份上下文，所有未执行的校验层明确披露。公共规则契约保留精确来源和定义，具体执行结果不由规则发现推断。

Model `build-resulting-process` 与正式别名 `aggregate` 使用同一算法及规范命令名，只生成候选 Process。模型来源携带明确类型及精确版本；保存结果过程是后续独立操作。Source 上传附件保留失败引用并独立下载验证，上传不等于对象已保存。

create 不覆盖已有版本，save 不创建缺失对象。普通草稿保存复用服务端内容 CAS；Model 使用已有事务接口，Model 保存与删除的内容比较仅发生在 CLI 前检，结果必须披露。账号、目标环境和请求身份固定到原意图；派发后未知结果只能恢复或读回，不能重放。

## 审核

Review 适配已有业务语义：一个起始对象、服务端默认关联、当前查询与材料、审核者草稿和独立决定。分配与最终处理仍由现有管理员业务完成。重新提交以真实驳回记录和同一精确对象为前提，不虚构服务端轮次或历史包。

关闭关联、多起始对象审核包、历史包、追加式独立意见及撤回属于后续目标设计。未实施语义明确拒绝，不能通过客户端编排冒充服务端保证。

## 上下文与保留协议

核心业务 JSON 包含真实结果、完整性、警告及有界下一步建议。`nextActions` 只包含说明与可选完整命令；`replyTemplate` 为包内 Markdown 路径。模板丢失不改变业务事实，不触发业务重试。Auth 回执本体及其公共解析协议保留；Doctor 区分本地观察和显式在线健康检查。

旧 `search/flow/process/lifecyclemodel/qa/publish` 与通用 Dataset 兼容入口已删除，没有隐藏路由或自动转接。调用方按真实能力组合原子操作，Release 后独立采用新版本。普通维护、Study、分类维护、Release、admin、runtime/PCR、文件包工具及四个公共库子路径保留自身协议。

[已有安全约束](agents/existing-runtime-contract.md)、[精确引用](agents/exact-reference-intent-contract.md)、[Study](agents/study-cli-contract.md)、[runtime](agents/runtime-distribution-contract.md) 与 [PCR](agents/pcr-snapshot-contract.md) 各自维护协议细节。保留当前适配器和专用协议实际依赖的算法与恢复设施。已退役工作流及其专属日志只能由匹配的历史版本解释，不新增公共深层 API。

## 环境选择

具体配置由 `.env.example` 和 `src/lib/config/env.ts` 维护；以下只区分是否需要远程身份，不复制环境实例值。

| 命令组 | 必需 env |
| --- | --- |
| 本地 Dataset 内容处理、doctor、runtime describe | 不要求远程凭据；runtime 不加载项目 `.env`。 |
| 交互 Auth 与远程 Dataset/Review | 官方公共配置可用默认值，用户通过 OAuth 建立会话；自定义目标要求完整且匹配的配置。 |
| Headless 远程操作 | 显式 API 目标、publishable key、access-token 模式及短期令牌，只从获准环境或秘密边界注入。 |
| Release、Study、runtime/PCR 执行与普通维护 | 按各自契约检查额外配置、权限与输入；安装不代表授权。 |

## 验证

[验证契约](agents/repo-validation.md)规定真实规则验证、故障及权限情景、源码外原生安装包、入口 IO 和 100% 源码覆盖率。旧入口负向验证与新入口成功场景分别执行；领域算法和安全测试直接调用内部实现，不为了通过旧测试重建命令兼容层。

单元、协议模拟、真实本地服务与四平台 CI 分别提供各自证据。模拟成功不证明部署权限；本机通过不证明四平台执行。具体源码、运行结果和未执行事项保存在交付记录，不写入接口规范。

核心帮助分别提供可读文本和 `--help --json` 机器契约，动作参数、默认值与限制按实际解析能力声明。写入错误只在已有服务契约证明未生效时记为明确拒绝；其余不确定结果继续禁止重放。拒绝结果仅保留安全错误码与类别，不复制远端原始文本。

本地报告通过 `report render` 读取轻量报告 JSON；application 校验展示结构，lib/report 生成转义 HTML/SVG，adapter 独立写文件。Skill 提供正文、双语、实际模型投影和结果，渲染器不读取线上数据、不计算、不维护研究状态。浏览器交互和打印验证见[验证指南](agents/repo-validation.md)。
