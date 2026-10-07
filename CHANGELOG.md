# Changelog

All notable changes to Propmaster. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Web app** (`propmaster ui`): set up connections with a live access check, install the recorder, record with a Start button and one step per Enter, watch changes appear live, browse and search sessions, open any change for its before and after values, export, and edit and run rules. Light and dark mode. Runs on 127.0.0.1 only, with a secret token per run, a Host-header check (DNS rebinding) and an Origin check. Saved connections live in `~/.propmaster/ui.json`.
- **Auto steps** (`record start --auto-steps [seconds]`, and **Name steps for me** in the web app): no need to type a step before each action. A quiet gap (default 3 s) ends a step, and each step is named after its changes, e.g. "New order #66 with order item, payment · inventory product_id 3 stock 14 → 12". A typed name goes to the next action. Steps are worked out from the stored changes, so a recording always reads the same. Auto-named steps are marked `auto`. Live (trigger) mode only.
- **Floating recorder window** (web app, Chrome and Edge): **Pop out** opens a small always-on-top window with the current step, a step field (Enter adds the step), Pause/Resume, Flag with a note, Stop, and a live feed of the latest changes. It keeps working while the Propmaster tab is in the background.
- **Pause and resume** (`record pause`, `record resume`, and buttons in the web app): the session stays open but nothing is recorded, for setup that isn't part of the test. In snapshot mode, pausing compares the step so far, and resuming takes a fresh snapshot.
- **Flags** (`record flag [note]`, and a Flag button): mark the current step as "looks wrong", with an optional note. Pauses, resumes and flags show in the timeline, the HTML and Markdown exports, and the web app.
- `record status` and the web app say when the recorder in a database is from an older version, and the Setup page has an **Upgrade recorder** button (`propmaster install` upgrades too; recordings are kept).

### Changed

- **Easier-to-read changes in the web app.** Each change is laid out as labelled fields instead of one long `column=value` line: the new values of an insert, *old → new* for an update (old struck through, new highlighted), and what a deleted row held. Text shows without SQL quotes, times in local format (the exact value in the tooltip), NULL and empty text quietly, numbers in tabular figures, and true/false as small tags. Expanding a change still shows every column exactly as stored. On a phone, a step's table scrolls sideways in its card.

- **Restyled terminal output** across the CLI: a PROPMASTER header, `STEP n` sections with counts on the right, and **bordered tables**: one per step for the timeline (Op, Table, Row, Changes; the same column widths for every step), one for rule results plus a table of the breaking rows under each failure, and one for `record list`. Long text wraps between words inside its cell, values too long for a cell are shortened with `…`, and everything fits the terminal width. Messages are consistent, with a `→` next step.
- The demo explains itself (it plays a tester) and runs in numbered stages; the Docker demo hides npm's setup output.

### Fixed

- A broken settings file is reported instead of being treated as empty (saving would have erased the saved connections).
- Colour codes are no longer written when output is piped to a file (picocolors enables colour on every Windows process).
- Piping into a program that stops reading early (`| head`) no longer prints an EPIPE stack trace.

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
- **Demo:** a small e-commerce database in Docker (`npm run db:up`) and the whole flow in one command: `docker compose run --rm demo` (only Docker needed) or `npm run demo`.
- Tests on PostgreSQL 13 to 17 in CI, a written test plan, and a benchmark (`npm run bench`).

[0.1.0]: https://github.com/rameshlakmal/propmaster/releases/tag/v0.1.0
