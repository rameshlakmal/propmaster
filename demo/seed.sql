INSERT INTO customers (email, name) VALUES
  ('alice@example.com', 'Alice Tester'),
  ('bob@example.com',   'Bob Checker'),
  ('cara@example.com',  'Cara Bugfinder');

INSERT INTO products (sku, name, price) VALUES
  ('MUG-001',  'QA Coffee Mug',       12.50),
  ('TEE-002',  'It Works On My Machine T-shirt', 24.00),
  ('BOOK-003', 'Lessons Learned in Testing',     42.25),
  ('DUCK-004', 'Rubber Debug Duck',    8.00);

INSERT INTO inventory (product_id, stock) VALUES
  (1, 40), (2, 15), (3, 6), (4, 100);
