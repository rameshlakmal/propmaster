# Test plan: DB Change Recorder (v0.1) and Test Data Finder (v0.2)

## 1. What is tested, and why

The recorder runs inside someone else's database, next to the application under test. That makes two failures worse than any missing feature:

1. **The recorder breaks or slows the app.** A tool meant to find bugs would then cause them.
2. **The recording is wrong.** A tester would trust evidence that doesn't match what the database did.

So most tests target those two risks. Features such as filters and exports come next.

The Test Data Finder runs testers' own SQL on a shared database and hands out rows to people. Its worst failures are:

3. **A recipe changes data or hangs the database.**
4. **Two testers get the same row**, which is the very problem claiming exists to solve.
5. **A recipe silently returns the wrong rows**: a parameter pasted wrongly, or a recipe broken by a migration that nobody notices.

**In scope:** trigger mode, snapshot mode, the CLI, filters, masking, the HTML, Markdown and SQL exports, business rule checks, `doctor`, install, upgrade and uninstall. For the Finder: recipe files, parameters, finding, claims, `recipes check`, `--json`, and the Find data page.
**Out of scope for v0.1:** MySQL and other databases, the web dashboard and the Chrome side panel (later phases), and concurrent recording sessions (one session per database is a design limit).

## 2. Risks and how each one is covered

| # | Risk | Likelihood · impact | Mitigation in the design | Covered by |
|---|---|---|---|---|
| R1 | A recorder error makes the app's write fail | Low · **High** | One exception block per statement turns errors into `WARNING`s | `never breaks the app write when recording fails` (sabotages the changes table, then checks that INSERT and TRUNCATE still succeed and the warning appears) |
| R2 | The recorder slows the database | Med · High | Statement-level triggers with transition tables; triggers disabled while idle; one-row switch as backstop | `npm run bench` (section 5); `disables its triggers while idle…` |
| R3 | Subtransaction overflow on big statements | Med · High | One subtransaction per statement, never per row | Design review; bulk benchmark (50,000-row UPDATE) |
| R4 | Wrong rows paired in an UPDATE | Low · **High** | Transition tables are filled in step; pairing by position | `pairs old and new rows of a multi-row update that changes the keys`, `…tables without a primary key`, alias-collision test |
| R5 | Values change on the way (numeric 84.50 → 84.5, bigint precision) | Med · Med | Lossless JSON parsing (`JSON.rawJSON`) | `keeps big numbers exact`, `formatValue keeps exact numbers` |
| R6 | Odd schemas break capture | Med · Med | Generic `to_jsonb(row.*)`, `%I` quoting, PK passed as trigger args | Edge-case suite: enums, generated columns, arrays, json, bytea, composite keys, no key, partitions (incl. row moves), inheritance, self-references, FK cycles, quoted identifiers, other schemas, key changes, columns added mid-session, columns named `n`, `o`, `t`… |
| R7 | Noise from other users on a shared DB | High · Med | Each change stores DB user, application_name, client address and transaction ID; filters | `records changes made by another DB user`, filter unit tests |
| R8 | Leftover objects after uninstall | Med · Med | Everything in `_propmaster`; `DROP SCHEMA … CASCADE` | `uninstall removes the schema and every trigger`, also for a non-owner tester |
| R9 | Testers lack permissions | High · Med | Snapshot mode needs only SELECT; `doctor` explains and lists grants | Snapshot suite as a read-only role; doctor tests for owner, read-only and installed cases; non-owner tester test |
| R10 | Running against production | Low · **High** | Hosts and databases named with the word prod/production are refused | Guard unit tests (incl. false positives such as `products`), CLI test |
| R11 | Sensitive data leaks through exports | Med · High | Masking on by default for exports; masked columns left out of SQL checks | Masking unit tests; SQL export test |
| R12 | HTML report runs injected script | Low · High | Every value HTML-escaped; no external resources | `escapes everything that comes from the database` |
| R13 | Start or stop hangs on a locked table | Med · Med | `lock_timeout` 5 s; clear error; disabling at stop is best effort | `gives up waiting for a locked table instead of hanging` |
| R14 | SQL checks pass when they shouldn't | Med · High | Containment checks on recorded values; end-state folding | Checks run against real Postgres: pass right after a session, fail after tampering, strict form raises, pass on a re-run with ignored ids |
| R15 | A rule check changes data or hangs | Low · **High** | Rules run in a `READ ONLY` transaction with `statement_timeout`; one statement per rule (extended protocol); each rule in its own savepoint | `cannot change data` (write through a function and in a CTE), `allows one statement per rule`, `stops a rule that runs too long` |
| R16 | A rule silently checks nothing, or checks the wrong rows | Med · High | `{{table}}` expands to the session's rows by their final key; a rule with no rows in scope is reported as skipped, not passed | `checks only rows the session touched…`, `skips a rule when the session touched none of its tables`, unit tests for scoping and key changes |
| R17 | Rules miss a real business-logic bug after a requirement change | Med · High | The demo encodes a requirement change with a planted bug | `a requirement change, checked with rules` suite: old build flagged, buggy v2 caught, correct build passes |
| R18 | Another program or website drives the web app (it can reach your test databases) | Low · **High** | Listens on 127.0.0.1 only; a secret token per run, accepted in a header only; Host-header check against DNS rebinding; Origin check against cross-site requests; passwords never sent to the browser | `test/ui-server.integration.test.ts`: security suite |
| R19 | The web app shows something different from what was recorded | Low · High | Values are formatted on the server with the same code as the CLI (exact numbers) | `records steps, shows them live, and stops` (exact `84.50`); browser walkthrough |
| R20 | Pausing loses or leaks changes: setup done while paused shows in the test, or changes before the pause disappear | Med · High | Trigger mode skips capture while the state row says paused; snapshot mode compares at the pause and takes a fresh baseline on resume; a new session always starts unpaused | `test/pause.integration.test.ts`: both modes, steps while paused, stopping while paused, errors for pausing twice; CLI e2e; browser walkthrough |
| R21 | Auto steps split or name an action wrongly, or differently each time a recording is read | Med · Med | Steps are worked out by a pure function from the stored changes and the gap saved with the session; typed names always win for the next action | `test/autosteps.test.ts` (splitting, naming, markers); `test/autosteps.integration.test.ts` (live, after stop, re-read, typed name, snapshot refused); browser walkthrough |
| R22 | A recipe changes data or hangs a shared database | Low · **High** | Recipes run in a `READ ONLY` transaction with `statement_timeout`, always rolled back; one statement (extended protocol) | `refuses recipes that change data` (a writing function, `nextval`, a second statement; the row count is unchanged afterwards), `stops a slow recipe at the time limit` |
| R23 | Two testers get the same row | Med · **High** | One `INSERT … ON CONFLICT DO UPDATE … WHERE expired` per row: a held row is skipped, the next free one is tried | `never gives the same row to two testers claiming at the same moment` (four connections at once), `claims the first free row, and others then get the next one` |
| R24 | A parameter changes the meaning of the query (SQL injection, or a mistyped value) | Low · High | Parameters are bind values with a declared type (`$1::int`); placeholders inside strings, comments, quoted names, dollar quotes and `::` casts are left alone; values are checked before they reach Postgres | Placeholder scanner unit tests; `uses parameters as bind values` (a value like `' OR '1'='1` matches nothing); mistyped-value tests |
| R25 | A recipe breaks after a migration and nobody notices | High · Med | `recipes check` runs every recipe (or `EXPLAIN`s it when a value is required) and fails CI when one is broken | `checkRecipes` integration test (missing table, missing claim key, broken query with a required parameter), CLI exit-code test |
| R26 | A forgotten claim blocks a row for good, or claims make the recorder look installed | Med · Med | Claims expire and are taken over after; the recorder checks for its own tables, not the schema | `lets an expired claim be taken over`, `keeps claims and the recorder apart` |
| R27 | A tester without write access can't use the Finder | High · Med | Finding needs only SELECT; claiming says which grant is missing | `works for a user who may only read` |

