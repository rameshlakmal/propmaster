import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/finder/claims.js';
import type { FindResult, RecipeCheck } from '../src/finder/find.js';
import { bind, bindNulls, loadRecipes, parseRecipes, pickRecipe, placeholders, searchRecipes, slug } from '../src/finder/recipes.js';
import { formatChecks, formatFindResult, formatRecipeList } from '../src/finder/report.js';

const colors = pc.createColors(false);

const ONE = [
  '-- File comments before the first recipe are fine.',
  '',
  '-- recipe: Customer with several orders',
  '-- A returning shopper',
  '-- with an order history.',
  '-- tags: Customers, orders',
  '-- param: min_orders int = 2 | At least this many orders',
  '-- param: email text',
  '-- claim: customers via customer_id',
  'SELECT c.id AS customer_id -- the key',
  '  FROM customers c JOIN orders o ON o.customer_id = c.id',
  ' WHERE c.email LIKE :email',
  ' GROUP BY c.id HAVING count(*) >= :min_orders;',
].join('\n');

describe('parseRecipes', () => {
  it('reads the header: description, tags, parameters and the claim', () => {
    const [r] = parseRecipes(ONE, 'customers.sql');
    expect(r).toEqual({
      id: 'customer-with-several-orders',
      name: 'Customer with several orders',
      description: 'A returning shopper with an order history.',
      tags: ['customers', 'orders'],
      params: [
        { name: 'min_orders', type: 'int', default: '2', description: 'At least this many orders' },
        { name: 'email', type: 'text' },
      ],
      claim: { table: 'customers', via: 'customer_id' },
      sql: 'SELECT c.id AS customer_id -- the key\n  FROM customers c JOIN orders o ON o.customer_id = c.id\n WHERE c.email LIKE :email\n GROUP BY c.id HAVING count(*) >= :min_orders',
      file: 'customers.sql',
      line: 3,
    });
  });

  it('splits several recipes and accepts quoted defaults and schema-qualified claims', () => {
    const recipes = parseRecipes([
      '-- recipe: A',
      "-- param: name text = 'two words | and a pipe'",
      '-- claim: billing.invoices',
      'SELECT :name AS name',
      '-- RECIPE:  B  ',
      'SELECT 1',
    ].join('\n'));
    expect(recipes.map((r) => [r.name, r.params[0]?.default, r.claim?.table])).toEqual([
      ['A', 'two words | and a pipe', 'billing.invoices'],
      ['B', undefined, undefined],
    ]);
  });

  it('explains recipes it cannot use', () => {
    expect(() => parseRecipes('SELECT 1', 'r.sql')).toThrow('r.sql, line 1: SQL before the first "-- recipe: <name>" line.');
    expect(() => parseRecipes('-- nothing', 'r.sql')).toThrow('r.sql has no recipes.');
    expect(() => parseRecipes('-- recipe: Empty\n-- tags: x\n', 'r.sql')).toThrow('Recipe "Empty" (r.sql, line 1) has no query.');
    expect(() => parseRecipes('-- recipe: X\nSELECT :id', 'r.sql')).toThrow('uses :id, but has no "-- param: id ..." line');
    expect(() => parseRecipes('-- recipe: X\n-- param: id int\nSELECT 1', 'r.sql')).toThrow('declares :id but its query never uses it');
    expect(() => parseRecipes('-- recipe: X\n-- param: id integer\nSELECT :id', 'r.sql')).toThrow('r.sql, line 2: parameter :id has an unknown type "integer"');
    expect(() => parseRecipes('-- recipe: X\n-- param: id int = two\nSELECT :id', 'r.sql')).toThrow(':id must be a whole number, not "two"');
    expect(() => parseRecipes('-- recipe: X\n-- param: id int\n-- param: id int\nSELECT :id', 'r.sql')).toThrow('parameter :id is declared twice');
    expect(() => parseRecipes('-- recipe: X\n-- claim: customers by id\nSELECT 1', 'r.sql')).toThrow('can\'t read "-- claim: customers by id"');
    expect(() => parseRecipes('-- recipe: X\n-- claim: a\n-- claim: b\nSELECT 1', 'r.sql')).toThrow('more than one "-- claim:" line');
  });

  it('reads the demo recipes', async () => {
    const recipes = await loadRecipes('demo/recipes');
    expect(recipes.map((r) => r.id)).toEqual([
      'customer-who-has-never-ordered', 'customer-with-several-orders', 'order-in-a-given-status',
      'product-low-on-stock', 'product-in-a-price-range', 'order-whose-payment-doesn-t-match-its-total',
    ]);
    expect(recipes.every((r) => r.claim)).toBe(true);
  });
});

