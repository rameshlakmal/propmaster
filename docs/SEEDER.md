# Tool 3: Seeder & Cleaner (design)

Create exactly the data a test needs, then remove every trace of it, on a shared test database.

> "The QA database has 40,000 users named 'test test'. Nobody knows which ones are safe to delete, so nobody deletes anything."

## What it does

| Command | What happens |
|---|---|
| `propmaster seed` | Lists the scenarios. |
| `propmaster seed <scenario> [-p name=value]` | Inserts the scenario's rows, parents first, in one transaction. Every row is tracked under a **run** id. |
| `propmaster seed <scenario> --dry-run` | Does it all inside a transaction, shows what would be created, and rolls back. |
| `propmaster runs` | Lists runs: scenario, who, when, rows, cleaned or not. |
| `propmaster clean --run 42` | **Preview** of what cleaning run 42 would delete. Nothing changes. |
| `propmaster clean --run 42 --apply` | Saves a backup file, then deletes the run's rows (children first) in one transaction. |
| `propmaster clean --session 12 [--apply]` | **Undo a recorded session** (Tool 1): deletes the rows the app inserted, puts updated columns back, and re-inserts deleted rows. |
| `propmaster restore <backup.json> [--apply]` | Puts back what a clean removed. |
| `propmaster scenarios check` | Seeds every scenario in a rolled-back transaction: catches scenarios broken by a migration (CI). |

## Scenarios

A scenario is a YAML file in `scenarios/` (or `--scenarios`, `$PROPMASTER_SCENARIOS`), kept in git next to the tests.

```yaml
# scenarios/two-orders.yml
name: Customer with two orders
description: One paid order with two items, one cancelled order with one item.
tags: [orders, checkout]
params:
  status: { type: text, default: PAID, description: Status of the first order }

seed:
  customers:
    name: Pat Two-Orders          # a fixed value
    # email is not given: it is NOT NULL and UNIQUE, so a unique one is generated
    orders:                       # child rows: orders.customer_id → customers is found from the schema
      - status: "{{status}}"
        order_items: 2            # two generated items (and a product for each, since product_id is required)
        payments: 1
      - status: CANCELLED
        order_items:
          product_id: 3           # an existing product
```

