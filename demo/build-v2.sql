-- "Build v2" of the demo shop's checkout: implements requirement v2 (10% off when buying 2 or more),
-- with a bug a tester should catch: the payment is still taken for the full, undiscounted price.
-- Used by `npm run demo`, which puts the original place_order() back afterwards.
CREATE OR REPLACE FUNCTION place_order(p_customer int, p_product int, p_qty int, p_method text DEFAULT 'CARD')
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_price  numeric(10, 2);
  v_order  int;
BEGIN
  SELECT price INTO STRICT v_price FROM products WHERE id = p_product;

  UPDATE inventory SET stock = stock - p_qty WHERE product_id = p_product;

  INSERT INTO orders (customer_id, total)
  VALUES (p_customer, round(v_price * p_qty * CASE WHEN p_qty >= 2 THEN 0.9 ELSE 1 END, 2))
  RETURNING id INTO v_order;

  INSERT INTO order_items (order_id, product_id, qty, unit_price)
  VALUES (v_order, p_product, p_qty, v_price);

  INSERT INTO payments (order_id, amount, method)
  VALUES (v_order, v_price * p_qty, p_method);  -- BUG: should charge the discounted total

  RETURN v_order;
END $$;
