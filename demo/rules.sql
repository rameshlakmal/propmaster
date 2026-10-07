-- Business rules for the qa_shop checkout, requirement v2: "10% off when you buy 2 or more".
-- Run them against a recorded session:  propmaster record check demo/rules.sql
--
-- Each rule is one query that returns the rows BREAKING the rule. No rows = the rule holds.
-- {{orders}} means "the orders rows this session inserted or updated"; plain `orders` means the whole table.
-- When the requirement changes, change the rule here, not dozens of recorded values.

-- rule: Order total is the items' price, with 10% off for 2 or more items
SELECT o.id AS order_id, o.total,
       round(sum(i.qty * i.unit_price) * CASE WHEN sum(i.qty) >= 2 THEN 0.9 ELSE 1 END, 2) AS expected
  FROM {{orders}} o
  JOIN order_items i ON i.order_id = o.id
 GROUP BY o.id, o.total
HAVING o.total <> round(sum(i.qty * i.unit_price) * CASE WHEN sum(i.qty) >= 2 THEN 0.9 ELSE 1 END, 2);

-- rule: Payment amount matches the order total
SELECT p.order_id, p.amount, o.total
  FROM {{payments}} p
  JOIN orders o ON o.id = p.order_id
 WHERE p.amount <> o.total;

-- rule: Every order in the session has exactly one payment
SELECT o.id AS order_id, count(p.id) AS payments
  FROM {{orders}} o
  LEFT JOIN payments p ON p.order_id = o.id
 GROUP BY o.id
HAVING count(p.id) <> 1;

-- rule: Items are charged at the product's current price
SELECT i.id AS item_id, i.unit_price, p.price
  FROM {{order_items}} i
  JOIN products p ON p.id = i.product_id
 WHERE i.unit_price <> p.price;
