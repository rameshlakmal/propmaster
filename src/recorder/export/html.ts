import { columnDiffs, formatKey, formatPairs, formatTime, formatValue, plural, tableLabel } from '../format.js';
import type { Change, Marker, Recording } from '../types.js';
import type { ExportOptions } from './markdown.js';
import { summarize } from './summary.js';

const SUMMARY_VALUE_LENGTH = 40;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

function oneLine(change: Change): string {
  const keyCols = new Set(Object.keys(change.rowKey ?? {}));
  switch (change.op) {
    case 'UPDATE':
      return Object.keys(change.newValues ?? {})
        .map((col) => `${col}: ${formatValue(change.oldValues?.[col], SUMMARY_VALUE_LENGTH)} → ${formatValue(change.newValues?.[col], SUMMARY_VALUE_LENGTH)}`)
        .join(', ');
    case 'INSERT':
      return formatPairs(change.newValues, keyCols, SUMMARY_VALUE_LENGTH);
    case 'DELETE':
      return formatPairs(change.oldValues, keyCols, SUMMARY_VALUE_LENGTH);
    case 'TRUNCATE':
      return 'every row removed';
  }
}

// Longer values get a cell of fixed height with its own scrollbar, so one big value can't swamp the report.
const LONG_VALUE = 160;

function cellHtml(side: 'before' | 'after', value: unknown): string {
  const text = formatValue(value);
  const long = text.length > LONG_VALUE;
  return long
    ? `<td class="${side} long"><div class="scroll" tabindex="0" role="region" aria-label="${side} value, ${text.length} characters">${e(text)}</div></td>`
    : `<td class="${side}">${e(text)}</td>`;
}

