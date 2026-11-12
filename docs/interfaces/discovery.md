---
title: 数据查询与发现
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# 数据查询与发现

查询挂在具体业务对象下。Dataset 使用 `dataset <type> get|list|search|versions|contract|list-references`，审核与发布使用各自文档规定的读取动作。Process 的 `statistics` 提供明确范围的聚合计数，遵循同样的可见性和完整性约束。

## 查询动作

| 动作 | 输入 | 输出 |
| --- | --- | --- |
| `get` | `--id`、`--version`，以及可选的 `--fields`。 | 精确身份、可见状态、内容及可用的修订凭据。 |
| `list` | `--state`、`--owner`、`--limit`、`--cursor`、`--fields`。 | 按明确范围及稳定顺序返回对象页面。 |
| `search` | `--query`、受支持过滤、`--limit`、`--cursor`。 | 候选身份、匹配依据与实际查询范围。 |
| `versions` | `--id` 及分页条件。 | 当前权限可见的版本集合和状态。 |
| `list-references` | `--id` 与精确 `--version`，或 `--input <file>` 指定本地内容，二者互斥。 | 当前内容的出向数据集引用清单：目标类型、ID、版本及每处出现位置。 |
| `contract` | 类型、`--include schema,methodology,ruleset`。 | 精确来源和版本、可用 schema、方法文档及规则。 |

契约中的方法资料和规则按类型实际存在性返回，缺少的组件标记为不可用，不生成替代内容或假定已通过其规则。

Dataset `get` 必须提供版本，或显式使用 `--version latest`。`latest` 由领域服务在当前权限和所选范围内解析，返回实际版本及选择范围；不能在后续变更时再次解析。`versions` 供调用方先选择版本。查询结果中的缺失修订凭据不能由 CLI 伪造。

列表和搜索默认返回 20 项，`--limit` 范围为 1–100；`--cursor` 是不透明的继续读取标识，绑定过滤条件与排序。列表采用稳定的身份及版本顺序；搜索按相关性和稳定身份排序。改变过滤条件必须开始新查询。服务端不能可靠续页时，显式返回截断，不能编造游标。

`--owner` 只缩小可见范围，不授予他人权限。类型专属过滤字段通过帮助和请求契约发现；未知字段返回输入错误。搜索不支持的类型返回明确的能力错误，不降级为本地猜测。

## 背景过程发现

为 [Study 建模](study.md)提供明确的当前账号与获准访问的背景数据查询范围；选择范围不授予新权限。Process 候选及其详情保留精确版本，按实际可用信息提供参考产品、单位、清单类型、技术、地域、时间、边界和覆盖情况；缺失属性不得推断为匹配。

聚合清单型背景 Process 的可计算性遵循[消费契约](study.md#背景过程与显式连接)。状态码、发布成功或搜索分数不独立证明其适用性。搜索返回候选，Agent 读取并明确选择后才写入 Model 连接；搜索和精确读取不自动改写模型或启动计算。

## 分类与关系发现

`dataset classification children --type <目录> [--parent <code>]` 返回直接子项；`dataset classification path --type <目录> --code <code>` 返回完整分类路径。结果携带目录身份和版本，地理位置使用 `location` 目录。目录导航不修改数据，分类赋值通过显式本地补丁完成。

`dataset <type> list-references` 让调用方无需遍历完整数据结构即可获得出向引用清单，适用类型以各对象能力表为准。远程输入只读取所选对象，本地输入只读取文件；命令不递归展开、不逐一请求引用目标，也不把列出引用表述为引用有效。重复引用保留全部出现位置；缺少类型、ID 或版本时保留位置并标明缺失，不猜测目标。大清单通过分页或 `--output` 交付，并明确完整性。不承诺无法证明完整性的全库反向引用查询。

确认目标存在及可访问时，对清单中的类型、ID 和版本执行精确 `get`。检查引用类型、版本、属性与单位等关系约束使用 `validate --checks references`，目标存在不代表关系有效；远程检查必须显式选择并声明所需身份与范围。引用修改通过直接编辑或通用 `patch` 完成，再按需 `save`，见[数据处理契约](datasets/processing.md)。

本版不提供跨类型模糊搜索入口。调用方按类型查询，结果均携带 `type`、`id` 和 `version`，可以直接用于下一次精确读取。

## 查询上下文

查询使用 [AI 上下文契约](ai-context.md) 和 `query-result` 模板。结果返回实际版本、字段投影、过滤、排序、观察来源和已采用的默认值；摘要只表达本次可见范围。

有下一页时 `nextActions` 提供保持全部选择条件的游标命令。搜索候选不唯一时，业务结果保留候选身份及差异，`nextActions.description` 说明需要选择对象；可同时提供具体候选的只读查询命令，但不把第一条候选变为修改目标。没有更多页或后续目标时允许空动作列表。

## 完整性

所有查询返回实际环境、范围、过滤、返回数量、`hasMore` 和 `nextCursor`；未知总数为 null。完整当前页不代表完整数据集，公开可见范围不代表全库。

跨页查询不隐含事务快照。批量导出保留每项实际内容身份和观察范围，不把多次观察描述为同时点快照。无结果、不可见与服务失败按权限和服务契约表达。

搜索分数不是科学有效性、业务适用性或等价性的证明。查询不能自动创建对象、更新引用或选择生产路径。

```bash
tiangong-lca dataset flow search --query "electricity" --limit 10 --json
tiangong-lca dataset flow versions --id <flow-id> --json
tiangong-lca dataset flow get --id <flow-id> --version <version> --json
tiangong-lca dataset process contract --include schema,ruleset --output contract.json --json
tiangong-lca dataset process list-references --id <process-id> --version <version> --json
```
