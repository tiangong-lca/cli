---
title: Process 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Process

入口：`tiangong-lca dataset process <action>`。Process 包含过程说明、输入输出交换项、参考信息及领域数据。

## 操作

| 动作 | Process 语义 |
| --- | --- |
| `get` / `list` / `search` / `versions` | 读取或查找过程。`get --fields exchanges` 读取交换项投影。 |
| `contract` | 获取过程内容结构、方法资料和规则。 |
| `statistics` | 在明确可见范围内按状态、分类等已声明维度汇总数量，返回范围、观察时间和扫描完整性。 |
| `validate` | 检查结构、交换项身份、参考项、引用及适用的业务规则。 |
| `create` / `save` / `delete` | 创建新草稿、保存或删除已有草稿，禁止隐式创建或覆盖。 |
| `diff` / `patch` | 比较或修改明确内容，补丁定位到具体交换项或字段。 |
| `references get` / `references check` / `references rewrite` | 返回、核验或在本地替换明确引用。 |
| `translations extract` / `translations apply` | 提取多语言字段或回填给定译文。 |

共同操作遵循 [Dataset](README.md) 和[数据处理](processing.md)。交换项不建立独立远程保存入口：调用方在本地应用补丁，再使用完整内容与前置修订保存 Process。

`statistics` 接收与列表一致的范围过滤和 `--group-by` 维度；只支持命令契约声明的分组。输入范围或扫描不完整时返回部分结果，不将统计覆盖率解释为数据质量或生产任务完成率。

## 交换项与科学语义

交换项身份只在所属 Process 内解释，同一 Flow 可被多个交换项引用。Flow 名称不能替代精确引用，数组位置不能替代稳定交换项身份。

数量、单位、方向、参考输出和分配具有业务含义。缺少事实或证据时返回可定位问题，不填入未经选择的默认科学数值。显式字段补丁可以表达调用方决定，命令不产生该决定。

结构合法、引用可解析、规则通过和物理合理性分别报告。质量平衡只在所选维度、单位、边界及参考证据足以支持时计算；运输功、能量等不能混入质量总量。不适用、未验证与数值不平衡分别表达，不以零替代未知值。

创建与保存检查身份、引用及服务端约束；保存额外核对已有草稿的并发状态。来源模型关联保留精确版本，不自动引用最新模型。保存过程成功不表示相关模型或计算结果已更新。

## 审核

Process 支持独立审核，也可作为多对象审核包的成员。统一使用 `review submit` 和 `review resubmit`，通过请求中的 `type: process` 和精确内容身份选择对象。

默认 `includeRelated: true` 包含关联数据；设置为 `false` 时只审核所选对象或明确包内成员。默认按业务依赖纳入所需 Flow、Source、Contact 等数据，区分本次被审成员与已有通过结论的精确参考材料。

提交、预览、内容固定、重新提交与审核处理遵循 [Review 契约](../reviews.md)。Dataset 保存不自动提交审核，也不改变已提交的审核包。

## 示例

```bash
tiangong-lca dataset process get --id <process-id> --version <version> --output process.json --json
tiangong-lca dataset process validate --input candidate-process.json --checks schema,references,business --json
tiangong-lca dataset process create --input process-create.json --json
tiangong-lca dataset process save --input process-save.json --json
tiangong-lca review submit --input process-review.json --json
tiangong-lca review resubmit --input process-resubmission.json --json
```

远程引用检查需要认证或明确的本地引用证据。审核进度与处理通过 [Review](../reviews.md) 完成。
