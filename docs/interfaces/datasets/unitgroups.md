---
title: Unit Group 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Unit Group

入口：`tiangong-lca dataset unitgroup <action>`。Unit Group 表示一组单位、参考单位和组内转换关系。单位组以标识和版本定位，组内单位使用其局部身份。

## 操作

| 动作                | Unit Group 语义                                          |
| ------------------- | -------------------------------------------------------- |
| `get`               | 按精确标识和版本读取单位组、参考单位及各单位的转换信息。 |
| `list` / `versions` | 返回可见单位组或指定单位组的版本页面。                   |
| `contract`          | 返回单位组内容结构、分类和可用规则。                     |
| `validate`          | 检查本地结构、组内单位身份、参考单位及适用的一致性约束。 |

输入输出遵循 [Dataset](README.md) 和[查询契约](../discovery.md)。普通接口不提供创建、保存、删除、合并或独立审核申请。

在 [Review](../reviews.md) 的关联审核包中，本类型作为精确版本的参考材料。关联展开不将其变为可独立提交的被审对象，不改变参考数据治理权限。

## 单位身份与转换边界

单位名称和符号不是全局唯一身份。引用和校验必须绑定精确单位组版本及组内单位，不跨单位组按名称自动匹配。

读取返回实际记录的转换关系与依据。单位转换还需调用方明确数量、原单位、目标单位和适用维度；本接口不自动修改 Process 数量或 Flow 属性值，也不推断任意复合单位的换算。

缺少参考单位、单位身份冲突或关系不一致时返回可定位的问题。未知系数不得以 1 或其他默认值代替；结构合法与具体物理换算成立分别表达。

受保护单位数据的维护遵守其独立治理契约。只读能力与本地校验不授予参考数据写入权限。

```bash
tiangong-lca dataset unitgroup list --limit 20 --json
tiangong-lca dataset unitgroup get --id <unitgroup-id> --version <version> --json
tiangong-lca dataset unitgroup validate --input unitgroup.json --json
```
