-- Demo database for screenshots and videos: a small shop with one of each
-- problem the optimizer looks for. Load it into an empty database, then run
-- dev/demo-workload.mjs so pg_stat_statements has queries to show.
--
--   createdb shop && psql shop -f dev/demo.sql && PG_URL=postgres://.../shop node dev/demo-workload.mjs

-- Keep extension objects out of the public schema.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS hypopg SCHEMA extensions;

CREATE TABLE customers (
  id serial PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO customers (email, name, region, created_at)
SELECT 'customer' || g || '@example.com',
       'Customer ' || g,
       (ARRAY['us-east', 'us-west', 'eu', 'apac'])[1 + g % 4],
       now() - (g || ' minutes')::interval
FROM generate_series(1, 60000) g;

CREATE TABLE products (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  title text NOT NULL,
  price numeric(10, 2) NOT NULL
);
INSERT INTO products (sku, title, price)
SELECT 'SKU-' || g, 'Product ' || g, (5 + g % 200)::numeric
FROM generate_series(1, 2000) g;

-- customer_id references customers but has no index.
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers (id),
  status text NOT NULL,
  total numeric(10, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO orders (customer_id, status, total, created_at)
SELECT 1 + (g::bigint * 7919) % 60000,
       (ARRAY['pending', 'paid', 'shipped', 'delivered', 'refunded'])[1 + g % 5],
       (g % 900)::numeric + 0.99,
       now() - (g || ' seconds')::interval
FROM generate_series(1, 1200000) g;

CREATE TABLE order_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id),
  product_id int NOT NULL REFERENCES products (id),
  quantity int NOT NULL
);
INSERT INTO order_items (order_id, product_id, quantity)
SELECT 1 + g % 1200000, 1 + g % 2000, 1 + g % 3
FROM generate_series(1, 400000) g;
CREATE INDEX order_items_order_id_idx ON order_items (order_id);

-- Two identical indexes, both covered by a third.
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_status_idx1 ON orders (status);
CREATE INDEX orders_status_created_at_idx ON orders (status, created_at);

-- Nothing ever uses this one.
CREATE INDEX customers_created_at_idx ON customers (created_at);

ALTER TABLE orders ADD CONSTRAINT orders_total_check CHECK (total >= 0) NOT VALID;

-- Autovacuum is off, so dead rows pile up and statistics are never collected.
CREATE TABLE sessions (
  id serial PRIMARY KEY,
  customer_id int,
  token text,
  last_seen timestamptz
) WITH (autovacuum_enabled = false);
INSERT INTO sessions (customer_id, token, last_seen)
SELECT g % 60000, md5(g::text), now() FROM generate_series(1, 80000) g;
UPDATE sessions SET last_seen = now();

-- An int4 serial most of the way to its limit.
CREATE TABLE support_tickets (id serial PRIMARY KEY, subject text);
SELECT setval('support_tickets_id_seq', 1900000000);
INSERT INTO support_tickets (subject) VALUES ('Where is my order?');

-- No primary key.
CREATE TABLE audit_log (at timestamptz DEFAULT now(), message text);
INSERT INTO audit_log (message) SELECT 'event ' || g FROM generate_series(1, 5000) g;

-- Duplicate values, so the unique index build fails and leaves an invalid index.
CREATE TABLE newsletter_signups (email text);
INSERT INTO newsletter_signups VALUES ('a@example.com'), ('a@example.com');

ANALYZE customers;
ANALYZE products;
ANALYZE orders;
ANALYZE order_items;
ANALYZE support_tickets;
