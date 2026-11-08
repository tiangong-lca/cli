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
| `dataset <type> references get` | 精确远程身份或明确本地内容，返回出向引用的类型、标识、版本及出现位置。 |
| `dataset <type> references check` | 核对声明内容的引用存在性、版本及可见范围，返回未解决和未检查项。 |
| `dataset <type> references rewrite` | 对本地内容应用显式旧引用到新引用的映射，记录逐处修改。 |
| `dataset <type> translations extract` | 提取指定语言字段、稳定位置及源内容绑定。 |
| `dataset <type> translations apply` | 回填外部给定的译文；源内容或定位变化时拒绝陈旧输入。 |

`diff`、`patch`、`rewrite`、翻译操作使用 `--input` 结构化请求和 `--output` 产物。没有明确声明远程检查的文件操作不访问网络。输出不覆盖输入。

补丁支持 `test`、`add`、`replace`、`remove`。修改应携带依据或证据引用；执行依据检查不代表认可科学判断。整份输入的前置检查失败时不输出部分修改的数据；返回发现与原内容身份。批量模式按项表达原子边界。

分类赋值通过补丁表达，分类合法性由领域校验检查。双语完整度通过 `validate --checks business` 检查；CLI 不调用语言模型生成翻译或补造证据。

引用替换必须指定原引用、目标版本和作用范围，不执行“全部刷新到最新”。远程引用检查明确账号和可见范围；精确引用例外仍受所属领域的证据与授权契约约束。

## 调用示例

```bash
tiangong-lca dataset process patch --input process-patch.json --output process-candidate.json --json
tiangong-lca dataset process references rewrite --input reference-mapping.json --output process-rewritten.json --json
```

## 范围之外

证据搜索策略、文档理解、数据生成、重复项取舍、生产队列和跨对象修复计划由调用方提供。确定性转换成功不等于内容科学有效，也不等于任务完成。局部工具可以返回可执行的下一步信息，但不持有 Agent 工作流阶段。
