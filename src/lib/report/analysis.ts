import type { ReportContribution, ReportSensitivity } from '../../application/report.js';
import { escape, localized, ui } from './text.js';

const readable = new Intl.NumberFormat('en', { maximumSignificantDigits: 5, useGrouping: false });
const percent = new Intl.NumberFormat('en', {
  maximumSignificantDigits: 3,
  minimumFractionDigits: 1,
  useGrouping: false,
});

function magnitude(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, Math.abs(value)), 0) || 1;
}

function bar(value: number, signed: boolean): string {
  const width = Math.abs(value) * (signed ? 50 : 100);
  const left = signed ? 50 - (value < 0 ? width : 0) : 0;
  return `<div class="analysis-track${signed ? ' signed' : ''}" aria-hidden="true"><span class="analysis-bar${value < 0 ? ' negative' : ''}" style="left:${left}%;width:${width}%"></span></div>`;
}

function item(label: string, value: number, visual: string, auxiliary = ''): string {
  return `<li class="analysis-row"><div class="analysis-label">${label}</div>${visual}<div class="analysis-value"><data value="${escape(value)}" title="${escape(value)}">${escape(readable.format(value))}</data>${auxiliary ? `<small>${auxiliary}</small>` : ''}</div></li>`;
}

export function renderContributions(block: ReportContribution): string {
  const max = magnitude(block.items.map(({ value }) => value));
  const signed = block.items.some(({ value }) => value < 0);
  const total = block.total;
  const showShare = total !== undefined && total !== 0;
  const rows = block.items.map(({ label, nodeId, value }) => {
    const content = localized(label);
    const linked = nodeId
      ? `<a href="#node-${nodeId}" data-graph-link="node-${nodeId}">${content}</a>`
      : content;
    const ratio = showShare ? (value / total) * 100 : NaN;
    const share = Number.isFinite(ratio) ? `${percent.format(ratio)}%` : '';
    return item(linked, value, bar(value / max, signed), share);
  });
  return `<div class="analysis-heading">${ui('Contribution', '贡献')}<span>${escape(block.unit)}</span></div><ul class="analysis-rows">${rows.join('')}</ul>${showShare ? `<p class="analysis-total">${ui('Total used for percentages', '占比计算基准')} <span>${escape(total)} ${escape(block.unit)}</span></p>` : ''}`;
}

export function renderSensitivity(block: ReportSensitivity): string {
  // Normalize before subtraction so even finite results of opposite signs can fit the scale.
  const scale = magnitude([block.baseline, ...block.scenarios.map(({ value }) => value)]);
  const baseline = block.baseline / scale;
  const offsets = block.scenarios.map(({ value }) => value / scale - baseline);
  const max = magnitude(offsets);
  const rows = block.scenarios.map(({ label, value, description }, index) => {
    const delta = value - block.baseline;
    const ratio = block.baseline === 0 ? NaN : (delta / Math.abs(block.baseline)) * 100;
    const signedDelta = delta > 0 ? '+' : '';
    const change = Number.isFinite(ratio)
      ? `${signedDelta}${percent.format(ratio)}%`
      : Number.isFinite(delta)
        ? `Δ ${signedDelta}${escape(Number(delta.toPrecision(12)))} ${escape(block.unit)}`
        : '';
    const content =
      localized(label) + (description ? `<small>${localized(description)}</small>` : '');
    return item(content, value, bar(offsets[index] / max, true), change);
  });
  return `<div class="analysis-heading">${ui('Baseline', '基准结果')}<span>${escape(block.baseline)} ${escape(block.unit)}</span></div><ul class="analysis-rows">${rows.join('')}</ul>`;
}