function renderChange(change: Change): string {
  const key = formatKey(change);
  const diffs = columnDiffs(change);
  const showBefore = change.op !== 'INSERT';
  const showAfter = change.op !== 'DELETE';
  const search = [tableLabel(change), key ?? '', JSON.stringify(change.oldValues ?? {}), JSON.stringify(change.newValues ?? {})]
    .join(' ').toLowerCase();

  const rows = diffs.map((d) => `
          <tr${d.changed ? ' class="changed"' : ''}>
            <th scope="row">${e(d.column)}</th>
            ${showBefore ? cellHtml('before', d.before) : ''}
            ${showAfter ? cellHtml('after', d.after) : ''}
          </tr>`).join('');

  const body = diffs.length === 0 ? '' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">Column</th>${showBefore ? '<th scope="col">Before</th>' : ''}${showAfter ? '<th scope="col">After</th>' : ''}</tr></thead>
            <tbody>${rows}
            </tbody>
          </table>
        </div>`;

  return `
      <details class="change" data-op="${change.op}" data-search="${e(search)}"${change.op === 'UPDATE' ? ' open' : ''}>
        <summary>
          <span class="op op-${change.op.toLowerCase()}">${change.op}</span>
          <span class="table-name">${e(tableLabel(change))}</span>
          <span class="key">${e(key ?? (change.op === 'TRUNCATE' ? '' : '(no primary key)'))}</span>
          <span class="brief">${e(oneLine(change))}</span>
          ${change.dbUser ? `<span class="who" title="DB user · application">${e(change.dbUser)}${change.appName ? ` · ${e(change.appName)}` : ''}</span>` : ''}
        </summary>${body}
      </details>`;
}

const STYLE = `
:root {
  --bg: #f7f6f3; --surface: #ffffff; --ink: #1d1d1f; --ink-2: #55565b; --ink-3: #8a8b90; --line: #e4e2dd;
  --insert: #1f7a4d; --insert-bg: #e3f3ea; --update: #9a6200; --update-bg: #fbf0d9;
  --delete: #b3261e; --delete-bg: #fbe5e3; --truncate: #7a3db8; --truncate-bg: #efe5fa;
  --changed: #fff6dc; --focus: #2b59c3;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141416; --surface: #1d1d20; --ink: #ececee; --ink-2: #b4b5ba; --ink-3: #85868c; --line: #2f2f34;
    --insert: #6fd3a0; --insert-bg: #16352a; --update: #f2c46b; --update-bg: #3a2e14;
    --delete: #ff8d84; --delete-bg: #3d1d1b; --truncate: #c8a2f5; --truncate-bg: #2e2140;
    --changed: #3a3216; --focus: #8fb0ff;
  }
}
:root[data-theme="dark"] {
  --bg: #141416; --surface: #1d1d20; --ink: #ececee; --ink-2: #b4b5ba; --ink-3: #85868c; --line: #2f2f34;
  --insert: #6fd3a0; --insert-bg: #16352a; --update: #f2c46b; --update-bg: #3a2e14;
  --delete: #ff8d84; --delete-bg: #3d1d1b; --truncate: #c8a2f5; --truncate-bg: #2e2140;
  --changed: #3a3216; --focus: #8fb0ff;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
header h1 { font-size: 26px; line-height: 1.2; margin: 6px 0 18px; letter-spacing: -0.01em; }
.eyebrow { color: var(--ink-3); font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1px;
  background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.meta div { background: var(--surface); padding: 10px 14px; }
.meta dt { color: var(--ink-3); font-size: 12px; }
.meta dd { margin: 2px 0 0; font-weight: 550; overflow-wrap: anywhere; }
.notes { margin: 16px 0 0; padding: 10px 14px; border-left: 3px solid var(--update); background: var(--update-bg); border-radius: 6px; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 12px 0; margin: 20px 0 4px; background: var(--bg); border-bottom: 1px solid var(--line); }
.toolbar input[type="search"] { flex: 1 1 220px; min-width: 0; padding: 8px 12px; border: 1px solid var(--line);
  border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; }
.toolbar button { padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface);
  color: var(--ink-2); font: inherit; font-size: 13px; cursor: pointer; }
.toolbar button[aria-pressed="false"] { opacity: .45; text-decoration: line-through; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.step { margin-top: 28px; }
.step h2 { font-size: 17px; margin: 0 0 10px; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.step h2 .seq { color: var(--ink-3); font-weight: 600; font-variant-numeric: tabular-nums; }
.markers { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.marker time { color: var(--ink-3); font-variant-numeric: tabular-nums; }
.marker.flag { padding: 6px 10px; border-left: 3px solid var(--update); background: var(--update-bg); border-radius: 6px; }
.marker.pause, .marker.resume { color: var(--ink-3); }
.step h2 .count { color: var(--ink-3); font-size: 13px; font-weight: 500; }
.empty { color: var(--ink-3); font-style: italic; margin: 0; }
.change { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; margin: 8px 0; }
.change summary { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding: 10px 14px; cursor: pointer; list-style: none; }
.change summary::-webkit-details-marker { display: none; }
.change summary::before { content: "▸"; color: var(--ink-3); width: 10px; }
.change[open] summary::before { content: "▾"; }
.op { font: 600 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .04em; padding: 4px 7px; border-radius: 5px; }
.op-insert { color: var(--insert); background: var(--insert-bg); }
.op-update { color: var(--update); background: var(--update-bg); }
.op-delete { color: var(--delete); background: var(--delete-bg); }
.op-truncate { color: var(--truncate); background: var(--truncate-bg); }
.table-name { font-weight: 650; }
.key, .brief, td, .who { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
.key { color: var(--ink-2); }
.brief { color: var(--ink-3); flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.who { color: var(--ink-3); font-size: 12px; }
.table-wrap { overflow-x: auto; border-top: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
thead th { color: var(--ink-3); font-size: 12px; font-weight: 600; }
tbody th { font-weight: 550; white-space: nowrap; width: 1%; }
td { overflow-wrap: anywhere; }
tr td.before:not(:last-child), tr td.before + td.after { width: 50%; }
tr.changed td.before { color: var(--delete); text-decoration: line-through; text-decoration-thickness: 1px; }
tr.changed td.before.long { text-decoration: none; } /* struck-through paragraphs are unreadable */
td.long .scroll { max-height: 12em; overflow-y: auto; white-space: pre-wrap; }
tr.changed td.after { background: var(--changed); font-weight: 600; }
.brief { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.change[open] .brief { white-space: normal; }
footer { margin-top: 40px; color: var(--ink-3); font-size: 13px; }
.hidden { display: none !important; }
`;

const SCRIPT = `
const search = document.getElementById('search');
const buttons = [...document.querySelectorAll('[data-filter-op]')];
function apply() {
  const q = search.value.trim().toLowerCase();
  const ops = new Set(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.filterOp));
  for (const step of document.querySelectorAll('.step')) {
    let shown = 0;
    for (const c of step.querySelectorAll('.change')) {
      const ok = ops.has(c.dataset.op) && (!q || c.dataset.search.includes(q));
      c.classList.toggle('hidden', !ok);
      if (ok) shown++;
    }
    const total = step.querySelectorAll('.change').length;
    step.querySelector('.count').textContent = shown === total
      ? total + (total === 1 ? ' change' : ' changes')
      : shown + ' of ' + total + ' shown';
  }
}
search.addEventListener('input', apply);
for (const b of buttons) b.addEventListener('click', () => {
  b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  apply();
});
`;

const MARKER_LABEL = { pause: '‖ Paused', resume: '● Resumed', flag: '⚑ Flagged' } as const;

function renderMarker(m: Marker): string {
  return `<li class="marker ${m.kind}"><strong>${MARKER_LABEL[m.kind]}</strong> <time>${formatTime(m.at)}</time>${m.note ? ` · ${e(m.note)}` : ''}</li>`;
}

/** A self-contained HTML report: no external files, safe to attach to a ticket or open offline. */
export function toHtml(rec: Recording, { masked, hidden = 0 }: ExportOptions): string {
  const s = summarize(rec);
  const steps = rec.steps
    .filter((st) => !(st.seq === 0 && st.changes.length === 0 && !st.markers?.length))
    .map((st) => `
    <section class="step">
      <h2><span class="seq">Step ${st.seq}</span> ${e(st.name)} <span class="count">${plural(st.changes.length, 'change')}</span></h2>
      ${st.markers?.length ? `<ul class="markers">${st.markers.map(renderMarker).join('')}</ul>` : ''}
      ${st.changes.length === 0 ? '<p class="empty">No database changes.</p>' : st.changes.map(renderChange).join('')}
    </section>`).join('');

  const opButtons = (['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const)
    .filter((op) => s.byOp[op] > 0)
    .map((op) => `<button type="button" data-filter-op="${op}" aria-pressed="true">${op.toLowerCase()} · ${s.byOp[op]}</button>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Propmaster">
<title>${e(rec.name)} · Propmaster</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Propmaster recording</div>
    <h1>${e(rec.name)}</h1>
    <dl class="meta">
      <div><dt>Session</dt><dd>#${e(rec.id)} · ${rec.mode} mode</dd></div>
      <div><dt>Database</dt><dd>${e(rec.database)}</dd></div>
      <div><dt>Recorded</dt><dd>${e(s.recorded)}</dd></div>
      <div><dt>Changes</dt><dd>${e(s.text)}${hidden ? ` · ${plural(hidden, 'change')} hidden by filters` : ''}</dd></div>
    </dl>
    ${rec.notes.length ? `<div class="notes">${rec.notes.map((n) => `<p>${e(n)}</p>`).join('')}</div>` : ''}
  </header>
  <div class="toolbar" role="search">
    <input id="search" type="search" placeholder="Filter by table, key or value" aria-label="Filter changes">
    ${opButtons}
  </div>
  <main>${steps}
  </main>
  <footer>Generated by Propmaster. ${masked ? 'Sensitive values are masked.' : '<strong>Values are not masked.</strong>'}</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
