---
title: LCIA Method 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# LCIA Method

入口：`tiangong-lca dataset lciamethod <action>`。LCIA Method 数据内容描述影响评价方法，包括方法信息、影响类别或指标、定量参考、适用时空信息、特征化因子及相关来源。

方法数据集、使用该方法执行的计算任务及计算结果是不同对象。本版 CLI 接口覆盖方法内容契约发现与本地结构校验。

## 操作

| 动作                       | LCIA Method 语义                                                    |
| -------------------------- | ------------------------------------------------------------------- |
| `contract`                 | 获取方法内容 schema、分类及实际可用的契约组件，返回精确来源与版本。 |
| `validate --checks schema` | 对明确的本地方法内容执行 schema 校验，返回字段位置及结构发现。      |

方法资料或规则组件不存在时标记为不可用，不生成替代规则。普通接口不提供远程查询、创建、保存、删除、独立审核申请或方法执行；支持某种 schema 不等于支持该类型全部数据业务操作。

## 身份与校验边界

输入保留方法的数据身份、版本、定量参考及来源信息。内容契约版本与方法数据版本分别记录，不使用方法名称替代精确身份。

结构校验不验证特征化因子的科学有效性、归一化或权重选择的适用性，也不计算 LCIA 结果。未执行的引用解析、完整性及科学检查必须明确标记，不能随 schema 通过而报告完成。

方法内容中的历史审核记录属于输入数据，不等于当前系统生成的审核单或本次调用获得的审核授权。

```bash
tiangong-lca dataset lciamethod contract --include schema --output method-contract.json --json
tiangong-lca dataset lciamethod validate --input method.json --checks schema --json
```
