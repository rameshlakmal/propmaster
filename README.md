# Propmaster

**See exactly what the database did while you tested.**

Propmaster is a test-data toolkit for QA engineers, built on PostgreSQL. Tool 1, the **DB Change Recorder**, records every insert, update and delete your test causes, grouped by the test step that caused it. Then it checks the recording against your business rules, and turns it into a bug-ticket report or SQL checks you can re-run.

> "I clicked **Place Order** and the screen said 'Success'. But did it create the payment row? Did it reduce the stock? Did it change something else?"

![Propmaster demo](demo/gif/propmaster-demo.gif)

```
$ propmaster record start "Checkout happy path"
 ● REC  Session #12 · Checkout happy path                       6 tables watched
   → before each test step: propmaster record step "<name>"
   → when you are done:    propmaster record stop
$ propmaster record step "Click Place Order"
   ...the tester clicks through the app...
$ propmaster record step "Cancel the order"
$ propmaster record stop
 ■ Stopped session #12

  PROPMASTER   Session #12 · Checkout happy path
 qa_shop · 2026-10-07 11:01:59 → 11:02:27 (28s) · UTC+05:30

 STEP 1  Click Place Order                                             4 changes
   ~ update    inventory    product_id=3   stock 20 → 18
   + insert    orders       id=54
               customer_id=45 status='PENDING' total=84.50
               created_at='2026-10-07T11:02:05.586281+00:00'
   + insert    order_items  id=54
               order_id=54 product_id=3 qty=2 unit_price=42.25
   + insert    payments     id=54
               order_id=54 amount=84.50 method='CARD' status='AUTHORIZED'

 STEP 2  Cancel the order                                              2 changes
   ~ update    orders       id=54   status 'PENDING' → 'CANCELLED'
   ~ update    inventory    product_id=3   stock 18 → 20

 ──────────────────────────────────────────────────────────────────────────────
 6 changes · 4 tables · 3 inserts · 3 updates
```

## Why

- Bug reports say "it broke" without proof of what the data looked like.
- The UI can say "Success" while the database tells another story: a missing payment row, stock that didn't change, or an unrelated table that did.
- Audit tools serve compliance and diff tools serve data engineers. Nothing records database changes **per test step, for the tester**.

## Quick start

**Just want to see it?** With only Docker installed:

```sh
docker compose run --rm demo   # starts Postgres with the demo shop, then records, reports and checks rules
```

**To use it,** with Node 22.12+ and Docker:

```sh
npm install
npm run db:up        # PostgreSQL 17 with the qa_shop demo database, on port 5433
cp .env.example .env

npm run demo         # the whole flow in one command: record, timeline, HTML/Markdown/SQL exports
```

Or step by step, with the demo shop standing in for the app's buttons:

```sh
npm run propmaster -- install
npm run propmaster -- record start "My test"
npm run propmaster -- record step "Click Place Order"
npm run shop -- order 1 3 2
npm run propmaster -- record stop
npm run propmaster -- record export --open
```

Installed as a package, the command is `propmaster`, or `prop` for short (`prop record start "My test"`).

Not sure what your DB user is allowed to do? Run `propmaster doctor`.

## Two ways to record

| | Trigger mode (default) | Snapshot mode (`--snapshot`) |
|---|---|---|
| Needs | `CREATE` on the database and `TRIGGER` on the tables (`doctor` lists the grants) | Only `SELECT` |
| Sees | Every change as it happens, with DB user, application, client address and transaction ID | The difference between snapshots taken at each step |
| Misses | Nothing in watched tables | Who made a change; a row changed twice within one step shows once |
| Leaves in the DB | The `_propmaster` schema (removed by `propmaster uninstall`) | Nothing. Snapshots are kept under `.propmaster/` while recording |

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Checks what your DB user can do, recommends a mode, and lists the GRANTs to ask a DBA for. |
| `install` / `uninstall` | Adds or removes the recorder (`uninstall` asks you to type `uninstall`, or pass `--yes`). Re-running `install` upgrades in place. |
| `record start [name]` | Starts a session. `--snapshot` for snapshot mode, with `--exclude` and `--max-rows`. |
| `record step <name>` | Starts the next test step. Changes before the first step go into step 0. |
| `record stop` | Stops and prints the timeline. |
| `record status` / `list` | Is anything recording? Which sessions exist? |
| `record show [id]` | Prints a session's timeline (default: the latest). |
| `record export [id]` | Writes `--format html` (default), `md` or `sql`. See below. |
| `record check <rules.sql> [id]` | Checks business rules against the rows a session touched. See below. |
| `record delete <id>` / `prune --older-than "7 days"` | Housekeeping. |
| `record exclude <table…>` / `include <table…>` | Stop or resume watching busy tables such as `sessions` or `audit_log`. |

