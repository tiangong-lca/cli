---
title: 本地研究报告呈现接口
docType: guide
scope: repo
status: active
authoritative: false
owner: cli
language: zh-CN
whenToUse:
  - composing or rendering a local research report
whenToUpdate:
  - when report inputs, HTML interactions or print semantics change
related:
  - README.md
  - study.md
  - calculations.md
---

# Report：从 JSON 生成交互报告

`report render` 将一份明确的报告 JSON 转换成自包含 HTML。它是可独立调用的呈现操作；Study Skill 组织研究、解释结果、准备中英文内容并调用 CLI。渲染器不研究资料、不翻译、不计算，也不读取线上模型或隐式创建 Study。

```bash
tiangong-lca report render --input report.json --output report.html --json
```

`--input -` 读取标准输入。输出文件必须明确指定，已有文件默认拒绝覆盖；`--force` 只覆盖独立输出，不能替换输入及其文件别名。成功返回统一结果信封、HTML 路径、内容计数、真实能力范围和下一步提示，不把 HTML 放入 stdout。

## 输入结构

只要求 `title`；正文和可视化按研究内容提供。文本为纯文本字符串，或 `{ "en": "English", "zh": "中文" }`。字符串原样显示；语言映射缺少一侧时保留已有文字并标注语言，不伪造翻译。换行保持，HTML 标签和脚本均作为文本转义，不执行 Markdown 或原始 HTML。

| 字段 | 内容 |
| --- | --- |
| `title`, `subtitle` | 标题与可选副标题，使用文本格式。 |
| `language` | `en` 或 `zh`，默认 `zh`；每次只显示一种语言，用户可在 HTML 中切换。 |
| `sections` | `{title, body?, sources?, table?}` 数组，按输入顺序呈现正文；表格为 `{columns, rows}`，单元格是文本或有限数值。 |
| `model` | `{nodes, edges}` 图形投影，来源于调用方选择的 Model 和 Process；不是直接提交规范 Model 文档。 |
| `results` | `{label, value, unit, method?}` 数组；共享同一份数值和单位，`method` 可注明所选 Run 和方法。 |
| `sources` | `{id, title, url?, note?}` 数组，记录来源或本地资料位置说明；链接只允许无凭据的绝对 HTTP(S) URL。 |
| `limitations` | 文本数组，用于结果解释、假设影响、适用范围和未解决的问题。 |

节点为 `{id, label, kind?, details?, inputs?, outputs?, sources?}`；`kind` 是 `foreground` 或 `background`，默认前景。输入输出是说明性文本列表。连接为 `{id, from, to, label, amount?, unit?, details?}`，引用已声明节点；不会根据名称或数量推断连接。背景节点表示已选定的聚合边界，不展开上游。

节点、连接和来源在各自集合内使用唯一 ID，只用于图内连接和页面锚点。ID 允许字母、数字、下划线和连字符，长度 1–80。`sources` 引用必须能在来源集合找到。检查这些结构是为了完整呈现，不是验证科学正确性。没有贡献数据时只展示已有结果，不从总影响推算节点贡献。

```json
{
  "title": { "en": "Product study", "zh": "产品研究" },
  "sections": [
    {
      "title": { "en": "Goal and scope", "zh": "目标与范围" },
      "body": { "en": "One product at the factory gate.", "zh": "一件出厂产品。" }
    }
  ],
  "model": {
    "nodes": [
      { "id": "assembly", "label": { "en": "Assembly", "zh": "装配" }, "outputs": ["1 product"] }
    ],
    "edges": []
  },
  "limitations": [{ "en": "Calculation is pending.", "zh": "尚未完成计算。" }]
}
```

[完整合成示例](../../assets/report/example.json)包含双语正文、表格、前景与背景、连接、结果和来源。它仅演示接口，不是科学研究数据。

## HTML 与 PDF

中英文作为同一内容的两套文本保存，阅读和打印均一次显示一种语言，不并排或上下重复展示。标题、正文、表格、模型标签和界面控件随语言选择切换。只有一种语言的内容保留原文并标注，渲染器不补写翻译。

HTML 包含样式、固定交互代码和 SVG 模型，不加载 CDN、字体、远程数据或计算运行时。目录、模型节点、连接编号和来源锚点可点击；模型支持缩放和适应宽度；表格可筛选。模型沿用 Platform 的天工主色、过程标题栏、圆角节点、左右输入输出分组、方形连接点与点阵画布视觉规则，以离线 SVG 实现。图示连接点只表示已提供的过程间连接，不推断规范交换端口身份；节点内的输入输出预览不替代完整详情。节点详情和全部数值本来就在文档中，关闭 JavaScript 仍可阅读。

“打印 / 导出 PDF”打开浏览器打印界面，用户选择保存为 PDF。打印沿用所选语言，隐藏操作控件，恢复所有被筛选隐藏的表格行，保留模型、完整详情和来源链接文字。CLI 本身只生成 HTML，无需安装浏览器或启动 PDF 服务；自动化 PDF 转换不属于此命令。

## 内容与边界

报告 JSON 是可编辑的展示投影，不是新的研究状态机或计算输入格式。正文、科学解释、实际 Run 选择及来源准确性由调用方负责；布局变化不修改 Model，不要求哈希、发布身份或版本绑定。生成时只读取该 JSON，不自动打开其链接或读取其描述的路径。已有 HTML 不会因后续模型或线上数据变化而静默更新。

本地呈现成功不代表研究完整、计算有效、审核通过或允许公开。已有 `study report`、签名导出、审核和分享维持独立服务契约；本地报告不伪装为正式签名产物。