describe('placeholders and binding', () => {
  it('ignores casts, strings, quoted names, comments and dollar quotes', () => {
    const sql = [
      "SELECT :a, x::int, ':b', E'\\':c', \"col:d\", $$ :e $$, $t$ :f $t$, arr[1:2]",
      '-- :g in a comment',
      '/* :h /* nested :i */ still :j */',
      'WHERE y = :A AND z = :k_2',
    ].join('\n');
    expect(placeholders(sql)).toEqual(['a', 'k_2']);
  });

  it('turns each :name into a typed bind value, reusing the number when it appears twice', () => {
    const [r] = parseRecipes('-- recipe: X\n-- param: low int = 1\n-- param: high int = 9\n-- param: tag text\nSELECT * FROM t WHERE n BETWEEN :low AND :high OR m = :low AND tag = :tag');
    expect(bind(r!, { tag: 'vip' })).toEqual({
      sql: 'SELECT * FROM t WHERE n BETWEEN $1::int AND $2::int OR m = $1::int AND tag = $3::text',
      values: ['1', '9', 'vip'],
    });
    expect(bind(r!, { tag: 'x', HIGH: '20' }).values).toEqual(['1', '20', 'x']);
    expect(bindNulls(r!).values).toEqual([null, null, null]);
  });

  it('explains missing, unknown and mistyped values', () => {
    const [r] = parseRecipes('-- recipe: X\n-- param: n int | How many\n-- param: on date = today\nSELECT :n, :on');
    expect(() => bind(r!)).toThrow('"X" needs a value for :n (How many).');
    expect(() => bind(r!, { n: '1', nn: '2' })).toThrow('"X" has no parameter :nn.');
    expect(() => bind(r!, { n: '1.5' })).toThrow(':n must be a whole number, not "1.5".');
    expect(() => bind(r!, { n: '1', on: '31/01/2024' })).toThrow(':on must be a date like 2024-01-31');
  });
});

