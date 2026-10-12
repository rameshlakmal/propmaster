import { describe, expect, it } from 'vitest';
import { allowedValues, generateValue, type GenerateContext } from '../src/seeder/generate.js';
import { childSpecs, fillPlaceholders, Nested, paramValues, parseScenario, searchScenarios } from '../src/seeder/scenarios.js';
import type { Column, Table } from '../src/seeder/schema.js';

const col = (name: string, over: Partial<Column> = {}): Column => ({
  name, type: 'text', baseType: 'text', category: 'S', notNull: true, hasDefault: false, identity: '', generated: false, ...over,
});

const table = (over: Partial<Table> = {}): Table => ({
  schema: 'public', name: 'customers', key: 'public.customers', columns: [], primaryKey: ['id'], uniques: [['id']], checks: [], foreignKeys: [], ...over,
});

let tokens = 0;
const ctx = (t: Table, over: Partial<GenerateContext> = {}): GenerateContext => ({ table: t, n: 1, token: () => `r7n${++tokens}`, ...over });

describe('allowedValues', () => {
  const check = (definition: string, columns = ['x']) => ({ name: 'c', columns, definition });

  it('reads the lists Postgres prints for IN (...)', () => {
    expect(allowedValues('status', [check("CHECK ((status = ANY (ARRAY['PENDING'::text, 'PAID'::text])))", ['status'])]).choices).toEqual(['PENDING', 'PAID']);
    expect(allowedValues('status', [check("CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'it''s'::character varying])::text[])))", ['status'])]).choices)
      .toEqual(['new', "it's"]);
    expect(allowedValues('kind', [check("CHECK ((kind = 'gift'::text))", ['kind'])]).choices).toEqual(['gift']);
  });

  it('reads number bounds, keeping the tightest', () => {
    expect(allowedValues('x', [check('CHECK ((x > 0))')])).toMatchObject({ min: 0, minExclusive: true });
    expect(allowedValues('x', [check('CHECK ((x >= (0)::numeric))')])).toMatchObject({ min: 0, minExclusive: false });
    expect(allowedValues('x', [check('CHECK (((x >= 1) AND (x <= 5)))')])).toMatchObject({ min: 1, max: 5 });
    expect(allowedValues('x', [check('CHECK ((x >= 1))'), check('CHECK ((x > 3))')])).toMatchObject({ min: 3, minExclusive: true });
    expect(allowedValues('x', [check("CHECK ((x >= '-10'::integer))")])).toMatchObject({ min: -10 });
  });

  it('leaves alone checks with OR, or on several columns', () => {
    expect(allowedValues('x', [check('CHECK (((x > 0) OR (x IS NULL)))')])).toEqual({});
    expect(allowedValues('x', [check('CHECK ((x > y))', ['x', 'y'])])).toEqual({});
    expect(allowedValues('x', [check('CHECK ((y > 0))', ['y'])])).toEqual({});
  });
});

