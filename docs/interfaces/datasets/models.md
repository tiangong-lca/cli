---
title: Model 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Model

入口：`tiangong-lca dataset model <action>`。`model` 表示生命周期模型数据集，包含过程实例、连接、参考实例和系统边界。

## 操作

| 动作 | Model 语义 |
| --- | --- |
| `get` / `list` / `search` / `versions` | 读取或查找模型，返回精确过程引用。 |
| `contract` / `validate` | 获取结构与规则，检查实例、连接端点、参考项和边界。 |
| `create` / `save` | 创建新模型草稿或保存精确已有草稿。 |
| `diff` / `patch` | 比较或应用明确的本地内容修改。 |
| `list-references` | 列出当前内容的出向数据集引用，包含类型、ID、版本及出现位置；不逐一查询引用目标。 |
| `translations extract` / `translations apply` | 提取多语言字段或回填给定译文。 |
| `graph` | 从明确模型内容生成图结构和连接发现。 |
| `aggregate` | 根据明确模型、Process 内容、投影及分配配置生成结果 Process 候选和来源关系。 |

共同契约见 [Dataset](README.md) 和[数据处理](processing.md)。本版不提供模型删除、递归规划、自动选过程或自动发布结果的命令。

## 图与聚合

`graph` 和 `aggregate` 使用 `--input` 请求、`--output` 产物。输入可以引用明确本地文件或精确远程对象，二者不能冲突；远程获取必须显式声明，缺失引用不能自动选最新版本。

`graph` 返回输入内容身份、实例、边、端点和结构发现。图生成成功不能代替业务校验，也不证明模型可计算。

`aggregate` 的输入包括完整模型、精确过程内容、参考输出、投影范围和适用分配配置。结果包含聚合后的候选数据、模型与过程内容绑定、算法及规则版本、诊断和未解决条件。支持范围之外的循环、分配或计算条件必须拒绝或标记未完成，不能默默简化。

聚合是确定性的内容处理，不运行研究任务，不启动远程 LCIA 作业，不自动保存或发布生成内容。结果 Process 经独立校验后由 `dataset process create` 或 `save` 持久化。

## 身份与关联一致性

过程实例身份与被引用 Process 身份分别表达，同一过程可被多个实例使用。连接定位到具体实例和交换项。

创建或保存模型不隐式改写所引用过程。结果过程与来源模型保持精确关系；已有结果不会因为模型更新自动变成适用于新内容。

关联写入必须满足服务端的一致性要求。需要整体提交模型与结果而接口没有对应事务保证时，返回明确的不支持或前置条件错误，不用逐项保存伪装整体原子成功。本版不暴露混合创建、更新和发布的通用 bundle 写入命令。

## 审核

Model 支持独立审核，也可作为多对象审核包的成员。统一使用 `review submit` 和 `review resubmit`，通过请求中的 `type: model` 和精确内容身份选择对象。

默认 `includeRelated: true` 包含关联数据；设置为 `false` 时只审核所选对象或明确包内成员。默认按模型的精确 Process 引用及其必要依赖解析审核包。结果过程只有在明确的业务关联及审核范围内才纳入，不能仅凭模型组成关系推断。

提交、预览、内容固定、重新提交与审核处理遵循 [Review 契约](../reviews.md)。Dataset 保存不自动提交审核，也不改变已提交的审核包。

## 示例

```bash
tiangong-lca dataset model get --id <model-id> --version <version> --output model.json --json
tiangong-lca dataset model graph --input model-graph.json --output graph.json --json
tiangong-lca dataset model aggregate --input model-aggregate.json --output resulting-process.json --json
tiangong-lca dataset model create --input model-create.json --json
tiangong-lca dataset model save --input model-save.json --json
tiangong-lca review submit --input model-review.json --json
tiangong-lca review resubmit --input model-resubmission.json --json
```

模型审核材料中的关联数据使用精确身份。进度、意见和决定通过 [Review](../reviews.md) 查询与处理。
