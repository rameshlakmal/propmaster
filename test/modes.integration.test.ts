import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeDatabase, type Db } from '../src/core/db.js';
import { diagnose } from '../src/recorder/doctor.js';
import { toSql } from '../src/recorder/export/sql.js';
import * as snapshot from '../src/recorder/snapshot.js';
import * as trigger from '../src/recorder/trigger.js';
import { changesOf, connectTest, ensureRole, plain, resetDatabase, TEST_URL, urlAs } from './helpers.js';

let db: Db;

beforeAll(async () => {
  db = await connectTest();
  await ensureRole(db, 'propmaster_reader');
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetDatabase(db);
});

async function runChecks(sql: string): Promise<{ check_name: string; pass: boolean }[]> {
  return (await db.query(sql)).rows;
}

describe('SQL checks against a real database', () => {
  beforeEach(async () => {
    await trigger.install(db);
    await trigger.start(db, 'checkout');
    await trigger.step(db, 'Place order');
    await db.query('SELECT place_order(1, 3, 2)');
    await trigger.step(db, 'Cancel it');
    await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = 1");
    await db.query("DELETE FROM customers WHERE id = 3");
    await trigger.stop(db);
  });

  it('all pass right after the session', async () => {
    const rows = await runChecks(toSql((await trigger.getRecording(db))!));
    expect(rows.length).toBe(5); // inventory, order (inserted + cancelled), item, payment, deleted customer
    expect(rows.filter((r) => !r.pass)).toEqual([]);
  });

  it('catch a database that ended up different', async () => {
    await db.query("UPDATE orders SET status = 'PAID' WHERE id = 1");
    await db.query("INSERT INTO customers (id, email, name) VALUES (3, 'back@example.com', 'Back')");
    const failed = (await runChecks(toSql((await trigger.getRecording(db))!))).filter((r) => !r.pass);
    expect(failed.map((r) => r.check_name)).toEqual([
      'public.customers id=3 was deleted',
      'public.orders id=1 was inserted with customer_id, status, total',
    ]);
  });

  it('strict form raises an error naming the failed checks', async () => {
    const sql = toSql((await trigger.getRecording(db))!, { strict: true });
    await db.query(sql); // passes now
    await db.query('UPDATE inventory SET stock = 0 WHERE product_id = 3');
    await expect(db.query(sql)).rejects.toThrow(/Propmaster checks failed:\nstep 1: public.inventory product_id=3 was updated with stock/);
  });

  it('pass on a re-run of the same test when generated ids are ignored', async () => {
    const sql = toSql((await trigger.getRecording(db))!, { ignoreColumns: ['id', 'order_id'] });
    await resetDatabase(db);
    await db.query('SELECT setval(pg_get_serial_sequence(\'orders\', \'id\'), 500)'); // ids differ this time
    await db.query('SELECT place_order(1, 3, 2)');
    await db.query("UPDATE orders SET status = 'CANCELLED'");
    await db.query("DELETE FROM customers WHERE id = 3");
    expect((await runChecks(sql)).filter((r) => !r.pass)).toEqual([]);
  });
});

