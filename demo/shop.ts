// A stand-in for the demo shop's UI: each command is one button a tester would click.
//   npm run shop -- signup "Dina QA" dina@example.com
//   npm run shop -- order <customer> <product> <qty>
//   npm run shop -- cancel <order|last>
//   npm run shop -- restock            (tops every product up to at least 20 in stock)
import pg from 'pg';

const url = process.env.PROPMASTER_DATABASE_URL ?? 'postgres://propmaster:propmaster@localhost:5433/qa_shop';
const [command, ...args] = process.argv.slice(2);

const db = new pg.Client({ connectionString: url, application_name: 'qa-shop-web' });
await db.connect();
try {
  switch (command) {
    case 'signup': {
      const [name, email] = args;
      const { rows: [c] } = await db.query<{ id: number }>(
        'INSERT INTO customers (name, email) VALUES ($1, $2) RETURNING id', [name, email]);
      console.log(`Welcome, ${name}! (customer ${c!.id})`);
      break;
    }
    case 'order': {
      const [customer, product, qty] = args.map(Number);
      const { rows: [o] } = await db.query<{ id: number }>('SELECT place_order($1, $2, $3) AS id', [customer, product, qty]);
      console.log(`Success! Order ${o!.id} placed.`);
      break;
    }
    case 'cancel': {
      const order = args[0] === 'last'
        ? (await db.query<{ id: number }>('SELECT max(id) AS id FROM orders')).rows[0]!.id
        : Number(args[0]);
      await db.query('BEGIN');
      await db.query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [order]);
      await db.query(`UPDATE inventory i SET stock = i.stock + oi.qty
                        FROM order_items oi WHERE oi.order_id = $1 AND i.product_id = oi.product_id`, [order]);
      await db.query('COMMIT');
      console.log(`Order ${order} cancelled.`);
      break;
    }
    case 'restock': {
      const { rowCount } = await db.query('UPDATE inventory SET stock = 20 WHERE stock < 20');
      console.log(`Restocked ${rowCount} product${rowCount === 1 ? '' : 's'}.`);
      break;
    }
    default:
      console.log('Usage: shop signup <name> <email> | order <customer> <product> <qty> | cancel <order|last> | restock');
      process.exitCode = 1;
  }
} catch (err) {
  // What a real shop would show: a short message, not a stack trace.
  console.error(`Sorry, that didn't work: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