- **Under `seed:`** each key is a table, and its value is one row (a mapping), several rows (a list), or a number of generated rows.
- **Inside a row**, a key is either a column (its value) or another table (child rows, linked through the foreign key from that table to this one).
- **Keys starting with `$`** belong to Propmaster: `$count: 5` (this many copies), `$as: pat` (a name to refer to the row), `$via: billing_customer_id` (which foreign key links a child, when there is more than one).
- **`{ $ref: pat }`** as a column value means "the key of the row named pat". A literal value (`product_id: 3`) uses an existing row.
- **Placeholders** in text: `{{param}}`, `{{run}}` (the run id), `{{n}}` (the row's number within its list), `{{unique}}` (a short unique token).
- **Parameters** have the same types as recipe parameters (text, int, numeric, boolean, date, …) and are checked before anything runs.

## Generated values

Columns not given in the scenario:

1. Columns with a default, identity or generated value are left to the database.
2. Nullable columns are left NULL. A nullable foreign key is left NULL too, so no parent is created needlessly.
3. A required foreign key gets a **new parent row** (generated the same way, recursively). Required cycles are reported with advice instead of looping.
4. Any other required column gets a value from its type, name and constraints:
   - `CHECK (status IN (...))` and enum types: the first allowed value.
   - `CHECK (qty > 0)`, `>=`, `<`, `<=`, `BETWEEN`: a number inside the bounds.
   - Unique columns: a value with a unique token in it; `varchar(n)` lengths are respected.
   - Column names: `email`, `name`, `first_name`, `phone`, `city`, `sku`, `url`, … get realistic-looking values.
   - Types: numbers, booleans, dates and times, uuid, json/jsonb, arrays, inet, interval, bytea.
5. A unique violation is retried (up to 3 times) with a new token, inside a savepoint. Any other constraint error names the table, column and constraint, and says to give the value in the scenario.

## Tracking and cleanup

- `_propmaster.seed_runs` and `_propmaster.seeded_rows` (`sql/seeder.sql`), created on the first seed. Each tracked row keeps its primary key and its full values as created. They are written in the same transaction as the rows, so a seed either fully happens and is tracked, or doesn't happen at all.
- Tables without a primary key can't be seeded (their rows couldn't be found again for cleanup).
- **Cleanup deletes only tracked rows, by primary key**, never anything chosen by a broad `WHERE`. It deletes in reverse creation order, so children go before parents.
- **The preview** lists every row, and marks:
  - rows already gone (deleted by the test, which is fine);
  - rows *changed since seeding*, with what changed (a test usually changes its data; they are still the run's rows, so they are deleted);
  - rows another tester has **claimed** (Tool 2): cleaning refuses unless `--force`;
  - **dependents**: rows the run didn't create that point at rows it did (for example an order the app created for a seeded customer), found by following foreign keys recursively. Cleaning refuses unless `--include-dependents`, because they aren't the run's to delete. `ON DELETE CASCADE` and `SET NULL` children count as dependents too, since deleting would remove or change them silently.
- **All or nothing**: one transaction, rows locked with `FOR UPDATE`; any surprise rolls everything back.
- **Backup first**: every row about to be deleted (full values, dependents included) is written to `~/.propmaster/backups/<time>-<title>.json` (or `$PROPMASTER_BACKUPS`) before the transaction commits. A backup is the list of changes the clean made, so `propmaster restore` undoes it with the same machinery as a recorded session, and only into the database it came from.
- A run that has been cleaned is marked so, and can't be cleaned twice.
- Claims (Tool 2) on rows that were deleted are released with them.

This differs from the original idea document in one place: it said rows changed since seeding would be skipped. In practice a test almost always changes its data (an order goes from PENDING to PAID), and skipping those rows would also block deleting their parents. Ownership comes from the run that created the row, so changed rows are deleted and shown in the preview; claims and dependents are what protect other people's work.

## Undoing a recorded session (with Tool 1)

`clean --session 12` walks the session's recorded changes newest first:

| Recorded | Undo | Only if (otherwise: a conflict, left alone) |
|---|---|---|
| INSERT | delete the row | it still exists and holds the inserted values |
| UPDATE | set the changed columns back to their old values | the row still holds the recorded new values |
| DELETE | insert the old row again | no row with that key exists |
| TRUNCATE | cannot be undone | (reported) |

Because changes are undone newest first, a row changed several times steps back through each state. A row someone else changed after the session is a **conflict**: never overwritten, reported in the preview. Rows of tables without a primary key are reported as not undoable. Dependents and the backup work as for runs. A session still recording can't be undone.

## Finder handoff

A recipe can name the scenario that creates its data: `-- seed: two-orders`. When nothing is free, `propmaster find` says so and suggests `propmaster seed two-orders`; `find --seed` seeds it and finds again (and claims, with `--claim`).

## Safety summary

- Same production guard as the other tools.
- Seeding and cleaning each run in one transaction, with the usual 5 s lock timeout.
- Cleanup previews by default; `--apply` is needed to delete.
- Only tracked rows (or recorded changes) are touched; dependents and other people's claims need an explicit flag.
- A backup file is written before anything is deleted.
- `propmaster uninstall` removes the run tracking with the rest of `_propmaster`; it never deletes seeded rows.

## Limitations (v1)

- Seeding inserts straight into the database, so app logic (password hashing, events) doesn't run. Give such values in the scenario, or seed through the app.
- Generated values satisfy common constraints; complex CHECKs, triggers that reject rows, or rules that live only in app code need the value in the scenario.
- Tables without a primary key can't be seeded, and their recorded changes can't be undone.
- TRUNCATE can't be undone.
