CREATE TABLE IF NOT EXISTS orders (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  sku         text NOT NULL,
  qty         int  NOT NULL CHECK (qty > 0),
  amount      int  NOT NULL,
  status      text NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED')),
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saga_log (
  order_id    uuid NOT NULL,
  step        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('STARTED', 'DONE', 'COMPENSATED')),
  payload     jsonb,
  created_at  timestamptz DEFAULT now(),
  PRIMARY KEY (order_id, step)
);

CREATE TABLE IF NOT EXISTS two_phase_decisions (
  order_id    uuid PRIMARY KEY,
  decision    text NOT NULL CHECK (decision IN ('COMMIT', 'ROLLBACK')),
  created_at  timestamptz DEFAULT now()
);