describe('generateValue', () => {
  it('uses an allowed value, the first enum label, or a value inside the bounds', () => {
    const t = table({ checks: [{ name: 'c', columns: ['status'], definition: "CHECK ((status = ANY (ARRAY['PENDING'::text, 'PAID'::text])))" }] });
    expect(generateValue(col('status'), ctx(t))).toBe('PENDING');
    expect(generateValue(col('mood', { category: 'E', enumLabels: ['happy', 'sad'] }), ctx(table()))).toBe('happy');

    const qty = table({ checks: [{ name: 'c', columns: ['qty'], definition: 'CHECK ((qty > 5))' }] });
    expect(generateValue(col('qty', { baseType: 'int4', category: 'N' }), ctx(qty))).toBe('6');
    const rating = table({ checks: [{ name: 'c', columns: ['rating'], definition: 'CHECK (((rating >= 1) AND (rating <= 5)))' }] });
    expect(generateValue(col('rating', { baseType: 'int4', category: 'N' }), ctx(rating))).toBe('1');
  });

  it('respects numeric precision and scale', () => {
    expect(generateValue(col('price', { baseType: 'numeric', category: 'N', precision: 10, scale: 2 }), ctx(table()))).toBe('19.99');
    expect(generateValue(col('rate', { baseType: 'numeric', category: 'N', precision: 3, scale: 2 }), ctx(table()))).toBe('0.10');
    expect(generateValue(col('price', { baseType: 'numeric', category: 'N', precision: 3, scale: 2 }), ctx(table()))).toBe('9.99');
  });

  it('makes unique values unique, and fits them into varchar(n)', () => {
    const t = table({ uniques: [['id'], ['email'], ['code'], ['name']] });
    const email = generateValue(col('email'), ctx(t));
    expect(email).toMatch(/^[a-z]+\.[a-z]+\.r7n\d+@example\.test$/);
    expect(generateValue(col('email'), ctx(t))).not.toBe(email);
    const code = generateValue(col('code', { maxLength: 8 }), ctx(t));
    expect(code.length).toBeLessThanOrEqual(8);
    expect(generateValue(col('name', { maxLength: 12 }), ctx(t)).length).toBeLessThanOrEqual(12);
  });

  it('asks a unique integer for the next free number', () => {
    const t = table({ uniques: [['id'], ['order_no']] });
    expect(generateValue(col('order_no', { baseType: 'int4', category: 'N' }), ctx(t, { uniqueInt: () => 501 }))).toBe('501');
  });

  it('makes names that look like data', () => {
    const people = table({ name: 'customers' });
    expect(generateValue(col('name'), ctx(people))).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(generateValue(col('name'), ctx(table({ name: 'products', key: 'public.products' })))).toMatch(/^[A-Z]/);
    expect(generateValue(col('phone'), ctx(people))).toMatch(/^\+1 555/);
  });

  it('covers the other types', () => {
    expect(generateValue(col('active', { baseType: 'bool', category: 'B' }), ctx(table()))).toBe('true');
    expect(generateValue(col('deleted', { baseType: 'bool', category: 'B' }), ctx(table()))).toBe('false');
    expect(generateValue(col('born', { baseType: 'date', category: 'D' }), ctx(table()))).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(generateValue(col('id', { baseType: 'uuid', category: 'U' }), ctx(table()))).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateValue(col('meta', { baseType: 'jsonb', category: 'U' }), ctx(table()))).toBe('{}');
    expect(generateValue(col('tags', { baseType: '_text', category: 'A' }), ctx(table()))).toBe('{}');
  });

  it('says which column needs a value when it can\'t make one up', () => {
    expect(() => generateValue(col('shape', { type: 'geometry', baseType: 'geometry', category: 'U' }), ctx(table())))
      .toThrow(/Can't make up a value for customers\.shape \(type geometry\)/);
  });
});

