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
| `results` | 按精确 Process ID 与版本查询对应的已发布直接结果候选。 |
| `get-result` | 读取对应结果的 overview、完整 LCI 或 LCIA；有歧义时显式选择结果 ID。 |
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

线上背景选择状态 100 的 Process，并通过独立结果服务读取该精确版本对应的聚合 LCI；不按 `LCI result` 字段筛选，也不把 `get --fields exchanges` 当作聚合结果读取。结果须具备参考产品、单位与数量基准、资源和排放清单、来源及覆盖边界；仅有 LCIA 分数的结果不在该消费范围。固定 Process、结果、发布及产物身份后，按聚合后清单使用，不重复施加已完成的分配，不自动展开其原始组成过程。原始过程的追溯引用与计算依赖分别表达，具体规则见[背景过程与显式连接](../study.md#背景过程与显式连接)。

可搜索、可读和可参与计算分别验证。允许读取并消费背景清单不自动授予修改、删除或再次发布原结果的权限。目标消费规则不改变既有已发布接口的权限，相关实现须由所属服务同步交付。

## 已发布结果读取

`results --id <process-id> --version <version>` 返回当前可读的直接结果候选；没有结果返回空集合。`get-result` 使用相同过程选择，默认读取 `--kind overview`；仅有一个候选时直接读取，存在多个候选时通过 `--result-id` 明确选择。

`--kind lci --output <file>` 自动读取完整清单；`--kind lcia` 读取影响指标。LCI 必须指定文件输出，stdout 保留身份及数量摘要；`--max-items` 默认 100000，可设为 1–2000000，超出预算明确拒绝，不输出伪完整清单。文件默认不可覆盖，显式 `--force` 才可替换。

调用方不提供发布 ID、运行版本或 hash。适配层按服务契约绑定分页；遇到服务明确报告的发布或运行变化，可丢弃未完成读取并最多从头重新读取一次。结果未就绪、无权限或没有所需层明确报告，不触发计算或数据保存。

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

## 年度量与 Platform 展示兼容

Process 业务验证保留 `annualSupplyOrProductionVolume` 的原始多语言内容。显式年度量（如 `1000 kg/year`、`1000 kg/年`）继续支持；数量须为有限正数且各语言一致。结构检查通过不等于年度依据充分。

Platform 的“数值＋参考单位及功能单位描述”和“数值＋功能单位描述”可通过同一业务验证。此兼容路径要求唯一的定量参考交换项、精确版本的 Flow → FlowProperty → UnitGroup 单位链、匹配的本地化描述，以及稳定方法学中的可确定核验的年度推导。它不从参考交换量推测实际年产量，不自动补年度标记或重写正文。

当前支持的回退限定为 Unit process、Product/Waste 参考流、实际年产量未知、仅本数据集适用的每年一个参考批次。每种年度字段语言都须有对应的 `dataTreatmentAndExtrapolationsPrinciples`。以下完整声明是受支持的中英文表达（数值与单位按实际证据填写）：

```text
For this dataset only, annual quantity is 1000 kg/year, assuming one reference batch per year (1000 kg per batch); actual annual production is unknown.
```

```text
仅适用于本数据集：年度量为1000 kg/年，假设每年一个参考批次（每批1000 kg）；实际年产量未知。
```

完整声明同时约束年度量、批次数量、单位、周期和适用范围。两处数量必须与当前定量参考批次一致，单位必须与精确单位链一致；它只是显式建模假设，不是实测年产量或科学审核结论。CLI 不用关键词匹配任意叙述来推断结论。其他推导方式、否定或误导语句、缺失语言、数值冲突及不完整历史记录不能获得兼容通过。调用方必须先核实依据，不应为通过验证而机械替换原方法学。

离线验证可显式提供独立参考文档文件，其结构为 `{"documents": [完整Flow, 完整FlowProperty, 完整UnitGroup]}`：

```bash
tiangong-lca dataset process validate --input process.json --reference-documents references.json --checks schema,business --json
```

参考文件只作为验证上下文，不写入 Process。缺少必需参考证据时结果为 `incomplete`，命令以非零状态退出。存在其他已确定的校验错误时仍为失败。启用 `--checks schema,business,references` 后，CLI 读取当前账号可见的精确引用链；同时提供本地证据时必须与这些读取一致。此检查不自动选择最新版本。

`dataset process save --dry-run` 和实际保存前检复用同一校验及当前精确参考读取；dry-run 不创建写入意图或发送变更。年度量结果中的 `annual_volume` 记录候选内容、单位链文档及方法学文本的绑定。其他 schema、分配、引用、账号、草稿状态、完整前像和读回要求仍独立生效。过去的通过报告不授予后续保存权限。
