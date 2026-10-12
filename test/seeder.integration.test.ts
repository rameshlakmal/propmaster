import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeDatabase, type Db } from '../src/core/db.js';
import * as claims from '../src/finder/claims.js';
import * as sessions from '../src/recorder/sessions.js';
import * as trigger from '../src/recorder/trigger.js';
import { clean, listBackups, readBackup, type Action } from '../src/seeder/clean.js';
import * as runs from '../src/seeder/runs.js';
import { loadScenarios, parseScenario } from '../src/seeder/scenarios.js';
import { checkScenarios, seed } from '../src/seeder/seed.js';
import { connectTest, plain, resetDatabase, TEST_URL } from './helpers.js';

let db: Db;
let backups: string;
const identity = describeDatabase(TEST_URL);
const by = 'pat';
const opts = { by, identity };

beforeAll(async () => {
  db = await connectTest();
  backups = await mkdtemp(join(tmpdir(), 'propmaster-backups-'));
  process.env.PROPMASTER_BACKUPS = backups;
});

afterAll(async () => {
  await resetDatabase(db);
  await db.end();
  await rm(backups, { recursive: true, force: true });
  delete process.env.PROPMASTER_BACKUPS;
});

beforeEach(async () => {
  await resetDatabase(db);
});

const scenario = (yaml: string, file = 'test.yml') => parseScenario(yaml, file);
const count = async (table: string) => Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

