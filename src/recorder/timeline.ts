import { brand, divider, makeStyle, pad, spread, visibleLength, wrapItems, type Colors, type Style } from '../core/ui.js';
import { summarize } from './export/summary.js';
import { formatDateTime, formatDuration, formatKey, formatValue, plural, tableLabel, utcOffset } from './format.js';
import type { Change, Recording } from './types.js';

const MAX_VALUE_LENGTH = 40;
const INDENT = 3;          // where the operation starts
const OP_WIDTH = 12;       // "! truncate" plus two spaces
const VALUES_AT = INDENT + OP_WIDTH;
const MAX_TABLE_WIDTH = 22;

const OP_LABEL = {
  INSERT: (c: Colors) => c.green('+ insert'),
  UPDATE: (c: Colors) => c.yellow('~ update'),
  DELETE: (c: Colors) => c.red('- delete'),
  TRUNCATE: (c: Colors) => c.magenta('! truncate'),
} as const;

function pairs(row: Record<string, unknown> | null, skip: Set<string>): string[] {
  return Object.entries(row ?? {}).filter(([col]) => !skip.has(col)).map(([col, v]) => `${col}=${formatValue(v, MAX_VALUE_LENGTH)}`);
}

/** One change: the operation, table and key on the first line, then the values (dimmed) where they fit. */
export function formatChangeLines(change: Change, s: Style, tableWidth: number): string[] {
  const { c } = s;
  const keyCols = new Set(Object.keys(change.rowKey ?? {}));
  const key = formatKey(change) ?? c.dim('(no primary key)');
  // A table name longer than the column still keeps two spaces before the key.
  const tableCell = c.bold(tableLabel(change));
  const head = `${' '.repeat(INDENT)}${pad(OP_LABEL[change.op](c), OP_WIDTH)}${tableCell}${' '.repeat(Math.max(2, tableWidth + 2 - tableLabel(change).length))}`;

  switch (change.op) {
    case 'INSERT':
      return [`${head}${key}`, ...wrapItems(pairs(change.newValues, keyCols).map((p) => c.dim(p)), VALUES_AT, s.width)];
    case 'UPDATE': {
      const cols = Object.keys(change.newValues ?? {});
      const before = (col: string) => formatValue(change.oldValues?.[col], MAX_VALUE_LENGTH);
      const after = (col: string) => c.yellow(formatValue(change.newValues?.[col], MAX_VALUE_LENGTH));
      const oneLine = `${head}${key}   ${cols.map((col) => `${col} ${before(col)} → ${after(col)}`).join(', ')}`;
      if (visibleLength(oneLine) <= s.width || cols.length === 0) return [oneLine];

      // One column per line; when even that is too wide, the new value goes under the old one.
      const at = ' '.repeat(VALUES_AT);
      return [`${head}${key}`, ...cols.flatMap((col) => {
        const line = `${at}${col} ${before(col)} → ${after(col)}`;
        return visibleLength(line) <= s.width ? [line] : [`${at}${col} ${before(col)}`, `${at}${' '.repeat(col.length)} → ${after(col)}`];
      })];
    }
    case 'DELETE':
      // Without a primary key, the old values are the only way to tell which row went.
      return change.rowKey ? [`${head}${key}`] : [`${head}${key}`, ...wrapItems(pairs(change.oldValues, new Set()).map((p) => c.dim(p)), VALUES_AT, s.width)];
    case 'TRUNCATE':
      return [`${head}${c.dim('every row removed')}`];
  }
}

export interface TimelineOptions {
  colors?: Colors;
  width?: number;
  /** Changes hidden by filters, mentioned in the footer. */
  hidden?: number;
}

/** Renders a recording as a step-by-step timeline for the terminal. */
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

  const changes = rec.steps.flatMap((st) => st.changes);
  const tableWidth = Math.min(MAX_TABLE_WIDTH, Math.max(5, ...changes.map((ch) => tableLabel(ch).length)));

  for (const step of rec.steps) {
    // Step 0 collects changes made before the first named step; hide it when empty.
    if (step.seq === 0 && step.changes.length === 0) continue;
    lines.push('');
    lines.push(spread(` ${c.cyan(c.bold(`STEP ${step.seq}`))}  ${c.bold(step.name)}`, c.dim(plural(step.changes.length, 'change')), s.width));
    if (step.changes.length === 0) lines.push(`${' '.repeat(INDENT)}${c.dim('no database changes')}`);
    for (const change of step.changes) lines.push(...formatChangeLines(change, s, tableWidth));
  }

  const sum = summarize(rec);
  const parts = [plural(sum.changes, 'change'), plural(sum.tables, 'table')];
  for (const op of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    if (sum.byOp[op]) parts.push(plural(sum.byOp[op], op.toLowerCase()));
  }
  lines.push('', divider(s), ` ${parts.join(' · ')}${hidden ? c.yellow(` · ${plural(hidden, 'change')} hidden by filters`) : ''}`);
  return lines.join('\n');
}
