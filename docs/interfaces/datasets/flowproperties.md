---
title: Flow Property 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Flow Property

入口：`tiangong-lca dataset flowproperty <action>`。Flow Property 描述流的可量化属性，并引用其参考 Unit Group。Flow 中的属性取值、属性数据集和单位组分别拥有身份。

## 操作

| 动作                                  | Flow Property 语义                               |
| ------------------------------------- | ------------------------------------------------ |
| `get`                                 | 按精确标识和版本读取属性内容及参考单位组关系。   |
| `list` / `versions`                   | 返回可见属性记录或指定属性的版本页面。           |
| `contract`                            | 获取属性内容 schema、分类和可用规则。            |
| `validate`                            | 检查本地属性内容、定量参考与显式选择的引用证据。 |
| `references get` / `references check` | 返回出向引用或核验精确 Unit Group 等引用。       |

查询遵循[查询与发现](../discovery.md)，内容检查遵循 [Dataset](README.md)。普通接口提供参考数据读取和检查，不提供创建、保存、删除、引用改写或独立审核申请。

在 [Review](../reviews.md) 的关联审核包中，本类型作为精确版本的参考材料。关联展开不将其变为可独立提交的被审对象，不改变参考数据治理权限。

## 关系与成功条件

结果保留属性自身和参考单位组的精确身份。名称相同不能自动认定属性等价；无法解析引用时返回具体位置、所需版本及未解决原因，不选择名称相近的替代项。

属性引用可解析不证明某次流量换算成立。换算还需要明确流的属性值、参考关系和单位证据；CLI 不从属性名称推导转换系数。

需要选用其他属性时，调用方读取精确候选，并在 Flow 内容中显式变更引用。普通属性读取不修改 Flow、Process 或 Unit Group。

受保护的账号内属性写入属于独立治理操作，不通过通用参数放开，也不由本地校验成功授予权限。

```bash
tiangong-lca dataset flowproperty list --limit 20 --json
tiangong-lca dataset flowproperty get --id <property-id> --version <version> --json
tiangong-lca dataset flowproperty references check --input property-references.json --json
```
