// Scenarios: YAML files that describe the rows a test needs, kept in git next to the tests.
//
//   name: Customer with two orders
//   description: One paid order with two items, one cancelled order.
//   tags: [orders, checkout]
//   params:
//     status: { type: text, default: PAID }
//   seed:
//     customers:
//       name: Pat Two-Orders          # a column value
//       orders:                       # child rows (a table), linked by its foreign key to customers
//         - status: "{{status}}"
//           order_items: 2            # two generated rows
//         - status: CANCELLED
//
// Whether a key is a column or a child table is decided against the database when seeding: this file
// only checks the shape, the parameters and the placeholders.
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';
import { UserError } from '../core/errors.js';
import { checkValue, PARAM_TYPES, slug, type Param, type ParamType } from '../finder/recipes.js';

/** A row (or `count` rows) of one table, with its values and child rows. */
export interface RowSpec {
  /** The table as written: customers, billing.invoices. */
  table: string;
  /** Column (or child table) → value as written. Decided against the schema when seeding. */
  fields: Record<string, unknown>;
  /** How many copies of the row ($count, or a number given for the table). */
  count: number;
  /** $as: a name other rows can point at with { $ref: name }. */
  as?: string;
  /** $via: the foreign key column (in this table) that links it to its parent row. */
  via?: string;
  /** Where it is in the file, for messages. */
  line: number;
}

export interface Scenario {
  /** From the file name: two-orders. */
  id: string;
  name: string;
  description: string;
  tags: string[];
  params: Param[];
  /** The top-level rows, in file order. */
  seed: RowSpec[];
  file: string;
}

const BUILT_IN = new Set(['run', 'n', 'unique']);
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const TOP_LEVEL = new Set(['name', 'description', 'tags', 'params', 'seed']);
const SPECIAL = new Set(['$count', '$as', '$via']);

/** Reads one scenario file. `file` is how it is named in messages. */
export function parseScenario(text: string, file = 'scenario.yml'): Scenario {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const at = (node: YamlNode | null | undefined) => (node?.range ? lines.linePos(node.range[0]).line : 1);
  if (doc.errors.length) {
    const e = doc.errors[0]!;
    throw new UserError(`${file}, line ${lines.linePos(e.pos[0]).line}:${e.message.split('\n')[0]}`, 'Check the YAML: indentation, colons after names, quotes around text with ": " or "#".');
  }
  const root = doc.contents;
  if (!isMap(root)) throw new UserError(`${file}: a scenario is a YAML mapping with "name:" and "seed:".`, 'See scenarios/ in the demo for an example.');

  const id = slug(basename(file, extname(file)));
  const scenario: Scenario = { id, name: id, description: '', tags: [], params: [], seed: [], file };

  for (const pair of root.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : '';
    const where = `${file}, line ${at(pair.key as YamlNode)}`;
    if (!TOP_LEVEL.has(key)) throw new UserError(`${where}: unknown key "${key}".`, 'A scenario has: name, description, tags, params and seed.');
    const value = pair.value as YamlNode | null;
    const plain = value ? (value as YamlNode & { toJSON(): unknown }).toJSON() : null;

    if (key === 'name' || key === 'description') {
      if (typeof plain !== 'string' || !plain.trim()) throw new UserError(`${where}: "${key}" must be text.`);
      scenario[key] = plain.replace(/\s+/g, ' ').trim();
    } else if (key === 'tags') {
      const list = Array.isArray(plain) ? plain : typeof plain === 'string' ? plain.split(',') : null;
      if (!list) throw new UserError(`${where}: "tags" must be a list, e.g. tags: [orders, checkout]`);
      scenario.tags = list.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    } else if (key === 'params') {
      scenario.params = parseParams(plain, where);
    } else {
      if (!isMap(value)) throw new UserError(`${where}: "seed" must map table names to rows.`, 'For example:\nseed:\n  customers:\n    name: Pat');
      for (const p of value.items) {
        const table = isScalar(p.key) ? String(p.key.value) : '';
        scenario.seed.push(...rowSpecs(table, p.value as YamlNode | null, at(p.key as YamlNode), at, file));
      }
    }
  }
  if (scenario.seed.length === 0) throw new UserError(`${file} has nothing under "seed:".`, 'Add the rows to create, e.g.\nseed:\n  customers: 1');
  checkPlaceholders(scenario);
  return scenario;
}

