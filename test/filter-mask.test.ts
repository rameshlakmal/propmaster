import { describe, expect, it } from 'vitest';
import { filterRecording, hasFilters, matchesTable, parseOps, parseTime } from '../src/recorder/filter.js';
import { createMasker, isSecretColumn, MASK, maskRecording } from '../src/recorder/mask.js';
import { allChanges } from '../src/recorder/types.js';
import { change, recording, step } from './fixtures.js';

const rec = recording([
  step(1, 'one', [
    change({ tableName: 'orders', dbUser: 'app', appName: 'shop-api', changedAt: new Date('2026-10-07T10:00:01') }),
    change({ tableName: 'order_items', dbUser: 'app', op: 'UPDATE', changedAt: new Date('2026-10-07T10:00:02') }),
    change({ tableSchema: 'billing', tableName: 'invoices', dbUser: 'batch_job', appName: 'cron', changedAt: new Date('2026-10-07T10:00:03') }),
  ]),
  step(2, 'two', [
    change({ tableName: 'sessions', op: 'DELETE', dbUser: 'other_tester', changedAt: new Date('2026-10-07T10:00:04') }),
  ]),
]);

const names = (filters: Parameters<typeof filterRecording>[1]) =>
  allChanges(filterRecording(rec, filters).rec).map((c) => c.tableName);

describe('filters', () => {
  it('matches table names and patterns', () => {
    expect(matchesTable(['orders'], 'public', 'orders')).toBe(true);
    expect(matchesTable(['ORDERS'], 'billing', 'orders')).toBe(true); // any schema, any case
    expect(matchesTable(['order_*'], 'public', 'order_items')).toBe(true);
    expect(matchesTable(['order_*'], 'public', 'orders')).toBe(false);
    expect(matchesTable(['billing.*'], 'billing', 'invoices')).toBe(true);
    expect(matchesTable(['public.invoices'], 'billing', 'invoices')).toBe(false);
  });

  it('filters by table, user, app, operation and step', () => {
    expect(names({ tables: ['order*'] })).toEqual(['orders', 'order_items']);
    expect(names({ exceptTables: ['sessions', 'billing.*'] })).toEqual(['orders', 'order_items']);
    expect(names({ users: ['app'] })).toEqual(['orders', 'order_items']);
    expect(names({ apps: ['cron'] })).toEqual(['invoices']);
    expect(names({ ops: ['UPDATE', 'DELETE'] })).toEqual(['order_items', 'sessions']);
    expect(names({ steps: [2] })).toEqual(['sessions']);
  });

  it('filters by time window', () => {
    expect(names({ since: new Date('2026-10-07T10:00:02'), until: new Date('2026-10-07T10:00:03') })).toEqual(['order_items', 'invoices']);
  });

  it('keeps empty steps and counts what it hid', () => {
    const { rec: out, hidden } = filterRecording(rec, { users: ['batch_job'] });
    expect(out.steps.map((s) => s.changes.length)).toEqual([1, 0]);
    expect(hidden).toBe(3);
  });

  it('knows when no filter is set', () => {
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ tables: [] })).toBe(false);
    expect(hasFilters({ ops: ['INSERT'] })).toBe(true);
  });

  it('parses operations', () => {
    expect(parseOps(['insert', 'Update'])).toEqual(['INSERT', 'UPDATE']);
    expect(() => parseOps(['upsert'])).toThrow(/Unknown operation/);
  });

  it('parses relative, clock and ISO times', () => {
    const now = new Date('2026-10-07T12:00:00');
    expect(parseTime('15m', now)).toEqual(new Date('2026-10-07T11:45:00'));
    expect(parseTime('2h', now)).toEqual(new Date('2026-10-07T10:00:00'));
    expect(parseTime('10:30', now)).toEqual(new Date('2026-10-07T10:30:00'));
    expect(parseTime('09:05:30', now)).toEqual(new Date('2026-10-07T09:05:30'));
    expect(parseTime('2026-10-01T08:00:00Z', now)).toEqual(new Date('2026-10-01T08:00:00Z'));
    expect(() => parseTime('yesterday-ish', now)).toThrow(/Can't read the time/);
  });
});

describe('masking', () => {
  it.each(['password', 'password_hash', 'access_token', 'apiKey', 'api_key', 'client_secret', 'ssn', 'card_number', 'cvv'])(
    'treats %s as secret', (col) => expect(isSecretColumn(col)).toBe(true));

  it.each(['author', 'name', 'passage', 'tokenizer_id', 'pinned', 'status'])(
    'does not treat %s as secret', (col) => expect(isSecretColumn(col)).toBe(false));

  it('hides secrets and partly hides e-mails', () => {
    const mask = createMasker();
    expect(mask('password_hash', '$2b$10$abc')).toEqual({ value: MASK, masked: true });
    expect(mask('email', 'dina@example.com')).toEqual({ value: 'd***@example.com', masked: true });
    expect(mask('contact', 'not an email')).toEqual({ value: 'not an email', masked: false });
    expect(mask('password', null)).toEqual({ value: null, masked: false });
  });

  it('hides extra columns and can leave e-mails alone', () => {
    const mask = createMasker({ columns: ['Phone'], emails: false });
    expect(mask('phone', '+44 7700 900123').masked).toBe(true);
    expect(mask('email', 'dina@example.com').masked).toBe(false);
  });

  it('masks every row of a recording without changing the original', () => {
    const original = recording([step(1, 'signup', [
      change({ tableName: 'users', newValues: { id: 1, email: 'dina@example.com', password: 'hunter2' } }),
      change({ op: 'UPDATE', tableName: 'users', oldValues: { password: 'hunter2' }, newValues: { password: 'hunter3' } }),
    ])]);
    const masked = maskRecording(original, createMasker());
    const [ins, upd] = allChanges(masked);
    expect(ins!.newValues).toEqual({ id: 1, email: 'd***@example.com', password: MASK });
    expect(upd!.oldValues).toEqual({ password: MASK });
    expect(allChanges(original)[0]!.newValues!.password).toBe('hunter2');
  });
});
