// Recipes: named, shareable queries that find test data in a given state ("a customer with no orders").
//
// A recipe file is SQL, kept in git next to the tests. Each recipe starts with a "-- recipe: <name>" line,
// followed by header comments and one SELECT:
//
//   -- recipe: Customer with no orders
//   -- For first-purchase tests.                      (any other comment: the description)
//   -- tags: customers, checkout
//   -- param: since date = 2024-01-01 | Signed up on or after this date
//   -- claim: customers                              (or: customers via customer_id)
//   SELECT c.id, c.email FROM customers c WHERE ... AND c.created_at >= :since
//
// :since is a parameter. It is sent to Postgres as a bind value ($1::date), never pasted into the SQL.
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { UserError } from '../core/errors.js';

export const PARAM_TYPES = ['text', 'int', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz', 'interval'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface Param {
  name: string;
  type: ParamType;
  /** The default as written; undefined when the parameter is required. */
  default?: string;
  description?: string;
}

export interface Claim {
  /** The table whose rows are claimed, as written: customers, billing.invoices. */
  table: string;
  /** The result column holding that table's primary key; undefined means the key column's own name. */
  via?: string;
}

export interface Recipe {
  /** Short id made from the name: "customer-with-no-orders". */
  id: string;
  name: string;
  description: string;
  tags: string[];
  params: Param[];
  claim?: Claim;
  sql: string;
  file: string;
  /** Line of the "-- recipe:" header, for error messages. */
  line: number;
}

const HEADER = /^\s*--\s*recipe:\s*(.+?)\s*$/i;
const DIRECTIVE = /^\s*--\s*(tags|param|claim):\s*(.*?)\s*$/i;
const PARAM = /^([a-z_][a-z0-9_]*)\s+([a-z]+)(?:\s*=\s*('(?:[^']|'')*'|[^|]*?))?(?:\s*\|\s*(.*))?$/i;
const CLAIM = /^((?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?:\.(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*))?)(?:\s+via\s+([a-z_][a-z0-9_$]*))?$/i;

export function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'recipe';
}

