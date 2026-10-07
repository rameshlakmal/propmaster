import pg from 'pg';
import { UserError } from './errors.js';
import { assertNotProduction } from './guard.js';
import { parseJsonExact } from './json.js';

export type Db = pg.Client;

const JSON_OID = 114;
const JSONB_OID = 3802;

/** Type parsers for this tool's connections: JSON values keep exact numbers. */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === JSON_OID || oid === JSONB_OID) return parseJsonExact;
    return pg.types.getTypeParser(oid, format);
  },
} as pg.CustomTypesConfig;

/** The connection string from --url, or the PROPMASTER_DATABASE_URL environment variable. */
export function resolveDatabaseUrl(cliUrl?: string): string {
  const url = cliUrl ?? process.env.PROPMASTER_DATABASE_URL;
  if (!url) {
    throw new UserError('No database given.', 'Pass --url or set PROPMASTER_DATABASE_URL (see .env.example).');
  }
  return url;
}

/** Opens a guarded connection. Attaching triggers waits at most 5 s for table locks. */
export async function connect(databaseUrl: string): Promise<Db> {
  assertNotProduction(databaseUrl);

  const db = new pg.Client({ connectionString: databaseUrl, application_name: 'propmaster', types });
  await db.connect();
  await db.query("SET lock_timeout = '5s'");
  return db;
}

/** Opens a guarded connection, runs fn, and always closes the connection. */
export async function withDb<T>(databaseUrl: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await connect(databaseUrl);
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** host:port/database, without credentials: safe to print and to store in local files. */
export function describeDatabase(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}
