# Changelog

All notable changes to Propmaster. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Tool 3, the **Seeder & Cleaner**.

### Added

- **Scenarios** (`propmaster seed <scenario>`): YAML files that list the rows a test needs. Under `seed:`, a table holds one row, a list of rows or a number of rows; inside a row, a key is a column or a child table linked through its foreign key. `$count`, `$as` / `{ $ref: name }` and `$via` cover copies, pointing at another row of the scenario, and choosing between several foreign keys. Parameters are typed like recipe parameters (`-p name=value`); text can use `{{param}}`, `{{run}}`, `{{n}}` and `{{unique}}`. Example scenarios: `demo/scenarios/`.
- **Made-up values** for columns a scenario leaves out: defaults and nullable columns are left alone; a required foreign key gets a new parent row (required cycles are explained instead of looping); other required columns get a value that passes NOT NULL, `CHECK (… IN …)`, enums, `CHECK` number bounds, `varchar(n)`, `numeric(p, s)` and unique constraints, with realistic-looking names, emails, phones, cities and SKUs. A unique clash on a made-up value is retried with a new one.
- **Tracked runs**: every seeded row is recorded in `_propmaster.seeded_rows` (`sql/seeder.sql`, created on the first seed) in the same transaction as the insert. `--dry-run` seeds and rolls back. `propmaster runs` lists runs that still have data.
- **Cleanup** (`propmaster clean --run 42`, `--mine`): a preview by default; `--apply` deletes the run's rows by primary key, children first, in one transaction with the rows locked. The preview marks rows changed since seeding and rows already gone. Rows the run didn't create that point at its rows (followed through foreign keys at any depth, `ON DELETE CASCADE` and `SET NULL` children included) need `--include-dependents`; rows another tester claimed need `--force`. Claims on deleted rows are released. A cleaned run can't be cleaned twice.
- **Undo a recorded session** (`propmaster clean --session 12`): inserts are deleted, updated columns set back and deleted rows put back, newest first, each only if the row still holds what the recording left; anything changed since is reported as a conflict and left alone. TRUNCATE and tables without a primary key are reported as not undoable. `--session` and `--run` can be cleaned together.
- **Backups and restore**: every applied clean first writes what it changed to `~/.propmaster/backups/` (or `$PROPMASTER_BACKUPS`). `propmaster restore` lists them; `restore <file>` previews putting it back and `--apply` does it, only into the database it came from.
- **`propmaster scenarios check`** seeds every scenario and rolls back, failing when a migration broke one (scenarios with a required parameter are skipped).
- **Finder handoff**: a recipe can name the scenario that creates its data (`-- seed: two-orders`). `find --seed` seeds it when not enough rows are free, finds again, and claims with `--claim`; without it, an empty result says how to create one.
- **Seed & clean page** in the web app: search scenarios, fill in parameters, seed or dry-run, see the rows created; list runs, preview and apply a clean with checkboxes for dependents and claimed rows; undo a recorded session; restore from a backup. **Undo changes…** on a session's page, and **Create one** on the Find data page when a recipe that names a scenario finds nothing.

### Changed

- **Redesigned web app.** A new look (light first, with dark or system in the top bar) and a new way to work:
  - **Home** is your test workspace: name the test you're on, and a **Find → Seed → Record → Check → Clean** stepper fills in as you claim, seed, record, check rules and clean. Cards list your claims, runs still to clean and recent recordings, and a live recording shows with its current step.
  - **Finish & clean up** releases the test's claims, deletes the rows seeded for it and can undo what the app changed while recording, through the usual clean preview.
  - A **top bar** replaces the sidebar: tabs, a live REC pill, the database switcher, appearance and Setup. The current test's stages stay in a strip under it on every page.
  - **Ctrl K / ⌘K** command palette: pages, actions (new test, finish test, theme), and search across recipes, scenarios and recent sessions.
  - Recordings are named after the current test by default; claims, seed runs, recordings and rule checks are gathered under it (kept per database in this browser).
  - **Seed & clean** is split into Seed, Clean up and Backups tabs. Recipe and scenario folders are a small chip in the page header (Change, Check all) instead of a path bar.
  - Record page: a start form with a how-it-works guide, and a highlighted console while recording. Every page has a coloured tool icon and a clearer header.
