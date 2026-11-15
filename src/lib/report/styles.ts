/** Offline report typography, model workspace and print layout. */
export const REPORT_CSS = String.raw`
:root {
  color-scheme: light;
  --ink: #27232a;
  --muted: #625b68;
  --line: #e3dfe5;
  --accent: #5c246a;
  --accent-wash: #f5eff7;
  --paper: #fff;
  --wash: #f8f6f9;
  --display: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "Iowan Old Style", Georgia, serif;
  font-family: "Avenir Next", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--ink);
  background: var(--paper);
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
.primary-button { color: var(--accent); border-color: var(--accent); font-weight: 600; }
h1, h2, h3, p { margin: 0; }
p { white-space: pre-wrap; overflow-wrap: anywhere; }
h1 { text-wrap: balance; overflow-wrap: anywhere; font-family: var(--display); font-size: clamp(32px,4.25vw,60px); font-weight: 600; line-height: 1.3; letter-spacing: -.025em; max-width: 920px; }
h2 { font-family: var(--display); font-size: clamp(24px,2.65vw,33px); line-height: 1.4; font-weight: 600; margin: 0 0 22px; }
h3 { font-size: 16px; line-height: 1.5; font-weight: 600; }
.localized { display: block; }
[data-language=en] [data-language-text=zh]:not([data-only]),
[data-language=zh] [data-language-text=en]:not([data-only]) { display: none; }
[data-only]::after { content: attr(data-only); font-size: 10px; font-weight: 400; color: var(--muted); margin-left: 5px; }
.toolbar { position: sticky; top: 0; z-index: 3; background: #fff; border-bottom: 1px solid var(--line); padding: 14px max(28px,calc((100vw - 1280px)/2)); display: flex; align-items: center; gap: 14px; font-size: 12px; }
.brand { font-weight: 600; letter-spacing: .09em; margin-right: auto; display: flex; align-items: center; gap: 12px; }
.brand .localized { font-weight: 400; letter-spacing: .02em; color: var(--muted); }
.brand-divider { color: #ccc7d0; font-weight: 400; }
.page { max-width: 1280px; margin: auto; padding: 0 38px 64px; }
.hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 32%); gap: clamp(24px,5vw,68px); align-items: center; padding: 40px 0 34px; border-bottom: 1px solid var(--line); }
.eyebrow { color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: .115em; margin-bottom: 15px; }
.eyebrow::after { content: ""; display: block; width: 36px; height: 2px; background: var(--accent); margin-top: 8px; }
.subtitle { margin-top: 22px; max-width: 780px; font-size: 15px; color: var(--muted); line-height: 1.85; }
.layout { display: grid; grid-template-columns: 154px minmax(0,1fr); gap: 35px; margin-top: 39px; }
.toc { position: sticky; top: 100px; align-self: start; font-size: 12px; max-height: 80vh; overflow: auto; }
.toc-title { color: var(--muted); font-size: 10px; letter-spacing: .14em; margin-bottom: 16px; padding-left: 12px; }
.toc a { display: block; text-decoration: none; color: var(--muted); border-left: 2px solid var(--line); padding: 7px 12px; }
.toc a .localized { display: inline; }
.toc a:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-wash); }
main { min-width: 0; }
.section { border-bottom: 1px solid var(--line); padding: 0 0 32px; margin-bottom: 32px; scroll-margin-top: 90px; }
.prose { margin-bottom: 18px; max-width: 84ch; font-size: 15px; line-height: 1.9; }
.source-refs { font-size: 11px; display: flex; flex-wrap: wrap; gap: 7px; margin-top: 18px; }
.source-refs a { color: var(--muted); }
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
.node-body { fill: white; stroke: #b7a8bf; stroke-width: 1.3; }
.node-port { fill: white; stroke: #8c7995; stroke-width: 1; }
.edge-path { stroke: #a093a7; stroke-width: 1.6; fill: none; stroke-linejoin: round; }
.edge-hit { stroke: transparent; stroke-width: 18; fill: none; }
.legend { font-size: 11px; color: var(--muted); border-top: 1px solid var(--line); background: #fff; }
.detail { overflow-wrap: anywhere; scroll-margin-top: 88px; }
.detail p { margin-top: 7px; color: var(--muted); line-height: 1.65; font-size: 13px; }
.detail-kicker { font-size: 11px; color: var(--accent); font-weight: 600; margin-bottom: 4px; }
.process-header h3 { font-family: var(--display); font-size: clamp(20px,2.2vw,30px); line-height: 1.35; }
.exchange-table { margin-top: 13px; table-layout: auto; font-size: 13px; }
.exchange-table caption { text-align: left; color: var(--accent); font-weight: 600; padding: 4px 7px; background: var(--accent-wash); }
.exchange-table :is(th,td) { background: none; padding: 6px 7px; }
.exchange-table thead th { font-size: 11px; }
.exchange-table th[scope=row] { color: var(--ink); font-weight: 400; }
.exchange-table th[scope=row] small { font-size: 11px; color: var(--muted); display: block; }
.exchange-table td[colspan] { color: var(--muted); }
.exchange-table :is(td,th):nth-child(2) { text-align: right; }
.exchange-amount { white-space: nowrap; font-variant-numeric: tabular-nums; }
.exchange-unit { white-space: nowrap; }
.reference-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.reference-table :is(th,td) { font-weight: 600; }
.exchange-link { color: inherit; text-decoration-color: #94779f; text-decoration-thickness: 1px; }
.exchange-link:hover, .exchange-link[aria-current] { color: var(--accent); }
.exchange-current { background: var(--accent-wash); box-shadow: inset 2px 0 var(--accent); }
.exchange-links { margin: 4px 0 0; padding-inline-start: 16px; }
.connection-route { display: flex; flex-wrap: wrap; gap: 5px 8px; font-size: 12px; margin-top: 4px; }
.connection-amount { color: var(--ink) !important; font-variant-numeric: tabular-nums; font-weight: 600; }
.process-catalog { margin-top: 13px; }
.catalog-toggle { border: 0; color: var(--accent); padding: 4px 0; border-radius: 0; font-weight: 600; font-size: 13px; }
.catalog-toggle:hover { background: none; text-decoration: underline; }
.catalog-toggle[aria-expanded=false] .catalog-close-label, .catalog-toggle[aria-expanded=true] .catalog-open-label { display: none; }
.catalog-toggle > span::after { content: " ›"; }
:where(.catalog-toggle) .localized { display: inline; }
.catalog-content .detail { padding: 15px 0; border-top: 1px solid var(--line); }
.catalog-heading { margin: 14px 0 8px; }
@media screen {
  .catalog-toggle[aria-expanded=false] + .catalog-content { display: none; }
}
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
}
@media(max-width:760px) {
  .toolbar { padding: 12px 16px; gap: 8px; flex-wrap: wrap; }
  .brand { width: 100%; margin-bottom: 4px; }
  .toolbar > label { margin-right: auto; }
  .page { padding: 0 16px 32px; }
  .hero { grid-template-columns: 1fr; gap: 22px; padding: 28px 0; }
  .cover-art { max-width: 380px; }
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

}
@page { size: A4; margin: 16mm; }
@media print {
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  :root, body { background: white; font-size: 10pt; }
  .toolbar, .toc, .table-controls, .catalog-toggle { display: none!important; }
  .page { padding: 0; max-width: none; }
  .layout { display: block; margin-top: 20px; }
  .hero { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 24px; padding: 0 0 24px; break-inside: avoid; }
  h1 { font-size: 27pt; }
  h2 { font-size: 17pt; break-after: avoid; }
  .section { border: 0; border-radius: 0; padding: 20px 0; margin: 0; break-inside: auto; border-bottom: 1px solid var(--line); }
  .table-wrap, .graph-scroll { overflow: visible; }
  .model-panel { break-inside: avoid; }
  .graph-scroll { background-image: none; }
  .process-header, .exchange-table caption { break-after: avoid; }
  .exchange-table thead th { background: white; }
  tr { break-inside: avoid; }
  tr[hidden] { display: table-row!important; }
  a { color: inherit; }
  .source-url { display: block; font-size: 9pt; }
  p, li { orphans: 3; widows: 3; }
}

.official-logo { width: 34px; height: 34px; object-fit: contain; flex: none; }
.cover-art { display: block; width: 100%; aspect-ratio: 3 / 2; object-fit: cover; border-radius: 5px; }
.result-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(238px, 100%), 1fr)); border-bottom: 1px solid var(--line); }
.result-tile { display: grid; grid-template-columns: fit-content(58%) minmax(0, 1fr); align-items: baseline; gap: 3px 16px; padding: 21px 0 22px; }
.result-tile + .result-tile { border-left: 1px solid var(--line); padding-left: 20px; }
.result-label { color: var(--ink); font-family: var(--display); font-size: clamp(17px,2.15vw,25px); font-weight: 600; }
.result-context { color: var(--muted); font-size: 13px; }
.result-number { grid-column: 1 / -1; color: var(--accent); font-size: clamp(38px,6vw,70px); line-height: 1.1; font-variant-numeric: tabular-nums; font-weight: 600; overflow-wrap: anywhere; }
.result-number > span { font-size: clamp(15px,2.1vw,24px); font-weight: 500; }
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
  .result-tile { grid-template-columns: 1fr; }
  .result-context { font-size: 12px; }
}
@media print {
  .result-summary, .analysis-row { break-inside: avoid; }
  .result-number { font-size: 20pt; }
  .result-tile { padding: 12px 0; }
}
.network-panel { border-color: #d8d0da; --workspace-height: clamp(440px, 63vh, 575px); }
.network-title { font-size: 12px; font-weight: 600; color: var(--accent); }
.network-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.network-panel [hidden] { display: none; }
.network-legend { display: none; }
[data-network-ready] .network-legend { display: block; }
.network-controls button { padding: 3px 8px; font-size: 11px; }
.network-controls output { padding: 0 2px; color: var(--muted); text-align: center; min-width: 36px; font-variant-numeric: tabular-nums; font-size: 10px; }
.network-expand { color: var(--accent); }
.network-workspace { display: grid; grid-template-columns: minmax(0, 1fr); }
.network-panel[data-network-ready] .network-workspace { grid-template-columns: minmax(0, 46fr) minmax(0, 54fr); }
.network-viewport {
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  height: var(--workspace-height);
  min-width: 0;
  overflow: auto;
  cursor: grab;
  touch-action: pan-x pan-y;
  background: #fdfcfe radial-gradient(#e6dee8 .7px, transparent .7px) 0 0 / 14px 14px;
  scrollbar-width: thin;
}
.network-dragging { cursor: grabbing; user-select: none; }
.network-svg { display: block; flex: none; margin-inline: auto; }
.network-svg a { text-decoration: none; cursor: pointer; }
.network-node-content { display: flex; flex-direction: column; justify-content: center; height: 100%; line-height: 1.18; }
.network-node-kind { color: #695e70; font-size: 11px; margin-bottom: 4px; }
.network-node-title { color: var(--ink); font-weight: 600; font-size: 15px; overflow: hidden; }
.network-node-title .localized { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.22; overflow-wrap: anywhere; }
.network-node.foreground .node-body { fill: var(--accent-wash); stroke: #876093; }
.network-node.network-related .node-body { fill: var(--accent-wash); stroke: var(--accent); }
.network-node:hover .node-body, .network-node.network-active .node-body, .network-node:focus-visible .node-body { fill: #f1e6f3; stroke: var(--accent); stroke-width: 2.5; }
.network-edge:hover .edge-path, .network-edge.network-active .edge-path, .network-edge:focus-visible .edge-path { stroke: var(--accent); stroke-width: 3; }
.network-node .node-port { pointer-events: none; }
.network-edge-label { width: 100%; height: 100%; }
.network-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.network-inspector { min-width: 0; max-height: var(--workspace-height); overflow: auto; border-inline-start: 1px solid var(--line); background: #fff; padding: 17px clamp(12px,2vw,24px); }
.network-inspector .process-detail + .connection { border-top: 1px solid var(--line); margin-top: 13px; padding-top: 9px; }
.network-inspector :where(.connection-route a) .localized { display: inline; }
.network-legend { padding: 8px 14px; }
.network-dialog { padding: 0; border: 0; background: transparent; width: calc(100vw - 28px); max-width: none; max-height: none; }
.network-dialog::backdrop { background: rgba(38, 22, 44, .52); }
.network-dialog .network-panel { width: 100%; }
.network-dialog .network-panel .network-workspace { grid-template-columns: minmax(0, 52fr) minmax(0, 48fr); }
.network-dialog .network-viewport, .network-dialog .network-inspector { height: calc(100dvh - 125px); max-height: none; }
@media (max-width: 720px) {
  .network-panel[data-network-ready] .network-workspace, .network-dialog .network-panel .network-workspace { grid-template-columns: minmax(0, 1fr); }
  .network-viewport { height: 300px; }
  .network-inspector { border-inline-start: 0; border-top: 1px solid var(--line); max-height: none; }
  .network-dialog .network-viewport { height: 42dvh; min-height: 140px; }
  .network-dialog .network-inspector { height: auto; max-height: 37dvh; }
}
@media print {
  .network-panel[data-network-ready] .network-workspace { display: block; }
  .network-controls, .network-inspector, .network-legend, .network-dialog { display: none !important; }
  .network-viewport { display: block; height: auto; overflow: visible; background: white; }
  .network-svg { width: 100% !important; height: auto !important; max-height: 125mm; }
}
`;
