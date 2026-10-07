// Measures what the recorder costs the app: npm run bench
// Runs against the propmaster_test database (it is reset first), never against the demo data.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { connect, type Db } from '../src/core/db.js';
import * as trigger from '../src/recorder/trigger.js';

const URL = process.env.PROPMASTER_TEST_DATABASE_URL ?? 'postgres://propmaster:propmaster@localhost:5433/propmaster_test';
const ORDERS = Number(process.env.BENCH_ORDERS ?? 500);
const BULK_ROWS = Number(process.env.BENCH_BULK_ROWS ?? 50000);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);

type State = 'no recorder' | 'installed, idle' | 'recording';

async function reset(db: Db): Promise<void> {
  await db.query('DROP SCHEMA IF EXISTS _propmaster CASCADE');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile('demo/schema.sql', 'utf8'));
  await db.query(await readFile('demo/seed.sql', 'utf8'));
  await db.query('UPDATE inventory SET stock = 100000000');
  await db.query(`CREATE TABLE bulk (id int PRIMARY KEY, n int NOT NULL, label text NOT NULL)`);
  await db.query(`INSERT INTO bulk SELECT g, 0, 'row ' || g FROM generate_series(1, ${BULK_ROWS}) g`);
  await db.query('VACUUM ANALYZE');
}

async function prepare(db: Db, state: State): Promise<void> {
  await reset(db);
  if (state === 'no recorder') return;
  await trigger.install(db);
  if (state === 'recording') await trigger.start(db, 'bench');
}

/** App-like load: one place_order() call per round trip (4 row writes each). */
async function checkout(db: Db): Promise<number> {
  const t = performance.now();
  for (let i = 0; i < ORDERS; i++) await db.query('SELECT place_order($1, $2, 1)', [1 + (i % 3), 1 + (i % 4)]);
  return performance.now() - t;
}

/** The same checkout run inside the database, so network latency doesn't hide the trigger cost. */
async function checkoutInDb(db: Db): Promise<number> {
  const t = performance.now();
  await db.query(`DO $$ BEGIN FOR i IN 0..${ORDERS * 5 - 1} LOOP PERFORM place_order(1 + i % 3, 1 + i % 4, 1); END LOOP; END $$`);
  return performance.now() - t;
}

/** Batch load: one UPDATE that touches every row of a table. */
async function bulkUpdate(db: Db): Promise<number> {
  const t = performance.now();
  await db.query('UPDATE bulk SET n = n + 1');
  return performance.now() - t;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** One timing of a workload in a state: fresh data, a warm-up run, fresh data again, then the measured run. */
async function timeOnce(db: Db, state: State, work: (db: Db) => Promise<number>): Promise<number> {
  await prepare(db, state);
  await work(db);
  await prepare(db, state);
  return work(db);
}

const db = await connect(URL);
try {
  const states: State[] = ['no recorder', 'installed, idle', 'recording'];
  const workloads = [
    { name: `checkout from the app: ${ORDERS} place_order() calls, one round trip each`, run: checkout, unit: (ms: number) => `${(ORDERS / (ms / 1000)).toFixed(0)} orders/s` },
    { name: `checkout inside the database: ${ORDERS * 5} place_order() calls`, run: checkoutInDb, unit: (ms: number) => `${(ORDERS * 5 / (ms / 1000)).toFixed(0)} orders/s` },
    { name: `bulk: UPDATE of ${BULK_ROWS.toLocaleString('en')} rows`, run: bulkUpdate, unit: (ms: number) => `${(BULK_ROWS / (ms / 1000) / 1000).toFixed(0)}k rows/s` },
  ];

  console.log(`Propmaster recorder overhead · median of ${RUNS} runs · ${(await db.query('SHOW server_version')).rows[0].server_version}\n`);
  for (const w of workloads) {
    // States take turns within each round, so drift on a noisy machine hits all of them alike.
    const times = new Map<State, number[]>(states.map((st) => [st, []]));
    for (let round = 0; round < RUNS; round++) {
      for (const state of states) times.get(state)!.push(await timeOnce(db, state, w.run));
    }

    console.log(w.name);
    const base = median(times.get('no recorder')!);
    for (const state of states) {
      const ms = median(times.get(state)!);
      const overhead = state === 'no recorder' ? '' : `  ${ms >= base ? '+' : ''}${(((ms - base) / base) * 100).toFixed(0)}%`;
      console.log(`  ${state.padEnd(16)} ${ms.toFixed(0).padStart(7)} ms  ${w.unit(ms).padStart(14)}${overhead}`);
    }
    console.log('');
  }
} finally {
  await reset(db);
  await db.end();
}