/** Splits a recipe file into recipes. Text before the first "-- recipe:" line may only be comments. */
export function parseRecipes(text: string, file = 'recipe file'): Recipe[] {
  const recipes: Recipe[] = [];
  let current: { name: string; line: number; lines: { text: string; line: number }[] } | null = null;

  const finish = () => {
    if (!current) return;
    const where = `${file}, line ${current.line}`;
    const recipe: Recipe = { id: slug(current.name), name: current.name, description: '', tags: [], params: [], sql: '', file, line: current.line };
    const description: string[] = [];
    let i = 0;

    // The header: the comment lines right after "-- recipe:".
    for (; i < current.lines.length; i++) {
      const { text: line, line: n } = current.lines[i]!;
      if (!/^\s*--/.test(line)) break;
      const d = DIRECTIVE.exec(line);
      if (!d) {
        description.push(line.replace(/^\s*--\s?/, '').trim());
        continue;
      }
      const [, kind, value] = d as unknown as [string, string, string];
      if (kind.toLowerCase() === 'tags') {
        recipe.tags.push(...value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
      } else if (kind.toLowerCase() === 'param') {
        recipe.params.push(parseParam(value, `${file}, line ${n}`));
      } else {
        if (recipe.claim) throw new UserError(`${file}, line ${n}: recipe "${current.name}" has more than one "-- claim:" line.`);
        const m = CLAIM.exec(value);
        if (!m) throw new UserError(`${file}, line ${n}: can't read "-- claim: ${value}".`, 'Write the table whose rows you claim, e.g. "-- claim: customers", or "-- claim: customers via customer_id" when the key column has another name.');
        recipe.claim = { table: m[1]!, via: m[2] };
      }
    }
    recipe.description = description.join(' ').replace(/\s+/g, ' ').trim();

    const seen = new Set<string>();
    for (const p of recipe.params) {
      if (seen.has(p.name)) throw new UserError(`${where}: parameter :${p.name} is declared twice.`);
      seen.add(p.name);
    }

    recipe.sql = current.lines.slice(i).map((l) => l.text).join('\n').trim().replace(/;\s*$/, '').trim();
    const code = recipe.sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim();
    if (!code) throw new UserError(`Recipe "${current.name}" (${where}) has no query.`);

    // Every :name must be declared, and every declared parameter used: both are usually typos.
    const used = new Set(placeholders(recipe.sql));
    for (const name of used) {
      if (!seen.has(name)) throw new UserError(`Recipe "${current.name}" (${where}) uses :${name}, but has no "-- param: ${name} ..." line.`, `Declare it, e.g.: -- param: ${name} text`);
    }
    for (const name of seen) {
      if (!used.has(name)) throw new UserError(`Recipe "${current.name}" (${where}) declares :${name} but its query never uses it.`);
    }
    recipes.push(recipe);
  };

  text.split(/\r?\n/).forEach((line, i) => {
    const header = HEADER.exec(line);
    if (header) {
      finish();
      current = { name: header[1]!, line: i + 1, lines: [] };
    } else if (current) {
      current.lines.push({ text: line, line: i + 1 });
    } else if (line.trim() && !/^\s*--/.test(line)) {
      throw new UserError(`${file}, line ${i + 1}: SQL before the first "-- recipe: <name>" line.`, 'Start every recipe with a line like: -- recipe: Customer with no orders');
    }
  });
  finish();

  if (recipes.length === 0) throw new UserError(`${file} has no recipes.`, 'Start every recipe with a line like: -- recipe: Customer with no orders');
  return recipes;
}

function parseParam(text: string, where: string): Param {
  const m = PARAM.exec(text);
  if (!m) throw new UserError(`${where}: can't read "-- param: ${text}".`, 'Write it as: -- param: <name> <type> [= <default>] [| <description>], e.g. -- param: min_orders int = 2 | At least this many orders');
  const type = m[2]!.toLowerCase();
  if (!(PARAM_TYPES as readonly string[]).includes(type)) {
    throw new UserError(`${where}: parameter :${m[1]} has an unknown type "${m[2]}".`, `Use one of: ${PARAM_TYPES.join(', ')}.`);
  }
  const param: Param = { name: m[1]!, type: type as ParamType };
  if (m[3] !== undefined) {
    param.default = unquote(m[3]);
    checkValue(param, param.default, where);
  }
  if (m[4]) param.description = m[4].trim();
  return param;
}

/** A default may be quoted so it can hold spaces or a "|": 'two words'. */
function unquote(value: string): string {
  const v = value.trim();
  return /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v;
}

const CHECKS: Partial<Record<ParamType, [RegExp, string]>> = {
  int: [/^[+-]?\d+$/, 'a whole number'],
  bigint: [/^[+-]?\d+$/, 'a whole number'],
  numeric: [/^[+-]?(\d+(\.\d*)?|\.\d+)$/, 'a number'],
  boolean: [/^(true|false|t|f|yes|no|on|off|1|0)$/i, 'true or false'],
  date: [/^\d{4}-\d\d-\d\d$|^(today|yesterday|tomorrow)$/i, 'a date like 2024-01-31'],
};

/** Catches mistyped values before they reach Postgres, with a message that names the parameter. */
export function checkValue(param: Param, value: string, where?: string): void {
  const check = CHECKS[param.type];
  if (check && !check[0].test(value.trim())) {
    throw new UserError(`${where ? `${where}: ` : ''}:${param.name} must be ${check[1]}, not "${value}".`);
  }
}

// ---------- placeholders ----------

/**
 * Finds :name placeholders outside strings, quoted names and comments, and not part of a :: cast.
 * Calls `onPlaceholder` for each one and returns the SQL with each replaced by what it returns.
 */
function scan(sql: string, onPlaceholder: (name: string) => string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === '-' && next === '-') { // line comment
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') { // block comment, nested as in Postgres
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; } else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      out += sql.slice(i, j);
      i = j;
    } else if (ch === "'" || ch === '"') { // string or quoted name; E'..' strings allow backslash escapes
      const escapes = ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[a-zA-Z0-9_]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '$' && !/[a-zA-Z0-9_]/.test(sql[i - 1] ?? '')) { // dollar quotes: $$...$$, $tag$...$tag$
      const tag = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? n : end + tag[0].length;
        out += sql.slice(i, stop);
        i = stop;
      } else {
        out += ch;
        i++;
      }
    } else if (ch === ':' && next === ':') { // a cast
      out += '::';
      i += 2;
    } else if (ch === ':' && /[a-zA-Z_]/.test(next ?? '') && !/[a-zA-Z0-9_\]]/.test(sql[i - 1] ?? '')) {
      const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(sql.slice(i + 1))![0];
      out += onPlaceholder(name.toLowerCase());
      i += 1 + name.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The :name placeholders a query uses, in order of first use. */
export function placeholders(sql: string): string[] {
  const names: string[] = [];
  scan(sql, (name) => {
    if (!names.includes(name)) names.push(name);
    return '';
  });
  return names;
}

/** Fills in parameters: each :name becomes $n::type, and `values` holds the matching bind values. */
export function bind(recipe: Recipe, given: Record<string, string | undefined> = {}): { sql: string; values: (string | null)[] } {
  const unknown = Object.keys(given).filter((k) => !recipe.params.some((p) => p.name === k.toLowerCase()));
  if (unknown.length) {
    const known = recipe.params.map((p) => p.name).join(', ');
    throw new UserError(`"${recipe.name}" has no parameter ${unknown.map((k) => `:${k}`).join(', ')}.`, known ? `Its parameters: ${known}` : 'It takes no parameters.');
  }
  const lower = Object.fromEntries(Object.entries(given).map(([k, v]) => [k.toLowerCase(), v]));

  const values: (string | null)[] = [];
  const index = new Map<string, number>();
  const sql = scan(recipe.sql, (name) => {
    const param = recipe.params.find((p) => p.name === name)!;
    if (!index.has(name)) {
      const value = lower[name] ?? param.default;
      if (value === undefined) throw new UserError(`"${recipe.name}" needs a value for :${name}${param.description ? ` (${param.description})` : ''}.`, `Pass it with -p ${name}=<value>`);
      checkValue(param, value);
      values.push(value);
      index.set(name, values.length);
    }
    return `$${index.get(name)}::${param.type}`;
  });
  return { sql, values };
}

/** Like bind, but every parameter is NULL: enough for EXPLAIN to check a recipe that has required parameters. */
export function bindNulls(recipe: Recipe): { sql: string; values: null[] } {
  const index = new Map<string, number>();
  const sql = scan(recipe.sql, (name) => {
    if (!index.has(name)) index.set(name, index.size + 1);
    return `$${index.get(name)}::${recipe.params.find((p) => p.name === name)!.type}`;
  });
  return { sql, values: Array.from({ length: index.size }, () => null) };
}

// ---------- loading and searching ----------

/** Where recipes live: --recipes, $PROPMASTER_RECIPES, or ./recipes. */
export function resolveRecipesPath(cli?: string): string {
  return resolve(cli ?? process.env.PROPMASTER_RECIPES ?? 'recipes');
}

async function sqlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await sqlFiles(full)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.sql')) files.push(full);
  }
  return files;
}

