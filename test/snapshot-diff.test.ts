import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../src/recorder/snapshot.js';

const at = '2026-10-07T10:00:00.000Z';
const snap = (tables: { table: string; key: string[] | null; rows: object[] }[], skipped: string[] = []) => ({
  takenAt: at,
  skipped,
  tables: tables.map((t) => ({ schema: 'public', table: t.table, key: t.key, rows: t.rows.map((r) => JSON.stringify(r)) })),
});

describe('diffSnapshots', () => {
  it('finds inserts, updates (changed columns only) and deletes by primary key', () => {
    const before = snap([{ table: 'orders', key: ['id'], rows: [{ id: 1, status: 'PENDING', total: 5 }, { id: 2, status: 'PAID', total: 7 }] }]);
    const after = snap([{ table: 'orders', key: ['id'], rows: [{ id: 1, status: 'PAID', total: 5 }, { id: 3, status: 'PENDING', total: 9 }] }]);

    const changes = diffSnapshots(before, after, 10);
    expect(changes.map((c) => [c.id, c.op, c.rowKey, c.oldValues, c.newValues])).toEqual([
      [10, 'UPDATE', { id: 1 }, { status: 'PENDING' }, { status: 'PAID' }],
      [11, 'INSERT', { id: 3 }, null, { id: 3, status: 'PENDING', total: 9 }],
      [12, 'DELETE', { id: 2 }, { id: 2, status: 'PAID', total: 7 }, null],
    ]);
    expect(changes[0]!.dbUser).toBeNull();
    expect(changes[0]!.changedAt).toEqual(new Date(at));
  });

  it('compares tables without a key as multisets of rows', () => {
    const before = snap([{ table: 'views', key: null, rows: [{ p: '/a' }, { p: '/a' }, { p: '/b' }] }]);
    const after = snap([{ table: 'views', key: null, rows: [{ p: '/a' }, { p: '/c' }, { p: '/b' }] }]);
    expect(diffSnapshots(before, after, 1).map((c) => [c.op, c.newValues ?? c.oldValues])).toEqual([
      ['INSERT', { p: '/c' }],
      ['DELETE', { p: '/a' }],
    ]);
  });

  it('shows rows of a new table as inserts, and ignores tables it could not compare', () => {
    const before = snap([], ['public.big']);
    const after = snap([{ table: 'fresh', key: ['id'], rows: [{ id: 1 }] }, { table: 'big', key: ['id'], rows: [{ id: 1 }] }]);
    expect(diffSnapshots(before, after, 1).map((c) => `${c.op} ${c.tableName}`)).toEqual(['INSERT fresh']);
  });

  it('finds nothing when nothing changed', () => {
    const s = snap([{ table: 'orders', key: ['id'], rows: [{ id: 1, status: 'PAID' }] }]);
    expect(diffSnapshots(s, s, 1)).toEqual([]);
  });
});
