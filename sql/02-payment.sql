CREATE TABLE IF NOT EXISTS payments (
  id          uuid PRIMARY KEY,
  order_id    uuid NOT NULL,
  amount      int  NOT NULL CHECK (amount > 0),
  status      text NOT NULL CHECK (status IN ('CHARGED', 'REFUNDED')),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
