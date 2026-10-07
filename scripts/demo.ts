// The whole recorder flow on the demo shop in one command: npm run demo
// Needs the demo database (npm run db:up). Writes demo-report.html, demo-report.md and demo-checks.sql,
// then plays a requirement change: build v2 of the checkout, checked with the rules in demo/rules.sql.
import { readFile, writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { connect } from '../src/core/db.js';
import { toHtml } from '../src/recorder/export/html.js';
import { toMarkdown } from '../src/recorder/export/markdown.js';
import { toSql } from '../src/recorder/export/sql.js';
import { createMasker, maskRecording } from '../src/recorder/mask.js';
import { checkRules, parseRules } from '../src/recorder/rules.js';
import { formatRuleResults } from '../src/recorder/rules-report.js';
import { formatTimeline } from '../src/recorder/timeline.js';
import * as trigger from '../src/recorder/trigger.js';

const URL = process.env.PROPMASTER_DATABASE_URL ?? 'postgres://propmaster:propmaster@localhost:5433/qa_shop';

const say = (text: string) => console.log(pc.dim(`\n# ${text}`));

const db = await connect(URL);
try {
  say('Install the recorder (safe to repeat)');
  await trigger.install(db);
  const { active, watchedTables } = await trigger.status(db);
  if (active) await trigger.stop(db); // a leftover session from an earlier run
  console.log(`Watching ${watchedTables} tables.`);

  say('A tester checks out, then cancels the order');
  await trigger.start(db, 'Demo: checkout and cancel');

  await trigger.step(db, 'Sign up');
  await db.query("INSERT INTO customers (email, name) VALUES ($1, 'Demo Tester')", [`demo+${Date.now()}@example.com`]);

  await trigger.step(db, 'Click Place Order');
  const { rows: [order] } = await db.query<{ id: number }>(
    "SELECT place_order((SELECT max(id) FROM customers), 3, 2) AS id");

  await trigger.step(db, 'Cancel the order');
  await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [order!.id]);
  await db.query('UPDATE inventory SET stock = stock + 2 WHERE product_id = 3');

  await trigger.step(db, 'View order history');
  const id = await trigger.stop(db);
  const rec = (await trigger.getRecording(db, id))!;

  say('The timeline');
  console.log(formatTimeline(rec));

  say('Evidence files');
  const masker = createMasker();
  await writeFile('demo-report.html', toHtml(maskRecording(rec, masker), { masked: true }));
  await writeFile('demo-report.md', toMarkdown(maskRecording(rec, masker), { masked: true }));
  await writeFile('demo-checks.sql', toSql(rec, { masker }));
  console.log('demo-report.html  demo-report.md  demo-checks.sql');

  say('The SQL checks pass against the database right now');
  const { rows } = await db.query<{ pass: boolean }>(toSql(rec, { masker }));
  console.log(`${rows.filter((r) => r.pass).length} of ${rows.length} checks pass.`);

  // Act 2: the requirement changes, a new build ships, and the business rules check it.
  say('Requirement v2: "10% off when you buy 2 or more". Build v2 is deployed (demo/build-v2.sql)');
  const { rows: [original] } = await db.query<{ def: string }>("SELECT pg_get_functiondef('place_order'::regproc) AS def");
  await db.query(await readFile('demo/build-v2.sql', 'utf8'));
  try {
    await trigger.start(db, 'Demo: checkout on build v2');
    await trigger.step(db, 'Click Place Order (2 items)');
    await db.query('SELECT place_order(1, 3, 2)');
    const v2 = (await trigger.getRecording(db, await trigger.stop(db)))!;

    say('Check the session against the rules in demo/rules.sql');
    const results = await checkRules(db, v2, parseRules(await readFile('demo/rules.sql', 'utf8'), 'demo/rules.sql'));
    console.log(formatRuleResults(results));
    console.log(pc.dim('\nThe discount was applied to the order, but the payment still charges the full price.'));
  } finally {
    await db.query(original!.def); // back to build v1, so the demo can run again
  }
} finally {
  await db.end();
}