- `propmaster uninstall` also removes the seed-run tracking, and warns first when runs still have data (their rows stay in the database, untracked).
- In a scenario, a required foreign key to a row the current row is nested under further up (`order_items` under `customers > orders`, with a required `customer_id`) uses that row instead of being reported as a cycle.
- The web app's link works in a second tab or from a bookmark while the server runs (the token is kept in the browser, not only in the tab).
- Masked exports also hide secrets inside JSON values (`{"api_token": …}` in a settings column) and e-mail addresses inside longer text.

### Fixed

From a review of the whole project.

**Safety**
- The production guard read only the address of a connection string. The driver connects to `?host=` / `?port=` when given, and falls back to `PGHOST` / `PGDATABASE`, so `postgres://u@localhost/test?host=prod-db` got through. The guard now checks where the connection really goes.
- `record check --limit 0` returned no rows, so every rule passed. `--limit`, `--max-rows` and `--port` now refuse anything but whole numbers in range.
- SQL export: a session or table name with a carriage return could end the header comment and put live SQL in the script. Control characters in header lines are now spaces.
- The web app's Setup page could switch or remove the database in use while a recording ran on it, leaving the recording with no way to stop it from the app. The server now refuses, and the buttons are disabled.
- Pages kept their state when you switched databases: a clean preview of run #7 on one database could be applied to run #7 on another, and ticked sessions could be deleted on the other one. Every page now starts afresh when the database changes.
- Saving the rules editor under a new path could overwrite another `.sql` file (a migration, say) without asking. "Run rules" saved to the path typed in the box, even when that file hadn't been opened.

**Wrong results**
- SQL export checks for array and json columns used containment, so `["a"]` passed against `["a","b"]`. They now compare whole values. `timestamptz` columns (`--include-timestamps`) compare as timestamps, so a script recorded in one time zone passes in another.
- SQL export: a row inserted into a table without a primary key was still checked with its first values after a later UPDATE or DELETE on that table could have changed it.
- Undoing a session skipped rows as "changed since" when the app's session used another time zone (`created_at` came back as different text for the same moment), and failed on array columns ("malformed array literal").
- Cleaning with dependents could delete a row before another dependent that points at it (an order before its item, when the item also points at a seeded product), failing the clean.
- One parent with a NULL in the referenced column hid every dependent of the other parents.
- Restoring a clean's backup left the run marked as cleaned, so it was no longer listed or cleanable.
- A backup was kept when the clean's commit failed.
- Scenario numbers lost their exact text: `0771234567` became `771234567`, `1.10` became `1.1`, and `9007199254740993` became `…992`.
- Unique clashes on a several-column unique key were retried with the same values.
- `clean --mine` only cleaned the newest 50 of your runs.
- `claims add orders 0042` didn't find order 42, and scanned the whole table.
- Recipe parameters with capital letters (`-- param: Since date`) were always reported as unused.
- The recorder's triggers kept the old key columns after a primary key column was renamed, so every row got an empty key. They are now attached again (run `propmaster install` once to get this).
- A rule naming a table Postgres can't parse (`{{a b}}`) stopped every other rule.
- `--since 2026-10-13` meant midnight UTC, not midnight local time like `2026-10-13T10:30`.
- Change ids above 2³¹ would have overflowed when loading a session.

