import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import * as claims from '../src/finder/claims.js';
import { checkRecipes, claimFound, find } from '../src/finder/find.js';
import { loadRecipes, parseRecipes, pickRecipe, type Recipe } from '../src/finder/recipes.js';
import * as trigger from '../src/recorder/trigger.js';
import { connectTest, ensureRole, resetDatabase, urlAs } from './helpers.js';

let db: Db;
let shop: Recipe[];

const recipe = (text: string) => parseRecipes(`-- recipe: Test\n${text}`, 'test.sql')[0]!;
const ids = (r: Awaited<ReturnType<typeof find>>) => r.rows.map((row) => row.values.id ?? row.values.customer_id ?? row.values.order_id);
const as = (by: string) => ({ by, seconds: 3600 });

beforeAll(async () => {
  db = await connectTest();
  shop = await loadRecipes('demo/recipes');
  await ensureRole(db, 'propmaster_reader');
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetDatabase(db);
  // Alice (1) has two orders, Bob (2) one, Cara (3) none.
  await db.query('SELECT place_order(1, 1, 1), place_order(1, 2, 1), place_order(2, 3, 1)');
});

describe('find', () => {
  it('runs a recipe and returns its rows in its own order, with the claim key', async () => {
    const r = await find(db, pickRecipe(shop, 'never ordered'));
    expect(r.columns).toEqual(['id', 'email', 'name']);
    expect(r.rows).toEqual([{ values: { id: 3, email: 'cara@example.com', name: 'Cara Bugfinder' }, key: '3', claimedBy: null }]);
    expect(r).toMatchObject({ matches: 1, claimed: 0, claim: { table: 'public.customers', keyColumn: 'id', column: 'id' } });
  });

  it('uses parameters as bind values, with defaults', async () => {
    const several = pickRecipe(shop, 'several orders');
    expect(ids(await find(db, several))).toEqual([1]);
    expect(ids(await find(db, several, { params: { min_orders: '1' } }))).toEqual([1, 2]);
    // A value that looks like SQL stays a value.
    const status = pickRecipe(shop, 'given status');
    expect((await find(db, status, { params: { status: "PENDING' OR '1'='1" } })).matches).toBe(0);
    expect((await find(db, status)).matches).toBe(3);
  });

  it('shows dates and numbers as Postgres prints them', async () => {
    const r = await find(db, recipe("SELECT 84.50::numeric(10,2) AS total, date '2024-01-31' AS day, '{\"a\": 1.10}'::jsonb AS doc"));
    expect(r.rows[0]!.values).toMatchObject({ total: '84.50', day: '2024-01-31' });
    expect(JSON.stringify(r.rows[0]!.values.doc)).toBe('{"a":1.10}');
  });

  it('limits the rows but counts every match', async () => {
    const r = await find(db, pickRecipe(shop, 'price range'), { limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.matches).toBe(4);
  });

  it('refuses recipes that change data', async () => {
    await expect(find(db, recipe("SELECT place_order(3, 1, 1) AS id"))).rejects.toThrow('"Test" (test.sql, line 1) tried to change data. Recipes may only read.');
    await expect(find(db, recipe("SELECT nextval('orders_id_seq') AS id"))).rejects.toThrow('tried to change data');
    await expect(find(db, recipe('SELECT 1; DELETE FROM orders'))).rejects.toThrow(/failed: (cannot insert multiple commands|syntax error)/);
    expect((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(3);
  });

  it('stops a slow recipe at the time limit', async () => {
    await expect(find(db, recipe('SELECT 1 AS id FROM pg_sleep(2)'), { timeout: '200ms' })).rejects.toThrow('"Test" (test.sql, line 1) took longer than 200ms, so it was stopped.');
  });

  it('explains a claim that cannot work', async () => {
    await expect(find(db, recipe('-- claim: customers\nSELECT email FROM customers'))).rejects.toThrow('claims customers rows, so its result needs the column "id". It has: email.');
    await expect(find(db, recipe('-- claim: customerz\nSELECT 1 AS id'))).rejects.toThrow('claims customerz rows, but there is no table "customerz".');
    await db.query('CREATE TABLE no_key (n int)');
    await expect(find(db, recipe('-- claim: no_key\nSELECT n FROM no_key'))).rejects.toThrow('"no_key" has no primary key');
  });

  it('works for a user who may only read', async () => {
    await db.query('GRANT USAGE ON SCHEMA public TO propmaster_reader');
    await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO propmaster_reader');
    await db.query('REVOKE CREATE ON DATABASE propmaster_test FROM PUBLIC');
    const reader = await connectTest(urlAs('propmaster_reader'));
    try {
      const r = await find(reader, pickRecipe(shop, 'never ordered'));
      expect(ids(r)).toEqual([3]);
      await expect(claimFound(reader, r, as('reader'))).rejects.toThrow("Your DB user may not create the _propmaster schema, so claims can't be stored.");
    } finally {
      await reader.end();
    }
  });
});

describe('claims', () => {
  it('claims the first free row, and others then get the next one', async () => {
    const lowStock = pickRecipe(shop, 'low on stock');
    const params = { max_stock: '50' };
    const first = await find(db, lowStock, { params });
    expect(ids(first)).toEqual([3, 2, 1]);

    const [mine] = await claimFound(db, first, { ...as('ana'), note: 'checkout test' });
    expect(mine).toMatchObject({ table: 'public.products', key: '3', claimedBy: 'ana', recipe: 'Product low on stock', note: 'checkout test', expired: false });

    // Claimed rows come last, marked with who holds them.
    const second = await find(db, lowStock, { params });
    expect(ids(second)).toEqual([2, 1, 3]);
    expect(second.claimed).toBe(1);
    expect(second.rows[2]!.claimedBy).toMatchObject({ claimedBy: 'ana' });
    const [theirs] = await claimFound(db, second, as('ben'));
    expect(theirs!.key).toBe('2');

    expect((await claims.list(db)).map((c) => [c.key, c.claimedBy])).toEqual([['2', 'ben'], ['3', 'ana']]);
    expect((await claims.list(db, { by: 'ana' })).map((c) => c.key)).toEqual(['3']);
  });

  it('claims several at once, and says when nothing is left', async () => {
    const r = await find(db, pickRecipe(shop, 'price range'));
    expect((await claimFound(db, r, { ...as('ana'), count: 3 })).map((c) => c.key)).toEqual(['4', '1', '2']);
    const again = await find(db, pickRecipe(shop, 'price range'));
    await claimFound(db, again, as('ben'));
    await expect(claimFound(db, await find(db, pickRecipe(shop, 'price range')), as('cy'))).rejects.toThrow('Nothing to claim: all 4 matching rows are claimed by others.');
    const none = await find(db, pickRecipe(shop, 'price range'), { params: { min_price: '500' } });
    await expect(claimFound(db, none, as('cy'))).rejects.toThrow('Nothing to claim: the recipe found no rows.');
    await expect(claimFound(db, await find(db, recipe('SELECT 1 AS id')), as('cy'))).rejects.toThrow('has no "-- claim: <table>" line');
  });

  it('never gives the same row to two testers claiming at the same moment', async () => {
    const testers = await Promise.all(['a', 'b', 'c', 'd'].map(() => connectTest()));
    try {
      const r = await find(db, pickRecipe(shop, 'price range'));
      const got = await Promise.all(testers.map((t, n) => claimFound(t, r, as(`tester${n}`)).then((c) => c[0]!.key)));
      expect(new Set(got).size).toBe(4);
    } finally {
      await Promise.all(testers.map((t) => t.end()));
    }
  });

  it('lets an expired claim be taken over, and lists it only with includeExpired', async () => {
    const r = await find(db, pickRecipe(shop, 'never ordered'));
    const [old] = await claimFound(db, r, as('ana'));
    await db.query("UPDATE _propmaster.claims SET claimed_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'");
    expect(await claims.list(db)).toEqual([]);
    expect((await claims.list(db, { includeExpired: true }))[0]).toMatchObject({ id: old!.id, expired: true });

    const fresh = await find(db, pickRecipe(shop, 'never ordered'));
    expect(fresh.rows[0]!.claimedBy).toBeNull();
    const [taken] = await claimFound(db, fresh, as('ben'));
    expect(taken).toMatchObject({ id: old!.id, key: '3', claimedBy: 'ben', expired: false });
  });

  it('adds, extends and releases claims by hand', async () => {
    const added = await claims.claimByKey(db, 'orders', '2', { by: 'ana', seconds: 60 });
    await expect(claims.claimByKey(db, 'orders', '2', { by: 'ben', seconds: 60 })).rejects.toThrow(`orders 2 is already claimed by ana (claim #${added.id}).`);
    await expect(claims.claimByKey(db, 'orders', '99', { by: 'ben', seconds: 60 })).rejects.toThrow('orders has no row with id = 99.');

    const extended = await claims.extend(db, added.id, 86400);
    expect(new Date(extended.expiresAt).getTime() - Date.now()).toBeGreaterThan(86000 * 1000);

    await claims.claimByKey(db, 'customers', '1', { by: 'ana', seconds: 60 });
    await claims.claimByKey(db, 'customers', '2', { by: 'ben', seconds: 60 });
    expect((await claims.release(db, [`#${added.id}`])).map((c) => c.key)).toEqual(['2']);
    await expect(claims.release(db, ['999'])).rejects.toThrow('There is no claim #999.');
    expect(await claims.releaseAllBy(db, 'ana')).toBe(1);
    expect((await claims.list(db)).map((c) => c.claimedBy)).toEqual(['ben']);

    await db.query("UPDATE _propmaster.claims SET claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'");
    expect(await claims.clearExpired(db)).toBe(1);
  });

  it('keeps claims and the recorder apart: claims alone are not an installed recorder', async () => {
    await claims.claimByKey(db, 'customers', '3', { by: 'ana', seconds: 60 });
    expect(await trigger.isInstalled(db)).toBe(false);
    await trigger.install(db);
    expect(await trigger.isInstalled(db)).toBe(true);
    expect((await claims.list(db))).toHaveLength(1); // installing the recorder keeps claims
    await trigger.uninstall(db);
    expect(await claims.claimsExist(db)).toBe(false);
  });
});

describe('checkRecipes', () => {
  it('reports working, empty and broken recipes, and only plans ones that need a value', async () => {
    const results = await checkRecipes(db, [
      ...shop.slice(0, 2),
      ...parseRecipes([
        '-- recipe: Refunded order', "SELECT id FROM orders WHERE status = 'REFUNDED'",
        '-- recipe: Old table', 'SELECT id FROM orderz',
        '-- recipe: Lost key', '-- claim: orders', 'SELECT total FROM orders',
        '-- recipe: By email', '-- param: email text', 'SELECT id FROM customers WHERE email = :email',
        '-- recipe: Broken with a parameter', '-- param: email text', 'SELECT idd FROM customers WHERE email = :email',
      ].join('\n'), 'ci.sql'),
    ]);
    expect(results.map((r) => [r.recipe.name, r.status, r.how, r.matches])).toEqual([
      ['Customer who has never ordered', 'ok', 'run', 1],
      ['Customer with several orders', 'ok', 'run', 1],
      ['Refunded order', 'empty', 'run', 0],
      ['Old table', 'error', 'run', null],
      ['Lost key', 'error', 'run', null],
      ['By email', 'ok', 'explain', null],
      ['Broken with a parameter', 'error', 'explain', null],
    ]);
    expect(results[3]!.error).toBe('relation "orderz" does not exist.');
    expect(results[4]!.error).toContain('needs the column "id". It has: total.');
    expect(results[6]!.error).toMatch(/column "idd" does not exist/);
  });
});
