import { randomUUID } from 'node:crypto';
import type { OrderRequest, TransactionDbClient } from '../domain.js';

type StockRow = {
  sku: string;
  qty: number;
};

type ReservationRow = {
  sku: string;
  qty: number;
};

export async function reserveStock(client: TransactionDbClient, req: OrderRequest): Promise<void> {
  if (req.qty <= 0) {
    throw new Error('qty must be positive');
  }

  const [reservation] = (await client`
    SELECT sku, qty
    FROM reservations
    WHERE order_id = ${req.orderId}
      AND sku = ${req.sku}
  `) as ReservationRow[];

  if (reservation) {
    if (reservation.qty === req.qty) {
      return;
    }

    throw new Error(
      `reservation already exists for order ${req.orderId} sku ${req.sku} with qty ${reservation.qty}`,
    );
  }

  const [stock] = (await client`
    SELECT sku, qty
    FROM stocks
    WHERE sku = ${req.sku}
    FOR UPDATE
  `) as StockRow[];

  if (!stock) {
    throw new Error(`stock not found: ${req.sku}`);
  }

  if (stock.qty < req.qty) {
    throw new Error('insufficient stock');
  }

  await client`
    UPDATE stocks
    SET qty = qty - ${req.qty}
    WHERE sku = ${req.sku}
  `;

  await client`
    INSERT INTO reservations (id, order_id, sku, qty)
    VALUES (${randomUUID()}, ${req.orderId}, ${req.sku}, ${req.qty})
  `;
}

export async function releaseStock(client: TransactionDbClient, orderId: string): Promise<void> {
  const reservations = (await client`
    DELETE FROM reservations
    WHERE order_id = ${orderId}
    RETURNING sku, qty
  `) as ReservationRow[];

  for (const reservation of reservations) {
    await client`
      UPDATE stocks
      SET qty = qty + ${reservation.qty}
      WHERE sku = ${reservation.sku}
    `;
  }
}