function parseParams(value: unknown, where: string): Param[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new UserError(`${where}: "params" maps names to types, e.g. params:\n  status: { type: text, default: PAID }`);
  }
  return Object.entries(value as Record<string, unknown>).map(([name, spec]) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new UserError(`${where}: "${name}" is not a parameter name (letters, digits and _).`);
    const s = typeof spec === 'string' ? { type: spec } : spec;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new UserError(`${where}: parameter "${name}" needs a type, e.g. ${name}: { type: int, default: 2 }`);
    const { type = 'text', default: def, description, ...rest } = s as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length) throw new UserError(`${where}: parameter "${name}" has an unknown setting "${extra[0]}".`, 'Use type, default and description.');
    const t = String(type).toLowerCase();
    if (!(PARAM_TYPES as readonly string[]).includes(t)) throw new UserError(`${where}: parameter "${name}" has an unknown type "${String(type)}".`, `Use one of: ${PARAM_TYPES.join(', ')}.`);
    const param: Param = { name: name.toLowerCase(), type: t as ParamType };
    if (def !== undefined && def !== null) {
      param.default = String(def);
      checkValue(param, param.default, where);
    }
    if (description !== undefined) param.description = String(description);
    return param;
  });
}

/** The rows a table key stands for: a mapping is one row, a list is several, a number is that many generated rows. */
function rowSpecs(table: string, node: YamlNode | null, line: number, at: (n: YamlNode | null | undefined) => number, file: string): RowSpec[] {
  if (!table) throw new UserError(`${file}, line ${line}: a table name is missing.`);
  if (node === null || (isScalar(node) && node.value === null)) return [{ table, fields: {}, count: 1, line }];
  if (isScalar(node)) {
    const n = node.value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000) {
      throw new UserError(`${file}, line ${line}: "${table}: ${String(n)}" isn't a number of rows (0 to 1000), a row, or a list of rows.`,
        `If "${table}" is a column, it belongs inside a row of its table.`);
    }
    return n === 0 ? [] : [{ table, fields: {}, count: n, line }];
  }
  if (isSeq(node)) {
    return node.items.flatMap((item) => rowSpecs(table, item as YamlNode | null, at(item as YamlNode), at, file));
  }
  if (!isMap(node)) throw new UserError(`${file}, line ${line}: can't read the rows of "${table}".`);

  const spec: RowSpec = { table, fields: {}, count: 1, line };
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : '';
    const where = `${file}, line ${at(pair.key as YamlNode)}`;
    const value = pair.value as YamlNode | null;
    const plain = value ? (value as YamlNode & { toJSON(): unknown }).toJSON() : null;
    if (key.startsWith('$')) {
      if (!SPECIAL.has(key)) throw new UserError(`${where}: unknown setting "${key}".`, 'Settings are $count, $as and $via.');
      if (key === '$count') {
        if (typeof plain !== 'number' || !Number.isInteger(plain) || plain < 0 || plain > 1000) throw new UserError(`${where}: $count must be a whole number from 0 to 1000.`);
        spec.count = plain;
      } else {
        if (typeof plain !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(plain)) throw new UserError(`${where}: ${key} must be a name (letters, digits and _).`);
        if (key === '$as') spec.as = plain; else spec.via = plain;
      }
      continue;
    }
    if (!key) throw new UserError(`${where}: a column or table name is missing.`);
    // Child rows stay as YAML nodes, so their line numbers survive; values become plain JSON.
    spec.fields[key] = (isMap(value) && !isRef(plain)) || (isSeq(value) && value.items.some((i) => isMap(i)))
      ? new Nested(value, at(value), at)
      : plain;
  }
  if (spec.as && spec.count !== 1) throw new UserError(`${file}, line ${line}: $as names one row, but this is ${spec.count} rows.`, 'Give each row its own $as, or drop $count.');
  return spec.count === 0 ? [] : [spec];
}

/** { $ref: name }: the key of the row named `name` with $as. */
export function isRef(value: unknown): value is { $ref: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { $ref?: unknown }).$ref === 'string';
}

/**
 * A field kept as YAML because it may be child rows (a mapping, or a list of mappings). The seeder turns it
 * into rows when the key is a table, or into a plain value (JSON) when it is a column.
 */
export class Nested {
  constructor(readonly node: YamlNode, readonly line: number, readonly at: (n: YamlNode | null | undefined) => number) {}

  toJSON(): unknown {
    return (this.node as YamlNode & { toJSON(): unknown }).toJSON();
  }
}

/** Child rows under a key of a row: a number, a mapping or a list. Called once the key is known to be a table. */
export function childSpecs(table: string, value: unknown, line: number, file: string): RowSpec[] {
  if (value instanceof Nested) return rowSpecs(table, value.node, value.line, value.at, file);
  if (value === null || value === undefined) return [{ table, fields: {}, count: 1, line }];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000) return value === 0 ? [] : [{ table, fields: {}, count: value, line }];
  throw new UserError(`${file}, line ${line}: "${table}" is a table, so its value must be rows (a mapping, a list or a number from 0 to 1000), not ${JSON.stringify(value)}.`);
}

