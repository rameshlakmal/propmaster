import { boxTable, brand, cell, divider, makeStyle, spread, type Cell, type Colors, type Column, type Token } from '../core/ui.js';
import { summarize } from './export/summary.js';
import { formatDateTime, formatDuration, formatTime, formatValue, jsonColumnChanges, plural, prettyJson, tableLabel, utcOffset } from './format.js';
import type { Change, Marker, Recording, Row } from './types.js';

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

/** JSON values print over several lines; this many at most per value, then a count of the rest. */
const MAX_JSON_LINES = 15;

function pairTokens(row: Row | null, skip: Set<string> = new Set()): Token[] {
  return Object.entries(row ?? {})
    .filter(([col, v]) => !skip.has(col) && prettyJson(v) === null)
    .map(([col, v]) => ({ text: `${col}=${formatValue(v, MAX_VALUE_LENGTH)}`, shorten: true }));
}

/** JSON lines as paragraphs of one token each, so their indentation is kept. */
function jsonLines(json: string, c: Colors, style?: (s: string) => string): Token[][] {
  const lines = json.split('\n');
  const shown = lines.slice(0, MAX_JSON_LINES).map((line) => [{ text: line, style }]);
  return lines.length > MAX_JSON_LINES
    ? [...shown, [{ text: `… ${lines.length - MAX_JSON_LINES} more lines (record export shows all)`, style: (t: string) => c.dim(t) }]]
    : shown;
}

/** Each JSON column of a row: its name, then the JSON over several lines. */
function jsonBlocks(row: Row | null, skip: Set<string>, c: Colors, style?: (s: string) => string): Cell {
  return Object.entries(row ?? {}).flatMap(([col, v]) => {
    const json = skip.has(col) ? null : prettyJson(v);
    return json === null ? [] : [[{ text: `${col}=`, style: (t: string) => c.dim(t) }], ...jsonLines(json, c, style)];
  });
}

/** The four cells of one change: operation, table, row key, and what changed. */
export function changeRow(change: Change, c: Colors): Cell[] {
  const keyCols = new Set(Object.keys(change.rowKey ?? {}));
  const op = cell(change.op.toLowerCase(), OP_STYLE[change.op](c));
  const table = cell(tableLabel(change), (t) => c.bold(t));
  const key: Cell = change.rowKey ? [pairTokens(change.rowKey)] : cell('(no primary key)', (t) => c.dim(t));

  let changes: Cell;
  switch (change.op) {
    case 'INSERT': {
      const pairs = pairTokens(change.newValues, keyCols);
      changes = [...(pairs.length ? [pairs] : []), ...jsonBlocks(change.newValues, keyCols, c)];
      break;
    }
    case 'UPDATE':
      // One line per changed column: "stock 20 → 18", the new value highlighted. For JSON, one line per path inside it.
      changes = Object.keys(change.newValues ?? {}).flatMap((col): Token[][] => {
        const inside = jsonColumnChanges(change.oldValues?.[col], change.newValues?.[col]);
        if (!inside) {
          return [[
            { text: col },
            { text: formatValue(change.oldValues?.[col], MAX_VALUE_LENGTH) },
            { text: '→', style: (t) => c.dim(t) },
            { text: formatValue(change.newValues?.[col], MAX_VALUE_LENGTH), style: (t) => c.yellow(t) },
          ]];
        }
        return inside.flatMap((j) => {
          const label = { text: `${col}.${j.path}`.replace('.[', '['), style: (t: string) => c.dim(t) };
          const multi = (j.before ?? '').includes('\n') || (j.after ?? '').includes('\n');
          if (!multi) {
            return [[label, { text: j.before ?? 'missing' }, { text: '→', style: (t: string) => c.dim(t) }, { text: j.after ?? 'missing', style: (t: string) => c.yellow(t) }]];
          }
          // A key only on one side was added or removed: show that side alone.
          if (j.before === null) return [[label, { text: 'added', style: (t: string) => c.green(t) }], ...jsonLines(j.after!, c, (t) => c.yellow(t))];
          if (j.after === null) return [[label, { text: 'removed', style: (t: string) => c.red(t) }], ...jsonLines(j.before, c, (t) => c.dim(t))];
          return [[label], [{ text: 'before:', style: (t: string) => c.dim(t) }], ...jsonLines(j.before, c),
            [{ text: 'after:', style: (t: string) => c.dim(t) }], ...jsonLines(j.after, c, (t) => c.yellow(t))];
        });
      });
      break;
    case 'DELETE': {
      // Without a primary key, the old values are the only way to tell which row went.
      if (change.rowKey) { changes = cell('row removed', (t) => c.dim(t)); break; }
      const dim = (s: string) => c.dim(s);
      const pairs = pairTokens(change.oldValues).map((t) => ({ ...t, style: dim }));
      changes = [...(pairs.length ? [pairs] : []), ...jsonBlocks(change.oldValues, new Set(), c, dim)];
      break;
    }
    case 'TRUNCATE':
      changes = cell('every row removed', (t) => c.dim(t));
      break;
  }
  return [op, table, key, changes];
}

const MARKER_TEXT = { pause: 'paused', resume: 'resumed', flag: 'flagged' } as const;

/** One line per pause, resume or flag, e.g. "⚑ flagged 10:42:07 · total shows 0.00". */
export function markerLine(m: Marker, c: Colors): string {
  const icon = m.kind === 'flag' ? c.yellow('⚑') : m.kind === 'pause' ? c.yellow('‖') : c.red('●');
  const text = m.kind === 'resume' ? MARKER_TEXT[m.kind] : c.yellow(MARKER_TEXT[m.kind]);
  return `   ${icon} ${text} ${c.dim(formatTime(m.at))}${m.note ? ` ${c.dim('·')} ${m.note}` : ''}`;
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
    const markers = step.markers ?? [];
    if (step.seq === 0 && step.changes.length === 0 && markers.length === 0) continue;
    lines.push('');
    const count = plural(step.changes.length, 'change');
    lines.push(spread(` ${c.cyan(c.bold(`STEP ${step.seq}`))}  ${c.bold(step.name)}`, c.dim(step.auto ? `auto · ${count}` : count), s.width));
    lines.push(...markers.map((m) => markerLine(m, c)));
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
