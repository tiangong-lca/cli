/** Offline report typography plus Platform-inspired Model presentation. */
export const REPORT_CSS = String.raw`
:root {
  color-scheme: light;
  --ink: #22242b;
  --muted: #696b75;
  --line: #e6e4e8;
  --accent: #5c246a;
  --accent-wash: #f5eff7;
  --paper: #fff;
  --wash: #f8f8fa;
  font-family: "Avenir Next", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--ink);
  background: var(--wash);
  line-height: 1.7;
  font-size: 15px;
}
* { box-sizing: border-box; }
body { margin: 0; }
a { color: var(--accent); text-underline-offset: 3px; overflow-wrap: anywhere; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 4px;
}
button, input, select { font: inherit; color: inherit; }
button, select, input { border: 1px solid var(--line); border-radius: 6px; background: white; padding: 7px 12px; }
button { cursor: pointer; transition: background .15s, border-color .15s; }
button:hover { background: var(--accent-wash); border-color: var(--accent); }
input[type=range] { padding: 0; width: 100px; accent-color: var(--accent); }
input[type=search] { background: var(--wash); padding: 5px 10px; }
.primary-button { background: var(--accent); color: white; border-color: var(--accent); }
.primary-button:hover { background: #723383; color: white; }
h1, h2, h3, p { margin: 0; }
p { white-space: pre-wrap; overflow-wrap: anywhere; }
h1 { overflow-wrap: anywhere; font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", serif; font-size: clamp(30px,3.6vw,49px); font-weight: 600; line-height: 1.3; letter-spacing: -.025em; max-width: 920px; }
h2 { font-size: 25px; line-height: 1.4; font-weight: 600; letter-spacing: -.025em; margin: 0 0 26px; }
h3 { font-size: 16px; line-height: 1.5; font-weight: 600; }
.localized { display: block; }
[data-language=en] [data-language-text=zh]:not([data-only]),
[data-language=zh] [data-language-text=en]:not([data-only]) { display: none; }
[data-only]::after { content: attr(data-only); font-size: 10px; font-weight: 400; color: var(--muted); margin-left: 5px; }
.toolbar { position: sticky; top: 0; z-index: 3; background: #fff; border-bottom: 1px solid var(--line); padding: 14px max(28px,calc((100vw - 1280px)/2)); display: flex; align-items: center; gap: 14px; font-size: 12px; }
.brand { font-weight: 600; letter-spacing: .09em; margin-right: auto; display: flex; align-items: center; gap: 12px; }
.brand .localized { font-weight: 400; letter-spacing: .02em; color: var(--muted); }
.brand-divider { color: #ccc7d0; font-weight: 400; }
.page { max-width: 1280px; margin: auto; padding: 0 36px 60px; }
.hero { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 44px; align-items: center; padding: 46px 0 36px; border-bottom: 1px solid var(--line); }
.eyebrow { color: var(--accent); font-size: 11px; font-weight: 600; letter-spacing: .16em; margin-bottom: 18px; }
.subtitle { margin-top: 22px; max-width: 780px; font-size: 15px; color: var(--muted); line-height: 1.85; }
.layout { display: grid; grid-template-columns: 180px minmax(0,1fr); gap: 44px; margin-top: 44px; }
.toc { position: sticky; top: 100px; align-self: start; font-size: 12px; max-height: 80vh; overflow: auto; }
.toc-title { color: var(--muted); font-size: 10px; letter-spacing: .14em; margin-bottom: 16px; padding-left: 12px; }
.toc a { display: block; text-decoration: none; color: var(--muted); border-left: 2px solid var(--line); padding: 10px 12px; }
.toc a .localized { display: inline; }
.toc a:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-wash); }
main { min-width: 0; }
.section { border-bottom: 1px solid var(--line); padding: 0 0 32px; margin-bottom: 32px; scroll-margin-top: 90px; }
.prose { margin-bottom: 20px; font-size: 14px; line-height: 1.95; }
.source-refs { font-size: 11px; display: flex; flex-wrap: wrap; gap: 7px; margin-top: 18px; }
.source-refs a { text-decoration: none; padding: 2px 7px; border-radius: 4px; background: var(--accent-wash); }
.table-wrap { overflow: auto; margin-top: 20px; }
.table-controls { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 14px; font-size: 11px; color: var(--muted); }
.table-controls label { display: flex; align-items: center; gap: 10px; }
.table-controls label > .localized { flex-shrink: 0; white-space: nowrap; }
.table-controls input { max-width: 200px; width: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
th { font-weight: 500; background: var(--wash); color: var(--muted); font-size: 11px; }
td, th { padding: 14px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
tbody tr:hover { background: #faf8fb; }
td.numeric { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; font-size: 16px; }
thead { display: table-header-group; }
.model-panel { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.model-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 16px; background: #fcfbfd; border-bottom: 1px solid var(--line); }
.graph-scroll { overflow: auto; background-color: white; background-image: radial-gradient(#d9d4dd .7px, transparent .7px); background-size: 12px 12px; }
.node-body { fill: white; stroke: var(--accent); stroke-width: 1; }
.node-title-bar { fill: var(--accent); }
.port-empty { font-size: 12px; color: #a5a0aa; display: block; }
.node-port { fill: white; stroke: var(--accent); stroke-width: 1; }
.edge-path { stroke: var(--accent); stroke-width: 1.3; fill: none; stroke-linejoin: round; }
.edge-hit { stroke: transparent; stroke-width: 18; fill: none; }
.legend { font-size: 11px; color: var(--muted); padding: 10px 16px; border-top: 1px solid var(--line); background: #fcfbfd; }
.details-heading { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; margin: 28px 0 14px; }
.details-heading > span:last-child { font-size: 10px; background: #eeebf1; color: var(--muted); padding: 1px 6px; border-radius: 4px; }
.details-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
.detail { border: 1px solid var(--line); border-radius: 6px; padding: 18px; scroll-margin-top: 100px; overflow-wrap: anywhere; }
.detail.selected { outline: 2px solid var(--accent); outline-offset: 2px; background: #fdfbfe; }
.detail-kicker { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--muted); margin-bottom: 12px; }
.detail-kicker > span:first-child { color: var(--accent); font-weight: 600; }
.detail p { font-size: 12px; margin-top: 12px; line-height: 1.8; }
.detail-id { font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; color: var(--muted); margin-top: 6px; }
.detail-io { border-top: 1px solid var(--line); margin-top: 16px; }
.io { font-size: 11px; margin-top: 12px; }
.io strong { font-weight: 500; color: var(--muted); }
.io ul { padding-left: 16px; margin: 4px 0 0; }
.connection-list { margin-top: 18px; display: grid; gap: 8px; }
.connection { display: grid; grid-template-columns: 26px minmax(0,1fr) auto; gap: 10px; padding: 16px; }
.connection h3 { font-size: 13px; }
.connection p { margin-top: 4px; }
.connection-number { font-size: 11px; color: var(--accent); padding-top: 2px; }
.connection-amount { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
.sources { padding-left: 20px; margin-bottom: 0; }
.sources li { padding-left: 8px; margin-bottom: 22px; scroll-margin-top: 100px; }
.sources li::marker { color: var(--accent); font-size: 11px; }
.sources strong { font-size: 13px; font-weight: 600; }
.sources p { font-size: 12px; color: var(--muted); margin-top: 7px; }
.source-url { font-size: 12px; }
.limitations { padding-left: 18px; font-size: 13px; }
.limitations li { margin-bottom: 14px; padding-left: 4px; }
.limitations li::marker { color: var(--accent); }
@media(max-width:1000px) {
  .layout { grid-template-columns: 140px minmax(0,1fr); gap: 24px; }
  .details-grid { grid-template-columns: 1fr; }
  .detail-io { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
}
@media(max-width:760px) {
  .toolbar { padding: 12px 16px; gap: 8px; flex-wrap: wrap; }
  .brand { width: 100%; margin-bottom: 4px; }
  .toolbar > label { margin-right: auto; }
  .page { padding: 0 16px 32px; }
  .hero { grid-template-columns: 1fr; gap: 22px; padding: 28px 0; }
  .cover-art { max-width: 460px; }
  .layout { display: block; margin-top: 24px; }
  .toc { position: static; max-height: none; display: flex; flex-wrap: wrap; margin-bottom: 22px; gap: 4px; }
  .toc-title { width: 100%; padding-left: 0; margin-bottom: 6px; }
  .toc a { padding: 6px 10px; }
  .section { padding: 0 0 24px; }
  h2 { font-size: 22px; margin-bottom: 20px; }
  .model-panel-head { flex-wrap: wrap; padding: 10px; gap: 8px; }
  .legend { padding: 10px; }
  .table-controls label { display: block; }
  .table-controls label > .localized { flex-shrink: 0; white-space: nowrap; }
.table-controls input { max-width: 170px; }
  td, th { padding: 10px 8px; }
  .connection { grid-template-columns: 20px minmax(0,1fr); }
  .connection-amount { grid-column: 2; }
}
@page { size: A4; margin: 16mm; }
@media print {
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  :root, body { background: white; font-size: 10pt; }
  .toolbar, .toc, .table-controls { display: none!important; }
  .page { padding: 0; max-width: none; }
  .layout { display: block; margin-top: 20px; }
  .hero { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 24px; padding: 0 0 24px; break-inside: avoid; }
  h1 { font-size: 27pt; }
  h2 { font-size: 17pt; break-after: avoid; }
  .section { border: 0; border-radius: 0; padding: 20px 0; margin: 0; break-inside: auto; border-bottom: 1px solid var(--line); }
  .table-wrap, .graph-scroll { overflow: visible; }
  .model-panel { break-inside: avoid; }
  .graph-scroll { background-image: none; }
  .details-grid { display: block; }
  .detail { break-inside: avoid; margin-bottom: 10px; }
  .detail-io { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .detail.selected { outline: 0; background: white; }
  tr { break-inside: avoid; }
  tr[hidden] { display: table-row!important; }
  a { color: inherit; }
  .source-url { display: block; font-size: 9pt; }
  p, li { orphans: 3; widows: 3; }
}

.official-logo { width: 34px; height: 34px; object-fit: contain; flex: none; }
.cover-art { display: block; width: 100%; aspect-ratio: 3 / 2; object-fit: cover; border-radius: 5px; }
.result-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 1px; margin-top: 25px; border: 1px solid #dfd3e5; background: #dfd3e5; border-radius: 5px; overflow: hidden; }
.result-tile { background: var(--accent-wash); padding: 19px 24px; }
.result-label { color: var(--accent); font-size: 12px; overflow-wrap: anywhere; }
.result-number { font-size: clamp(25px, 3vw, 36px); line-height: 1.3; margin-top: 8px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.result-number > span { font-size: 12px; color: var(--muted); }
.analysis-heading, .analysis-total { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; color: var(--muted); font-size: 12px; }
.analysis-heading { padding: 9px 0; border-bottom: 1px solid var(--line); }
.analysis-total { justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }
.analysis-rows { list-style: none; padding: 0; margin: 0; }
.analysis-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(65px, auto); gap: 14px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--line); }
.analysis-label, .analysis-value { font-size: 13px; overflow-wrap: anywhere; }
.analysis-label > small, .analysis-value > small { display: block; font-size: 11px; color: var(--muted); margin-top: 3px; }
.analysis-value { text-align: right; font-variant-numeric: tabular-nums; }
.analysis-track { position: relative; height: 14px; background: var(--accent-wash); border-radius: 3px; }
.analysis-track.signed { background: linear-gradient(90deg, var(--accent-wash) calc(50% - .5px), #a28cac calc(50% - .5px), #a28cac calc(50% + .5px), var(--accent-wash) calc(50% + .5px)); }
.analysis-bar { position: absolute; inset-block: 0; background: #724281; border-radius: 2px; }
.analysis-bar.negative { background: #aa88b9; }
@media (max-width: 500px) {
  .brand { width: auto; gap: 7px; }
  .brand-divider, .brand .localized, .toolbar > label { display: none; }
  .official-logo { width: 27px; height: 27px; }
  .analysis-row { gap: 8px; }
}
@media print {
  .result-summary, .analysis-row { break-inside: avoid; }
  .result-number { font-size: 20pt; }
  .result-tile { padding: 12px 16px; }
}
.network-panel { border-color: #d9cede; }
.network-title { font-size: 12px; font-weight: 600; color: var(--accent); }
.network-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.network-panel [hidden] { display: none; }
.network-legend { display: none; }
[data-network-ready] .network-legend { display: block; }
.network-controls button { padding: 3px 8px; font-size: 11px; }
.network-controls output { padding: 0 2px; color: var(--muted); text-align: center; min-width: 36px; font-variant-numeric: tabular-nums; font-size: 10px; }
.network-expand { color: var(--accent); }
.network-workspace { display: grid; grid-template-columns: minmax(0, 1fr); }
.network-panel[data-network-ready] .network-workspace { grid-template-columns: minmax(0, 1fr) minmax(165px, 25%); }
.network-viewport {
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  height: clamp(310px, 44vh, 490px);
  min-width: 0;
  overflow: auto;
  cursor: grab;
  touch-action: pan-x pan-y;
  background: #fcfafd radial-gradient(#ded3e3 .75px, transparent .75px) 0 0 / 14px 14px;
  scrollbar-width: thin;
}
.network-dragging { cursor: grabbing; user-select: none; }
.network-svg { display: block; flex: none; margin-inline: auto; }
.network-svg a { text-decoration: none; cursor: pointer; }
.network-node-title { color: white; line-height: 36px; font-weight: 600; font-size: 14px; }
.network-node-title .localized, .network-flow, .network-flow .localized { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.network-node-content { font-size: 11px; line-height: 17px; }
.network-node-kind { color: #74647d; font-size: 10px; }
.network-node-flows { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 5px; }
.network-node-flows > :last-child { text-align: right; }
.network-node-flows strong { font-size: 10px; color: var(--accent); }
.network-node.background .node-title-bar { fill: #795887; }
.network-node.foreground .node-title-bar { fill: #5c246a; }
.network-node:hover .node-body, .network-node.network-active .node-body, .network-node:focus-visible .node-body { stroke: var(--accent); stroke-width: 3; }
.network-edge:hover .edge-path, .network-edge.network-active .edge-path, .network-edge:focus-visible .edge-path { stroke: var(--accent); stroke-width: 3; }
.network-node .node-port { pointer-events: none; }
.network-edge-label { text-align: center; color: #594062; font-size: 10px; white-space: nowrap; }
.network-edge-label > [aria-hidden] { display: inline-block; background: #fff; border: 1px solid #dfd1e5; border-radius: 3px; padding: 0 5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.network-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.network-inspector { min-width: 0; max-height: clamp(310px, 44vh, 490px); overflow: auto; border-inline-start: 1px solid var(--line); background: #fff; }
.network-inspector .detail { border: 0; border-radius: 0; padding: 15px; }
.network-inspector .detail-io { display: block; }
.network-inspector .connection { display: block; }
.network-inspector .connection-number { display: block; margin-bottom: 6px; }
.network-inspector .connection-amount { margin-top: 10px; white-space: normal; }
:where(.network-inspector .detail-id a) .localized { display: inline; }
.network-inspector a { overflow-wrap: anywhere; }
.network-legend { padding: 8px 14px; }
.network-dialog { padding: 0; border: 0; background: transparent; width: calc(100vw - 28px); max-width: none; max-height: none; }
.network-dialog::backdrop { background: rgba(38, 22, 44, .52); }
.network-dialog .network-panel { width: 100%; }
.network-dialog .network-panel .network-workspace { grid-template-columns: minmax(0, 1fr) minmax(215px, 26%); }
.network-dialog .network-viewport, .network-dialog .network-inspector { height: calc(100dvh - 125px); max-height: none; }
@media (max-width: 720px) {
  .network-panel[data-network-ready] .network-workspace, .network-dialog .network-panel .network-workspace { grid-template-columns: minmax(0, 1fr); }
  .network-inspector { border-inline-start: 0; border-top: 1px solid var(--line); max-height: 210px; }
  .network-dialog .network-viewport { height: calc(100dvh - 325px); min-height: 140px; }
  .network-dialog .network-inspector { height: auto; max-height: 180px; }
}
@media print {
  .network-panel[data-network-ready] .network-workspace { display: block; }
  .network-controls, .network-inspector, .network-legend, .network-dialog { display: none !important; }
  .network-viewport { display: block; height: auto; overflow: visible; background: white; }
  .network-svg { width: 100% !important; height: auto !important; max-height: 125mm; }
}
`;
