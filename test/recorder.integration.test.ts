import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import * as recorder from '../src/recorder/trigger.js';
import { changesOf, connectTest, ensureRole, plain, resetDatabase, urlAs } from './helpers.js';

let db: Db;

async function changes() {
  return changesOf(await recorder.getRecording(db));
}

beforeAll(async () => {
  db = await connectTest();
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetDatabase(db);
  await recorder.install(db);
});

describe('install and uninstall', () => {
  it('watches every demo table and can be run twice', async () => {
    expect((await recorder.status(db)).watchedTables).toBe(6);
    expect(await recorder.install(db)).toBe(0); // nothing new to attach
    expect((await recorder.status(db)).watchedTables).toBe(6);
  });

  it('keeps recordings when re-installed (upgrade in place)', async () => {
    await recorder.start(db, 's');
    await db.query("UPDATE customers SET name = 'A' WHERE id = 1");
    await recorder.stop(db);
    await recorder.install(db);
    expect(await changes()).toHaveLength(1);
  });

  it('uninstall removes the schema and every trigger', async () => {
    await recorder.uninstall(db);
    expect(await recorder.isInstalled(db)).toBe(false);
    const { rows } = await db.query("SELECT 1 FROM pg_trigger WHERE tgname LIKE 'propmaster_%'");
    expect(rows).toHaveLength(0);
    await db.query("INSERT INTO customers (email, name) VALUES ('x@example.com', 'X')"); // app still works
  });
});

