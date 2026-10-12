// Values for columns a scenario doesn't give: made up from the column's type, its name and its constraints,
// so the row passes NOT NULL, CHECK, enum, length and unique rules without the tester spelling them out.
import { randomUUID } from 'node:crypto';
import { UserError } from '../core/errors.js';
import type { Check, Column, Table } from './schema.js';

/** What a column's CHECK constraints allow, as far as simple checks can tell. */
export interface Allowed {
  /** IN (...) / = ANY (ARRAY[...]) / = 'x': the value must be one of these. */
  choices?: string[];
  /** Number bounds; `minExclusive` means > rather than >=. */
  min?: number;
  minExclusive?: boolean;
  max?: number;
  maxExclusive?: boolean;
}

const NUMBER = String.raw`\(?'?(-?\d+(?:\.\d+)?)'?\)?(?:::[a-z ]+(?:\(\d+(?:,\s*\d+)?\))?)?`;
const COMPARISON = new RegExp(String.raw`\(?\(?"?([a-z_][a-z0-9_$]*)"?\)?(?:::[a-z ]+)?\s*(>=|<=|>|<|=)\s*${NUMBER}\)`, 'gi');

/**
 * Reads the checks Postgres prints for one column, like CHECK ((qty > 0)), CHECK (((rating >= 1) AND
 * (rating <= 5))) or CHECK ((status = ANY (ARRAY['PENDING'::text, 'PAID'::text]))). Anything with OR, or
 * that reads other columns, is left to the database (and a clear error if the made-up value breaks it).
 */
export function allowedValues(column: string, checks: Check[]): Allowed {
  const allowed: Allowed = {};
  for (const check of checks) {
    if (check.columns.length !== 1 || check.columns[0] !== column) continue;
    const def = check.definition;
    if (/\bOR\b/i.test(def)) continue;

    const list = /=\s*ANY\s*\(+\s*ARRAY\[(.*?)\]/i.exec(def);
    if (list) {
      allowed.choices = [...list[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
      continue;
    }
    const single = /^CHECK \(+"?[a-z_][a-z0-9_$]*"?\)?(?:::[a-z ]+)?\s*=\s*'((?:[^']|'')*)'/i.exec(def);
    if (single) {
      allowed.choices = [single[1]!.replace(/''/g, "'")];
      continue;
    }
    for (const m of def.matchAll(COMPARISON)) {
      if (m[1] !== column) continue;
      const n = Number(m[3]);
      switch (m[2]) {
        case '>': raise(allowed, 'min', n, true); break;
        case '>=': raise(allowed, 'min', n, false); break;
        case '<': raise(allowed, 'max', n, true); break;
        case '<=': raise(allowed, 'max', n, false); break;
        case '=': allowed.min = n; allowed.max = n; allowed.minExclusive = false; allowed.maxExclusive = false; break;
      }
    }
  }
  return allowed;
}

/** Keeps the tighter of two bounds. */
function raise(a: Allowed, side: 'min' | 'max', n: number, exclusive: boolean): void {
  const current = a[side];
  const tighter = current === undefined || (side === 'min' ? n > current || (n === current && exclusive) : n < current || (n === current && exclusive));
  if (!tighter) return;
  a[side] = n;
  if (side === 'min') a.minExclusive = exclusive; else a.maxExclusive = exclusive;
}

// Small word lists, so generated rows look like data rather than noise in the app under test.
const FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Rowan', 'Harper'];
const LAST = ['Fernando', 'Okafor', 'Lindqvist', 'Tanaka', 'Moreau', 'Silva', 'Kowalski', 'Nguyen', 'Haddad', 'Brennan', 'Perera', 'Novak'];
const CITIES = ['Colombo', 'Lisbon', 'Wellington', 'Toronto', 'Osaka', 'Bergen', 'Cape Town', 'Austin'];
const STREETS = ['Harbour Road', 'Station Street', 'Lake Drive', 'Mill Lane', 'Park Avenue', 'Hill Road'];
const THINGS = ['Trail Mug', 'Canvas Tote', 'Field Notebook', 'Desk Lamp', 'Wool Socks', 'Steel Bottle', 'Day Pack', 'Rain Shell'];
const PEOPLE_TABLES = /(^|_)(customer|user|person|people|employee|member|account|author|contact|client|staff|student|patient|player)s?$/i;

