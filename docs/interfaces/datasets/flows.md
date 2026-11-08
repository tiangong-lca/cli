---
title: Flow 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Flow

入口：`tiangong-lca dataset flow <action>`。Flow 数据集描述流的身份、分类、属性、参考属性和单位关系。

## 操作

| 动作 | Flow 语义 |
| --- | --- |
| `get` / `list` / `search` / `versions` | 读取或查找流及其明确版本。搜索返回候选，不自动认定等价。 |
| `contract` | 获取流结构、分类和规则来源。 |
| `validate` | 检查结构、参考属性及所选证据支持的单位和引用关系。 |
| `create` / `save` / `delete` | 创建新草稿、更新或删除精确的已有草稿，遵循共同前置条件。 |
| `diff` / `patch` | 比较内容或应用明确本地修改，保留字段位置与来源。 |
| `list-references` | 列出当前内容的出向数据集引用，包含类型、ID、版本及出现位置；不逐一查询引用目标。 |
| `translations extract` / `translations apply` | 提取多语言字段或回填给定译文。 |

基础输入、输出与恢复遵循 [Dataset](README.md)，文件操作遵循[数据处理](processing.md)。

## 业务约束

Flow 与使用它的 Process 交换项分别拥有身份。修改 Flow 不修改引用它的过程、交换数量或模型。名称近似、分类相同或搜索相似不能作为复用标识、合并或替换的依据。

属性和单位关系必须定位到明确版本。缺少相关证据时报告未验证或阻断，不能根据名称推测单位换算。验证应区分“引用存在”“维度一致”和“具体换算成立”。

参考属性变化不隐式换算已有数量，也不自动更新下游对象。跨对象合并、批量重映射、衍生数据重建和生产修复轮次由独立运维流程安排；基础接口仍执行严格的对象和并发约束。

## 审核

Flow 支持独立审核，也可作为多对象审核包的成员。统一使用 `review submit` 和 `review resubmit`，通过请求中的 `type: flow` 和精确内容身份选择对象。

默认 `includeRelated: true` 包含关联数据；设置为 `false` 时只审核所选对象或明确包内成员。关联范围按 Flow 的业务引用展开；属性和单位等只读参考数据作为精确版本的参考材料，不自动形成新的被审成员。

提交、预览、内容固定、重新提交与审核处理遵循 [Review 契约](../reviews.md)。Dataset 保存不自动提交审核，也不改变已提交的审核包。

## 示例

```bash
tiangong-lca dataset flow search --query "electricity" --limit 10 --json
tiangong-lca dataset flow get --id <flow-id> --version <version> --json
tiangong-lca dataset flow validate --input candidate-flow.json --json
tiangong-lca dataset flow create --input flow-create.json --json
tiangong-lca dataset flow save --input flow-save.json --json
tiangong-lca review submit --input flow-review.json --json
tiangong-lca review resubmit --input flow-resubmission.json --json
```

创建与保存按对象是否已存在分别调用。审核受理后使用返回的审核单标识调用 [Review](../reviews.md)。
