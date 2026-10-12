import { UserError } from './errors.js';

/** Thrown when a connection looks like it points at production. */
export class ProductionGuardError extends UserError {
  constructor(what: string) {
    super(`Refusing to connect: ${what} looks like production. Propmaster only runs against test databases.`);
    this.name = 'ProductionGuardError';
  }
}

// "prod" or "production" as a separate word (app_prod, prod-db), so names like "products" still pass.
const PROD_PATTERN = /(^|[^a-z0-9])prod(uction)?($|[^a-z0-9])/i;

export interface Target {
  host: string;
  port: string;
  database: string;
}

/**
 * Where a connection string really connects, read the way the pg driver reads it: a `?host=` or `?port=`
 * in the query wins over the address, and a missing host or database falls back to PGHOST / PGDATABASE.
 * Checking only the address would let `postgres://u@localhost/test?host=prod-db` through.
 */
export function connectionTarget(databaseUrl: string): Target {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UserError('The database URL is not valid.', 'Expected postgres://user:password@host:port/database');
  }
  const host = url.searchParams.get('host') || decodeURIComponent(url.hostname.replace(/^\[(.+)\]$/, '$1')) || process.env.PGHOST || 'localhost';
  const port = url.searchParams.get('port') || url.port || process.env.PGPORT || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || process.env.PGDATABASE || decodeURIComponent(url.username) || process.env.PGUSER || '';
  return { host, port, database };
}

/** Refuses connection strings whose host or database name contains the word "prod". */
export function assertNotProduction(databaseUrl: string): void {
  const { host, database } = connectionTarget(databaseUrl);
  if (PROD_PATTERN.test(host)) throw new ProductionGuardError(`host "${host}"`);
  if (PROD_PATTERN.test(database)) throw new ProductionGuardError(`database "${database}"`);
}