describe('finding recipes', () => {
  const recipes = parseRecipes([
    '-- recipe: Customer who has never ordered', '-- tags: customers, new-user', 'SELECT 1',
    '-- recipe: Customer with several orders', '-- tags: customers, returning', 'SELECT 2',
    '-- recipe: Order in a given status', '-- tags: orders', 'SELECT 3',
  ].join('\n'));

  it('matches an exact id or name first, then every word', () => {
    expect(searchRecipes(recipes, 'order-in-a-given-status').map((r) => r.id)).toEqual(['order-in-a-given-status']);
    expect(searchRecipes(recipes, 'Customer With Several Orders').map((r) => r.id)).toEqual(['customer-with-several-orders']);
    expect(searchRecipes(recipes, 'never').map((r) => r.id)).toEqual(['customer-who-has-never-ordered']);
    expect(searchRecipes(recipes, 'customers returning').map((r) => r.id)).toEqual(['customer-with-several-orders']);
    expect(searchRecipes(recipes, 'customer')).toHaveLength(2);
  });

  it('wants exactly one recipe', () => {
    expect(pickRecipe(recipes, 'status').id).toBe('order-in-a-given-status');
    expect(() => pickRecipe(recipes, 'refund')).toThrow('No recipe matches "refund".');
    expect(() => pickRecipe(recipes, 'customer')).toThrow('2 recipes match "customer": customer-who-has-never-ordered, customer-with-several-orders.');
  });

  it('makes readable ids', () => {
    expect(slug("Order whose payment doesn't match")).toBe('order-whose-payment-doesn-t-match');
    expect(slug('  Ünïcode — café  ')).toBe('unicode-cafe');
  });

  it('loads a folder of files and refuses duplicate names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'propmaster-recipes-'));
    try {
      await mkdir(join(dir, 'billing'));
      await writeFile(join(dir, 'a.sql'), '-- recipe: One\nSELECT 1');
      await writeFile(join(dir, 'billing', 'b.sql'), '-- recipe: Two\nSELECT 2');
      await writeFile(join(dir, 'notes.txt'), 'not a recipe');
      expect((await loadRecipes(dir)).map((r) => [r.name, r.file])).toEqual([['One', 'a.sql'], ['Two', 'billing/b.sql']]);
      await writeFile(join(dir, 'c.sql'), '-- recipe: one\nSELECT 3');
      await expect(loadRecipes(dir)).rejects.toThrow('Two recipes have the same name: "one" (a.sql, line 1 and c.sql, line 1).');
      await expect(loadRecipes(join(dir, 'missing'))).rejects.toThrow("Can't find recipes at");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseDuration', () => {
  it('reads durations with units', () => {
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('45 s')).toBe(45);
    expect(parseDuration('1d')).toBe(86400);
    expect(() => parseDuration('2')).toThrow('"2" is not a duration.');
    expect(() => parseDuration('60d')).toThrow('at most 30 days');
  });
});

describe('Finder terminal output', () => {
  const result: FindResult = {
    recipe: { id: 'r', name: 'Customer who has never ordered', file: 'shop.sql', line: 1 },
    params: { min: '1' },
    columns: ['id', 'email'],
    rows: [
      { values: { id: 2, email: 'bob@example.com' }, key: '2', claimedBy: null },
      { values: { id: 3, email: 'cara@example.com' }, key: '3', claimedBy: { id: '9', table: 'public.customers', key: '3', claimedBy: 'priya', recipe: null, note: null, claimedAt: '2026-01-01T10:00:00.000Z', expiresAt: '2099-01-01T12:00:00.000Z', expired: false } },
    ],
    matches: 5,
    claimed: 1,
    claim: { table: 'public.customers', keyColumn: 'id', column: 'id' },
    ms: 12,
  };

  it('shows the rows, who holds which, and how to get more', () => {
    const out = formatFindResult(result, [], { colors, width: 80 });
    expect(out).toContain('Customer who has never ordered  min=1');
    expect(out).toContain('5 matches · 1 claimed · 12 ms');
    expect(out).toMatch(/│ 2  │ bob@example.com +│ free +│/);
    expect(out).toMatch(/│ 3  │ cara@example.com +│ priya until 2099-01-01 \d\d:\d\d +│/);
    expect(out).toContain('…and 3 more (show more with --limit)');
    expect(out).toContain('run again with --claim');
  });

  it('confirms a claim with the command to release it', () => {
    const mine = { ...result.rows[1]!.claimedBy!, id: '10', key: '2', claimedBy: 'me' };
    const out = formatFindResult(result, [mine], { colors, width: 80 });
    expect(out).toMatch(/│ 2  │ bob@example.com +│ ✔ yours +│/);
    expect(out).toContain('✔ Claimed customers 2 · claim #10');
    expect(out).toContain('→ when you are done: propmaster claims release 10');
  });

  it('says when nothing matches', () => {
    const out = formatFindResult({ ...result, rows: [], matches: 0, claimed: 0 }, [], { colors });
    expect(out).toContain('○ No rows match.');
  });

  it('lists recipes and check results', () => {
    const recipes = parseRecipes(ONE, 'customers.sql');
    const list = formatRecipeList(recipes, 'recipes', { colors, width: 100 });
    expect(list).toContain('1 recipe in recipes');
    expect(list).toContain('min_orders = 2');
    expect(list).toContain('email (required)');

    const checks: RecipeCheck[] = [
      { recipe: recipes[0]!, status: 'ok', how: 'explain', matches: null, ms: 3 },
      { recipe: { ...recipes[0]!, name: 'Empty one' }, status: 'empty', how: 'run', matches: 0, ms: 4 },
      { recipe: { ...recipes[0]!, name: 'Broken one' }, status: 'error', how: 'run', matches: null, ms: 5, error: 'relation "orderz" does not exist.' },
    ];
    const out = formatChecks(checks, { colors, width: 100 });
    expect(out).toContain('planned only (needs a parameter)');
    expect(out).toContain('relation "orderz" does not exist.');
    expect(out).toContain('1 working · 1 found nothing · 1 broken');
    expect(formatChecks(checks, { colors, width: 100, strict: true })).toMatch(/│ ✖ │ Empty one/);
  });
});
