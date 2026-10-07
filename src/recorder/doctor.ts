import type { Db } from '../core/db.js';
import { quoteIdent } from './export/sql.js';
import * as trigger from './trigger.js';

export const MIN_SERVER_VERSION = 130000;

export type Level = 'ok' | 'warn' | 'fail';

export interface Finding {
  level: Level;
  text: string;
}

export interface DoctorReport {
  findings: Finding[];
  /** The mode to use, or null when neither works. */
  recommended: 'trigger' | 'snapshot' | null;
  /** GRANT statements to ask a DBA for, to unlock trigger mode. */
  grants: string[];
}

interface Facts {
  version: string;
  versionNum: number;
  user: string;
  database: string;
  superuser: boolean;
  canCreateSchema: boolean;
}

interface SchemaAccess {
  schema: string;
  tables: number;
  withTrigger: number;
  withSelect: number;
}

export async function diagnose(db: Db): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const grants: string[] = [];

  const { rows: [f] } = await db.query<Facts>(`
    SELECT current_setting('server_version') AS version,
           current_setting('server_version_num')::int AS "versionNum",
           session_user AS user, current_database() AS database,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
           has_database_privilege(current_database(), 'CREATE') AS "canCreateSchema"`);
  const facts = f!;

  findings.push({ level: 'ok', text: `Connected to ${facts.database} as ${facts.user}${facts.superuser ? ' (superuser)' : ''}.` });
  if (facts.versionNum < MIN_SERVER_VERSION) {
    findings.push({ level: 'fail', text: `PostgreSQL ${facts.version} is too old. Propmaster needs 13 or newer.` });
    return { findings, recommended: null, grants };
  }
  findings.push({ level: 'ok', text: `PostgreSQL ${facts.version}.` });

  const { rows: schemas } = await db.query<SchemaAccess>(`
    SELECT n.nspname AS schema, count(*)::int AS tables,
           count(*) FILTER (WHERE has_table_privilege(c.oid, 'TRIGGER'))::int AS "withTrigger",
           count(*) FILTER (WHERE has_table_privilege(c.oid, 'SELECT'))::int AS "withSelect"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND n.nspname NOT IN ('information_schema', '_propmaster') AND n.nspname NOT LIKE 'pg\\_%'
     GROUP BY n.nspname
     ORDER BY n.nspname`);

  const total = schemas.reduce((n, s) => n + s.tables, 0);
  const withTrigger = schemas.reduce((n, s) => n + s.withTrigger, 0);
  const withSelect = schemas.reduce((n, s) => n + s.withSelect, 0);

  if (total === 0) {
    findings.push({ level: 'fail', text: 'No tables found in this database.' });
    return { findings, recommended: null, grants };
  }

  const status = await trigger.status(db);
  if (status.installed) {
    findings.push({ level: 'ok', text: `The recorder is installed and watching ${status.watchedTables} of ${total} tables.` });
    if (status.excludedTables.length) findings.push({ level: 'ok', text: `Excluded on purpose: ${status.excludedTables.join(', ')}.` });
    if (status.active) findings.push({ level: 'warn', text: `Session #${status.active.id} "${status.active.name}" is recording right now.` });
  } else {
    findings.push({ level: facts.canCreateSchema ? 'ok' : 'fail', text: facts.canCreateSchema
      ? 'You can create the _propmaster schema.'
      : 'You cannot create schemas in this database, so the recorder cannot be installed.' });
    if (!facts.canCreateSchema) grants.push(`GRANT CREATE ON DATABASE ${quoteIdent(facts.database)} TO ${quoteIdent(facts.user)};`);
  }

  const triggerLevel: Level = withTrigger === total ? 'ok' : withTrigger === 0 ? 'fail' : 'warn';
  findings.push({ level: triggerLevel, text: `You can add triggers to ${withTrigger} of ${total} tables (trigger mode).` });
  for (const s of schemas) {
    if (s.withTrigger < s.tables) grants.push(`GRANT TRIGGER ON ALL TABLES IN SCHEMA ${quoteIdent(s.schema)} TO ${quoteIdent(facts.user)};`);
  }

  findings.push({
    level: withSelect === total ? 'ok' : withSelect === 0 ? 'fail' : 'warn',
    text: `You can read ${withSelect} of ${total} tables (snapshot mode).`,
  });

  const triggerReady = withTrigger > 0 && (status.installed || facts.canCreateSchema);
  const recommended = triggerReady ? 'trigger' : withSelect > 0 ? 'snapshot' : null;
  return { findings, recommended, grants };
}
