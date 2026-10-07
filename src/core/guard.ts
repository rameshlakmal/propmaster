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

/** Refuses connection strings whose host or database name contains the word "prod". */
export function assertNotProduction(databaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UserError('The database URL is not valid.', 'Expected postgres://user:password@host:port/database');
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (PROD_PATTERN.test(url.hostname)) throw new ProductionGuardError(`host "${url.hostname}"`);
  if (PROD_PATTERN.test(database)) throw new ProductionGuardError(`database "${database}"`);
}
