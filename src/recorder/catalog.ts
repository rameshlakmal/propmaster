import type { Db } from '../core/db.js';
import { tableKey, type Column } from './types.js';

/** Columns (name and SQL type, in table order) for the given "schema.table" keys. Dropped tables are left out. */
export async function loadColumns(db: Db, tables: string[]): Promise<Record<string, Column[]>> {
  if (tables.length === 0) return {};

  const { rows } = await db.query<{ tableSchema: string; tableName: string; columns: Column[] }>(`
    SELECT n.nspname AS "tableSchema", c.relname AS "tableName",
           json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
                    ORDER BY a.attnum) AS columns
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE format('%s.%s', n.nspname, c.relname) = ANY ($1)
     GROUP BY n.nspname, c.relname`, [tables]);

  return Object.fromEntries(rows.map((r) => [tableKey(r.tableSchema, r.tableName), r.columns]));
}
