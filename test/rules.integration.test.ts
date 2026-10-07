import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import { checkRules, parseRules, type RuleResult } from '../src/recorder/rules.js';
import * as trigger from '../src/recorder/trigger.js';
import type { Recording } from '../src/recorder/types.js';
import { connectTest, resetDatabase } from './helpers.js';

let db: Db;
let demoRules: ReturnType<typeof parseRules>;

const summary = (results: RuleResult[]) => results.map((r) => [r.rule.name, r.status, r.violationCount]);

/** Records one checkout of 2 items, like a tester clicking Place Order. */
async function recordCheckout(qty = 2): Promise<Recording> {
  await trigger.start(db, 'checkout');
  await trigger.step(db, 'Click Place Order');
  await db.query('SELECT place_order(1, 3, $1)', [qty]);
  await trigger.stop(db);
  return (await trigger.getRecording(db))!;
}

beforeAll(async () => {
  db = await connectTest();
  demoRules = parseRules(await readFile('demo/rules.sql', 'utf8'));
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetDatabase(db);
  await trigger.install(db);
});

describe('a requirement change, checked with rules', () => {
  it('flags the old build: it does not give the new discount', async () => {
    const results = await checkRules(db, await recordCheckout(), demoRules);
    expect(summary(results)).toEqual([
      ["Order total is the items' price, with 10% off for 2 or more items", 'fail', 1],
      ['Payment amount matches the order total', 'pass', 0],
      ['Every order in the session has exactly one payment', 'pass', 0],
      ["Items are charged at the product's current price", 'pass', 0],
    ]);
    expect(results[0]!.violations).toEqual([{ order_id: 1, total: '84.50', expected: '76.05' }]);
    expect(results[0]!.scope).toEqual({ 'public.orders': 1 });
  });

  it('catches the bug in build v2: the discount is applied but the payment is not', async () => {
    await db.query(await readFile('demo/build-v2.sql', 'utf8'));
    const results = await checkRules(db, await recordCheckout(), demoRules);
    expect(summary(results).map(([, status]) => status)).toEqual(['pass', 'fail', 'pass', 'pass']);
    expect(results[1]!.violations).toEqual([{ order_id: 1, amount: '84.50', total: '76.05' }]);
  });

  it('passes a correct build', async () => {
    await db.query(await readFile('demo/build-v2.sql', 'utf8'));
    await db.query(`
      CREATE OR REPLACE FUNCTION fix_payment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.amount := (SELECT total FROM orders WHERE id = NEW.order_id); RETURN NEW; END $$;
      CREATE TRIGGER fix_payment BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION fix_payment()`);
    expect(summary(await checkRules(db, await recordCheckout(), demoRules)).map(([, s]) => s)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('checks only rows the session touched, unless asked for whole tables', async () => {
    await db.query('SELECT place_order(2, 1, 5)'); // an old, undiscounted order outside the session
    const rec = await recordCheckout(1);            // 1 item: no discount due, so this order is fine
    const rule = demoRules.slice(0, 1);
    expect((await checkRules(db, rec, rule))[0]).toMatchObject({ status: 'pass', scope: { 'public.orders': 1 } });
    expect((await checkRules(db, rec, rule, { allRows: true }))[0]).toMatchObject({ status: 'fail', violationCount: 1 });
    expect((await checkRules(db, null, rule, { allRows: true }))[0]).toMatchObject({ status: 'fail' });
  });

  it('skips a rule when the session touched none of its tables', async () => {
    await trigger.start(db, 'browse only');
    await db.query("UPDATE customers SET name = 'Alice' WHERE id = 1");
    await trigger.stop(db);
    const results = await checkRules(db, (await trigger.getRecording(db))!, demoRules);
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
  });
});

describe('rules are safe and fail clearly', () => {
  const rules = (text: string) => parseRules(text);
  let rec: Recording;

  beforeEach(async () => {
    rec = await recordCheckout();
  });

  it('cannot change data', async () => {
    const results = await checkRules(db, rec, rules([
      '-- rule: Writes through a function', 'SELECT place_order(1, 1, 1)',
      '-- rule: Writes in a CTE', 'WITH x AS (UPDATE orders SET total = 0 RETURNING id) SELECT * FROM x',
    ].join('\n')));
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['error', 'cannot execute UPDATE in a read-only transaction'],
      ['error', 'WITH clause containing a data-modifying statement must be at the top level'],
    ]);
    const { rows } = await db.query('SELECT count(*)::int AS orders, sum(total)::text AS total FROM orders');
    expect(rows).toEqual([{ orders: 1, total: '84.50' }]);
  });

  it('allows one statement per rule', async () => {
    const [r] = await checkRules(db, rec, rules('-- rule: Two\nSELECT 1; DELETE FROM orders'));
    expect(r!.status).toBe('error');
    expect(r!.error).toMatch(/multiple commands|syntax error/);
  });

  it('reports a broken rule and still runs the others', async () => {
    const results = await checkRules(db, rec, rules([
      '-- rule: Typo', 'SELECT amout FROM {{payments}}',
      '-- rule: Unknown table', 'SELECT * FROM {{paymnets}}',
      '-- rule: Fine', 'SELECT * FROM {{payments}} WHERE amount < 0',
    ].join('\n')));
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['error', 'column "amout" does not exist'],
      ['error', 'Unknown table {{paymnets}}.'],
      ['pass', undefined],
    ]);
  });

  it('stops a rule that runs too long', async () => {
    const [r] = await checkRules(db, rec, rules('-- rule: Slow\nSELECT pg_sleep(2) FROM {{orders}}'), { timeout: '200ms' });
    expect(r!.status).toBe('error');
    expect(r!.error).toMatch(/statement timeout/);
  });

  it('shows the first violating rows and counts them all', async () => {
    await trigger.start(db, 'many');
    for (let i = 0; i < 4; i++) await db.query('SELECT place_order(1, 1, 1)');
    await trigger.stop(db);
    const [r] = await checkRules(db, (await trigger.getRecording(db))!, rules('-- rule: No orders at all\nSELECT id FROM {{orders}} ORDER BY id'), { limit: 2 });
    expect(r).toMatchObject({ status: 'fail', violationCount: 4, violations: [{ id: 2 }, { id: 3 }] });
  });

  it('understands quoted names and other schemas', async () => {
    await db.query('CREATE SCHEMA billing; CREATE TABLE billing."Invoice Lines" (id int PRIMARY KEY, amount numeric)');
    await trigger.start(db, 's');
    await db.query(`INSERT INTO billing."Invoice Lines" VALUES (1, -5)`);
    await trigger.stop(db);
    const [r] = await checkRules(db, (await trigger.getRecording(db))!,
      rules('-- rule: No negative lines\nSELECT id, amount FROM {{billing."Invoice Lines"}} WHERE amount < 0'));
    expect(r).toMatchObject({ status: 'fail', scope: { 'billing.Invoice Lines': 1 }, violations: [{ id: 1, amount: '-5' }] });
  });
});
