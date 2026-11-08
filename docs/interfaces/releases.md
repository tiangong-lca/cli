---
title: Release 接口保留范围
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Release

Release 负责数据产品及其交付产物的发布。由于尚无实际使用反馈，本轮不优化 Release；现有命令名称、参数、结果结构、权限和恢复机制全部沿用既有契约。

## 保留接口

| 范围 | 现有命令 |
| --- | --- |
| 发布操作 | `prepare`、`upload`、`finalize`、`approve`、`publish`、`readback-verify`、`unpublish`。 |
| 状态查询 | `status`、`current`。 |
| 交付产物读取 | `calculation-bundle`、`calculation-artifact`、`artifact-download`。 |

入口为 `tiangong-lca release <action>`。`status` 继续使用 `--release-run-id`；文件下载继续使用现有产物标识与 `--output`。本轮不引入 `release get` 或 `release download`，也不将新的通用结果结构强加给现有 Release。

```bash
tiangong-lca release --help
tiangong-lca release status --release-run-id <release-run-id> --json
tiangong-lca release artifact-download --artifact-id <artifact-id> --output release.zip --json
```

## 与 Dataset、Review 的边界

Dataset 负责数据集内容；Review 负责单对象或审核包的提交、重新提交及审核单处理；Release 负责数据产品发布。数据保存、审核决定和产品发布是不同的业务结果。本轮对象类型补全不调整 Release 与服务端之间的既有协议。

现有行为及约束见[架构说明](../agents/repo-architecture.md#lcilcia-data-release-transport)、[命令入口](../../src/cli.ts)和 [Release 适配器](../../src/lib/lca-release.ts)。
