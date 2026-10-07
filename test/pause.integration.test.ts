import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeDatabase, type Db } from '../src/core/db.js';
import { explainError } from '../src/core/errors.js';
import { toHtml } from '../src/recorder/export/html.js';
import { toMarkdown } from '../src/recorder/export/markdown.js';
import * as sessions from '../src/recorder/sessions.js';
import { formatTimeline } from '../src/recorder/timeline.js';
import * as trigger from '../src/recorder/trigger.js';
import type { Recording } from '../src/recorder/types.js';
import { connectTest, ensureRole, resetDatabase, TEST_URL, urlAs } from './helpers.js';

let db: Db;

beforeAll(async () => {
  db = await connectTest();
  await ensureRole(db, 'propmaster_reader');
});

afterAll(async () => {
  await db?.end();
});

/** Each step as [seq, name, "op table" per change, "kind note" per marker]. */
function outline(rec: Recording) {
  return rec.steps.map((s) => [
    s.seq, s.name,
    s.changes.map((c) => `${c.op} ${c.tableName}`),
    (s.markers ?? []).map((m) => (m.note ? `${m.kind} ${m.note}` : m.kind)),
  ]);
}

async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (explainError(err) as Error).message;
  }
  throw new Error('expected it to fail');
}

describe('pause, resume and flag in trigger mode', () => {
  const identity = describeDatabase(TEST_URL);

  beforeEach(async () => {
    await resetDatabase(db);
    await trigger.install(db);
  });

  it('records nothing while paused, and keeps the markers on their steps', async () => {
    await sessions.start(db, identity, 'paused checkout');
    await sessions.step(db, identity, 'Place order');
    await db.query('SELECT place_order(1, 3, 2)');
    await sessions.flag(db, identity, '  total looks high  ');
    await sessions.pause(db, identity);
    expect((await sessions.status(db, identity)).active).toMatchObject({ paused: true, stepSeq: 1 });

    await db.query("UPDATE customers SET name = 'Setup only' WHERE id = 1"); // not part of the test
    await sessions.step(db, identity, 'Cancel it'); // a step while paused starts paused
    await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = 1");
    await sessions.resume(db, identity);
    await db.query("DELETE FROM payments WHERE order_id = 1");
    await sessions.flag(db, identity, '');

    const rec = await sessions.stop(db, identity);
    expect(outline(rec)).toEqual([
      [0, '(before first step)', [], []],
      [1, 'Place order', ['UPDATE inventory', 'INSERT orders', 'INSERT order_items', 'INSERT payments'], ['flag total looks high', 'pause']],
      [2, 'Cancel it', ['DELETE payments'], ['resume', 'flag']],
    ]);
    expect(rec.steps[1]!.markers![0]!.at).toBeInstanceOf(Date);
    expect((await sessions.status(db, identity)).active).toBeNull();
  });

  it('explains pausing twice, resuming a running session, and pausing with nothing recording', async () => {
    expect(await message(sessions.pause(db, identity))).toBe('Nothing is recording.');
    expect(await message(sessions.flag(db, identity, 'x'))).toBe('Nothing is recording.');
    await sessions.start(db, identity, 'twice');
    expect(await message(sessions.resume(db, identity))).toBe('The recording is already running.');
    await sessions.pause(db, identity);
    expect(await message(sessions.pause(db, identity))).toBe('The recording is already paused.');
  });

  it('starts the next session unpaused after stopping a paused one', async () => {
    await sessions.start(db, identity, 'first');
    await sessions.pause(db, identity);
    await sessions.stop(db, identity);
    await sessions.start(db, identity, 'second');
    expect((await sessions.status(db, identity)).active).toMatchObject({ name: 'second', paused: false });
    await sessions.step(db, identity, 'Order');
    await db.query('SELECT place_order(1, 3, 2)');
    expect((await sessions.stop(db, identity)).steps[1]!.changes).toHaveLength(4);
  });

  it('keeps recordings when installed again over a running paused session', async () => {
    await sessions.start(db, identity, 'upgrade');
    await sessions.pause(db, identity);
    await trigger.install(db);
    expect((await sessions.status(db, identity)).active).toMatchObject({ name: 'upgrade', paused: true });
  });

  it('shows markers in the timeline and both exports', async () => {
    await sessions.start(db, identity, 'shown');
    await sessions.step(db, identity, 'Pay');
    await sessions.flag(db, identity, 'total shows <0.00>');
    await sessions.pause(db, identity);
    const rec = await sessions.stop(db, identity);

    const timeline = formatTimeline(rec, { width: 100 });
    expect(timeline).toMatch(/⚑ flagged \d\d:\d\d:\d\d · total shows <0\.00>/);
    expect(timeline).toMatch(/‖ paused \d\d:\d\d:\d\d/);
    expect(toMarkdown(rec, { masked: false })).toMatch(/- ⚑ \*\*Flagged\*\* at \d\d:\d\d:\d\d: total shows &lt;0\.00>/); // escaped, like every Markdown cell
    const html = toHtml(rec, { masked: false });
    expect(html).toContain('<li class="marker flag"><strong>⚑ Flagged</strong>');
    expect(html).toContain('total shows &lt;0.00&gt;');
  });
});

describe('pause, resume and flag in snapshot mode', () => {
  let home: string;
  let reader: Db;
  const readerUrl = urlAs('propmaster_reader');
  const identity = describeDatabase(readerUrl);

  beforeEach(async () => {
    await resetDatabase(db);
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

  it('keeps what happened before the pause, and never reports what changed while paused', async () => {
    await sessions.start(reader, identity, 'paused snapshots', { snapshot: true });
    await sessions.step(reader, identity, 'Place order');
    await db.query('SELECT place_order(1, 3, 2)');
    await sessions.pause(reader, identity);
    expect((await sessions.status(reader, identity)).active).toMatchObject({ mode: 'snapshot', paused: true });

    await db.query("UPDATE customers SET name = 'Setup only' WHERE id = 1");
    await sessions.step(reader, identity, 'Cancel it');
    await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = 1");
    await sessions.resume(reader, identity);
    await db.query("DELETE FROM payments WHERE order_id = 1");
    await sessions.flag(reader, identity, 'payment gone?');

    const rec = await sessions.stop(reader, identity);
    expect(outline(rec)).toEqual([
      [0, '(before first step)', [], []],
      [1, 'Place order', ['UPDATE inventory', 'INSERT order_items', 'INSERT orders', 'INSERT payments'], ['pause']], // snapshot mode reads tables in name order
      [2, 'Cancel it', ['DELETE payments'], ['resume', 'flag payment gone?']],
    ]);

    // The markers survive the trip through the session file.
    const reloaded = await sessions.load(reader, identity, rec.id);
    expect(reloaded.steps[2]!.markers![1]!.at).toBeInstanceOf(Date);
  });

  it('stops a paused session without comparing again', async () => {
    await sessions.start(reader, identity, 'stop paused', { snapshot: true });
    await sessions.step(reader, identity, 'Look');
    await sessions.pause(reader, identity);
    await db.query("UPDATE customers SET name = 'Later' WHERE id = 1");
    const rec = await sessions.stop(reader, identity);
    expect(rec.steps.flatMap((s) => s.changes)).toEqual([]);
  });

  it('explains pausing twice', async () => {
    await sessions.start(reader, identity, 'twice', { snapshot: true });
    await sessions.pause(reader, identity);
    expect(await message(sessions.pause(reader, identity))).toBe('The recording is already paused.');
    await sessions.resume(reader, identity);
    expect(await message(sessions.resume(reader, identity))).toBe('The recording is already running.');
  });
});