**Filters** work with `show`, `stop` and `export`:
`--table orders,order_*,billing.*` · `--except-table` · `--user` · `--app` · `--op insert,update` · `--since 15m` · `--until 10:30` · `--step 2,3`

Another tester or a background job writing to the same database? Filter by `--user` or `--app`: every change stores who made it.

## Exports

- **HTML** (default). A self-contained page for a bug ticket: before and after values side by side with changes highlighted, search, operation filters, and light and dark themes. It loads nothing from the internet. `--open` opens it.
- **Markdown** for GitHub issues, Jira and pull requests.
- **SQL checks** that verify the database ends up in the recorded state, for regression tests:

  ```sql
  SELECT step, check_name, pass
    FROM (VALUES
      (1, 'public.inventory product_id=3 was updated with stock', EXISTS (SELECT 1 FROM "public"."inventory" t WHERE to_jsonb(t.*) @> '{"product_id":3,"stock":4}'::jsonb)),
      (2, 'public.orders id=1 was inserted with customer_id, status, total', EXISTS (...)),
      ...
  ```

  `--strict` gives a `DO` block that raises an error naming the failed checks, for CI. `--ignore-columns id,order_id` leaves out generated ids, so checks still pass when the test runs again. Timestamp columns are left out unless you pass `--include-timestamps`.

## Business rule checks

Recorded values tell you what the app *did*. Rules say what it *should* do, so when a requirement changes you change one rule, not dozens of recorded values.

A rules file is plain SQL. Each rule is a query that returns the rows **breaking** it; no rows means the rule holds. `{{orders}}` means "the orders rows this session inserted or updated", so a rule checks exactly what your test touched:

```sql
-- rule: Order total is the items' price, with 10% off for 2 or more items
SELECT o.id AS order_id, o.total,
       round(sum(i.qty * i.unit_price) * CASE WHEN sum(i.qty) >= 2 THEN 0.9 ELSE 1 END, 2) AS expected
  FROM {{orders}} o
  JOIN order_items i ON i.order_id = o.id
 GROUP BY o.id, o.total
HAVING o.total <> round(sum(i.qty * i.unit_price) * CASE WHEN sum(i.qty) >= 2 THEN 0.9 ELSE 1 END, 2);

-- rule: Payment amount matches the order total
SELECT p.order_id, p.amount, o.total
  FROM {{payments}} p JOIN orders o ON o.id = p.order_id
 WHERE p.amount <> o.total;
```

```
$ propmaster record check demo/rules.sql
  PROPMASTER   Session #13 · Checkout on build v2
 rule check · 4 rules from demo/rules.sql

 ✔ Order total is the items' price, with 10% off for 2 or more items  1 row of orders
 ✖ Payment amount matches the order total       1 violation in 1 row of payments
     order_id   amount   total
     55         84.50    76.05
 ✔ Every order in the session has exactly one payment            1 row of orders
 ✔ Items are charged at the product's current price         1 row of order_items

 ──────────────────────────────────────────────────────────────────────────────
 3 passed · 1 failed
```

- The exit code is 1 when a rule fails or can't run, so `record check` can gate a CI pipeline.
- A rule whose tables the session never touched is **skipped**, not passed, so you can see it checked nothing.
- `--all-rows` makes `{{table}}` mean the whole table, for checking existing data against a new rule.
- Rules run in a **read-only transaction** with a time limit (`--timeout`, default 30 s), one statement each. A rule can't change data, so rules are safe in snapshot mode too.
- `npm run demo` plays the whole story: requirement v2 adds a discount, [build v2](demo/build-v2.sql) applies it to the order but not the payment, and [the rules](demo/rules.sql) catch it.

**Which check to use:** SQL checks from `record export --format sql` pin down *exact values* (great for "nothing else changed" regression runs). Rules state *how values relate* (great for requirements, and they survive changes in data and ids).