## 3. Test levels

| Level | Where | What | Runs on |
|---|---|---|---|
| Unit | `test/*.test.ts` (not `integration`/`e2e`) | Formatting, filters, time parsing, masking, exports, rule parsing and scoping, snapshot diff, production guard, recipe parsing, placeholders, search, durations | Any machine, no database |
| Integration | `test/*.integration.test.ts` | Trigger mode, snapshot mode, doctor, SQL checks, rule checks, finding, claims and recipe checks against **real PostgreSQL** | Docker locally; GitHub Actions service container in CI |
| End to end | `test/cli.e2e.test.ts` | The CLI as a separate process: full flows, exit codes, error messages | Same as integration |
| Web app | `test/ui-server.integration.test.ts` | The web app's API: security, connections, a full recording, exports, rules | Same as integration |
| Web app, in a browser | Manual walkthrough before a release (section 6) | Start, steps, live timeline, pause, flag, the floating window, stop, sessions, search, rules, setup, light/dark, phone width, console errors | Headless Edge or Chrome |
| Compatibility | `.github/workflows/ci.yml` | PostgreSQL 13, 14, 15, 16, 17; Node 22.12 and 24 | GitHub Actions |
| Performance | `scripts/bench.ts` | Overhead with no recorder, installed but idle, and recording | Manually before a release |
| Exploratory | Section 6 | The HTML report in real browsers, the CLI on Windows, macOS and Linux | Manually before a release |

Integration tests reset the `propmaster_test` database before each test, so tests don't depend on each other and never touch the demo data. Files run one at a time because they share that database.

## 4. Entry and exit criteria

**Entry:** the code type-checks (`npm run typecheck`), and Postgres is reachable (`npm run db:up`).

**Exit (release):**

- All automated tests pass on every CI matrix entry.
- No open defect of high impact (R1, R4, R10, R12, R14 areas).
- The benchmark shows idle overhead within noise and recording overhead documented.
- The exploratory checklist in section 6 is done.
- README, CHANGELOG and this plan are up to date.

