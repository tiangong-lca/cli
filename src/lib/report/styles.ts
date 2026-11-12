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
h1 { font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", serif; font-size: clamp(32px,4vw,54px); font-weight: 600; line-height: 1.3; letter-spacing: -.025em; max-width: 920px; }
h2 { font-size: 25px; line-height: 1.4; font-weight: 600; letter-spacing: -.025em; margin: 0 0 26px; }
h3 { font-size: 16px; line-height: 1.5; font-weight: 600; }
.localized { display: block; }
[data-language=en] [data-language-text=zh]:not([data-only]),
[data-language=zh] [data-language-text=en]:not([data-only]) { display: none; }
[data-only]::after { content: attr(data-only); font-size: 10px; font-weight: 400; color: var(--muted); margin-left: 5px; }
.toolbar { position: sticky; top: 0; z-index: 3; background: #fff; border-bottom: 1px solid var(--line); padding: 14px max(28px,calc((100vw - 1280px)/2)); display: flex; align-items: center; gap: 14px; font-size: 12px; }
.brand { font-weight: 600; letter-spacing: .09em; margin-right: auto; display: flex; align-items: center; gap: 12px; }
.brand .localized { font-weight: 400; letter-spacing: .02em; color: var(--muted); }
.brand-mark { background: var(--accent); color: white; width: 27px; height: 27px; display: grid; place-items: center; font-family: Georgia, serif; font-size: 19px; border-radius: 5px; }
.brand-divider { color: #ccc7d0; font-weight: 400; }
.page { max-width: 1280px; margin: auto; padding: 0 36px 60px; }
.hero { padding: 66px 0 52px 224px; border-bottom: 1px solid var(--line); }
.eyebrow { color: var(--accent); font-size: 11px; font-weight: 600; letter-spacing: .16em; margin-bottom: 18px; }
.subtitle { margin-top: 22px; max-width: 780px; font-size: 15px; color: var(--muted); line-height: 1.85; }
.layout { display: grid; grid-template-columns: 180px minmax(0,1fr); gap: 44px; margin-top: 44px; }
.toc { position: sticky; top: 100px; align-self: start; font-size: 12px; max-height: 80vh; overflow: auto; }
.toc-title { color: var(--muted); font-size: 10px; letter-spacing: .14em; margin-bottom: 16px; padding-left: 12px; }
.toc a { display: block; text-decoration: none; color: var(--muted); border-left: 2px solid var(--line); padding: 10px 12px; }
.toc a .localized { display: inline; }
.toc a:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-wash); }
main { min-width: 0; }
.section { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 32px; margin-bottom: 24px; scroll-margin-top: 90px; }
.section-number { display: inline-flex; font-size: 11px; color: var(--accent); font-weight: 600; letter-spacing: .1em; margin-bottom: 12px; }
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
.model-caption { font-size: 10px; font-weight: 600; letter-spacing: .1em; color: var(--muted); }
.graph-controls { display: flex; gap: 10px; align-items: center; font-size: 11px; }
.graph-controls button { padding: 4px 9px; }
.graph-scroll { overflow: auto; background-color: white; background-image: radial-gradient(#d9d4dd .7px, transparent .7px); background-size: 12px 12px; }
.model-svg { display: block; width: 100%; min-width: 0; max-width: none; }
.node-body { fill: white; stroke: var(--accent); stroke-width: 1; }
.node-title-bar { fill: var(--accent); }
.node-label { color: white; font-size: 14px; line-height: 30px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node-label .localized { overflow: hidden; text-overflow: ellipsis; }
.node-kind { font-size: 10px; color: var(--muted); }
.node-io { display: grid; grid-template-columns: 1fr 1fr; margin-top: 16px; gap: 10px; }
.node-io > div { min-width: 0; }
.node-io > div:last-child { text-align: right; }
.node-io strong { display: block; font-size: 11px; font-weight: 500; margin-bottom: 6px; }
.port-preview { font-size: 11px; color: var(--muted); margin-bottom: 5px; }
.port-preview .localized { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.port-empty { font-size: 12px; color: #a5a0aa; display: block; }
.node-port { fill: white; stroke: var(--accent); stroke-width: 1; }
.edge-path { stroke: var(--accent); stroke-width: 1.3; fill: none; stroke-linejoin: round; }
.edge-hit { stroke: transparent; stroke-width: 18; fill: none; }
.edge-chip { display: flex; justify-content: center; gap: 6px; align-items: center; width: max-content; max-width: 96px; margin: 0 auto; padding: 3px 6px; background: white; border: 1px solid #d7c7dc; border-radius: 5px; font-size: 10px; line-height: 16px; white-space: nowrap; overflow: hidden; }
.edge-chip span { color: var(--accent); font-weight: 600; }
.selected .node-body { stroke-width: 2.5; }
.selected .edge-path { stroke-width: 2.5; }
.selected .edge-chip { border-color: var(--accent); }
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
.footer { display: flex; justify-content: space-between; gap: 24px; font-size: 10px; color: var(--muted); padding: 24px 0; border-top: 1px solid var(--line); }
.footer-brand { letter-spacing: .14em; font-weight: 600; color: var(--accent); }
@media(max-width:1000px) {
  .hero { padding-left: 0; }
  .layout { grid-template-columns: 140px minmax(0,1fr); gap: 24px; }
  .details-grid { grid-template-columns: 1fr; }
  .detail-io { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
}
@media(max-width:760px) {
  .toolbar { padding: 12px 16px; gap: 8px; flex-wrap: wrap; }
  .brand { width: 100%; margin-bottom: 4px; }
  .toolbar > label { margin-right: auto; }
  .page { padding: 0 16px 32px; }
  .hero { padding: 36px 0 30px; }
  .layout { display: block; margin-top: 24px; }
  .toc { position: static; max-height: none; display: flex; flex-wrap: wrap; margin-bottom: 22px; gap: 4px; }
  .toc-title { width: 100%; padding-left: 0; margin-bottom: 6px; }
  .toc a { padding: 6px 10px; }
  .section { padding: 22px 18px; }
  h2 { font-size: 22px; margin-bottom: 20px; }
  .model-panel-head { flex-wrap: wrap; padding: 10px; gap: 8px; }
  .graph-controls { width: 100%; justify-content: space-between; }
  .legend { padding: 10px; }
  .table-controls label { display: block; }
  .table-controls label > .localized { flex-shrink: 0; white-space: nowrap; }
.table-controls input { max-width: 170px; }
  td, th { padding: 10px 8px; }
  .connection { grid-template-columns: 20px minmax(0,1fr); }
  .connection-amount { grid-column: 2; }
  .footer { display: block; }
  .footer-brand { display: block; margin-bottom: 8px; }
}
@page { size: A4; margin: 16mm; }
@media print {
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  :root, body { background: white; font-size: 10pt; }
  .toolbar, .toc, .graph-controls, .table-controls { display: none!important; }
  .page { padding: 0; max-width: none; }
  .layout { display: block; margin-top: 20px; }
  .hero { padding: 0 0 24px; }
  h1 { font-size: 27pt; }
  h2 { font-size: 17pt; break-after: avoid; }
  .section { border: 0; border-radius: 0; padding: 20px 0; margin: 0; break-inside: auto; border-bottom: 1px solid var(--line); }
  .table-wrap, .graph-scroll { overflow: visible; }
  .model-svg { width: 100%!important; min-width: 0; height: auto; }
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
  .footer { font-size: 8pt; }
}
`;
