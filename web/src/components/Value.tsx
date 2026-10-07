// One recorded value, shown for reading rather than as SQL: text without quotes, times in local form,
// NULL and empty text quietly, numbers in tabular figures. The exact value is always in the tooltip.
import type { ValueKind } from '../types';

const DEFAULT_MAX = 60;

function unquote(sql: string): string {
  return sql.length >= 2 && sql.startsWith("'") && sql.endsWith("'") ? sql.slice(1, -1) : sql;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A timestamp from the database, as "7 Oct 2026, 20:55:00"; null when it can't be read as a date. */
function readableTime(raw: string, withTime: boolean): string | null {
  // A timestamp without a time zone is a local time; one with an offset is shown in this computer's time.
  const date = new Date(withTime ? raw.replace(' ', 'T') : `${raw}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * `sql` is the value as the server wrote it ('text', 84.50, NULL). `exact` shows it in full and unchanged
 * (for the expanded row), apart from dropping the quotes around text.
 */
export function Value({ sql, kind, max = DEFAULT_MAX, exact = false }: { sql: string | null; kind: ValueKind | null; max?: number; exact?: boolean }) {
  if (sql === null || kind === null) return null;
  const limit = exact ? Infinity : max;

  switch (kind) {
    case 'null':
      return <span className="v-null">null</span>;
    case 'number':
      return <span className="v-number">{sql}</span>;
    case 'boolean':
      return <span className={`v-bool v-bool-${sql}`}>{sql}</span>;
    case 'timestamp':
    case 'date': {
      const raw = unquote(sql);
      const nice = exact ? null : readableTime(raw, kind === 'timestamp');
      return <span className="v-time" title={raw}>{nice ?? raw}</span>;
    }
    case 'json':
      return <span className="v-json" title={sql.length > limit ? sql : undefined}>{shorten(sql, limit)}</span>;
    case 'text': {
      const text = unquote(sql);
      if (text === '') return <span className="v-null">empty</span>;
      return <span className="v-text" title={text.length > limit ? text : undefined}>{shorten(text, limit)}</span>;
    }
  }
}

/** Plain text of a value, for searching. */
export function valueText(sql: string | null): string {
  return sql === null ? '' : unquote(sql);
}