/** Reads every recipe in a .sql file, or in all .sql files under a folder. Recipe ids must be unique. */
export async function loadRecipes(path: string): Promise<Recipe[]> {
  if (!existsSync(path)) {
    throw new UserError(`Can't find recipes at ${path}.`, 'Pass --recipes <folder or .sql file>, set PROPMASTER_RECIPES, or create a recipes/ folder here.');
  }
  const isDir = statSync(path).isDirectory();
  const files = isDir ? await sqlFiles(path) : [path];
  if (files.length === 0) throw new UserError(`There are no .sql files in ${path}.`, 'Add a recipe file, e.g. recipes/customers.sql (see the README).');

  const recipes: Recipe[] = [];
  for (const file of files) {
    const shown = isDir ? relative(path, file).replace(/\\/g, '/') : file;
    recipes.push(...parseRecipes(await readFile(file, 'utf8'), shown));
  }
  const byId = new Map<string, Recipe>();
  for (const r of recipes) {
    const other = byId.get(r.id);
    if (other) throw new UserError(`Two recipes have the same name: "${r.name}" (${other.file}, line ${other.line} and ${r.file}, line ${r.line}).`, 'Give one of them another name.');
    byId.set(r.id, r);
  }
  return recipes;
}

/**
 * Recipes matching a search: an exact id or name wins; otherwise every word must appear in the name,
 * id, description or tags ("billing negative" finds a recipe tagged billing and negative).
 */
export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const q = query.trim().toLowerCase();
  if (!q) return recipes;
  const exact = recipes.filter((r) => r.id === q || r.name.toLowerCase() === q || r.id === slug(q));
  if (exact.length) return exact;
  const words = q.split(/\s+/);
  return recipes.filter((r) => {
    const haystack = [r.name, r.id, r.description, ...r.tags].join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** Exactly one recipe for a search, or a clear message listing the candidates. */
export function pickRecipe(recipes: Recipe[], query: string): Recipe {
  const found = searchRecipes(recipes, query);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new UserError(`No recipe matches "${query}".`, 'List them all with: propmaster find');
  throw new UserError(`${found.length} recipes match "${query}": ${found.map((r) => r.id).join(', ')}.`, 'Be more specific, or use a recipe id from that list.');
}