**Web app**
- A slow, older answer could overwrite a newer one (polling, switching pages), and polls piled up behind a slow one. Polling also pauses in a background tab.
- A clean preview that arrived late could show another run's plan above the button.
- The app was a blank page when its settings couldn't be read, or the token was missing. It now says why.
- Failed loads on the Find data and Seed & clean pages looked like "open a folder".
- Pressing Enter in a Find parameter ran the recipe with required parameters still empty, and twice when pressed twice.
- The tab title kept "● REC" after stopping from the floating window on another page.
- When another tab or the terminal switched the database in use, this tab kept showing the old one's name. It now follows the switch (and starts its page afresh).
- A request body that wasn't a JSON object caused a server error, and the static file check accepted sibling folders whose names start with `web`.
- Two settings saves at once could lose one. Query parameters such as `?password=` were shown in the browser.
- Text and terminal output: values with control characters (escape sequences, a lone carriage return) are shown escaped; Markdown cells keep `&lt;` as written and don't break on line breaks.

**Smaller UI improvements**
- Confirmations before removing a connection and before releasing all your claims.
- A warning when saving a connection under a name that's already saved.
- Copy buttons for the DBA's grant SQL and a clean's backup path.
- Long clean plans, seeded rows and find results scroll inside their card with the column names kept in view.
- Dates show the year when it isn't this year; "under a minute left" instead of "0 min left".
- Space opens a rule's rows and a session, like Enter. "Save & run rules" says it saves.

## [0.2.0] - 2026-10-13

Tool 2, the **Test Data Finder**, and the **web app**.

### Added

- **Tool 2: Test Data Finder.** Recipes are named, tagged SQL queries in `.sql` files (`-- recipe:`, `-- tags:`, `-- param:`, `-- claim:` header lines) that find test data in a given state. `propmaster find` lists them; `propmaster find <words> -p name=value` runs one. Parameters are typed and sent as bind values. Recipes run in a read-only transaction with a time limit. Example recipes: `demo/recipes/shop.sql`. Blank lines may separate header lines; a recipe with two statements, or two result columns of the same name, gets a clear message. Matches are counted up to 1,000 ("1000+ matches") so big results stay fast.
- **Claims**: `find --claim [n]` claims the first free rows for `--for 2h` (default) with an optional `--note`, so other testers on the same database don't use them. Rows others hold are listed last and never handed out; claiming is atomic, and claims expire by themselves. `claims` lists them; `claims add`, `extend`, `release [--mine]` and `clear-expired` manage them. A claim taken over after it expired gets a new id, so the old holder can't release it by mistake; releasing or extending someone else's live claim needs `--force`. `extend` adds time to what is left (at most 30 days ahead). Claims are stored in `_propmaster.claims` (`sql/finder.sql`), created on the first claim.
- `find --json` for automated tests: the free rows, how many rows you asked for, and the claims you got with each claimed row's values. Errors are printed as JSON. Exit code 1 when there's no free row. Without `--json`, a warning when fewer rows were free than you asked for.
- **`recipes check`** reports each recipe as working, finding nothing, or broken (for example after a migration renamed a column). Exit code 1 if one is broken; `--strict` also fails on recipes that find nothing.
- **Find data page** in the web app: search recipes, fill in parameters, find, claim a row with one click, see and release everyone's claims (releasing someone else's asks first), and check all recipes. The name claims are made under can be changed on the page (saved in `~/.propmaster/ui.json`). The results update when a claim is released or extended.