describe('recording', () => {
  it('records nothing while idle', async () => {
    await db.query("INSERT INTO customers (email, name) VALUES ('idle@example.com', 'Idle')");
    const { rows } = await db.query('SELECT count(*)::int AS n FROM _propmaster.changes');
    expect(rows[0].n).toBe(0);
  });

  it('groups the changes of "Place Order" under its step', async () => {
    await recorder.start(db, 'checkout');
    await recorder.step(db, 'Click Place Order');
    await db.query('SELECT place_order(1, 3, 2)');
    await recorder.stop(db);

    const rec = (await recorder.getRecording(db))!;
    const step1 = rec.steps.find((s) => s.seq === 1)!;
    expect(step1.name).toBe('Click Place Order');
    expect(step1.changes.map((c) => `${c.op} ${c.tableName}`)).toEqual([
      'UPDATE inventory', 'INSERT orders', 'INSERT order_items', 'INSERT payments',
    ]);

    const stock = step1.changes[0]!;
    expect(stock.rowKey).toEqual({ product_id: 3 });
    expect(stock.oldValues).toEqual({ stock: 6 });
    expect(stock.newValues).toEqual({ stock: 4 });

    const order = step1.changes[1]!;
    expect(Object.keys(order.newValues!)).toEqual(['id', 'customer_id', 'status', 'total', 'created_at']); // table order
    expect(JSON.stringify(order.newValues!.total)).toBe('84.50'); // numeric kept exactly
    expect(order.dbUser).toBe('propmaster');
    expect(order.appName).toBe('propmaster');
    expect(order.txid).toMatch(/^\d+$/);
  });

  it('puts changes before the first step into step 0', async () => {
    await recorder.start(db, 's');
    await db.query("UPDATE customers SET name = 'Alice B' WHERE id = 1");
    const rec = (await recorder.getRecording(db))!;
    expect(rec.steps[0]!.seq).toBe(0);
    expect(rec.steps[0]!.changes).toHaveLength(1);
  });

  it('skips updates that change nothing', async () => {
    await recorder.start(db, 's');
    await db.query('UPDATE products SET price = price');
    expect(await changes()).toHaveLength(0);
  });

  it('records a delete with the full old row', async () => {
    await db.query("INSERT INTO customers (email, name) VALUES ('gone@example.com', 'Gone')");
    await recorder.start(db, 's');
    await db.query("DELETE FROM customers WHERE email = 'gone@example.com'");
    const [del] = await changes();
    expect(del!.op).toBe('DELETE');
    expect(del!.oldValues).toMatchObject({ email: 'gone@example.com', name: 'Gone' });
    expect(del!.newValues).toBeNull();
  });

  it('records TRUNCATE', async () => {
    await db.query('CREATE TABLE scratch (id int PRIMARY KEY)');
    await db.query('INSERT INTO scratch VALUES (1), (2)');
    await recorder.start(db, 's');
    await db.query('TRUNCATE scratch');
    expect((await changes()).map((c) => `${c.op} ${c.tableName}`)).toEqual(['TRUNCATE scratch']);
  });

  it('does not record changes rolled back by the app, including to a savepoint', async () => {
    await recorder.start(db, 's');
    await db.query('BEGIN');
    await db.query("INSERT INTO customers (email, name) VALUES ('kept@example.com', 'Kept')");
    await db.query('SAVEPOINT sp');
    await db.query("INSERT INTO customers (email, name) VALUES ('undone@example.com', 'Undone')");
    await db.query('ROLLBACK TO SAVEPOINT sp');
    await db.query('COMMIT');
    await db.query('BEGIN');
    await db.query("INSERT INTO customers (email, name) VALUES ('rb@example.com', 'Rolled Back')");
    await db.query('ROLLBACK');
    expect((await changes()).map((c) => c.newValues!.email)).toEqual(['kept@example.com']);
  });

  it('records tables created during the session from the next step on', async () => {
    await recorder.start(db, 's');
    await db.query('CREATE TABLE late (id int PRIMARY KEY)');
    await recorder.step(db, 'after create');
    await db.query('INSERT INTO late VALUES (1)');
    const rec = (await recorder.getRecording(db))!;
    expect(rec.steps[1]!.changes.map((c) => c.tableName)).toEqual(['late']);
  });

  it('records changes made by another DB user without extra grants', async () => {
    await ensureRole(db, 'propmaster_app');
    await db.query('GRANT USAGE ON SCHEMA public TO propmaster_app');
    await db.query('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO propmaster_app');
    await db.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO propmaster_app');
    await recorder.start(db, 's');

    const app = await connectTest(urlAs('propmaster_app'));
    try {
      await app.query("INSERT INTO customers (email, name) VALUES ('app@example.com', 'From App')");
    } finally {
      await app.end();
    }

    const [ins] = await changes();
    expect(ins!.dbUser).toBe('propmaster_app');
    expect(ins!.clientAddr).toMatch(/\d/);
  });

  it('never breaks the app write when recording fails', async () => {
    await recorder.start(db, 's');
    // Sabotage the recorder: every insert into changes now fails.
    await db.query('ALTER TABLE _propmaster.changes ADD CONSTRAINT sabotage CHECK (false) NOT VALID');

    const warnings: string[] = [];
    db.on('notice', (n) => warnings.push(n.message ?? ''));
    await db.query("INSERT INTO customers (email, name) VALUES ('safe@example.com', 'Safe')");
    await db.query('TRUNCATE order_items, payments');
    db.removeAllListeners('notice');

    const { rows } = await db.query("SELECT 1 FROM customers WHERE email = 'safe@example.com'");
    expect(rows).toHaveLength(1);
    expect(warnings.some((w) => w.startsWith('propmaster: could not record INSERT on public.customers'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('propmaster: could not record TRUNCATE on public.payments'))).toBe(true);
  });
});

describe('edge-case schemas', () => {
  it('keeps composite primary keys in column order', async () => {
    await db.query('CREATE TABLE tags (product_id int, tag text, PRIMARY KEY (product_id, tag))');
    await recorder.start(db, 's');
    await db.query("INSERT INTO tags VALUES (1, 'sale')");
    const [ins] = await changes();
    expect(Object.entries(ins!.rowKey!)).toEqual([['product_id', 1], ['tag', 'sale']]);
  });

  it('records tables without a primary key', async () => {
    await db.query('CREATE TABLE page_views (path text)');
    await recorder.start(db, 's');
    await db.query("INSERT INTO page_views VALUES ('/cart')");
    const [ins] = await changes();
    expect(ins!.rowKey).toBeNull();
    expect(ins!.newValues).toEqual({ path: '/cart' });
  });

  it('records partitioned tables once, under the table the statement used', async () => {
    await db.query(`
      CREATE TABLE events (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
      CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE TABLE events_2027 PARTITION OF events FOR VALUES FROM ('2027-01-01') TO ('2028-01-01')`);
    await recorder.start(db, 's');
    await db.query("INSERT INTO events VALUES (1, '2026-10-07')");
    await db.query("INSERT INTO events_2026 VALUES (2, '2026-10-08')");
    await db.query("UPDATE events SET at = '2027-02-01' WHERE id = 1"); // moves to another partition
    expect((await changes()).map((c) => `${c.op} ${c.tableName} ${JSON.stringify(c.newValues)}`)).toEqual([
      'INSERT events {"id":1,"at":"2026-10-07"}',
      'INSERT events_2026 {"id":2,"at":"2026-10-08"}',
      'UPDATE events {"at":"2027-02-01"}',
    ]);
  });

  it('records inherited tables once, including rows changed through the parent', async () => {
    await db.query('CREATE TABLE vehicles (id int PRIMARY KEY, name text); CREATE TABLE trucks (axles int) INHERITS (vehicles)');
    await recorder.start(db, 's');
    await db.query("INSERT INTO trucks VALUES (1, 'big', 6)");
    await db.query("UPDATE vehicles SET name = 'bigger' WHERE id = 1");
    expect((await changes()).map((c) => `${c.op} ${c.tableName} ${JSON.stringify(c.newValues)}`)).toEqual([
      'INSERT trucks {"id":1,"name":"big","axles":6}',
      'UPDATE vehicles {"name":"bigger"}',
    ]);
  });

  it('pairs old and new rows of a multi-row update that changes the keys', async () => {
    await recorder.start(db, 's');
    await db.query('UPDATE customers SET id = id + 100, name = upper(name)');
    expect((await changes()).map((c) => [c.rowKey, c.oldValues!.id, c.newValues!.id, c.newValues!.name])).toEqual([
      [{ id: 1 }, 1, 101, 'ALICE TESTER'],
      [{ id: 2 }, 2, 102, 'BOB CHECKER'],
      [{ id: 3 }, 3, 103, 'CARA BUGFINDER'],
    ]);
  });

  it('is not confused by columns named like its own aliases (n, o, t, j, p, e, r)', async () => {
    await db.query('CREATE TABLE tricky (id int PRIMARY KEY, n int, o text, t text, j jsonb, p int, e int, r int)');
    await recorder.start(db, 's');
    await db.query(`INSERT INTO tricky VALUES (1, 1, 'o', 't', '{"j": 1}', 2, 3, 4)`);
    await db.query('UPDATE tricky SET n = 10, r = 40');
    await db.query('DELETE FROM tricky');
    const [ins, upd, del] = await changes();
    expect(plain(ins!.newValues)).toEqual({ id: 1, n: 1, o: 'o', t: 't', j: { j: 1 }, p: 2, e: 3, r: 4 });
    expect([upd!.rowKey, upd!.oldValues, upd!.newValues]).toEqual([{ id: 1 }, { n: 1, r: 4 }, { n: 10, r: 40 }]);
    expect(del!.oldValues).toMatchObject({ id: 1, n: 10, t: 't' });
  });

  it('pairs old and new rows of tables without a primary key', async () => {
    await db.query("CREATE TABLE notes (body text, n int); INSERT INTO notes VALUES ('a', 1), ('b', 2), ('c', 3)");
    await recorder.start(db, 's');
    await db.query('UPDATE notes SET n = n * 10 WHERE n > 1');
    expect((await changes()).map((c) => [c.oldValues, c.newValues])).toEqual([
      [{ n: 2 }, { n: 20 }],
      [{ n: 3 }, { n: 30 }],
    ]);
  });

  it('records upserts, cascaded deletes and MERGE', async () => {
    const { rows: [v] } = await db.query<{ n: number }>("SELECT current_setting('server_version_num')::int AS n");
    await db.query(`
      CREATE TABLE parents (id int PRIMARY KEY, label text);
      CREATE TABLE kids (id int PRIMARY KEY, parent_id int REFERENCES parents (id) ON DELETE CASCADE);
      INSERT INTO parents VALUES (1, 'p'); INSERT INTO kids VALUES (10, 1), (11, 1)`);
    await recorder.start(db, 's');
    await db.query("INSERT INTO parents VALUES (1, 'p2'), (2, 'q') ON CONFLICT (id) DO UPDATE SET label = excluded.label");
    await db.query('DELETE FROM parents WHERE id = 1');
    const expected = ['INSERT parents', 'UPDATE parents', 'DELETE kids', 'DELETE kids', 'DELETE parents'];
    if (v!.n >= 150000) {
      await db.query("MERGE INTO parents p USING (VALUES (2, 'merged')) s (id, label) ON p.id = s.id WHEN MATCHED THEN UPDATE SET label = s.label");
      expected.push('UPDATE parents');
    }
    expect((await changes()).map((c) => `${c.op} ${c.tableName}`).sort()).toEqual(expected.sort());
  });

  it('disables its triggers while idle and enables them while recording', async () => {
    const enabled = async () => (await db.query<{ state: string }>(
      "SELECT DISTINCT tgenabled AS state FROM pg_trigger WHERE tgname LIKE 'propmaster\\_%'")).rows.map((r) => r.state);
    expect(await enabled()).toEqual(['D']);
    await recorder.start(db, 's');
    expect(await enabled()).toEqual(['O']);
    await db.query('CREATE TABLE fresh (id int PRIMARY KEY)');
    await recorder.step(db, 'two'); // attaches enabled triggers to the new table
    expect(await enabled()).toEqual(['O']);
    await recorder.stop(db);
    expect(await enabled()).toEqual(['D']);
  });

  it('works for a tester who has only the grants doctor asks for (owns no tables)', async () => {
    await recorder.uninstall(db);
    await ensureRole(db, 'propmaster_tester');
    await db.query('GRANT CREATE ON DATABASE propmaster_test TO propmaster_tester');
    await db.query('GRANT USAGE ON SCHEMA public TO propmaster_tester');
    await db.query('GRANT TRIGGER ON ALL TABLES IN SCHEMA public TO propmaster_tester');

    const tester = await connectTest(urlAs('propmaster_tester'));
    try {
      await recorder.install(tester);
      expect((await recorder.status(tester)).watchedTables).toBe(6);
      // It can't disable triggers on tables it doesn't own, so they stay enabled...
      const { rows } = await db.query("SELECT DISTINCT tgenabled AS state FROM pg_trigger WHERE tgname LIKE 'propmaster\\_%'");
      expect(rows).toEqual([{ state: 'O' }]);
      // ...and the idle switch keeps them from recording anything.
      await db.query("UPDATE customers SET name = 'idle' WHERE id = 1");

      await recorder.start(tester, 's');
      await db.query("UPDATE customers SET name = 'recorded' WHERE id = 1"); // the app, as another user
      await recorder.stop(tester);
      const recorded = changesOf(await recorder.getRecording(tester));
      expect(recorded.map((c) => c.newValues)).toEqual([{ name: 'recorded' }]);
      await recorder.uninstall(tester);
    } finally {
      await tester.end();
      await db.query('REVOKE ALL ON DATABASE propmaster_test FROM propmaster_tester');
    }
    const { rows } = await db.query("SELECT 1 FROM pg_trigger WHERE tgname LIKE 'propmaster\\_%'");
    expect(rows).toEqual([]); // uninstall removed triggers on tables the tester doesn't own
  });

  it('handles enums, generated columns, arrays, json and bytea', async () => {
    await db.query(`
      CREATE TYPE mood AS ENUM ('happy', 'grumpy');
      CREATE TABLE odd (
        id int PRIMARY KEY,
        feeling mood,
        price numeric(10, 2),
        price_with_tax numeric GENERATED ALWAYS AS (price * 1.2) STORED,
        tags text[],
        meta jsonb,
        blob bytea
      )`);
    await recorder.start(db, 's');
    await db.query(`INSERT INTO odd (id, feeling, price, tags, meta, blob)
                    VALUES (1, 'happy', 10, '{a,b}', '{"x": [1, 2]}', '\\xdeadbeef')`);
    await db.query("UPDATE odd SET feeling = 'grumpy', price = 20 WHERE id = 1");

    const [ins, upd] = await changes();
    expect(plain(ins!.newValues)).toEqual({
      id: 1, feeling: 'happy', price: 10, price_with_tax: 12, tags: ['a', 'b'], meta: { x: [1, 2] }, blob: '\\xdeadbeef',
    });
    expect(JSON.stringify(ins!.newValues!.price)).toBe('10.00');
    expect(plain(upd!.oldValues)).toEqual({ feeling: 'happy', price: 10, price_with_tax: 12 });
    expect(plain(upd!.newValues)).toEqual({ feeling: 'grumpy', price: 20, price_with_tax: 24 });
  });

  it('keeps big numbers exact', async () => {
    await db.query('CREATE TABLE big (id bigint PRIMARY KEY, amount numeric)');
    await recorder.start(db, 's');
    await db.query("INSERT INTO big VALUES (9007199254740993, 123456789012345678901234.5678)");
    const [ins] = await changes();
    expect(JSON.stringify(ins!.rowKey)).toBe('{"id":9007199254740993}');
    expect(JSON.stringify(ins!.newValues!.amount)).toBe('123456789012345678901234.5678');
  });

  it('handles self-references and foreign key cycles', async () => {
    await db.query(`
      CREATE TABLE employees (id int PRIMARY KEY, manager_id int REFERENCES employees (id));
      CREATE TABLE teams (id int PRIMARY KEY, lead_id int);
      CREATE TABLE members (id int PRIMARY KEY, team_id int REFERENCES teams (id) DEFERRABLE INITIALLY DEFERRED);
      ALTER TABLE teams ADD FOREIGN KEY (lead_id) REFERENCES members (id) DEFERRABLE INITIALLY DEFERRED`);
    await recorder.start(db, 's');
    await db.query('INSERT INTO employees VALUES (1, NULL), (2, 1)');
    await db.query('BEGIN; INSERT INTO teams VALUES (1, 10); INSERT INTO members VALUES (10, 1); COMMIT');
    expect((await changes()).map((c) => `${c.tableName} ${JSON.stringify(c.rowKey)}`)).toEqual([
      'employees {"id":1}', 'employees {"id":2}', 'teams {"id":1}', 'members {"id":10}',
    ]);
  });

  it('handles quoted identifiers and other schemas', async () => {
    await db.query(`
      CREATE SCHEMA billing;
      CREATE TABLE billing."Order Lines" ("Line ID" int PRIMARY KEY, "Unit Price" numeric, note text)`);
    await recorder.start(db, 's');
    await db.query(`INSERT INTO billing."Order Lines" VALUES (1, 9.99, 'it''s "quoted"')`);
    const [ins] = await changes();
    expect(ins!.tableSchema).toBe('billing');
    expect(ins!.tableName).toBe('Order Lines');
    expect(ins!.rowKey).toEqual({ 'Line ID': 1 });
    expect(ins!.newValues!.note).toBe('it\'s "quoted"');
  });

  it('identifies a row by its old key when the key changes', async () => {
    await recorder.start(db, 's');
    await db.query('UPDATE customers SET id = 100 WHERE id = 3');
    const [upd] = await changes();
    expect(upd!.rowKey).toEqual({ id: 3 });
    expect(upd!.newValues).toEqual({ id: 100 });
  });

  it('keeps recording when a column is added mid-session', async () => {
    await recorder.start(db, 's');
    await db.query('ALTER TABLE products ADD COLUMN colour text');
    await db.query("UPDATE products SET colour = 'red' WHERE id = 1");
    const [upd] = await changes();
    expect(upd!.newValues).toEqual({ colour: 'red' });
  });
});

describe('excluding tables and pruning', () => {
  it('excludes a busy table and can include it again', async () => {
    await recorder.excludeTable(db, 'payments');
    let s = await recorder.status(db);
    expect(s.watchedTables).toBe(5);
    expect(s.excludedTables).toEqual(['public.payments']);

    await recorder.install(db); // re-install must not re-attach it
    expect((await recorder.status(db)).watchedTables).toBe(5);

    await recorder.start(db, 's');
    await db.query('SELECT place_order(1, 1, 1)');
    expect((await changes()).map((c) => c.tableName)).not.toContain('payments');

    await recorder.includeTable(db, 'payments');
    s = await recorder.status(db);
    expect(s.watchedTables).toBe(6);
    expect(s.excludedTables).toEqual([]);
  });

  it('explains an unknown table', async () => {
    await expect(recorder.excludeTable(db, 'nope')).rejects.toThrow(/does not exist/);
  });

  it('deletes and prunes stopped sessions only', async () => {
    const first = await recorder.start(db, 'old');
    await recorder.stop(db);
    await db.query("UPDATE _propmaster.sessions SET started_at = now() - interval '10 days' WHERE id = $1", [first]);
    const second = await recorder.start(db, 'new');
    await recorder.stop(db);
    const third = await recorder.start(db, 'running');

    expect(await recorder.prune(db, '7 days')).toBe(1);
    await expect(recorder.deleteSession(db, third)).rejects.toThrow(/still recording/);
    await recorder.deleteSession(db, second);
    expect((await recorder.listSessions(db)).map((s) => s.id)).toEqual([third]);
    await expect(recorder.deleteSession(db, '999')).rejects.toThrow(/no session/);
  });

  it('removes the changes of deleted and pruned sessions', async () => {
    const changeCount = async () => (await db.query('SELECT count(*)::int AS n FROM _propmaster.changes')).rows[0].n;
    const a = await recorder.start(db, 'a');
    await db.query('SELECT place_order(1, 1, 1)');
    await recorder.stop(db);
    const b = await recorder.start(db, 'b');
    await db.query('SELECT place_order(1, 1, 1)');
    await recorder.stop(db);
    expect(await changeCount()).toBe(8);

    await recorder.deleteSession(db, a);
    expect(await changeCount()).toBe(4);
    await db.query("UPDATE _propmaster.sessions SET started_at = now() - interval '2 days' WHERE id = $1", [b]);
    expect(await recorder.prune(db, '1 day')).toBe(1);
    expect(await changeCount()).toBe(0);
  });

  it('keeps captured changes in an unlogged table, and its own state in logged ones', async () => {
    const { rows } = await db.query(`
      SELECT relname, relpersistence FROM pg_class
       WHERE relnamespace = '_propmaster'::regnamespace AND relkind = 'r' ORDER BY relname`);
    expect(rows).toEqual([
      { relname: 'changes', relpersistence: 'u' },
      { relname: 'excluded_tables', relpersistence: 'p' },
      { relname: 'markers', relpersistence: 'p' },
      { relname: 'sessions', relpersistence: 'p' },
      { relname: 'state', relpersistence: 'p' },
      { relname: 'steps', relpersistence: 'p' },
    ]);
  });
});

describe('session rules', () => {
  it('refuses to start a second session while one is running', async () => {
    await recorder.start(db, 'first');
    await expect(recorder.start(db, 'second')).rejects.toThrow(/already recording/);
  });

  it('refuses step and stop when nothing is recording', async () => {
    await expect(recorder.step(db, 'x')).rejects.toThrow(/nothing is recording/);
    await expect(recorder.stop(db)).rejects.toThrow(/nothing is recording/);
  });

  it('numbers steps and reports status', async () => {
    const id = await recorder.start(db, 'flow');
    expect(await recorder.step(db, 'one')).toBe(1);
    expect(await recorder.step(db, 'two')).toBe(2);
    const s = await recorder.status(db);
    expect(s.active).toMatchObject({ id, name: 'flow', stepSeq: 2, stepName: 'two' });

    await recorder.stop(db);
    expect((await recorder.status(db)).active).toBeNull();
    const [latest] = await recorder.listSessions(db);
    expect(latest).toMatchObject({ id, name: 'flow', changeCount: 0, mode: 'trigger' });
    expect(latest!.stoppedAt).toBeInstanceOf(Date);
  });

  it('explains when the recorder is not installed', async () => {
    await recorder.uninstall(db);
    await expect(recorder.start(db, 's')).rejects.toThrow(/not installed/);
  });

  it('gives up waiting for a locked table instead of hanging', async () => {
    await db.query('CREATE TABLE locked (id int PRIMARY KEY)');
    const other = await connectTest();
    try {
      await other.query('BEGIN; LOCK TABLE locked IN ACCESS EXCLUSIVE MODE');
      await db.query("SET lock_timeout = '300ms'");
      await expect(recorder.start(db, 's')).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await other.query('ROLLBACK');
      await other.end();
      await db.query("SET lock_timeout = '5s'");
    }
  });
});