/** A fingerprint of every public table's rows: equal fingerprints mean equal data. */
async function checksum(): Promise<string> {
  const { rows } = await db.query<{ t: string }>("SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
  const parts: string[] = [];
  for (const { t } of rows) parts.push(`${t}:${(await db.query(`SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0].h}`);
  return parts.join(' ');
}

const TWO_ORDERS = `
name: Two orders
seed:
  customers:
    name: Pat
    orders:
      - status: PAID
        total: 49.50
        order_items: 2
        payments: { amount: 49.50, method: CARD }
      - status: CANCELLED
        total: 12.50
        order_items: { product_id: 1, qty: 1, unit_price: 12.50 }
`;

describe('seed', () => {
  it('creates child rows linked to their parent, made-up parents for required links, and tracks every row', async () => {
    const r = await seed(db, scenario(TWO_ORDERS), { by });
    expect(r.runId).toMatch(/^\d+$/);
    expect(r.rows.map((x) => `${x.table.replace('public.', '')}${x.auto ? '*' : ''}`)).toEqual([
      'customers', 'orders', 'products*', 'order_items', 'products*', 'order_items', 'payments', 'orders', 'order_items',
    ]);
    const [customer, order] = r.rows;
    expect(plain(order!.values)).toMatchObject({ customer_id: customer!.key.id, status: 'PAID', total: 49.5 });
    expect(plain(r.rows[8]!.values)).toMatchObject({ order_id: r.rows[7]!.key.id, product_id: 1 });
    // A made-up email that passes NOT NULL and UNIQUE.
    expect(customer!.values.email).toMatch(/@example\.test$/);

    const tracked = await runs.trackedRows(db, r.runId!);
    expect(tracked.map((t) => t.table)).toEqual(r.rows.map((x) => x.table));
    expect((await runs.get(db, r.runId!)).tables).toEqual({ 'public.customers': 1, 'public.orders': 2, 'public.products': 2, 'public.order_items': 3, 'public.payments': 1 });
  });

  it('a dry run shows the rows and saves nothing', async () => {
    const before = await checksum();
    const r = await seed(db, scenario(TWO_ORDERS), { by, dryRun: true });
    expect(r.runId).toBeNull();
    expect(r.rows).toHaveLength(9);
    expect(await checksum()).toBe(before);
    expect(await runs.runsExist(db)).toBe(false);
  });

  it('fills placeholders, parameters and $count, and points at named rows with $ref', async () => {
    const s = scenario(`
params:
  stock: { type: int, default: 3 }
seed:
  customers:
    - { $as: buyer, name: "Buyer {{run}}" }
    - { name: "Shopper {{n}}", $count: 2 }
  products:
    $as: lamp
    sku: "LAMP-{{unique}}"
    name: Lamp
    price: 5
    inventory: { stock: "{{stock}}" }
  orders:
    customer_id: { $ref: buyer }
    total: 5
    order_items: { product_id: { $ref: lamp }, qty: 1, unit_price: 5 }
`);
    const r = await seed(db, s, { by, params: { stock: '7' } });
    const v = r.rows.map((x) => plain(x.values));
    expect(v[0]).toMatchObject({ name: `Buyer ${r.runId}` });
    expect([v[1]!.name, v[2]!.name]).toEqual(['Shopper 1', 'Shopper 2']);
    expect(v[3]!.sku).toMatch(/^LAMP-r\d+n\d+/);
    expect(v[4]).toMatchObject({ product_id: v[3]!.id, stock: 7 });
    expect(v[5]).toMatchObject({ customer_id: v[0]!.id });
    expect(v[6]).toMatchObject({ order_id: v[5]!.id, product_id: v[3]!.id });
    expect(r.rows[0]!.alias).toBe('buyer');
  });

  it('makes up values that pass checks, enums, lengths and unique constraints', async () => {
    await db.query(`
      CREATE TYPE mood AS ENUM ('calm', 'busy');
      CREATE TABLE gadgets (
        id        int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        code      varchar(8) NOT NULL UNIQUE,
        serial_no int NOT NULL UNIQUE,
        rating    int NOT NULL CHECK (rating BETWEEN 2 AND 5),
        mood      mood NOT NULL,
        price     numeric(4, 2) NOT NULL CHECK (price > 0),
        size      text NOT NULL CHECK (size IN ('S', 'M', 'L')),
        tags      text[] NOT NULL,
        meta      jsonb NOT NULL,
        made_on   date NOT NULL,
        double    int GENERATED ALWAYS AS (rating * 2) STORED,
        note      text
      );
      INSERT INTO gadgets (code, serial_no, rating, mood, price, size, tags, meta, made_on) VALUES ('A1', 41, 3, 'calm', 1, 'M', '{}', '{}', now());`);
    const r = await seed(db, scenario('seed:\n  gadgets: 4\n'), { by });
    const rows = r.rows.map((x) => plain(x.values));
    expect(rows.map((x) => x.serial_no)).toEqual([42, 43, 44, 45]);
    expect(new Set(rows.map((x) => x.code)).size).toBe(4);
    for (const x of rows) {
      expect(x).toMatchObject({ rating: 2, mood: 'calm', size: 'S', tags: [], meta: {}, double: 4, note: null });
      expect((x.code as string).length).toBeLessThanOrEqual(8);
    }
    // A value given for a GENERATED ALWAYS identity column is inserted with OVERRIDING SYSTEM VALUE.
    const own = await seed(db, scenario('seed:\n  gadgets:\n    id: 900\n    tags: [a, "b c"]\n'), { by });
    expect(plain(own.rows[0]!.values)).toMatchObject({ id: 900, tags: ['a', 'b c'] });
  });

  it('leaves a nullable self-reference empty instead of looping, and explains required cycles', async () => {
    await db.query('CREATE TABLE staff (id serial PRIMARY KEY, name text NOT NULL, manager_id int REFERENCES staff)');
    const r = await seed(db, scenario('seed:\n  staff:\n    $as: boss\n    staff: { name: Report }\n'), { by });
    expect(plain(r.rows.map((x) => x.values.manager_id))).toEqual([null, r.rows[0]!.key.id]);

    await db.query(`
      CREATE TABLE a (id serial PRIMARY KEY, b_id int NOT NULL);
      CREATE TABLE b (id serial PRIMARY KEY, a_id int NOT NULL REFERENCES a);
      ALTER TABLE a ADD FOREIGN KEY (b_id) REFERENCES b;`);
    await expect(seed(db, scenario('seed:\n  a: 1\n'), { by })).rejects.toThrow(/a cycle/);
  });

  it('asks which foreign key links a child when there are several, and follows $via', async () => {
    await db.query('CREATE TABLE gifts (id serial PRIMARY KEY, giver_id int NOT NULL REFERENCES customers, receiver_id int NOT NULL REFERENCES customers)');
    await expect(seed(db, scenario('seed:\n  customers:\n    gifts: 1\n'), { by })).rejects.toThrow(/2 foreign keys to customers \(giver_id or receiver_id\)/);
    const r = await seed(db, scenario('seed:\n  customers:\n    gifts:\n      $via: receiver_id\n      giver_id: 1\n'), { by });
    expect(plain(r.rows[1]!.values)).toMatchObject({ giver_id: 1, receiver_id: r.rows[0]!.key.id });
  });

  it('explains mistakes, and a failed seed leaves nothing behind', async () => {
    const before = await checksum();
    await expect(seed(db, scenario('seed:\n  customers:\n    emial: x@y.z\n'), { by })).rejects.toThrow(/customers has no column "emial".*\n?/);
    await expect(seed(db, scenario('seed:\n  customers:\n    emial: x@y.z\n'), { by })).rejects.toMatchObject({ hint: 'Did you mean "email"?' });
    await expect(seed(db, scenario('seed:\n  custmers: 1\n'), { by })).rejects.toMatchObject({ message: 'There is no table "custmers".', hint: 'Did you mean "customers"?' });
    await expect(seed(db, scenario('seed:\n  customers:\n    email: alice@example.com\n'), { by })).rejects.toThrow(/test\.yml, line 2: customers already has a row like this/);
    await expect(seed(db, scenario('seed:\n  inventory:\n    product_id: 999\n    stock: 1\n'), { by })).rejects.toThrow(/points at a row that doesn't exist/);
    await expect(seed(db, scenario('seed:\n  products:\n    price: -1\n'), { by })).rejects.toThrow(/breaks the check "products_price_check" on price/);
    await expect(seed(db, scenario('seed:\n  orders:\n    total: lots\n'), { by })).rejects.toThrow(/invalid input syntax for type numeric/);

    // The first customer is inserted, the second fails: neither stays, and no run is left.
    await expect(seed(db, scenario('seed:\n  customers:\n    - name: Ok\n    - email: bob@example.com\n'), { by })).rejects.toThrow(/already has a row like this/);
    await db.query('CREATE TABLE logs (msg text NOT NULL)');
    await expect(seed(db, scenario('seed:\n  logs: 1\n'), { by })).rejects.toThrow(/logs has no primary key/);
    await db.query('DROP TABLE logs');
    expect(await checksum()).toBe(before);
    expect(await runs.list(db, { includeCleaned: true })).toEqual([]);
  });
});

describe('clean a run', () => {
  it('previews without changing anything, then deletes exactly the run\'s rows', async () => {
    const before = await checksum();
    const r = await seed(db, scenario(TWO_ORDERS), { by });
    const seeded = await checksum();

    const preview = await clean(db, { kind: 'run', runIds: [r.runId!] }, opts);
    expect(preview.applied).toBe(false);
    expect(preview.plan.actions.map((a) => `${a.op} ${a.table.replace('public.', '')}`)).toEqual(
      r.rows.slice().reverse().map((x) => `delete ${x.table.replace('public.', '')}`));
    expect(await checksum()).toBe(seeded);

    const done = await clean(db, { kind: 'run', runIds: [r.runId!] }, { ...opts, apply: true });
    expect(done.applied).toBe(true);
    expect(await checksum()).toBe(before);
    expect((await runs.get(db, r.runId!)).cleanedBy).toBe(by);
    await expect(clean(db, { kind: 'run', runIds: [r.runId!] }, opts)).rejects.toThrow(`Run #${r.runId} was already cleaned (by pat).`);
    expect(await runs.list(db)).toEqual([]);
  });

  it('marks rows the test changed, skips rows already gone, and still cleans up', async () => {
    const before = await checksum();
    const r = await seed(db, scenario(TWO_ORDERS), { by });
    const paid = r.rows[1]!.key.id;
    const cancelledItem = r.rows[8]!.key.id;
    await db.query("UPDATE orders SET status = 'SHIPPED' WHERE id = $1", [paid]);
    await db.query('DELETE FROM order_items WHERE id = $1', [cancelledItem]);

    const { plan } = await clean(db, { kind: 'run', runIds: [r.runId!] }, opts);
    const changed = plan.actions.find((a) => a.table === 'public.orders' && a.key.id === paid) as Extract<Action, { why: 'seeded' }>;
    expect(plain(changed.changed)).toEqual([{ column: 'status', from: 'PAID', to: 'SHIPPED' }]);
    expect(plain(plan.skipped)).toEqual([{ table: 'public.order_items', key: { id: cancelledItem }, reason: 'gone', detail: 'already deleted' }]);

    await clean(db, { kind: 'run', runIds: [r.runId!] }, { ...opts, apply: true });
    expect(await checksum()).toBe(before);
  });

  it('leaves rows it didn\'t create alone, unless told to delete them, cascade children included', async () => {
    await db.query('CREATE TABLE notes (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers ON DELETE CASCADE, body text)');
    const before = await checksum();
    const r = await seed(db, scenario(TWO_ORDERS), { by });
    const customer = r.rows[0]!.key.id;
    // The app, during the test: a new order (with item and payment) and a note for the seeded customer.
    await db.query('SELECT place_order($1, 2, 1)', [customer]);
    await db.query("INSERT INTO notes (customer_id, body) VALUES ($1, 'VIP')", [customer]);

    const { plan } = await clean(db, { kind: 'run', runIds: [r.runId!] }, opts);
    const deps = plan.actions.filter((a) => a.why === 'dependent');
    expect(deps.map((d) => d.table.replace('public.', '')).sort()).toEqual(['notes', 'order_items', 'orders', 'payments']);
    expect(plan.actions.slice(0, deps.length)).toEqual(deps); // dependents go first, deepest first
    expect(deps.findIndex((d) => d.table === 'public.orders')).toBeGreaterThan(deps.findIndex((d) => d.table === 'public.order_items'));
    expect((deps.find((d) => d.table === 'public.notes') as { via: string }).via).toBe('notes.customer_id → customers (ON DELETE CASCADE)');

    await expect(clean(db, { kind: 'run', runIds: [r.runId!] }, { ...opts, apply: true })).rejects.toThrow(/4 other rows \(.*\) point at rows being deleted/);
    await clean(db, { kind: 'run', runIds: [r.runId!] }, { ...opts, apply: true, includeDependents: true });
    await db.query('UPDATE inventory SET stock = stock + 1 WHERE product_id = 2'); // the app's stock change isn't the run's
    expect(await checksum()).toBe(before);
  });

  it('won\'t delete rows another tester claimed without --force, and releases claims on deleted rows', async () => {
    const r = await seed(db, scenario('seed:\n  customers: 2\n'), { by });
    const [a, b] = r.rows.map((x) => String(x.key.id));
    await claims.claim(db, { table: 'public.customers', keys: [a!], by: 'sam', seconds: 600 });
    await claims.claim(db, { table: 'public.customers', keys: [b!], by, seconds: 600 });

    const { plan } = await clean(db, { kind: 'run', runIds: [r.runId!] }, opts);
    expect(plan.claimed.map((c) => [c.key.id, c.claim.claimedBy])).toEqual([[Number(a), 'sam']]);
    await expect(clean(db, { kind: 'run', runIds: [r.runId!] }, { ...opts, apply: true })).rejects.toThrow(/claimed by someone else \(customers \d+ by sam, claim #\d+\)/);
    const done = await clean(db, { kind: 'run', runIds: [r.runId!] }, { ...opts, apply: true, force: true });
    expect(done.releasedClaims).toBe(2);
    expect(await claims.list(db, { includeExpired: true })).toEqual([]);
  });

  it('writes a backup that puts everything back, and a restore can itself be undone', async () => {
    const r = await seed(db, scenario(TWO_ORDERS), { by });
    const seeded = await checksum();
    const done = await clean(db, { kind: 'run', runIds: [r.runId!] }, { ...opts, apply: true });
    const cleaned = await checksum();

    const backup = await readBackup(done.backup!);
    expect(backup).toMatchObject({ kind: 'propmaster-backup', title: `Run #${r.runId} · Two orders`, database: identity, by });
    expect(backup.changes).toHaveLength(9);
    expect((await listBackups())[0]).toMatchObject({ file: done.backup, title: backup.title, changes: 9 });

    const preview = await clean(db, { kind: 'restore', file: done.backup! }, opts);
    expect(preview.plan.actions.map((a) => a.op)).toEqual(Array(9).fill('insert'));
    const restored = await clean(db, { kind: 'restore', file: done.backup! }, { ...opts, apply: true });
    expect(await checksum()).toBe(seeded);

    // Restoring twice finds every row already there: nothing is overwritten.
    const twice = await clean(db, { kind: 'restore', file: done.backup! }, opts);
    expect(twice.plan.actions).toEqual([]);
    expect(twice.plan.skipped.map((s) => s.reason)).toEqual(Array(9).fill('conflict'));

    await clean(db, { kind: 'restore', file: restored.backup! }, { ...opts, apply: true });
    expect(await checksum()).toBe(cleaned);
    await expect(clean(db, { kind: 'restore', file: done.backup! }, { ...opts, identity: 'other:5432/db' })).rejects.toThrow(/This backup is from .*, not other:5432\/db/);
  });

  it('seeding then cleaning every demo scenario leaves the database as it was', async () => {
    const before = await checksum();
    const scenarios = await loadScenarios('demo/scenarios');
    const ids: string[] = [];
    for (const s of scenarios) ids.push((await seed(db, s, { by })).runId!);
    expect(await checksum()).not.toBe(before);
    await clean(db, { kind: 'run', runIds: ids }, { ...opts, apply: true });
    expect(await checksum()).toBe(before);
  });
});

