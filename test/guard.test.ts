import { describe, expect, it } from 'vitest';
import { assertNotProduction, ProductionGuardError } from '../src/core/guard.js';

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
  ])('refuses %s', (url) => {
    expect(() => assertNotProduction(url)).toThrow(ProductionGuardError);
  });

  it('explains a malformed URL', () => {
    expect(() => assertNotProduction('not a url')).toThrow(/not valid/);
  });
});
