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
| `list-references` | 列出当前内容的出向数据集引用，包含类型、ID、版本及出现位置；不逐一查询引用目标。 |
| `translations extract` / `translations apply` | 提取多语言字段或回填给定译文。 |

共同操作遵循 [Dataset](README.md) 和[数据处理](processing.md)。交换项不建立独立远程保存入口：调用方直接编辑本地候选内容或应用通用补丁，再使用完整内容与前置修订保存 Process。

`statistics` 接收与列表一致的范围过滤和 `--group-by` 维度；只支持命令契约声明的分组。输入范围或扫描不完整时返回部分结果，不将统计覆盖率解释为数据质量或生产任务完成率。

支持 `--owner`、`--state`、`--scope visible|current-user` 和 `--group-by state,classification`；默认范围为当前权限可见的全部状态，默认按状态分组。结构化选择也可通过 `--input` 提供 `scope`、`owner`、`stateCodes`、`groupBy`、`maxRows`，与命令行范围参数互斥。`current-user` 在线核验账号，不能同时选择其他所有者。

`--max-rows` 默认 10000，范围为 1–100000。达到扫描上限、计数变化或跨页身份重复时报告部分观察结果及原因，不声称完成全量统计或一致快照。分类分组按实际分类层级和标识，缺失分类保留为 null。默认最多展示五个分组，完整分组通过 `--output` 写出。计数单位为范围内精确 ID 与版本的记录。

## 交换项与科学语义

交换项身份只在所属 Process 内解释，同一 Flow 可被多个交换项引用。Flow 名称不能替代精确引用，数组位置不能替代稳定交换项身份。

数量、单位、方向、参考输出和分配具有业务含义。缺少事实或证据时返回可定位问题，不填入未经选择的默认科学数值。显式字段补丁可以表达调用方决定，命令不产生该决定。

结构合法、引用可解析、规则通过和物理合理性分别报告。质量平衡只在所选维度、单位、边界及参考证据足以支持时计算；运输功、能量等不能混入质量总量。不适用、未验证与数值不平衡分别表达，不以零替代未知值。

创建与保存检查身份、引用及服务端约束；保存额外核对已有草稿的并发状态。来源模型关联保留精确版本，不自动引用最新模型。保存过程成功不表示相关模型或计算结果已更新。

## 前景与背景计算角色

Study 根据用户资料建立前景 Process，并显式选用适合的背景 Process，流程见 [Study 总体设计](../study.md)。前景与背景是模型中的角色，不要求增加两种数据集类型。

背景支持具备参考产品、单位与数量基准、资源和排放清单、来源及覆盖边界的聚合 Process。满足内容及使用契约的 Result Process 应允许作为此类输入，不能仅因 Result 类别拒绝；仅有 LCIA 分数的结果不在该消费范围。按聚合后清单使用，不重复施加已完成的分配，不自动展开其原始组成过程。原始过程的追溯引用与计算依赖分别表达，具体规则见[背景过程与显式连接](../study.md#背景过程与显式连接)。

可搜索、可读和可参与计算分别验证。允许读取并消费背景清单不自动授予修改、删除或再次发布原结果的权限。目标消费规则不改变既有已发布接口的权限，相关实现须由所属服务同步交付。

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
