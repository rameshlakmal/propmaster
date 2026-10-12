import { describe, expect, it } from 'vitest';
import { assertNotProduction, connectionTarget, ProductionGuardError } from '../src/core/guard.js';

describe('assertNotProduction', () => {
  it.each([
    'postgres://u:p@localhost:5433/qa_shop',
    'postgres://u:p@test-db.internal/app_staging',
    'postgres://u:p@127.0.0.1/products', // "products" must not trip the guard
    'postgres://u:p@reproduce-db/app',
  ])('allows %s', (url) => {
    expect(() => assertNotProduction(url)).not.toThrow();
  });

  it.each([
    'postgres://u:p@prod-db.company.com/app',
    'postgres://u:p@db.PRODUCTION.internal/app',
    'postgres://u:p@localhost/app_prod',
    'postgres://u:p@localhost/app%5Fprod',
    'postgres://u:p@prod/app',
    // The driver connects to ?host= / ?port= rather than the address, so the guard must look there too.
    'postgres://u:p@localhost/test?host=prod-db.corp',
    'postgres://u:p@localhost/test?host=%2Fvar%2Frun%2Fprod',
  ])('refuses %s', (url) => {
    expect(() => assertNotProduction(url)).toThrow(ProductionGuardError);
  });

  it('checks the PGHOST and PGDATABASE fallbacks when the URL leaves them out', () => {
    const saved = { host: process.env.PGHOST, db: process.env.PGDATABASE };
    try {
      process.env.PGHOST = 'prod-db';
      expect(() => assertNotProduction('postgres:///test')).toThrow(ProductionGuardError);
      delete process.env.PGHOST;
      process.env.PGDATABASE = 'shop_prod';
      expect(() => assertNotProduction('postgres://u@localhost')).toThrow(ProductionGuardError);
      expect(connectionTarget('postgres://u@localhost:5433/qa?port=6000')).toEqual({ host: 'localhost', port: '6000', database: 'qa' });
    } finally {
      if (saved.host === undefined) delete process.env.PGHOST; else process.env.PGHOST = saved.host;
      if (saved.db === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved.db;
    }
  });

  it('explains a malformed URL', () => {
    expect(() => assertNotProduction('not a url')).toThrow(/not valid/);
  });
});