export interface GenerateContext {
  table: Table;
  /** 1-based number of the row within its list in the scenario. */
  n: number;
  /** A short token unique to this run and row: r42a7. Changes on every call. */
  token: () => string;
  /** The next free number for a unique integer column (from the table's current max). */
  uniqueInt?: (column: string) => number;
}

const pick = <T>(list: T[], n: number): T => list[(n - 1) % list.length]!;
const isUnique = (table: Table, column: string) => table.uniques.some((u) => u.length === 1 && u[0] === column);

/** Fits text into varchar(n), keeping the unique token at the end when there is one. */
function fit(text: string, max: number | undefined, token?: string): string {
  if (max === undefined || text.length <= max) return text;
  if (token && token.length < max) return text.slice(0, max - token.length - 1).replace(/[\s.-]+$/, '') + (max - token.length - 1 > 0 ? '-' : '') + token;
  return text.slice(0, max);
}

/** A value for a required column, as text for Postgres to cast to the column's type. */
export function generateValue(column: Column, ctx: GenerateContext): string {
  const { table } = ctx;
  const allowed = allowedValues(column.name, table.checks);
  if (allowed.choices?.length) return allowed.choices[0]!;
  if (column.enumLabels?.length) return column.enumLabels[0]!;

  const unique = isUnique(table, column.name);
  const name = column.name.toLowerCase();

  switch (column.category) {
    case 'N': return number(column, name, allowed, unique, ctx);
    case 'S': return text(column, name, unique, ctx);
    case 'B': return /^(is_)?(active|enabled|visible|published|verified|confirmed)$/.test(name) ? 'true' : 'false';
    case 'D': return dateTime(column);
    case 'A': return '{}';
    case 'T': return '1 hour';
    case 'I': return column.baseType === 'cidr' ? '192.0.2.0/24' : `192.0.2.${(ctx.n % 250) + 1}`;
  }
  switch (column.baseType) {
    case 'uuid': return randomUUID();
    case 'json': case 'jsonb': return '{}';
    case 'bytea': return '\\x';
    case 'macaddr': return '08:00:2b:01:02:03';
    case 'bit': case 'varbit': return '1';
  }
  throw new UserError(
    `Can't make up a value for ${table.name}.${column.name} (type ${column.type}).`,
    `Give it in the scenario, e.g.  ${column.name}: <value>`);
}

function number(column: Column, name: string, allowed: Allowed, unique: boolean, ctx: GenerateContext): string {
  const integer = ['int2', 'int4', 'int8'].includes(column.baseType) || column.scale === 0;
  let value: number;
  if (unique && ctx.uniqueInt) value = ctx.uniqueInt(column.name);
  else if (/price|amount|total|cost|fee|balance|subtotal/.test(name)) value = integer ? 20 : 19.99;
  else if (/stock|inventory|available/.test(name)) value = 10;
  else if (/^age$/.test(name)) value = 30;
  else if (/year/.test(name)) value = new Date().getFullYear();
  else if (/percent|rate|discount/.test(name)) value = integer ? 10 : 0.1;
  else value = 1;

  const step = integer ? 1 : 1 / 10 ** (column.scale ?? 2);
  const low = allowed.min === undefined ? undefined : allowed.minExclusive ? allowed.min + step : allowed.min;
  const high = allowed.max === undefined ? undefined : allowed.maxExclusive ? allowed.max - step : allowed.max;
  if (low !== undefined && value < low) value = integer ? Math.ceil(low) : low;
  if (high !== undefined && value > high) value = integer ? Math.floor(high) : high;

  // numeric(3, 2) holds at most 9.99.
  if (column.precision !== undefined) {
    const limit = 10 ** (column.precision - (column.scale ?? 0)) - step;
    if (value > limit) value = limit;
  }
  if (column.baseType === 'int2' && value > 32767) value = 32767;
  return integer ? String(Math.round(value)) : value.toFixed(column.scale ?? 2);
}