## 5. Performance

`npm run bench` measures three states on the same workloads (median of several runs, database reset before each):

- **Checkout from the app:** `place_order()` called once per round trip, like a real app.
- **Checkout inside the database:** the same calls in a loop on the server, so network latency doesn't hide the trigger cost.
- **Bulk:** a single `UPDATE` of 50,000 rows.

Results for the release are recorded in the README. On Docker Desktop, round-trip latency varies a lot, so the in-database numbers are the reliable ones.

## 6. Exploratory checklist (manual, before a release)

Results for v0.1.0. ✅ = done; ⬜ = still to do by hand.

- ✅ HTML report in Chromium: search box and operation buttons filter correctly (driven through the DevTools protocol).
- ⬜ HTML report in Firefox and Edge.
- ✅ HTML report follows the system's dark mode, and has no sideways scrolling at 1200 px or at phone width (390 px), even with 2 KB text and large JSON values.
- ✅ Keyboard only: Tab reaches the search box, the buttons and each change; Space and Enter toggle the buttons; Enter opens and closes a change; focus has a visible outline; long values scroll in their own focusable box.
- ⬜ `record export --open` on macOS and Linux (✅ Windows).
- ✅ Killing the CLI during `record step --snapshot`, at five moments from start-up to file writing, leaves a usable session. Now an automated test (`survives being killed in the middle of a snapshot step`); snapshot files are written atomically.
- ✅ Very long values keep the timeline to one short line per change, and appear in full in the HTML report (automated: `very long values`).
- ✅ The Markdown export renders as tables on GitHub (checked with GitHub's Markdown renderer).
- ⬜ The Markdown export pasted into a Jira ticket.
- ✅ Web app walkthrough in headless Edge, driven like a tester (22 checks): start a recording from the form, add steps with Enter, see a real EverShop change appear live, stop, open the session, expand a change, search, run rules, run the access check, light and dark mode, phone width, and no console errors from the app.
- ✅ Floating window walkthrough in headless Edge (24 checks): upgrade an older recorder from Setup, pause, resume and flag on the page, pop out, add a step from the floating window (the page follows), see a real order arrive in its live feed, pause there (setup while paused is not recorded), resume, flag with a note, stop (the page shows the stopped view with the markers), close, and no console errors.
- ✅ Auto steps and the new Changes layout in headless Edge (14 checks): start with **Name steps for me**, two demo-shop actions become two named steps, a typed name goes to the next action, the session shows labelled fields, unquoted text, readable times and old → new, auto steps are labelled, no sideways page scrolling at phone width, no console errors.
- ✅ Sessions and JSON in headless Edge (16 checks): the list pages through 44 sessions, rename a step with the pencil (Enter saves, Escape cancels, the name is stored), select three sessions and delete them together with a confirmation, and a real EverShop cart update lists the changed JSON path (`[0].goodsWeight`), shows same-second times exactly, and opens the full JSON as indented blocks; no console errors.
- ⬜ Auto steps against a real app (EverShop): busy tables such as `event` should be excluded, or they keep a step from going quiet.
- ⬜ Floating window in a real (not headless) Chrome: it stays on top of another application's window.

Test Data Finder (v0.2):

- ✅ CLI on Windows against the demo shop: list recipes, find, claim one and two rows as different testers, claimed rows listed last with who holds them, `claims`, `extend`, `release`, `release --mine`, `claims add` for a missing row and an already-claimed row, `--json`, `recipes check`.
- ✅ Web app API against the demo shop: open a recipe folder pasted with quotes, find with an empty parameter (default used), claim a picked row, claim it again (refused, naming who holds it), extend, check all, release mine.
- ⬜ Find data page in a browser: search and tags, parameter form (number and date fields), Find, Claim on a row, Find and claim one, claims list with 2 more hours and Release, Check all recipes, light and dark mode, phone width, no console errors.
- ⬜ Recipes for a real app (EverShop or Halden), used by two people at once.

## 7. Known limitations (by design in v0.1)

- One recording session per database at a time; filters separate other users' changes.
- Trigger mode sees a table created during a session from the next step on.
- Snapshot mode can't tell who made a change, and a row changed twice within one step shows once.
- Snapshot mode stores full table copies under `.propmaster/` while recording; they are deleted at stop.
- With a statement on an inheritance parent, child-only columns are not in the recorded row (Postgres converts rows to the parent's type).
- SQL checks verify the final state of each touched row, not the order changes happened in.
- Only tables with a one-column primary key can be claimed.
- A claim marks a row; it doesn't lock it. The app, and testers who don't use Propmaster, can still change a claimed row.
- When nothing matches, the Finder says so; creating the missing data is Tool 3's job (Seeder).

## 8. How to run

```sh
npm run db:up        # Postgres 17 with qa_shop and propmaster_test
npm test             # unit + integration + end to end
npm run typecheck
npm run bench        # performance (takes several minutes)
```
