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
lastReviewedAt: 2026-11-11
lastReviewedCommit: a1f41e60c64954fe0caf9320785e7a79615417ac
lastReviewedNote: 'Reviewed Review refusal classification by endpoint, durable recovery, and unified absence errors.'
related:
  - AGENTS.md
  - .docpact/config.yaml
  - README.md
  - docs/agents/repo-validation.md
  - docs/agents/repo-architecture.md
  - docs/IMPLEMENTATION_GUIDE_CN.md
---

# CLI 开发指南

本指南说明当前候选源码的开发入口。能力清单与服务限制以 [README](README.md) 为准；目标设计位于 [docs/interfaces](docs/interfaces/README.md)，实现规则以 [AGENTS](AGENTS.md) 和[架构](docs/agents/repo-architecture.md)为准。旧入口到当前能力的对应见[能力对照](docs/analysis/cli-interface-comparison.md)。旧版本实现及交付过程从 Git 历史和原始交付记录追溯。

## 工具链与运行

使用 `.nvmrc` 的 Node 和 `package.json` 的精确 pnpm 版本，保留唯一根 workspace 与锁文件。安装前核对 manifest；不要引入第二种包管理器或无关依赖升级。

```bash
pnpm install --frozen-lockfile
pnpm build
node bin/tiangong-lca.js --help --json
pnpm dev
```

开发时可以从源码监听启动；安装包使用原生 Node 入口及生产依赖。源代码目录不属于已安装命令的运行前提。

## 命令与模块

数据能力使用 `dataset <type> <action>`，审核使用 `review <action>`。`create` 和 `save` 是不同写入意图，查询必须明确选择精确版本或 `latest`。本地修改、校验、Model 结果生成和 Source 附件传输不自动保存对象。`dataset model aggregate` 保留为 `build-resulting-process` 的正式别名。

旧 `search/flow/process/lifecyclemodel/qa/publish` 以及通用 Dataset 工作流入口已经删除；它们返回 `UNKNOWN_COMMAND`，不执行转接。普通维护、分类维护、Study、Release、admin、runtime/PCR 和文件包工具按独立契约保留。准确范围见[能力对照](docs/analysis/cli-interface-comparison.md#旧入口处置与保留边界)。

`src/cli.ts` 仅组合当前入口，`src/cli-deps.ts` 定义内部依赖。解析与呈现在 `src/commands/`，纯业务操作在 `src/application/`，服务适配在 `src/adapters/`。复用 `src/lib/` 的规则和安全设施；不要为了复用内部实现重新开放已删除命令或增加公共深层导出。

## 配置与身份

配置项说明见 `.env.example`；启动过程由 `src/main.ts`、`src/lib/config/dotenv.ts` 和 `src/lib/config/env.ts` 负责。Runtime 命令不加载项目 `.env`。官方公共 OAuth 配置可使用默认值，自定义环境必须提供完整且匹配的配置，不能混用默认身份或目标。

交互登录使用 OAuth/PKCE；headless 访问只通过获准的环境或秘密注入边界使用短期令牌，不持久化或自动刷新。令牌、密码、授权码及私有会话不得进入 argv、日志、fixture、产物或 Git。Auth 的在线身份回执放在 `data.receipt`，`--output` 可保存原始安全回执。`doctor` 的本地观察和显式在线健康检查不代表账号业务权限。

```bash
node bin/tiangong-lca.js doctor --json
node bin/tiangong-lca.js auth status --json
node bin/tiangong-lca.js dataset process validate --help --json
```

## 验证与安全

```bash
pnpm lint
pnpm test
pnpm prepush:gate
```

[验证契约](docs/agents/repo-validation.md)规定完整覆盖率、独立入口、安装包与领域测试。删除入口后的拒绝测试要验证无网络或写入；保留内部算法的测试继续验证科学结果、权限、派发前校验和原请求恢复。测试数变化不能替代这些性质的证据。

服务适配继续遵守[运行约束](docs/agents/existing-runtime-contract.md)。未知写入结果必须按原意图读回，不能自动重放；CLI 不使用 service-role、SQL 或裸 REST 变更作为业务后备。真实账号测试另受[授权规范](docs/agents/live-case-testing.md)约束，模拟服务不等于真实权限、事务或部署验证。

## 文档与交付

修改文档遵守 [docs/AGENTS](docs/AGENTS.md)，原位修正当前说明，保留历史证据的版本身份。实施状态见[重构计划](docs/plans/cli-0.2.0-refactor-plan.md)，当次源码、验证和授权范围记录在 Issue/PR。

发布流程由[发布手册](docs/release-runbook.md)与[发布配置](docs/release-setup.md)维护。软件源码、版本发布、下游采用和 workspace 集成是独立状态；下游升级在 CLI Release 后分别进行。

业务写入的明确拒绝和未知结果分别验证；相同请求身份返回已记录的原拒绝，不自动重新派发。普通帮助为可读文本，机器契约使用 `--help --json`。
