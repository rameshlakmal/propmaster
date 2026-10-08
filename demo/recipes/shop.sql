-- Test data recipes for the qa_shop demo database.
-- Find data:   propmaster find --recipes demo/recipes "never ordered" --claim
-- Check them:  propmaster recipes check --recipes demo/recipes
--
-- Each recipe is one SELECT. Parameters (:name) are declared with "-- param:" and sent as bind values.
-- "-- claim: <table>" lets testers claim a row so nobody else uses it while they test.

-- recipe: Customer who has never ordered
-- A brand-new shopper, for first-purchase and empty-order-history tests.
-- tags: customers, checkout, new-user
-- claim: customers
SELECT c.id, c.email, c.name
  FROM customers c
 WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
 ORDER BY c.id;

-- recipe: Customer with several orders
-- A returning shopper with an order history.
-- tags: customers, orders, returning
-- param: min_orders int = 2 | At least this many orders
-- claim: customers via customer_id
SELECT c.id AS customer_id, c.email, count(o.id) AS orders, max(o.created_at) AS last_order
  FROM customers c
  JOIN orders o ON o.customer_id = c.id
 GROUP BY c.id, c.email
HAVING count(o.id) >= :min_orders
 ORDER BY count(o.id) DESC, c.id;

-- recipe: Order in a given status
-- tags: orders
-- param: status text = PENDING | PENDING, PAID, SHIPPED or CANCELLED
-- claim: orders
SELECT o.id, o.status, o.total, c.email AS customer, o.created_at
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
 WHERE o.status = :status
 ORDER BY o.created_at DESC;

-- recipe: Product low on stock
-- For "only a few left" messages and out-of-stock edge cases.
-- tags: products, inventory, edge-case
-- param: max_stock int = 10 | At most this many in stock
-- claim: products
SELECT p.id, p.sku, p.name, p.price, i.stock
  FROM products p
  JOIN inventory i ON i.product_id = p.id
 WHERE i.stock <= :max_stock
 ORDER BY i.stock, p.id;

-- recipe: Product in a price range
-- tags: products, pricing
-- param: min_price numeric = 0
-- param: max_price numeric = 1000000
-- claim: products
SELECT p.id, p.sku, p.name, p.price
  FROM products p
 WHERE p.price BETWEEN :min_price AND :max_price
 ORDER BY p.price;

-- recipe: Order whose payment doesn't match its total
-- A broken order, to test refunds, support tools and reconciliation reports.
-- tags: orders, payments, negative
-- claim: orders via order_id
SELECT o.id AS order_id, o.total, p.amount AS paid, o.total - p.amount AS difference
  FROM orders o
  JOIN payments p ON p.order_id = o.id
 WHERE p.amount <> o.total
 ORDER BY o.id;