function text(column: Column, name: string, unique: boolean, ctx: GenerateContext): string {
  const { table, n } = ctx;
  const max = column.maxLength;
  const first = pick(FIRST, n);
  const last = pick(LAST, n + 3);
  const tok = ctx.token();
  // Values that already hold the token are unique; the others get it appended when the column is unique.
  const withToken = (base: string) => fit(unique ? `${base} ${tok}` : base, max, unique ? tok : undefined);

  if (/e_?mail/.test(name)) return fit(`${first}.${last}.${tok}@example.test`.toLowerCase(), max, tok);
  if (/^(first_?name|given_?name|forename)$/.test(name)) return withToken(first);
  if (/^(last_?name|surname|family_?name)$/.test(name)) return withToken(last);
  if (/^(full_?name|display_?name|name|contact_?name|customer_?name|user_?name)$/.test(name) && PEOPLE_TABLES.test(table.name) || /^(full_?name|display_?name|contact_?name|customer_?name)$/.test(name)) {
    return withToken(`${first} ${last}`);
  }
  if (/^(username|login|handle)$/.test(name)) return fit(`${first}.${tok}`.toLowerCase(), max, tok);
  if (/^(name|title|label)$/.test(name)) return withToken(table.name.match(/product|item|article|sku/i) ? pick(THINGS, n) : `Test ${singular(table.name)} ${n}`);
  if (/phone|mobile|tel/.test(name)) return fit(`+1 555 01${String(n % 100).padStart(2, '0')}`, max);
  if (/city|town/.test(name)) return withToken(pick(CITIES, n));
  if (/country/.test(name)) return max !== undefined && max <= 3 ? 'LK'.slice(0, max) : withToken('Sri Lanka');
  if (/currency/.test(name)) return 'USD'.slice(0, max ?? 3);
  if (/street|address|line_?1/.test(name)) return withToken(`${(n % 90) + 10} ${pick(STREETS, n)}`);
  if (/zip|postcode|postal/.test(name)) return fit(`1000${n % 10}`, max);
  if (/url|website|link|href/.test(name)) return fit(`https://example.test/${tok}`, max, tok);
  if (/slug/.test(name)) return fit(`test-${singular(table.name)}-${tok}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), max, tok);
  if (/sku|code|number|ref|reference|serial/.test(name)) return fit(`${name.slice(0, 3).toUpperCase()}-${tok.toUpperCase()}`, max, tok.toUpperCase());
  if (/description|summary|note|comment|body|bio|message|details/.test(name)) return withToken('Created by Propmaster for a test.');
  if (/password|hash|secret/.test(name)) return withToken('propmaster-test-password');
  if (/^(status|state)$/.test(name)) return withToken('active');
  if (/^(type|kind|category|role|method)$/.test(name)) return withToken('test');
  return fit(`${name.replace(/_/g, '-')}-${tok}`, max, tok);
}

function singular(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.endsWith('ies') ? `${words.slice(0, -3)}y` : words.endsWith('ses') ? words.slice(0, -2) : words.replace(/s$/, '');
}

function dateTime(column: Column): string {
  const now = new Date();
  switch (column.baseType) {
    case 'date': return now.toISOString().slice(0, 10);
    case 'time': case 'timetz': return '12:00:00';
    case 'timestamp': return now.toISOString().replace('T', ' ').replace('Z', '');
    default: return now.toISOString();
  }
}
