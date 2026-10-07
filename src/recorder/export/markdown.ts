import { formatKey, formatPairs, formatTime, formatValue, jsonColumnChanges, plural, prettyJson, tableLabel } from '../format.js';
import type { Change, Marker, Recording } from '../types.js';
import { summarize } from './summary.js';

const MAX_VALUE_LENGTH = 80;

/** Escapes text for a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/`/g, '\\`');
}

/** Columns holding JSON: a table cell can't show it over several lines, so it goes in a code block below. */
function jsonColumns(row: Change['newValues'], skip: Set<string>): Set<string> {
  return new Set(Object.entries(row ?? {}).filter(([col, v]) => !skip.has(col) && prettyJson(v) !== null).map(([col]) => col));
}

function withJsonNote(text: string, json: Set<string>): string {
  const note = json.size ? `${text ? '<br>' : ''}${[...json].map((col) => `${cell(col)}: JSON below`).join('<br>')}` : '';
  return text + note;
}

function details(change: Change): string {
  const keyCols = new Set(Object.keys(change.rowKey ?? {}));
  switch (change.op) {
    case 'INSERT': {
      const json = jsonColumns(change.newValues, keyCols);
      return withJsonNote(cell(formatPairs(change.newValues, new Set([...keyCols, ...json]), MAX_VALUE_LENGTH)), json);
    }
    case 'UPDATE':
      return Object.keys(change.newValues ?? {})
        .flatMap((col) => {
          const inside = jsonColumnChanges(change.oldValues?.[col], change.newValues?.[col]);
          if (!inside) return [`${cell(col)}: ${cell(formatValue(change.oldValues?.[col], MAX_VALUE_LENGTH))} → **${cell(formatValue(change.newValues?.[col], MAX_VALUE_LENGTH))}**`];
          return inside.map((j) => (j.before ?? '').includes('\n') || (j.after ?? '').includes('\n')
            ? `${cell(`${col}.${j.path}`.replace('.[', '['))}: JSON below`
            : `${cell(`${col}.${j.path}`.replace('.[', '['))}: ${cell(j.before ?? 'missing')} → **${cell(j.after ?? 'missing')}**`);
        })
        .join('<br>');
    case 'DELETE': {
      const json = jsonColumns(change.oldValues, keyCols);
      return withJsonNote(cell(formatPairs(change.oldValues, new Set([...keyCols, ...json]), MAX_VALUE_LENGTH)), json);
    }
    case 'TRUNCATE':
      return 'every row removed';
  }
}

export interface ExportOptions {
  masked: boolean;
  hidden?: number;
}

/** A Markdown report for bug tickets and pull requests. */
/** The JSON of a step's changes, each value in its own code block so it keeps its shape. */
function jsonSections(changes: Change[]): string[] {
  const out: string[] = [];
  const block = (title: string, json: string) => out.push(`**${title}**`, '', '```json', json, '```', '');
  for (const c of changes) {
    const where = `${tableLabel(c)} ${formatKey(c) ?? ''}`.trim();
    const keyCols = new Set(Object.keys(c.rowKey ?? {}));
    if (c.op === 'INSERT' || c.op === 'DELETE') {
      const row = c.op === 'INSERT' ? c.newValues : c.oldValues;
      for (const [col, v] of Object.entries(row ?? {})) {
        const json = keyCols.has(col) ? null : prettyJson(v);
        if (json !== null) block(`${where} · ${col}${c.op === 'DELETE' ? ' (removed)' : ''}`, json);
      }
    } else if (c.op === 'UPDATE') {
      for (const col of Object.keys(c.newValues ?? {})) {
        for (const j of jsonColumnChanges(c.oldValues?.[col], c.newValues?.[col]) ?? []) {
          if (!(j.before ?? '').includes('\n') && !(j.after ?? '').includes('\n')) continue;
          const path = `${col}.${j.path}`.replace('.[', '[');
          if (j.before === null) block(`${where} · ${path} (added)`, j.after!);
          else if (j.after === null) block(`${where} · ${path} (removed)`, j.before);
          else { block(`${where} · ${path} before`, j.before); block(`${where} · ${path} after`, j.after); }
        }
      }
    }
  }
  return out;
}

const MARKER_LABEL = { pause: '‖ **Paused**', resume: '● **Resumed**', flag: '⚑ **Flagged**' } as const;

export function toMarkdown(rec: Recording, { masked, hidden = 0 }: ExportOptions): string {
  const s = summarize(rec);
  const out: string[] = [
    `# Propmaster recording: ${rec.name}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Session | #${rec.id} (${rec.mode} mode) |`,
    `| Database | ${cell(rec.database)} |`,
    `| Recorded | ${s.recorded} |`,
    `| Changes | ${s.text}${hidden ? `, ${plural(hidden, 'change')} hidden by filters` : ''} |`,
    '',
  ];

  for (const note of rec.notes) out.push(`> **Note:** ${cell(note)}`, '');

  for (const step of rec.steps) {
    const markers = step.markers ?? [];
    if (step.seq === 0 && step.changes.length === 0 && markers.length === 0) continue;
    out.push(`## Step ${step.seq} · ${cell(step.name)} (${plural(step.changes.length, 'change')})`, '');
    if (markers.length) {
      out.push(...markers.map((m) => `- ${MARKER_LABEL[m.kind]} at ${formatTime(m.at)}${m.note ? `: ${cell(m.note)}` : ''}`), '');
    }
    if (step.changes.length === 0) {
      out.push('_No database changes._', '');
      continue;
    }
    out.push('| Op | Table | Row | Details |', '| --- | --- | --- | --- |');
    for (const c of step.changes) {
      out.push(`| ${c.op} | ${cell(tableLabel(c))} | ${cell(formatKey(c) ?? '(no primary key)')} | ${details(c)} |`);
    }
    out.push('');
    out.push(...jsonSections(step.changes));
  }

  out.push(`_Generated by Propmaster. ${masked ? 'Sensitive values are masked.' : '**Values are not masked.**'}_`, '');
  return out.join('\n');
}
