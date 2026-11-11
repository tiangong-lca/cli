---
title: 数据处理接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# 数据处理

本地处理接收明确内容和规则，返回可验证的新内容或发现。它不选择科学结论，不自动保存、提交审核或发布。适用类型由 [Dataset 能力表](README.md)及各类型文档限定。

## 单类型内容处理

| 动作 | 输入与效果 |
| --- | --- |
| `dataset <type> diff` | `--input` 声明两个明确内容，返回字段、引用和身份差异；两侧内容摘要进入结果。 |
| `dataset <type> patch` | `--input` 声明源内容、字段或交换项选择、预期旧值及修改，生成候选内容和修改记录。 |
| `dataset <type> translations extract` | 提取指定语言字段、稳定位置及源内容绑定。 |
| `dataset <type> translations apply` | 回填外部给定的译文；源内容或定位变化时拒绝陈旧输入。 |

`diff`、`patch`、翻译操作使用 `--input` 结构化请求和 `--output` 产物。没有明确声明远程检查的文件操作不访问网络。输出不覆盖输入。

补丁支持 `test`、`add`、`replace`、`remove`。修改应携带依据或证据引用；执行依据检查不代表认可科学判断。整份输入的前置检查失败时不输出部分修改的数据；返回发现与原内容身份。批量模式按项表达原子边界。

分类赋值通过补丁表达，分类合法性由领域校验检查。双语完整度通过 `validate --checks business` 检查；CLI 不调用语言模型生成翻译或补造证据。

## 引用的查看、检查与修改

`list-references` 属于[查询与发现](../discovery.md)，只列出当前内容的引用及出现位置，不检查每个目标。确认某个目标是否存在及可访问使用精确 `get`；检查引用关系的类型、版本和业务一致性使用 `validate --checks references`。校验需要远程事实时必须显式选择并提供认证条件，或使用精确本地引用证据；未检查项不能报告通过。精确引用例外仍受所属领域的证据与授权契约约束。

引用修改是普通内容修改：调用方直接编辑候选内容，或用通用 `patch` 修改明确字段，涉及多个关联字段时保持内容一致，再进行校验并按需 `save`。`patch` 是可选工具，不是保存的必经步骤。修改必须明确目标身份、版本及作用位置，不自动追新引用或换算数值；保存沿用已有草稿的权限、前置状态和恢复约束。

## 调用示例

```bash
tiangong-lca dataset process list-references --input process.json --json
tiangong-lca dataset flow get --id <flow-id> --version <version> --json
tiangong-lca dataset process patch --input process-patch.json --output process-candidate.json --json
tiangong-lca dataset process validate --input process-candidate.json --checks schema,references,business --json
tiangong-lca dataset process save --input process-save.json --json
```

示例中的引用目标与修改内容由调用方选择；`process-save.json` 是绑定候选内容、精确对象和预期修订的保存请求。上述操作按需组合，不是强制执行链。

## 范围之外

证据搜索策略、文档理解、数据生成、重复项取舍、生产队列和跨对象修复计划由调用方提供。确定性转换成功不等于内容科学有效，也不等于任务完成。局部工具可以返回可执行的下一步信息，但不持有 Agent 工作流阶段。
