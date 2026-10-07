import pc from 'picocolors';
import { formatDateTime, formatDuration, formatKey, formatPairs, formatTime, formatValue, plural, tableLabel, utcOffset } from './format.js';
import { allChanges, type Change, type Recording } from './types.js';

type Colors = Pick<typeof pc, 'bold' | 'dim' | 'green' | 'yellow' | 'red' | 'cyan' | 'magenta'>;

const MAX_VALUE_LENGTH = 40;

export function formatChange(change: Change, c: Colors = pc): string {
  const keyCols = new Set(Object.keys(change.rowKey ?? {}));
  const key = formatKey(change) ?? c.dim('(no primary key)');
  const table = c.bold(tableLabel(change));

  switch (change.op) {
    case 'INSERT':
      return `${c.green('+ INSERT')} ${table} ${key}  ${c.dim(formatPairs(change.newValues, keyCols, MAX_VALUE_LENGTH))}`;
    case 'UPDATE': {
      const diffs = Object.keys(change.newValues ?? {}).map((col) =>
        `${col}: ${formatValue(change.oldValues?.[col], MAX_VALUE_LENGTH)} → ${c.yellow(formatValue(change.newValues?.[col], MAX_VALUE_LENGTH))}`);
      return `${c.yellow('~ UPDATE')} ${table} ${key}  ${diffs.join(', ')}`;
    }
    case 'DELETE': {
      // Without a primary key, the old values are the only way to tell which row went.
      const detail = change.rowKey ? '' : `  ${c.dim(formatPairs(change.oldValues, new Set(), MAX_VALUE_LENGTH))}`;
      return `${c.red('- DELETE')} ${table} ${key}${detail}`;
    }
    case 'TRUNCATE':
      return `${c.magenta('! TRUNCATE')} ${table}  ${c.dim('(every row removed)')}`;
  }
}

export interface TimelineOptions {
  colors?: Colors;
  /** Changes hidden by filters, mentioned in the footer. */
  hidden?: number;
}

/** Renders a recording as a step-by-step timeline for the terminal. */
export function formatTimeline(rec: Recording, { colors: c = pc, hidden = 0 }: TimelineOptions = {}): string {
  const lines: string[] = [];
  const when = rec.stoppedAt
    ? `${formatDateTime(rec.startedAt)} → ${formatTime(rec.stoppedAt)} (${formatDuration(rec.startedAt, rec.stoppedAt)})`
    : `started ${formatDateTime(rec.startedAt)} · ${c.red('● recording')}`;
  const mode = rec.mode === 'snapshot' ? ' · snapshot mode' : '';
  lines.push(c.bold(`Session #${rec.id} · ${rec.name}`) + c.dim(` · ${rec.database}${mode}`));
  lines.push(c.dim(`${when} · times in ${utcOffset(rec.startedAt)}`), '');

  for (const note of rec.notes) lines.push(c.yellow(`! ${note}`));
  if (rec.notes.length > 0) lines.push('');

  for (const step of rec.steps) {
    // Step 0 collects changes made before the first named step; hide it when empty.
    if (step.seq === 0 && step.changes.length === 0) continue;

    lines.push(`${c.cyan(`Step ${step.seq}`)} · ${c.bold(step.name)} ${c.dim(`· ${plural(step.changes.length, 'change')}`)}`);
    if (step.changes.length === 0) lines.push(c.dim('  (no database changes)'));
    for (const change of step.changes) lines.push(`  ${formatChange(change, c)}`);
    lines.push('');
  }

  const all = allChanges(rec);
  const tables = new Set(all.map(tableLabel));
  const filtered = hidden > 0 ? ` · ${plural(hidden, 'change')} hidden by filters` : '';
  lines.push(c.dim(`Total: ${plural(all.length, 'change')} across ${plural(tables.size, 'table')}${filtered}`));
  return lines.join('\n');
}
