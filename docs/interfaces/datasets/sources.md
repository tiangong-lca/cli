---
title: Source 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Source

入口：`tiangong-lca dataset source <action>`。Source 表示来源记录，包括文献或资料的引用信息、出版类型、描述、联系人和数字附件引用。记录以类型、标识和版本定位；来源记录与附件文件具有不同身份。

## 操作

| 动作 | Source 语义 |
| --- | --- |
| `get` / `list` / `search` / `versions` | 读取或查找来源记录及精确版本，搜索结果保留匹配依据。 |
| `contract` | 返回来源内容 schema、分类和可用规则及其版本。 |
| `validate` | 检查记录结构、引用和适用的业务规则，明确附件是否经过实际核验。 |
| `create` / `save` / `delete` | 创建新来源草稿、更新或删除已有草稿，遵循身份、权限、修订及引用约束。 |
| `diff` / `patch` | 比较来源内容或应用给定的本地修改。 |
| `references get` / `references check` / `references rewrite` | 读取、检查或在本地明确替换数据集引用。 |
| `translations extract` / `translations apply` | 提取多语言字段或回填给定译文。 |
| `upload-attachments` | 上传明确附件，返回传输回执和更新附件引用后的候选 Source 内容。 |

共同操作遵循 [Dataset](README.md) 和[数据处理](processing.md)。

## 附件上传

`upload-attachments --input <request> --output <result>` 的输入包含文件路径、大小、内容摘要、目标存储范围和 Source 内待替换的引用位置。文件变化、引用位置不匹配或上传失败必须逐项报告。外部 URL 不自动下载、上传或重写。

上传与来源记录保存分别执行。上传成功后，由调用方将候选内容交给 `source create` 或 `source save`；命令不自动保存远程 Source。未成功项保留原引用，已上传项保留恢复身份，不通过自动删除附件模拟回滚。

Source 的数据集引用和附件地址分别处理。`references rewrite` 不负责文件传输；附件上传不修改其他数据集对 Source 的引用。文件可访问性以实际权限检查为准。

## 成功、失败与审核材料

创建或保存返回实际内容身份、状态及验证信息。记录存在不证明资料可信、足以支持某个结论或允许公开传播；这些判断由调用方和适用审核规则处理。

Source 可以独立提交审核，也可以作为 Process、Flow、Model 等审核包中的被审成员或参考材料。统一使用 `review submit` 和 `review resubmit`，通过请求中的 `type: source` 和精确内容身份选择对象。

默认 `includeRelated: true` 按业务依赖包含关联数据；设置为 `false` 时只审核所选 Source 或明确包内成员。来源记录和附件内容的身份分别绑定，附件上传不自动提交审核。范围解析、预览、重新提交和处理遵循 [Review 契约](../reviews.md)。

修改 Source 不改写已提交的审核包或材料身份。删除仅作用于允许删除的草稿，不级联删除附件或引用它的数据。

```bash
tiangong-lca dataset source get --id <source-id> --version <version> --json
tiangong-lca dataset source upload-attachments --input attachments.json --output uploaded-sources.json --json
tiangong-lca dataset source create --input source-create.json --json
tiangong-lca dataset source save --input source-save.json --json
tiangong-lca review submit --input source-review.json --json
tiangong-lca review resubmit --input source-resubmission.json --json
```