/** Every {{name}} must be a parameter or a built-in, and every parameter must be used. */
function checkPlaceholders(scenario: Scenario): void {
  const used = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER)) used.add(m[1]!.toLowerCase());
    else if (value instanceof Nested) visit(value.toJSON());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const spec of scenario.seed) visit(spec.fields);
  const declared = new Set(scenario.params.map((p) => p.name));
  for (const name of used) {
    if (!declared.has(name) && !BUILT_IN.has(name)) {
      throw new UserError(`${scenario.file} uses {{${name}}}, but has no parameter "${name}".`, `Declare it under params, e.g.  ${name}: { type: text }  (built in: {{run}}, {{n}}, {{unique}})`);
    }
  }
  for (const name of declared) {
    if (!used.has(name)) throw new UserError(`${scenario.file} declares the parameter "${name}" but never uses it.`, `Use it in a value as "{{${name}}}", or remove it.`);
  }
}

/** Replaces {{name}} in text. A value that is exactly one placeholder keeps the placeholder's value as is. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => values[name.toLowerCase()] ?? '');
}

/** Parameter values: given ones (checked against their type), else defaults. A missing required one is an error. */
export function paramValues(scenario: Scenario, given: Record<string, string> = {}): Record<string, string> {
  const lower = Object.fromEntries(Object.entries(given).map(([k, v]) => [k.toLowerCase(), v]));
  const unknown = Object.keys(lower).filter((k) => !scenario.params.some((p) => p.name === k));
  if (unknown.length) {
    const known = scenario.params.map((p) => p.name).join(', ');
    throw new UserError(`"${scenario.name}" has no parameter ${unknown.map((k) => `"${k}"`).join(', ')}.`, known ? `Its parameters: ${known}` : 'It takes no parameters.');
  }
  const out: Record<string, string> = {};
  for (const p of scenario.params) {
    const value = lower[p.name] ?? p.default;
    if (value === undefined) throw new UserError(`"${scenario.name}" needs a value for "${p.name}"${p.description ? ` (${p.description})` : ''}.`, `Pass it with -p ${p.name}=<value>`);
    checkValue(p, value);
    out[p.name] = value;
  }
  return out;
}

// ---------- loading and searching ----------

/** Where scenarios live: --scenarios, $PROPMASTER_SCENARIOS, or ./scenarios. */
export function resolveScenariosPath(cli?: string): string {
  return resolve(cli ?? process.env.PROPMASTER_SCENARIOS ?? 'scenarios');
}

const isYaml = (name: string) => /\.ya?ml$/i.test(name);

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await yamlFiles(full)));
    else if (e.isFile() && isYaml(e.name)) files.push(full);
  }
  return files;
}

/** Reads every scenario in a folder (or one file). Ids come from file names and must be unique. */
export async function loadScenarios(path: string): Promise<Scenario[]> {
  if (!existsSync(path)) {
    throw new UserError(`Can't find scenarios at ${path}.`, 'Pass --scenarios <folder or .yml file>, set PROPMASTER_SCENARIOS, or create a scenarios/ folder here.');
  }
  const isDir = statSync(path).isDirectory();
  const files = isDir ? await yamlFiles(path) : [path];
  if (files.length === 0) throw new UserError(`There are no .yml files in ${path}.`, 'Add a scenario, e.g. scenarios/two-orders.yml (see the README).');
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const shown = isDir ? relative(path, file).replace(/\\/g, '/') : file;
    scenarios.push(parseScenario(await readFile(file, 'utf8'), shown));
  }
  const byId = new Map<string, Scenario>();
  for (const s of scenarios) {
    const other = byId.get(s.id);
    if (other) throw new UserError(`Two scenario files have the same name: ${other.file} and ${s.file}.`, 'Rename one of them.');
    byId.set(s.id, s);
  }
  return scenarios;
}

/** Scenarios matching a search: an exact id or name wins; otherwise every word must appear. */
export function searchScenarios(scenarios: Scenario[], query: string): Scenario[] {
  const q = query.trim().toLowerCase();
  if (!q) return scenarios;
  const exact = scenarios.filter((s) => s.id === q || s.name.toLowerCase() === q || s.id === slug(q));
  if (exact.length) return exact;
  const words = q.split(/\s+/);
  return scenarios.filter((s) => {
    const haystack = [s.name, s.id, s.description, ...s.tags].join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export function pickScenario(scenarios: Scenario[], query: string): Scenario {
  const found = searchScenarios(scenarios, query);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new UserError(`No scenario matches "${query}".`, 'List them all with: propmaster seed');
  throw new UserError(`${found.length} scenarios match "${query}": ${found.map((s) => s.id).join(', ')}.`, 'Be more specific, or use a scenario id from that list.');
}