describe('undo a recorded session', () => {
  beforeEach(async () => {
    await trigger.install(db);
  });

  it('deletes what the app inserted, sets back what it updated, and puts back what it deleted', async () => {
    await sessions.start(db, identity, 'Checkout');
    await db.query('SELECT place_order(1, 2, 3)');
    await db.query("UPDATE customers SET name = 'Al', email = 'al@example.com' WHERE id = 1");
    await db.query("UPDATE customers SET name = 'Alfie' WHERE id = 1");
    await db.query('DELETE FROM inventory WHERE product_id = 4');
    await sessions.step(db, identity, 'Empty a table');
    await db.query('TRUNCATE inventory CASCADE');
    await db.query("INSERT INTO inventory VALUES (1, 40), (2, 12), (3, 6)");
    const rec = await sessions.stop(db, identity);

    const { plan } = await clean(db, { kind: 'session', recording: rec }, opts);
    expect(plan.actions.map((a) => `${a.op} ${a.table.replace('public.', '')}`)).toEqual([
      'delete inventory', 'delete inventory', 'delete inventory', // the rows inserted after the TRUNCATE
      'insert inventory', 'update customers', 'update customers', 'delete payments', 'delete order_items', 'delete orders',
    ]);
    const customer = plan.actions.filter((a) => a.op === 'update');
    expect(plain(customer.map((a) => a.op === 'update' && a.set))).toEqual([{ name: 'Al' }, { name: 'Alice Tester', email: 'alice@example.com' }]);
    // The TRUNCATE can't be undone, and it broke the history of the stock row place_order() updated.
    expect(plan.skipped.map((s) => [s.reason, s.key])).toEqual([['truncate', null], ['conflict', { product_id: 2 }]]);
  });

  it('puts the database back, leaving rows someone changed after the session alone', async () => {
    const before = await checksum();
    await sessions.start(db, identity, 'Checkout');
    await db.query('SELECT place_order(1, 2, 3)');
    await db.query("UPDATE customers SET name = 'Al' WHERE id = 1");
    await db.query("UPDATE products SET price = 30 WHERE id = 2");
    await db.query('DELETE FROM inventory WHERE product_id = 4');
    const rec = await sessions.stop(db, identity);
    await expect(clean(db, { kind: 'session', recording: { ...rec, stoppedAt: null } }, opts)).rejects.toThrow(/is still recording/);

    await db.query("UPDATE products SET price = 31 WHERE id = 2"); // someone else, after the session
    const { plan } = await clean(db, { kind: 'session', recording: rec }, opts);
    expect(plain(plan.skipped)).toEqual([{ table: 'public.products', key: { id: 2 }, reason: 'conflict', detail: 'changed again since: price 30.00 → 31.00' }]);

    await clean(db, { kind: 'session', recording: rec }, { ...opts, apply: true });
    await db.query('UPDATE products SET price = 24.00 WHERE id = 2');
    expect(await checksum()).toBe(before);
  });

  it('undoes a session and deletes a run in one go', async () => {
    const before = await checksum();
    const r = await seed(db, scenario(TWO_ORDERS), { by });
    await sessions.start(db, identity, 'Ship it');
    await db.query('SELECT place_order($1, 2, 1)', [r.rows[0]!.key.id]);
    await db.query("UPDATE orders SET status = 'SHIPPED' WHERE id = $1", [r.rows[1]!.key.id]);
    const rec = await sessions.stop(db, identity);

    const done = await clean(db, [{ kind: 'session', recording: rec }, { kind: 'run', runIds: [r.runId!] }], { ...opts, apply: true });
    expect(done.plan.title).toBe(`Session #${rec.id} · Ship it + Run #${r.runId} · Two orders`);
    expect(done.plan.actions.filter((a) => a.why === 'dependent')).toEqual([]);
    expect(await checksum()).toBe(before);
  });
});

describe('scenario checks', () => {
  it('reports scenarios a migration broke, without saving anything', async () => {
    const all = await loadScenarios('demo/scenarios');
    const before = await checksum();
    expect((await checkScenarios(db, all)).map((c) => c.status)).toEqual(all.map(() => 'ok'));
    await db.query('ALTER TABLE orders RENAME COLUMN total TO amount');
    const after = await checkScenarios(db, [...all, scenario('params:\n  who: text\nseed:\n  customers:\n    name: "{{who}}"\n', 'needs.yml')]);
    const byId = Object.fromEntries(after.map((c) => [c.scenario.id, c]));
    expect(byId['two-orders']).toMatchObject({ status: 'error', error: expect.stringMatching(/orders has no column "total"/) });
    expect(byId['new-customer']!.status).toBe('ok');
    expect(byId.needs).toMatchObject({ status: 'skipped', error: 'needs who' });
    await db.query('ALTER TABLE orders RENAME COLUMN amount TO total');
    expect(await checksum()).toBe(before);
  });
});
