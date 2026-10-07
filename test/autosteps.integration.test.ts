import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeDatabase, type Db } from '../src/core/db.js';
import * as sessions from '../src/recorder/sessions.js';
import { formatTimeline } from '../src/recorder/timeline.js';
import * as trigger from '../src/recorder/trigger.js';
import { connectTest, resetDatabase, TEST_URL } from './helpers.js';

let db: Db;
const identity = describeDatabase(TEST_URL);
const GAP = 600;
const quiet = () => new Promise((r) => setTimeout(r, GAP + 400));

beforeAll(async () => {
  db = await connectTest();
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetDatabase(db);
  await trigger.install(db);
});

describe('auto steps', () => {
  it('splits a session into named steps at quiet gaps, live and after stopping', async () => {
    await sessions.start(db, identity, 'auto checkout', { autoSteps: GAP });
    expect((await sessions.status(db, identity)).active).toMatchObject({ autoSplitMs: GAP });

    await db.query('SELECT place_order(1, 3, 2)');
    await quiet();
    await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = 1");

    const live = await sessions.load(db, identity);
    expect(live.steps.map((s) => s.name)).toEqual([
      'New order #1 with order item, payment · inventory product_id 3 stock 6 → 4',
      'Order #1 status PENDING → CANCELLED',
    ]);

    await quiet();
    await sessions.step(db, identity, 'Delete the customer'); // a typed name goes to the next action
    await db.query('DELETE FROM payments WHERE order_id = 1');
    await quiet();
    await db.query("INSERT INTO customers (email, name) VALUES ('late@example.com', 'Late')");

    const rec = await sessions.stop(db, identity);
    expect(rec.autoSplitMs).toBe(GAP);
    expect(rec.steps.map((s) => [s.seq, s.name, s.auto, s.changes.length])).toEqual([
      [1, 'New order #1 with order item, payment · inventory product_id 3 stock 6 → 4', true, 4],
      [2, 'Order #1 status PENDING → CANCELLED', true, 1],
      [3, 'Delete the customer', false, 1],
      [4, 'New customer #4', true, 1],
    ]);
    expect(formatTimeline(rec, { width: 100 })).toMatch(/STEP 2 {2}Order #1 status PENDING → CANCELLED +auto · 1 change/);

    // Read again later: the same steps.
    expect((await sessions.load(db, identity, rec.id)).steps.map((s) => s.name)).toEqual(rec.steps.map((s) => s.name));
  });

  it('records typed steps as before when auto steps are off', async () => {
    await sessions.start(db, identity, 'typed');
    expect((await sessions.status(db, identity)).active).toMatchObject({ autoSplitMs: null });
    await sessions.step(db, identity, 'Order');
    await db.query('SELECT place_order(1, 3, 2)');
    await quiet();
    await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = 1");
    const rec = await sessions.stop(db, identity);
    expect(rec.autoSplitMs).toBeUndefined();
    expect(rec.steps.map((s) => [s.name, s.changes.length])).toEqual([['(before first step)', 0], ['Order', 5]]);
  });

  it('refuses snapshot mode and gaps out of range', async () => {
    await expect(sessions.start(db, identity, 'x', { snapshot: true, autoSteps: true })).rejects.toThrow('Auto steps need live recording (trigger mode).');
    await expect(sessions.start(db, identity, 'x', { autoSteps: 100 })).rejects.toThrow('between 0.5 and 600 seconds');
    await expect(sessions.start(db, identity, 'x', { autoSteps: Number.NaN })).rejects.toThrow('between 0.5 and 600 seconds');
  });
});
