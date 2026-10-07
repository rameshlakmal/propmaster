# Changelog

All notable changes to Propmaster. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-07

The first release: **Tool 1, the DB Change Recorder**.

### Added

- **Trigger mode.** `propmaster install` adds the recorder to a PostgreSQL 13+ database in its own `_propmaster` schema. `record start`, `record step` and `record stop` capture every INSERT, UPDATE, DELETE and TRUNCATE, grouped by test step, with before and after values, the DB user, application name, client address and transaction ID.
  - Statement-level triggers with transition tables: one trigger call and one subtransaction per statement, whatever the number of rows.
  - Triggers are disabled while nothing is recording (on tables the recorder owns), so an idle recorder costs nothing.
  - Recorder errors never break the app's writes; they become warnings.
  - Tables created during a session are watched from the next step on.
- **Snapshot mode** (`record start --snapshot`) for testers with read-only access. It compares consistent snapshots at every step boundary and needs only SELECT.
- **`propmaster doctor`** shows what the current DB user can do, which mode to use, and the exact GRANT statements to ask a DBA for.
- **Filters** for `record show`, `record stop` and `record export`: by table (with patterns), DB user, application, operation, time window and step.
- **Exports** with `record export`:
  - `--format html` (default): a self-contained report with search and operation filters, light and dark themes.
  - `--format md`: Markdown for bug tickets and pull requests.
  - `--format sql`: SQL checks that verify the database ends up in the recorded state, with `--strict` for CI, `--ignore-columns` for generated ids, and timestamps left out by default.
- **Business rule checks** with `record check <rules.sql>`: rules are SQL queries that return the rows breaking them, and `{{table}}` scopes a rule to the rows the session touched. They run read-only with a time limit; the exit code is 1 when a rule fails, for CI. `--all-rows` checks whole tables. The demo includes a requirement change (a discount) with a bug the rules catch.
- **Masking** of passwords, tokens, keys, card numbers and e-mail addresses. On by default for exports (`--no-mask` to turn off); `--mask` for the terminal; `--mask-columns` for extra columns.
- **Housekeeping:** `record list`, `record delete`, `record prune --older-than`, and `record exclude` / `record include` for busy tables.
- **Safety:** connections to hosts or databases named like production are refused; attaching triggers waits at most 5 seconds for table locks; clear error messages with a next step.
- **Demo:** a small e-commerce database in Docker (`npm run db:up`) and the whole flow in one command (`npm run demo`).
- Tests on PostgreSQL 13 to 17 in CI, a written test plan, and a benchmark (`npm run bench`).

[0.1.0]: https://github.com/rameshlakmal/propmaster/releases/tag/v0.1.0
