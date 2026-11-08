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
lastReviewedAt: 2026-11-08
lastReviewedCommit: e2b7a7a0142085180935454aa2e782d6a79433e8
lastReviewedNote: 'CLI #468: reviewed documentation-first foundation and explicit implementation boundaries; target design remains separate from runtime capability.'
---

# TianGong LCA CLI

为人和 AI 提供明确、原子化、可组合的 LCA 业务操作：发现数据、准备内容、执行操作并准确读取结果。AI 或调用方决定目标与操作顺序，CLI 负责执行和表达实际效果。

包名：`@tiangong-lca/cli`。命令：`tiangong-lca`。

## 当前状态

当前源码正在实施 0.2.0 重构，包版本仍为 0.1.29；源码能力不代表 npm 已发布版本。查看已安装版本和实际帮助：

```bash
tiangong-lca --version
tiangong-lca --help
```

| 范围 | 当前状态 |
| --- | --- |
| 环境与认证 | 既有 `doctor`、`runtime`、`auth` 可用，重构中逐步统一发现和结果。 |
| 新 Dataset 入口 | 当前源码先提供 Process `get`、`validate` 样例；限制见下文。 |
| 其他 Dataset 类型、写入、Review | 已有目标设计，尚未迁移到新接口。 |
| Model 结果生成 | 主命令 `build-resulting-process`、别名 `aggregate` 是目标设计，当前源码尚未实现新入口。 |
| Release、运行支撑与旧命令 | 沿用既有行为，参见安装版本帮助及[原有命令参考](docs/reference/legacy-command-reference.md)。 |

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

## 当前源码的 Process 样例

```bash
pnpm install --frozen-lockfile
pnpm build
node bin/tiangong-lca.js dataset process get --help --json
node bin/tiangong-lca.js dataset process get --id <process-id> --version <version> --output process.json --json
node bin/tiangong-lca.js dataset process validate --input process.json --output validation.json --json
```

`get` 必须显式选择精确版本或 `latest`，精确版本不存在时不回退。`--output` 保存完整内容，默认拒绝覆盖已有文件。未指定输出文件时 JSON 包含完整内容；人类输出只呈现摘要。

`validate` 读取单个 Process JSON，复用现有本地结构、必填字段、多语言和分配语义检查。当前只支持默认 `schema,business` 检查组合；远程引用检查和其他组合尚未接入，显式请求会被拒绝。报告保留执行过的检查及证据缺口，不能把结构合法描述为科学有效或审核通过。

新入口的 JSON 返回业务结果、完整性和上下文。下一步提示仅包含说明与可选命令，回复模板为安装包中的 Markdown 路径。大校验报告可通过 `--output` 保存；终端只显示有界摘要。缺少模板时仍保留真实业务结果。

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
- [原有命令参考](docs/reference/legacy-command-reference.md)：尚未迁移的使用方式及历史说明。

下游迁移在 CLI 正式 Release 后由调用方分别推进，其完成状态不作为 CLI 验收条件。
