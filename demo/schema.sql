-- qa_shop: a small e-commerce database used as the system under test.
-- place_order() stands in for the application's checkout code.

CREATE TABLE customers (
  id          serial PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id     serial PRIMARY KEY,
  sku    text NOT NULL UNIQUE,
  name   text NOT NULL,
  price  numeric(10, 2) NOT NULL CHECK (price >= 0)
);

CREATE TABLE inventory (
  product_id  int PRIMARY KEY REFERENCES products (id),
  stock       int NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id           serial PRIMARY KEY,
  customer_id  int NOT NULL REFERENCES customers (id),
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'PAID', 'SHIPPED', 'CANCELLED')),
  total        numeric(10, 2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id          serial PRIMARY KEY,
  order_id    int NOT NULL REFERENCES orders (id),
  product_id  int NOT NULL REFERENCES products (id),
  qty         int NOT NULL CHECK (qty > 0),
  unit_price  numeric(10, 2) NOT NULL
);

CREATE TABLE payments (
  id        serial PRIMARY KEY,
  order_id  int NOT NULL REFERENCES orders (id),
  amount    numeric(10, 2) NOT NULL,
  method    text NOT NULL,
  status    text NOT NULL DEFAULT 'AUTHORIZED'
);

-- The "Place Order" button: creates the order, its item and payment, and reduces stock.
CREATE FUNCTION place_order(p_customer int, p_product int, p_qty int, p_method text DEFAULT 'CARD')
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_price  numeric(10, 2);
  v_order  int;
BEGIN
  SELECT price INTO STRICT v_price FROM products WHERE id = p_product;

  UPDATE inventory SET stock = stock - p_qty WHERE product_id = p_product;

  INSERT INTO orders (customer_id, total)
  VALUES (p_customer, v_price * p_qty)
  RETURNING id INTO v_order;

  INSERT INTO order_items (order_id, product_id, qty, unit_price)
  VALUES (v_order, p_product, p_qty, v_price);

  INSERT INTO payments (order_id, amount, method)
  VALUES (v_order, v_price * p_qty, p_method);

  RETURN v_order;
END $$;
