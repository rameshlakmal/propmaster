import { readFile } from 'node:fs/promises';
import { connect, type Db } from '../src/core/db.js';
import { allChanges, type Change, type Recording } from '../src/recorder/types.js';

// The propmaster_test database from docker-compose (`npm run db:up`).
export const TEST_URL = process.env.PROPMASTER_TEST_DATABASE_URL
  ?? 'postgres://propmaster:propmaster@localhost:5433/propmaster_test';

/** The same URL, logged in as another role. */
export function urlAs(user: string, password = user): string {
  const url = new URL(TEST_URL);
  url.username = user;
  url.password = password;
  return url.toString();
}

export async function connectTest(url = TEST_URL): Promise<Db> {
  return connect(url);
}

/** Drops the recorder and rebuilds the demo shop schema with its seed data. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA IF EXISTS _propmaster CASCADE');
  await db.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile('demo/schema.sql', 'utf8'));
  await db.query(await readFile('demo/seed.sql', 'utf8'));
}

/** Creates a login role if it doesn't exist yet (roles are cluster-wide, so they survive resets). */
export async function ensureRole(db: Db, name: string): Promise<void> {
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
        CREATE ROLE ${name} LOGIN PASSWORD '${name}';
      END IF;
    END $$`);
}

export function changesOf(rec: Recording | null): Change[] {
  return rec ? allChanges(rec) : [];
}

/** Plain JSON values: exact numbers (JSON.rawJSON) become ordinary numbers, for easy assertions. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