describe('parseScenario', () => {
  const yaml = `
name: Two orders
description: >
  A customer with
  two orders.
tags: [Orders, customers]
params:
  status: { type: text, default: PAID }
  qty: int
seed:
  customers:
    name: Pat
    $as: pat
    orders:
      - status: "{{status}}"
        order_items: 2
      - { status: CANCELLED, $count: 2 }
  payments:
    order_id: { $ref: pat }
    amount: "{{qty}}"
`;

  it('reads the header, parameters and rows', () => {
    const s = parseScenario(yaml, 'two-orders.yml');
    expect(s).toMatchObject({ id: 'two-orders', name: 'Two orders', description: 'A customer with two orders.', tags: ['orders', 'customers'] });
    expect(s.params).toEqual([{ name: 'status', type: 'text', default: 'PAID' }, { name: 'qty', type: 'int' }]);
    expect(s.seed.map((r) => [r.table, r.count, r.as])).toEqual([['customers', 1, 'pat'], ['payments', 1, undefined]]);
    expect(s.seed[1]!.fields.order_id).toEqual({ $ref: 'pat' });
    expect(s.seed[0]!.fields.orders).toBeInstanceOf(Nested);
  });

  it('turns nested rows into child specs with their own line numbers', () => {
    const s = parseScenario(yaml, 'two-orders.yml');
    const orders = childSpecs('orders', s.seed[0]!.fields.orders, s.seed[0]!.line, s.file);
    expect(orders.map((o) => [o.count, o.fields.status, o.line])).toEqual([[1, '{{status}}', 15], [2, 'CANCELLED', 17]]);
    expect(childSpecs('order_items', orders[0]!.fields.order_items, 15, s.file)).toEqual([{ table: 'order_items', fields: {}, count: 2, line: 15 }]);
    expect(() => childSpecs('orders', 'x', 3, 'f.yml')).toThrow(/"orders" is a table, so its value must be rows/);
  });

  it('a number of rows, an empty value, or a list', () => {
    const s = parseScenario('seed:\n  customers: 3\n  products:\n  orders:\n    - total: 1\n    - total: 2\n', 'x.yml');
    expect(s.seed.map((r) => [r.table, r.count])).toEqual([['customers', 3], ['products', 1], ['orders', 1], ['orders', 1]]);
  });

  it('explains mistakes with the file and line', () => {
    expect(() => parseScenario('seed:\n  customers:\n   name: x\n  bad', 'a.yml')).toThrow(/a\.yml, line \d+:/);
    expect(() => parseScenario('name: x\n', 'a.yml')).toThrow('a.yml has nothing under "seed:"');
    expect(() => parseScenario('nmae: x\nseed:\n  t: 1\n', 'a.yml')).toThrow('a.yml, line 1: unknown key "nmae"');
    expect(() => parseScenario('seed:\n  t:\n    $cout: 2\n', 'a.yml')).toThrow('a.yml, line 3: unknown setting "$cout"');
    expect(() => parseScenario('seed:\n  t:\n    $as: x\n    $count: 2\n', 'a.yml')).toThrow(/\$as names one row/);
    expect(() => parseScenario('seed:\n  t: -1\n', 'a.yml')).toThrow(/isn't a number of rows/);
    expect(() => parseScenario('seed:\n  t:\n    a: "{{nope}}"\n', 'a.yml')).toThrow('a.yml uses {{nope}}, but has no parameter "nope".');
    expect(() => parseScenario('params:\n  p: int\nseed:\n  t: 1\n', 'a.yml')).toThrow('declares the parameter "p" but never uses it');
    expect(() => parseScenario('params:\n  p: { type: money }\nseed:\n  t:\n    a: "{{p}}"\n', 'a.yml')).toThrow(/unknown type "money"/);
    expect(() => parseScenario('params:\n  p: { type: int, default: two }\nseed:\n  t:\n    a: "{{p}}"\n', 'a.yml')).toThrow(/:p must be a whole number/);
    expect(() => parseScenario('seed:\n  t:\n    a: 1\n    a: 2\n', 'a.yml')).toThrow(/line 4/);
  });

  it('accepts the built-in placeholders', () => {
    expect(() => parseScenario('seed:\n  t:\n    a: "{{run}}-{{n}}-{{ unique }}"\n', 'a.yml')).not.toThrow();
  });
});

describe('parameters and placeholders', () => {
  const s = parseScenario('params:\n  status: { type: text, default: PAID }\n  qty: int\nseed:\n  t:\n    a: "{{status}} {{qty}}"\n', 'p.yml');

  it('fills in defaults and checks given values', () => {
    expect(paramValues(s, { qty: '3' })).toEqual({ status: 'PAID', qty: '3' });
    expect(paramValues(s, { QTY: '3', status: 'NEW' })).toEqual({ status: 'NEW', qty: '3' });
    expect(() => paramValues(s, {})).toThrow('"p" needs a value for "qty"');
    expect(() => paramValues(s, { qty: 'x' })).toThrow(':qty must be a whole number');
    expect(() => paramValues(s, { qty: '1', colour: 'red' })).toThrow('has no parameter "colour"');
  });

  it('fills placeholders, case-insensitively', () => {
    expect(fillPlaceholders('{{Status}}-{{ qty }}!', { status: 'PAID', qty: '2' })).toBe('PAID-2!');
  });

  it('finds scenarios by id, name or words', () => {
    const list = [parseScenario('name: Two orders\ntags: [checkout]\nseed:\n  t: 1\n', 'two-orders.yml'), parseScenario('name: New customer\nseed:\n  t: 1\n', 'new-customer.yml')];
    expect(searchScenarios(list, 'two-orders').map((x) => x.id)).toEqual(['two-orders']);
    expect(searchScenarios(list, 'New Customer').map((x) => x.id)).toEqual(['new-customer']);
    expect(searchScenarios(list, 'checkout').map((x) => x.id)).toEqual(['two-orders']);
  });
});
