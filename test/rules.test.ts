import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { touchedRows } from '../src/recorder/export/sql.js';
import { expandTable, hasAlias, macroTables, parseRules, type RuleResult } from '../src/recorder/rules.js';
import { formatRuleResults, tally } from '../src/recorder/rules-report.js';
import { change, recording, step } from './fixtures.js';

const colors = pc.createColors(false);

describe('parseRules', () => {
  it('splits a file into named rules, keeping comments and dropping the final semicolon', () => {
    const rules = parseRules([
      '-- File header comments are fine.',
      '',
      '-- rule: Payment matches total',
      'SELECT 1 -- inline comment',
      '  FROM {{payments}};',
      '',
      '-- RULE:   Stock is never negative  ',
      'SELECT product_id FROM {{inventory}} WHERE stock < 0',
    ].join('\n'));
    expect(rules).toEqual([
      { name: 'Payment matches total', sql: 'SELECT 1 -- inline comment\n  FROM {{payments}}', line: 3 },
      { name: 'Stock is never negative', sql: 'SELECT product_id FROM {{inventory}} WHERE stock < 0', line: 7 },
    ]);
  });

  it('explains files it cannot use', () => {
    expect(() => parseRules('SELECT 1', 'r.sql')).toThrow('r.sql, line 1: SQL before the first "-- rule: <name>" line.');
    expect(() => parseRules('-- just a comment', 'r.sql')).toThrow('r.sql has no rules.');
    expect(() => parseRules('-- rule: Empty\n-- only a comment\n', 'r.sql')).toThrow('Rule "Empty" (r.sql, line 1) has no query.');
  });

  it('reads the demo rules', async () => {
    const { readFile } = await import('node:fs/promises');
    const rules = parseRules(await readFile('demo/rules.sql', 'utf8'));
    expect(rules.map((r) => r.name)).toEqual([
      "Order total is the items' price, with 10% off for 2 or more items",
      'Payment amount matches the order total',
      'Every order in the session has exactly one payment',
      "Items are charged at the product's current price",
    ]);
  });
});

describe('{{table}} macros', () => {
  it('finds the tables a rule refers to', () => {
    expect(macroTables('SELECT * FROM {{orders}} o JOIN {{ billing.invoices }} i ON true JOIN {{orders}} x ON true'))
      .toEqual(['orders', 'billing.invoices']);
    expect(macroTables('SELECT \'{"a":1}\'::jsonb')).toEqual([]);
  });

  it('knows whether the rule gave the table its own alias', () => {
    expect(hasAlias(' o JOIN x')).toBe(true);
    expect(hasAlias(' AS o')).toBe(true);
    expect(hasAlias(' "My Alias" WHERE')).toBe(true);
    expect(hasAlias(' WHERE amount < 0')).toBe(false);
    expect(hasAlias('\n  LEFT JOIN payments p')).toBe(false);
    expect(hasAlias(', orders')).toBe(false);
    expect(hasAlias('')).toBe(false);
  });

  it('expands to the touched rows, nothing, or the whole table', () => {
    const touched = { schema: 'public', table: 'orders', matches: [{ id: 1 }, { id: "it's" }] };
    expect(expandTable('public', 'orders', touched, false))
      .toBe(`(SELECT t.* FROM "public"."orders" t WHERE to_jsonb(t.*) @> ANY (ARRAY['{"id":1}', '{"id":"it''s"}']::jsonb[]))`);
    expect(expandTable('public', 'orders', undefined, false)).toBe('(SELECT t.* FROM "public"."orders" t WHERE false)');
    expect(expandTable('billing', 'Order Lines', touched, true)).toBe('"billing"."Order Lines"');
  });

  it('scopes to rows that still exist at the end of the session, by their final key', () => {
    const rec = recording([step(1, 'x', [
      change({ rowKey: { id: 1 }, newValues: { id: 1, status: 'PENDING' } }),
      change({ op: 'UPDATE', rowKey: { id: 2 }, oldValues: { status: 'PAID' }, newValues: { status: 'SHIPPED' } }),
      change({ op: 'UPDATE', rowKey: { id: 1 }, oldValues: { id: 1 }, newValues: { id: 10 } }),
      change({ op: 'DELETE', rowKey: { id: 3 }, oldValues: { id: 3 } }),
      change({ tableName: 'views', rowKey: null, newValues: { path: '/cart' } }),
    ])]);
    const touched = touchedRows(rec);
    expect(touched.get('public.orders')!.matches).toEqual([{ id: 2 }, { id: 10 }]);
    expect(touched.get('public.views')!.matches).toEqual([{ path: '/cart' }]);
  });
});

describe('rule report', () => {
  const rule = (name: string, line = 1) => ({ name, sql: 'SELECT 1', line });
  const results: RuleResult[] = [
    { rule: rule('Total follows the discount'), status: 'pass', scope: { 'public.orders': 2 }, violations: [], violationCount: 0 },
    {
      rule: rule('Payment matches the total'), status: 'fail', scope: { 'public.payments': 2 },
      violations: [{ order_id: 7, amount: '84.50', total: '76.05' }], violationCount: 3,
    },
    { rule: rule('Stock comes back on cancel'), status: 'skipped', scope: { 'public.inventory': 0 }, violations: [], violationCount: 0 },
    { rule: rule('Typo', 30), status: 'error', scope: {}, violations: [], violationCount: 0, error: 'column "amout" does not exist' },
  ];

  it('shows a table of rules, a table of the rows that break each failed rule, and a summary', () => {
    expect(formatRuleResults(results, { colors, width: 80 }).split('\n')).toEqual([
      ' ┌───┬─────────────────────────────┬───────────────────────────┬───────────────┐',
      ' │   │ Rule                        │ Checked                   │ Result        │',
      ' ├───┼─────────────────────────────┼───────────────────────────┼───────────────┤',
      ' │ ✔ │ Total follows the discount  │ 2 rows of orders          │ pass          │',
      ' │ ✖ │ Payment matches the total   │ 2 rows of payments        │ 3 violations  │',
      ' │ ⊘ │ Stock comes back on cancel  │ no inventory rows touched │ skipped       │',
      ' │ ! │ Typo                        │                           │ could not run │',
      ' └───┴─────────────────────────────┴───────────────────────────┴───────────────┘',
      '',
      ' ✖ Payment matches the total · 3 violations',
      ' ┌──────────┬────────┬───────┐',
      ' │ order_id │ amount │ total │',
      ' ├──────────┼────────┼───────┤',
      ' │ 7        │ 84.50  │ 76.05 │',
      ' └──────────┴────────┴───────┘',
      '   …and 2 more',
      '',
      ' ! Typo · could not run (line 30): column "amout" does not exist',
      '',
      ` ${'─'.repeat(78)}`,
      ' 1 passed · 1 failed · 1 skipped · 1 could not run',
    ]);
    expect(tally(results)).toEqual({ pass: 1, fail: 1, skipped: 1, error: 1 });
  });
});
