export type Op = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
export const OPS: readonly Op[] = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

export type Row = Record<string, unknown>;

/** How a session was recorded: database triggers, or snapshots compared by the CLI (read-only access). */
export type Mode = 'trigger' | 'snapshot';

export interface Change {
  id: number;
  tableSchema: string;
  tableName: string;
  op: Op;
  /** Primary key values, or null when the table has no primary key (and for TRUNCATE). */
  rowKey: Row | null;
  /** Full row for DELETE; only the changed columns for UPDATE. */
  oldValues: Row | null;
  /** Full row for INSERT; only the changed columns for UPDATE. */
  newValues: Row | null;
  /** When it happened (trigger mode), or when the snapshot that found it was taken. */
  changedAt: Date;
  /** Who made the change. Unknown (null) in snapshot mode. */
  txid: string | null;
  dbUser: string | null;
  appName: string | null;
  clientAddr: string | null;
}

/** Something the tester marked during a step: a pause, a resume, or a flag ("this looks wrong") with a note. */
export interface Marker {
  kind: 'pause' | 'resume' | 'flag';
  note: string | null;
  at: Date;
}

export interface Step {
  seq: number;
  name: string;
  startedAt: Date;
  changes: Change[];
  /** Pauses, resumes and flags during this step, in time order. */
  markers?: Marker[];
  /** Named by Propmaster from its changes (auto steps), not typed by the tester. */
  auto?: boolean;
  /**
   * Auto-step sessions only: where a new name for this step is kept. A step named by the tester lives in
   * its own row (`seq` of that row); a step worked out from the changes is renamed by its first change.
   */
  renameKey?: { seq: number } | { firstChangeId: number };
}

export interface Column {
  name: string;
  type: string;
}

export interface Recording {
  /** "12" for a trigger session, "s3" for a snapshot session. */
  id: string;
  mode: Mode;
  name: string;
  /** host:port/database, without credentials. */
  database: string;
  startedAt: Date;
  stoppedAt: Date | null;
  startedBy: string;
  steps: Step[];
  /** Columns of every table that appears in the changes, keyed by "schema.table", in table order. */
  columns: Record<string, Column[]>;
  /** Things the reader should know, such as tables skipped in snapshot mode. */
  notes: string[];
  /** Auto steps: the quiet gap (ms) that ends a step. Absent when steps were typed. */
  autoSplitMs?: number;
}

export interface SessionSummary {
  id: string;
  mode: Mode;
  name: string;
  startedAt: Date;
  stoppedAt: Date | null;
  changeCount: number;
}

export function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export function allChanges(rec: Recording): Change[] {
  return rec.steps.flatMap((s) => s.changes);
}

/** Puts each row's columns back in table order (jsonb sorts keys by length). Unknown keys go last. */
export function orderColumns(rec: Recording): Recording {
  const reorder = (row: Row | null, columns: Column[]): Row | null => {
    if (!row) return row;
    const ordered: Row = {};
    for (const { name } of columns) if (name in row) ordered[name] = row[name];
    for (const [name, value] of Object.entries(row)) if (!(name in ordered)) ordered[name] = value;
    return ordered;
  };

  return {
    ...rec,
    steps: rec.steps.map((step) => ({
      ...step,
      changes: step.changes.map((c) => {
        const columns = rec.columns[tableKey(c.tableSchema, c.tableName)] ?? [];
        return {
          ...c,
          rowKey: reorder(c.rowKey, columns),
          oldValues: reorder(c.oldValues, columns),
          newValues: reorder(c.newValues, columns),
        };
      }),
    })),
  };
}
