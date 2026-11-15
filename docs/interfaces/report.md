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
| `results` | `{label, value, unit, method?, context?, summary?}` 数组。`context` 说明该结果的参考量或其他核算口径。只有一项结果时默认在首页展示，可用 `summary: false` 隐藏；有多项结果时，首页展示标记 `summary: true` 的项。简报数值最多显示四位有效数字，明细表保留输入数值和计算方法。 |
| `analysis` | 可选的 `{contributions?, sensitivity?}`，分别提供已取得的贡献和情景结果。 |
| `sources` | `{id, title, url?, note?}` 数组，记录来源或本地资料位置说明；链接只允许无凭据的绝对 HTTP(S) URL。 |
| `interpretation` | 可选的 `{body, sources?}`。使用正文解释主要结果的形成原因、对情景变化的响应及其对研究目标的意义。排在计算结果与分析图表之后。 |
| `limitations` | 文本数组，用于记录假设影响、适用范围和未解决的问题。 |

节点为 `{id, label, kind?, details?, inputs?, outputs?, sources?}`。`kind` 为 `foreground` 或 `background`，默认前景。背景节点表示已选定的聚合过程。`inputs` 和 `outputs` 可包含两种条目：

- `{id, label, amount, unit, reference?, note?}` 用于可定位的交换项。`amount` 是有限数值，保留输入的符号，`reference: true` 将该项列入相应方向的参考交换。`note` 可记录该项的截断或建模说明。节点内的交换项 ID 在两个方向合计唯一。
- 纯文本或双语文本可继续呈现为清单说明。文本条目无需 ID，图中连线不会匹配这些条目。

连接为 `{id, from, to, label, amount?, unit?, details?, exchanges?: {from, to}}`。`from` 和 `to` 引用节点，`exchanges.from` 与 `exchanges.to` 分别引用对应节点中的交换项。端点按已保存模型的关系提供，交换项的输入输出方向和用量符号各自保留。连线的数量与交换项的数量都是各自声明的数据，例如供应过程的参考输出和消费过程的连接量可以不同。

节点、连接和来源在各自集合内使用唯一 ID，只用于图内连接和页面锚点。ID 允许字母、数字、下划线和连字符，长度 1–80。`sources` 引用必须能在来源集合找到。检查这些结构是为了完整呈现，不是验证科学正确性。没有贡献数据时只展示已有结果，不从总影响推算节点贡献。

- `analysis.contributions` 包含 `{title, unit, total?, items: [{label, value, nodeId?}], sources?}`。提供非零 `total` 时按该值计算显示占比。`nodeId` 必须引用报告中的节点，可用于从图表定位过程。
- `analysis.sensitivity` 包含 `{title, unit, baseline, scenarios: [{label, value, description?}], sources?}`。每组使用同一指标和单位。图表展示与基准的差异；基准为零时展示绝对差值。请在情景描述中注明变化条件。
- 每组至少提供一条数据。`sources` 引用报告的来源 ID。过程贡献可通过 `calculation result --kind contributions` 导出，情景结果可通过 `calculation compare` 导出。使用计算产物的过程实例把贡献对应到报告节点。未提供的分析不会生成图表，渲染器仅依据输入计算展示用的比例和差值。

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
      {
        "id": "grid",
        "label": "电力供应",
        "kind": "background",
        "outputs": [
          { "id": "ref", "label": "交流电", "amount": 1, "unit": "MJ", "reference": true }
        ]
      },
      {
        "id": "assembly",
        "label": "装配",
        "inputs": [{ "id": "power", "label": "交流电", "amount": 2, "unit": "MJ" }]
      }
    ],
    "edges": [
      {
        "id": "power-link",
        "from": "grid",
        "to": "assembly",
        "label": "供电",
        "amount": 2,
        "unit": "MJ",
        "exchanges": { "from": "ref", "to": "power" }
      }
    ]
  },
  "limitations": [{ "en": "Calculation is pending.", "zh": "尚未完成计算。" }]
}
```

[完整合成示例](../../assets/report/example.json)包含双语正文、表格、前景与背景、连接、结果和来源。它仅演示接口，不是科学研究数据。

## HTML 与 PDF

中英文作为同一内容的两套文本保存，阅读和打印均一次显示一种语言，不并排或上下重复展示。标题、正文、表格、模型标签和界面控件随语言选择切换。只有一种语言的内容保留原文并标注，渲染器不补写翻译。

HTML 内嵌天工 Logo、固定封面配图、样式、交互代码和 SVG 模型。模型按过程拓扑布局，支持平移、缩放、适应画布和全屏。选中节点时，图旁的详情按参考交换、输入流、输出流显示。带交换项引用的连线可定位目标节点的表格行；点击表内已连接的流可高亮对应连线。只有过程引用的连线可查看连接本身。完整过程清单可单独展开，关闭 JavaScript 或打印时直接展示。报告正文表格可筛选，正文、过程及分析的引用统一用编号，点击跳转至来源标题与说明。

“打印 / 导出 PDF”打开浏览器打印界面，用户选择保存为 PDF。打印沿用所选语言，隐藏操作控件，恢复所有被筛选隐藏的表格行，保留模型、完整详情和来源链接文字。CLI 本身只生成 HTML，无需安装浏览器或启动 PDF 服务；自动化 PDF 转换不属于此命令。

## 内容与边界

报告 JSON 是可编辑的展示投影，不是新的研究状态机或计算输入格式。正文、科学解释、实际 Run 选择及来源准确性由调用方负责；布局变化不修改 Model，不要求哈希、发布身份或版本绑定。生成时读取该 JSON 和 CLI 内置视觉资产，来源链接仅用于读者查阅。输入变化后须重新生成 HTML。

本地呈现成功不代表研究完整、计算有效、审核通过或允许公开。已有 `study report`、签名导出、审核和分享维持独立服务契约；本地报告不伪装为正式签名产物。
