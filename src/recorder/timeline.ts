import { boxTable, brand, cell, divider, makeStyle, spread, type Cell, type Colors, type Column, type Token } from '../core/ui.js';
import { summarize } from './export/summary.js';
import { formatDateTime, formatDuration, formatValue, plural, tableLabel, utcOffset } from './format.js';
import type { Change, Recording, Row } from './types.js';

const MAX_VALUE_LENGTH = 40;

const COLUMNS: Column[] = [
  { header: 'Op' },
  { header: 'Table', max: 24 },
  { header: 'Row', max: 24 },
  { header: 'Changes', flex: true },
];

const OP_STYLE = {
  INSERT: (c: Colors) => c.green,
  UPDATE: (c: Colors) => c.yellow,
  DELETE: (c: Colors) => c.red,
  TRUNCATE: (c: Colors) => c.magenta,
} as const;

function pairTokens(row: Row | null, skip: Set<string> = new Set()): Token[] {
  return Object.entries(row ?? {}).filter(([col]) => !skip.has(col)).map(([col, v]) => ({ text: `${col}=${formatValue(v, MAX_VALUE_LENGTH)}`, shorten: true }));
}

/** The four cells of one change: operation, table, row key, and what changed. */
export function changeRow(change: Change, c: Colors): Cell[] {
  const keyCols = new Set(Object.keys(change.rowKey ?? {}));
  const op = cell(change.op.toLowerCase(), OP_STYLE[change.op](c));
  const table = cell(tableLabel(change), (t) => c.bold(t));
  const key: Cell = change.rowKey ? [pairTokens(change.rowKey)] : cell('(no primary key)', (t) => c.dim(t));

  let changes: Cell;
  switch (change.op) {
    case 'INSERT':
      changes = [pairTokens(change.newValues, keyCols)];
      break;
    case 'UPDATE':
      // One line per changed column: "stock 20 → 18", the new value highlighted.
      changes = Object.keys(change.newValues ?? {}).map((col) => [
        { text: col },
        { text: formatValue(change.oldValues?.[col], MAX_VALUE_LENGTH) },
        { text: '→', style: (t) => c.dim(t) },
        { text: formatValue(change.newValues?.[col], MAX_VALUE_LENGTH), style: (t) => c.yellow(t) },
      ]);
      break;
    case 'DELETE':
      // Without a primary key, the old values are the only way to tell which row went.
      changes = change.rowKey ? cell('row removed', (t) => c.dim(t)) : [pairTokens(change.oldValues).map((t) => ({ ...t, style: (s: string) => c.dim(s) }))];
      break;
    case 'TRUNCATE':
      changes = cell('every row removed', (t) => c.dim(t));
      break;
  }
  return [op, table, key, changes];
}

export interface TimelineOptions {
  colors?: Colors;
  width?: number;
  /** Changes hidden by filters, mentioned in the footer. */
  hidden?: number;
}

/** Renders a recording as a step-by-step timeline for the terminal: one bordered table per step. */
export function formatTimeline(rec: Recording, { colors, width, hidden = 0 }: TimelineOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const lines: string[] = [];

  const when = rec.stoppedAt
    ? `${formatDateTime(rec.startedAt)} → ${formatDateTime(rec.stoppedAt).slice(11)} (${formatDuration(rec.startedAt, rec.stoppedAt)})`
    : `started ${formatDateTime(rec.startedAt)}`;
  const details = [rec.database, when, utcOffset(rec.startedAt), ...(rec.mode === 'snapshot' ? ['snapshot mode'] : [])];
  lines.push(` ${brand(c)}  ${c.bold(`Session #${rec.id}`)} · ${rec.name}`);
  lines.push(` ${c.dim(details.join(' · '))}${rec.stoppedAt ? '' : `  ${c.red('● recording')}`}`);
  for (const note of rec.notes) lines.push(` ${c.yellow(`! ${note}`)}`);

  // Every step's table gets the same column widths, so the borders line up down the page.
  const measure = rec.steps.flatMap((st) => st.changes.map((ch) => changeRow(ch, c)));

  for (const step of rec.steps) {
    // Step 0 collects changes made before the first named step; hide it when empty.
    if (step.seq === 0 && step.changes.length === 0) continue;
    lines.push('');
    lines.push(spread(` ${c.cyan(c.bold(`STEP ${step.seq}`))}  ${c.bold(step.name)}`, c.dim(plural(step.changes.length, 'change')), s.width));
    if (step.changes.length === 0) lines.push(`   ${c.dim('no database changes')}`);
    else lines.push(...boxTable(s, COLUMNS, step.changes.map((ch) => changeRow(ch, c)), { measure }));
  }

  const sum = summarize(rec);
  const parts = [plural(sum.changes, 'change'), plural(sum.tables, 'table')];
  for (const op of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    if (sum.byOp[op]) parts.push(plural(sum.byOp[op], op.toLowerCase()));
  }
  lines.push('', divider(s), ` ${parts.join(' · ')}${hidden ? c.yellow(` · ${plural(hidden, 'change')} hidden by filters`) : ''}`);
  return lines.join('\n');
}
