CREATE TABLE IF NOT EXISTS stocks (
  sku  text PRIMARY KEY,
  qty  int  NOT NULL CHECK (qty >= 0)
);

CREATE TABLE IF NOT EXISTS reservations (
  id          uuid PRIMARY KEY,
  order_id    uuid NOT NULL,
  sku         text NOT NULL,
  qty         int  NOT NULL CHECK (qty > 0),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservations_order_id ON reservations(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_order_id_sku_unique ON reservations(order_id, sku);

INSERT INTO stocks (sku, qty)
VALUES ('SKU-1', 10)
ON CONFLICT (sku) DO UPDATE SET qty = EXCLUDED.qty;