**Masking.** Exports hide passwords, tokens, API keys, card numbers and e-mail addresses (`d***@example.com`) by default. `--no-mask` turns that off, and `--mask-columns phone,dob` adds your own. Masked columns are left out of SQL checks. The terminal shows real values unless you pass `--mask`.

## How it works

All of trigger mode is in [`sql/recorder.sql`](sql/recorder.sql).

- **Statement-level triggers with transition tables.** `AFTER … FOR EACH STATEMENT REFERENCING OLD TABLE / NEW TABLE`: one trigger call per statement, and all its rows go into `_propmaster.changes` with one set-based `INSERT … SELECT`. A 50,000-row `UPDATE` is one trigger call, not 50,000.
- **Updates store only what changed.** Old and new rows are compared with `jsonb_each`, and updates that change nothing are skipped. Old and new rows are paired by position in the transition tables, which Postgres fills in step. That works for tables without a primary key and for updates that change the key.
- **Free when idle.** On tables the recorder owns, triggers are disabled between sessions (`ALTER TABLE … DISABLE TRIGGER`). A one-row switch, `_propmaster.state`, is the backstop for tables it can't disable.
- **It never breaks the app's writes.** Capturing runs in an exception block, so a failure becomes a `WARNING` and the app's statement still succeeds. It's one block per statement, so there's no subtransaction per row.
- **Built for write speed.** `_propmaster.changes` is `UNLOGGED` (no write-ahead log) and has no foreign keys. Measured, these halved the cost of recording. The catch is that a database crash empties the recorded changes; sessions and steps survive.
- **Exact values.** Values are stored as JSONB with `to_jsonb(row.*)`, and the CLI parses JSON losslessly, so `84.50` stays `84.50` and big `bigint`s stay exact.
- **Primary keys are read once,** from `pg_index` when a trigger is attached, and passed as trigger arguments.
- **Partitions and inheritance** are recorded under the table the statement named, never twice.
- **New tables** are picked up on every `start` and `step`.

SQL shown off: PL/pgSQL triggers, transition tables, JSONB, `pg_catalog` introspection, dynamic SQL with `format('%I')`, `REPEATABLE READ` snapshots, jsonb containment, and lock timeouts.

## Performance

`npm run bench`, PostgreSQL 17 in Docker Desktop on Windows, medians of interleaved runs:

| Workload | No recorder | Installed, idle | Recording |
|---|---|---|---|
| One `UPDATE` of 50,000 rows | 471 ms | 482 ms (+2%) | 2,808 ms (+497%) |
| 2,500 `place_order()` calls inside the database (4 writes each) | 2,001 ms | within noise | 4,879 ms (+144%) |
| 200 `place_order()` calls from the app, 12 alternating rounds | 1,830 ms | 1,908 ms (+4%, within noise) | — |

- **Idle costs nothing measurable,** because the triggers are switched off. Idle is the state that matters on a shared test database.
- **Recording** makes each small write statement about 2.5× as expensive, and each row in a big statement about 6×. That's the price of writing a second, JSON copy of every change, and it applies only while a session runs. A typical test step touches a few dozen rows, so the extra time is milliseconds.
- What the design work bought: the first row-level version cost **+89% while idle** and **+1368% while recording** on the 50,000-row update.

Docker Desktop's network latency swings a lot, so the in-database numbers are the reliable ones.

## Safety

- Hosts and databases named like production (`prod`, `production` as a word: `app_prod`, `prod-db`) are refused.
- Attaching triggers waits at most 5 seconds for table locks, then fails with a clear message instead of queueing behind a migration.
- Everything lives in the `_propmaster` schema; `propmaster uninstall` removes it all.
- Passwords stay in environment variables or `.env` (git-ignored), never in exported files.

## Development

```sh
npm run db:up
npm test             # unit, integration (real Postgres) and end-to-end CLI tests
npm run typecheck
npm run bench        # performance
npm run gif          # re-render the demo GIF (needs npm run build)
```

The [test plan](docs/TEST_PLAN.md) covers the risks, test levels and exit criteria. CI runs every test on PostgreSQL 13 to 17.

## Roadmap

Tool 1 (this) → **Tool 2: Test Data Finder** (saved SQL recipes for "find me a customer with an expired card") → **Tool 3: Seeder & Cleaner** (scenario seeding, safe cleanup, and undo of a recorded session) → a local dashboard and a Chrome side panel that marks test steps as you click.

## License

[MIT](LICENSE)
