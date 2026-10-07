// The whole recorder flow on the demo shop in one command: npm run demo (or docker compose run --rm demo)
// Needs the demo database (npm run db:up). Writes demo-report.html, demo-report.md and demo-checks.sql,
// then plays a requirement change: build v2 of the checkout, checked with the rules in demo/rules.sql.
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from '../src/core/db.js';
import { brand, hint, icons, makeStyle, spread } from '../src/core/ui.js';
import { toHtml } from '../src/recorder/export/html.js';
import { toMarkdown } from '../src/recorder/export/markdown.js';
import { toSql } from '../src/recorder/export/sql.js';
import { createMasker, maskRecording } from '../src/recorder/mask.js';
import { checkRules, parseRules } from '../src/recorder/rules.js';
import { formatRuleResults } from '../src/recorder/rules-report.js';
import { formatTimeline } from '../src/recorder/timeline.js';
import * as trigger from '../src/recorder/trigger.js';

const URL = process.env.PROPMASTER_DATABASE_URL ?? 'postgres://propmaster:propmaster@localhost:5433/qa_shop';
const STAGES = 6;

const ui = makeStyle();
const { c } = ui;
const i = icons(c);
const say = (...lines: string[]) => console.log(lines.join('\n'));
let stage = 0;
const nextStage = (title: string, detail = '') => {
  stage++;
  say('', spread(` ${c.cyan(c.bold(`${stage}/${STAGES}`))}  ${c.bold(title)}`, c.dim(detail), ui.width), '');
};
/** One click of the pretend tester. */
const click = (text: string) => say(`   ${c.cyan('▸')} ${text}`);

say(` ${brand(c)}  ${c.bold('Demo')}`,
  ` ${c.dim('This demo plays a tester clicking through a small shop, while Propmaster records')}`,
  ` ${c.dim('what every click does to the database. Nothing here tests Propmaster itself.')}`);

const db = await connect(URL);
try {
  nextStage('Install the recorder', 'safe to repeat');
  await trigger.install(db);
  const { active, watchedTables } = await trigger.status(db);
  if (active) await trigger.stop(db); // a leftover session from an earlier run
  await db.query('UPDATE inventory SET stock = 20 WHERE stock < 20'); // earlier runs may have sold out (not recorded)
  say(` ${i.ok} Watching ${watchedTables} tables of the qa_shop database`);

  nextStage('A tester checks out, then cancels', 'each click is one recorded step');
  await trigger.start(db, 'Demo: checkout and cancel');

  click('Sign up');
  await trigger.step(db, 'Sign up');
  await db.query("INSERT INTO customers (email, name) VALUES ($1, 'Demo Tester')", [`demo+${Date.now()}@example.com`]);

  click('Click Place Order (2 × book)');
  await trigger.step(db, 'Click Place Order');
  const { rows: [order] } = await db.query<{ id: number }>(
    "SELECT place_order((SELECT max(id) FROM customers), 3, 2) AS id");

  click('Cancel the order');
  await trigger.step(db, 'Cancel the order');
  await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [order!.id]);
  await db.query('UPDATE inventory SET stock = stock + 2 WHERE product_id = 3');

  click('View order history');
  await trigger.step(db, 'View order history');
  const id = await trigger.stop(db);
  const rec = (await trigger.getRecording(db, id))!;

  nextStage('What the database did', 'propmaster record stop');
  say(formatTimeline(rec));

  nextStage('Evidence for the bug ticket', 'propmaster record export');
  const masker = createMasker();
  await writeFile('demo-report.html', toHtml(maskRecording(rec, masker), { masked: true }));
  await writeFile('demo-report.md', toMarkdown(maskRecording(rec, masker), { masked: true }));
  await writeFile('demo-checks.sql', toSql(rec, { masker }));
  const { rows } = await db.query<{ pass: boolean }>(toSql(rec, { masker }));
  say(` ${i.ok} demo-report.html  ${c.dim('open it in a browser')}`,
    ` ${i.ok} demo-report.md    ${c.dim('paste it into Jira or GitHub')}`,
    ` ${i.ok} demo-checks.sql   ${c.dim(`${rows.filter((r) => r.pass).length} of ${rows.length} checks pass against the database now`)}`);

  // Act 2: the requirement changes, a new build ships, and the business rules check it.
  nextStage('A requirement changes: "10% off when you buy 2 or more"', 'build v2 is deployed');
  const { rows: [original] } = await db.query<{ def: string }>("SELECT pg_get_functiondef('place_order'::regproc) AS def");
  await db.query(await readFile('demo/build-v2.sql', 'utf8'));
  try {
    await trigger.start(db, 'Demo: checkout on build v2');
    click('Click Place Order (2 × book) on build v2');
    await trigger.step(db, 'Click Place Order (2 items)');
    await db.query('SELECT place_order(1, 3, 2)');
    const v2 = (await trigger.getRecording(db, await trigger.stop(db)))!;

    nextStage('Check build v2 against the business rules', 'propmaster record check demo/rules.sql');
    const results = await checkRules(db, v2, parseRules(await readFile('demo/rules.sql', 'utf8'), 'demo/rules.sql'));
    say(formatRuleResults(results));
    say('', ` ${i.fail} ${c.bold('The rules caught a bug:')} the order got the discount, but the payment still charges full price.`);
  } finally {
    // Leave the shop as we found it, so the demo can run again: build v1, and the stock act 2 sold.
    await db.query(original!.def);
    await db.query('UPDATE inventory SET stock = stock + 2 WHERE product_id = 3');
  }

  say('', ` ${c.bold('Try it yourself')} ${c.dim('(the shop commands stand in for an app\'s buttons):')}`,
    hint(c, 'npm run propmaster -- record start "My test"'),
    hint(c, 'npm run shop -- order 1 3 2'),
    hint(c, 'npm run propmaster -- record stop'));
} finally {
  await db.end();
}
