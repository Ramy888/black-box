-- The demo shop's operational database. Synthetic data only.
DROP TABLE IF EXISTS tool_calls, refunds, refund_requests, payments, orders, customers, policy_versions CASCADE;

CREATE TABLE customers (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  city        text NOT NULL
);

CREATE TABLE orders (
  id            text PRIMARY KEY,
  customer_id   text NOT NULL REFERENCES customers(id),
  amount_egp    numeric(10,2) NOT NULL,
  status        text NOT NULL,
  delivered_at  timestamptz NOT NULL
);

CREATE TABLE payments (
  id            text PRIMARY KEY,
  order_id      text NOT NULL REFERENCES orders(id),
  provider_ref  text NOT NULL,
  captured_at   timestamptz NOT NULL
);

-- Refund policy history: one open row (valid_to IS NULL) is the live version.
CREATE TABLE policy_versions (
  version          int PRIMARY KEY,
  max_return_days  int NOT NULL,
  valid_from       timestamptz NOT NULL,
  valid_to         timestamptz,
  note             text NOT NULL
);

-- The queue the refund agent works through.
CREATE TABLE refund_requests (
  id            text PRIMARY KEY,
  order_id      text NOT NULL REFERENCES orders(id),
  customer_id   text NOT NULL REFERENCES customers(id),
  reason        text NOT NULL,
  requested_at  timestamptz NOT NULL
);

-- Written by the refund agent when it pays out.
CREATE TABLE refunds (
  id            text PRIMARY KEY,
  request_id    text NOT NULL REFERENCES refund_requests(id),
  order_id      text NOT NULL REFERENCES orders(id),
  amount_egp    numeric(10,2) NOT NULL,
  issued_at     timestamptz NOT NULL,
  run_id        text NOT NULL
);

-- Every tool call the refund agent makes.
CREATE TABLE tool_calls (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL,
  request_id  text,
  ts          timestamptz NOT NULL,
  tool        text NOT NULL,
  args        jsonb NOT NULL,
  result      jsonb NOT NULL
);
