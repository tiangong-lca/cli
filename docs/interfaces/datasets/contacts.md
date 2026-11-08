---
title: Contact 接口设计
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
---

# Contact

入口：`tiangong-lca dataset contact <action>`。Contact 表示数据中的联系人或机构记录，包含名称、联系方式、描述和关联联系人等信息，以标识和版本定位。

Contact 与身份认证账号是不同对象。数据集中的所有者、作者或联系人引用不直接表达当前调用者的系统权限。

## 操作

| 动作 | Contact 语义 |
| --- | --- |
| `get` / `list` / `search` / `versions` | 在可见范围内读取、查找联系人或机构记录及版本。 |
| `contract` | 返回 Contact 结构、分类及可用规则。 |
| `validate` | 检查内容结构、字段格式及明确的数据集引用。 |
| `create` / `save` / `delete` | 创建新草稿、更新或删除精确已有草稿。 |
| `diff` / `patch` | 比较内容或应用明确的本地字段修改。 |
| `list-references` | 列出当前内容的出向数据集引用，包含类型、ID、版本及出现位置；不逐一查询引用目标。 |
| `translations extract` / `translations apply` | 提取多语言字段或回填给定译文。 |

共同输入、输出和恢复遵循 [Dataset](README.md)，本地操作遵循[数据处理](processing.md)。

## 身份与关联约束

名称、邮箱或网址相同不能直接证明两个 Contact 相同；搜索返回候选，不自动复用身份或合并记录。保存必须使用精确标识、版本及前置修订。

创建或修改 Contact 不创建登录账号、不改变账号资料、不发送验证消息，也不授予数据或组织权限。账号操作使用 [Auth](../identity.md)。字段格式合法不证明联系方式有效或主体身份已核实。

修改 Contact 不自动改写引用它的数据；删除遵守引用约束，不级联清理关联记录。输出遵守实际数据可见性，不因其属于支持数据而扩大访问范围。

Contact 可以独立提交审核，也可以作为其他对象审核包中的被审成员或参考材料。统一使用 `review submit` 和 `review resubmit`，通过请求中的 `type: contact` 和精确内容身份选择对象。

默认 `includeRelated: true` 按业务依赖包含关联数据；设置为 `false` 时只审核所选 Contact 或明确包内成员。关联联系人不按名称合并，循环引用按精确身份去重处理。范围解析、预览、重新提交和处理遵循 [Review 契约](../reviews.md)。

已提交审核包不会随联系人记录更新而改变。审核联系人数据也不构成对登录账号或系统权限的审批。

```bash
tiangong-lca dataset contact search --query "示例机构" --limit 10 --json
tiangong-lca dataset contact get --id <contact-id> --version <version> --json
tiangong-lca dataset contact create --input contact-create.json --json
tiangong-lca dataset contact save --input contact-save.json --json
tiangong-lca review submit --input contact-review.json --json
tiangong-lca review resubmit --input contact-resubmission.json --json
```