describe('snapshot mode (read-only user)', () => {
  let home: string;
  let reader: Db;
  const readerUrl = urlAs('propmaster_reader');
  const identity = describeDatabase(readerUrl);

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'propmaster-'));
    process.env.PROPMASTER_HOME = home;
    await db.query('GRANT USAGE ON SCHEMA public TO propmaster_reader');
    await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO propmaster_reader');
    reader = await connectTest(readerUrl);
  });

  afterEach(async () => {
    await reader.end();
    delete process.env.PROPMASTER_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it('cannot use trigger mode', async () => {
    await expect(trigger.install(reader)).rejects.toMatchObject({ code: '42501' });
  });

  it('records the checkout step by step with nothing but SELECT', async () => {
    const started = await snapshot.startSnapshot(reader, identity, 'read-only checkout');
    expect(started).toMatchObject({ id: 's1', tables: 6, skipped: [] });

    expect(await snapshot.stepSnapshot(reader, identity, 'Place order')).toBe(1);
    await db.query('SELECT place_order(2, 1, 3)'); // the app writes as another user
    expect(await snapshot.stepSnapshot(reader, identity, 'Look around')).toBe(2);
    const rec = await snapshot.stopSnapshot(reader, identity);

    expect(rec.mode).toBe('snapshot');
    expect(rec.stoppedAt).toBeInstanceOf(Date);
    expect(rec.steps.map((s) => [s.seq, s.name, s.changes.length])).toEqual([
      [0, '(before first step)', 0], [1, 'Place order', 4], [2, 'Look around', 0],
    ]);
    const stock = rec.steps[1]!.changes.find((c) => c.tableName === 'inventory')!;
    expect(plain([stock.op, stock.rowKey, stock.oldValues, stock.newValues])).toEqual(['UPDATE', { product_id: 1 }, { stock: 40 }, { stock: 37 }]);
    const order = rec.steps[1]!.changes.find((c) => c.tableName === 'orders')!;
    expect(Object.keys(order.newValues!)).toEqual(['id', 'customer_id', 'status', 'total', 'created_at']);
    expect(JSON.stringify(order.newValues!.total)).toBe('37.50');

    // Stored locally, listed for this database only, and SQL checks work on it too.
    expect(await snapshot.activeSnapshot()).toBeNull();
    expect((await snapshot.listSnapshots(identity)).map((s) => [s.id, s.changeCount])).toEqual([['s1', 4]]);
    expect(await snapshot.listSnapshots('elsewhere:5432/db')).toEqual([]);
    const reloaded = await snapshot.getSnapshotRecording('s1');
    expect(changesOf(reloaded)).toHaveLength(4);
    expect((await runChecks(toSql(reloaded!))).every((r) => r.pass)).toBe(true);
  });

  it('reads and checks tables with columns named like its own aliases', async () => {
    await db.query('CREATE TABLE tricky (id int PRIMARY KEY, t text, n int)');
    await db.query('GRANT SELECT ON tricky TO propmaster_reader');
    await snapshot.startSnapshot(reader, identity, 's');
    await db.query("INSERT INTO tricky VALUES (1, 'tee', 5)");
    const rec = await snapshot.stopSnapshot(reader, identity);
    expect(changesOf(rec).map((c) => c.newValues)).toEqual([{ id: 1, t: 'tee', n: 5 }]);
    const checks = await runChecks(toSql(rec));
    expect(checks).toEqual([{ step: 0, check_name: 'public.tricky id=1 was inserted with t, n', pass: true }]);
  });

  it('skips tables that are too big, and excluded ones, and says so', async () => {
    const s = await snapshot.startSnapshot(reader, identity, 's', { maxRows: 3, exclude: ['payments'] });
    expect(s.skipped).toEqual(['public.inventory', 'public.products']); // 4 rows each; customers has exactly 3
    expect(s.tables).toBe(3); // customers, orders, order_items (payments excluded)
    await db.query("UPDATE inventory SET stock = 1");
    const rec = await snapshot.stopSnapshot(reader, identity);
    expect(changesOf(rec)).toEqual([]);
    expect(rec.notes.join(' ')).toMatch(/Not watched \(more than 3 rows\): public.inventory, public.products/);
  });

  it('refuses a second session, or steps from another database', async () => {
    await snapshot.startSnapshot(reader, identity, 'one');
    await expect(snapshot.startSnapshot(reader, identity, 'two')).rejects.toThrow(/already recording/);
    await expect(snapshot.stepSnapshot(reader, 'other:5432/db', 'x')).rejects.toThrow(/is recording .* not other:5432\/db/);
    await expect(snapshot.deleteSnapshot('s1')).rejects.toThrow(/still recording/);
    await snapshot.stopSnapshot(reader, identity);
    await snapshot.deleteSnapshot('s1');
    expect(await snapshot.listSnapshots(identity)).toEqual([]);
  });

  it('leaves no temporary files, and skips a corrupt session file instead of failing', async () => {
    const { readdir, writeFile } = await import('node:fs/promises');
    await snapshot.startSnapshot(reader, identity, 'one');
    await snapshot.stepSnapshot(reader, identity, 'x');
    await snapshot.stopSnapshot(reader, identity);
    const files = await readdir(join(home, 'snapshots'));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);

    await writeFile(join(home, 'snapshots', 's7.json'), '{"identity": "half a fi');
    expect((await snapshot.listSnapshots(identity)).map((s) => s.id)).toEqual(['s1']);
  });

  it('explains when nothing is recording', async () => {
    await expect(snapshot.stepSnapshot(reader, identity, 'x')).rejects.toThrow(/Nothing is recording in snapshot mode/);
  });
});

describe('doctor', () => {
  it('recommends trigger mode for the table owner', async () => {
    const report = await diagnose(db);
    expect(report.recommended).toBe('trigger');
    expect(report.grants).toEqual([]);
    expect(report.findings.map((f) => f.text)).toContain('You can add triggers to 6 of 6 tables (trigger mode).');
  });

  it('recommends snapshot mode for a read-only user and lists the grants to ask for', async () => {
    await db.query('REVOKE CREATE ON DATABASE propmaster_test FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA public TO propmaster_reader');
    await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO propmaster_reader');
    const reader = await connectTest(urlAs('propmaster_reader'));
    try {
      const report = await diagnose(reader);
      expect(report.recommended).toBe('snapshot');
      expect(report.findings.filter((f) => f.level === 'fail').map((f) => f.text)).toEqual([
        'You cannot create schemas in this database, so the recorder cannot be installed.',
        'You can add triggers to 0 of 6 tables (trigger mode).',
      ]);
      expect(report.grants).toEqual([
        'GRANT CREATE ON DATABASE "propmaster_test" TO "propmaster_reader";',
        'GRANT TRIGGER ON ALL TABLES IN SCHEMA "public" TO "propmaster_reader";',
      ]);
    } finally {
      await reader.end();
    }
  });

  it('reports an installed recorder and a running session', async () => {
    await trigger.install(db);
    await trigger.start(db, 'busy');
    const texts = (await diagnose(db)).findings.map((f) => f.text);
    expect(texts).toContain('The recorder is installed and watching 6 of 6 tables.');
    expect(texts.some((t) => /Session #\d+ "busy" is recording right now/.test(t))).toBe(true);
  });
});

it('the test database URL is not mistaken for production', () => {
  expect(TEST_URL).toContain('propmaster_test');
});