- **Web app** (`propmaster ui`): set up connections with a live access check, install the recorder, record with a Start button and one step per Enter, watch changes appear live, browse and search sessions, open any change for its before and after values, export, and edit and run rules. Light and dark mode. Runs on 127.0.0.1 only, with a secret token per run, a Host-header check (DNS rebinding) and an Origin check. Saved connections live in `~/.propmaster/ui.json`.
- **Rename steps** after recording (or during): the pencil next to a step name in the web app, or `record rename <session> <step> <name>`. Works for typed steps, auto steps (kept against the step's first change) and snapshot sessions.
- **Sessions list: delete and pages.** Tick sessions to delete several at once (with a confirmation that counts them), or delete one from its row; a session still recording can't be deleted. The list is paged, 20 a page.
- **JSON over several lines everywhere**: the terminal timeline prints JSON values indented, line by line (up to 15 lines a value), and for an update the paths inside the JSON that changed, saying when a key was added or removed; the HTML report shows JSON in indented, scrollable blocks; the Markdown export puts it in ```json code blocks under each step's table.
- The web app notices when it is newer than the running server (rebuilt while `npm run ui` was running) and asks for a restart, instead of showing empty or wrong pages.
- **JSON keeps its structure** in the web app: JSON values (jsonb columns, and text columns holding JSON) are indented, exact numbers kept. For an update, the paths inside the JSON that changed are listed (`[0].goodsWeight 1000 → 500`), with the full JSON before and after on request.
- **Auto steps** (`record start --auto-steps [seconds]`, and **Name steps for me** in the web app): no need to type a step before each action. A quiet gap (default 3 s) ends a step, and each step is named after its changes, e.g. "New order #66 with order item, payment · inventory product_id 3 stock 14 → 12". A typed name goes to the next action. Steps are worked out from the stored changes, so a recording always reads the same. Auto-named steps are marked `auto`. Live (trigger) mode only.
- **Floating recorder window** (web app, Chrome and Edge): **Pop out** opens a small always-on-top window with the current step, a step field (Enter adds the step), Pause/Resume, Flag with a note, Stop, and a live feed of the latest changes. It keeps working while the Propmaster tab is in the background.
- **Pause and resume** (`record pause`, `record resume`, and buttons in the web app): the session stays open but nothing is recorded, for setup that isn't part of the test. In snapshot mode, pausing compares the step so far, and resuming takes a fresh snapshot.
- **Flags** (`record flag [note]`, and a Flag button): mark the current step as "looks wrong", with an optional note. Pauses, resumes and flags show in the timeline, the HTML and Markdown exports, and the web app.
- `record status` and the web app say when the recorder in a database is from an older version, and the Setup page has an **Upgrade recorder** button (`propmaster install` upgrades too; recordings are kept).

### Changed

- `propmaster uninstall` now says it removes recordings **and claims**. The recorder counts as installed only when its own tables exist, not just the `_propmaster` schema (which the Finder may create for claims).

- **Easier-to-read changes in the web app.** Each change is laid out as labelled fields instead of one long `column=value` line: the new values of an insert, *old → new* for an update (old struck through, new highlighted), and what a deleted row held. Text shows without SQL quotes, times in local format (the exact value in the tooltip), NULL and empty text quietly, numbers in tabular figures, and true/false as small tags. Expanding a change still shows every column exactly as stored. On a phone, a step's table scrolls sideways in its card.

- **Restyled terminal output** across the CLI: a PROPMASTER header, `STEP n` sections with counts on the right, and **bordered tables**: one per step for the timeline (Op, Table, Row, Changes; the same column widths for every step), one for rule results plus a table of the breaking rows under each failure, and one for `record list`. Long text wraps between words inside its cell, values too long for a cell are shortened with `…`, and everything fits the terminal width. Messages are consistent, with a `→` next step.
- The demo explains itself (it plays a tester) and runs in numbered stages; the Docker demo hides npm's setup output.

### Fixed

- The Rules page showed a blank screen after the session list became paged (it still expected the old list). It now reads the paged list, and a page that crashes shows the error and a Reload button instead of a blank screen.
- The Rules page accepts a file path pasted with quotes (Windows' "Copy as path").
- The web app's session list only ever showed the newest 20 sessions; older ones were unreachable. It now pages through all of them.
- A session with steps but no changes showed only "no changes", hiding its steps and flags.
- Two times within the same second read the same in the web app ("09:58:30 PM → 09:58:30 PM"); they now show the exact time.

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

[Unreleased]: https://github.com/rameshlakmal/propmaster/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rameshlakmal/propmaster/releases/tag/v0.2.0
[0.1.0]: https://github.com/rameshlakmal/propmaster/releases/tag/v0.1.0
