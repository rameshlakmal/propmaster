import { formatDateTime, formatDuration, formatTime, plural, tableLabel, utcOffset } from '../format.js';
import { allChanges, OPS, type Op, type Recording } from '../types.js';

export interface Summary {
  recorded: string;
  changes: number;
  tables: number;
  byOp: Record<Op, number>;
  /** "7 changes across 5 tables (4 inserts, 3 updates)" */
  text: string;
}

export function summarize(rec: Recording): Summary {
  const all = allChanges(rec);
  const byOp = Object.fromEntries(OPS.map((op) => [op, all.filter((c) => c.op === op).length])) as Record<Op, number>;
  const tables = new Set(all.map(tableLabel)).size;
  const parts = OPS.filter((op) => byOp[op] > 0).map((op) => plural(byOp[op], op.toLowerCase()));
  const recorded = rec.stoppedAt
    ? `${formatDateTime(rec.startedAt)} → ${formatTime(rec.stoppedAt)} (${formatDuration(rec.startedAt, rec.stoppedAt)}), ${utcOffset(rec.startedAt)}`
    : `${formatDateTime(rec.startedAt)}, ${utcOffset(rec.startedAt)}, still recording`;

  return {
    recorded,
    changes: all.length,
    tables,
    byOp,
    text: `${plural(all.length, 'change')} across ${plural(tables, 'table')}${parts.length ? ` (${parts.join(', ')})` : ''}`,
  };
}
