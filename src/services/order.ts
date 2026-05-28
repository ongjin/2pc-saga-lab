import type { DbClient, OrderRequest } from '../domain.js';

type OrderRow = {
  user_id: string;
  sku: string;
  qty: number;
  amount: number;
};

export async function createOrder(client: DbClient, req: OrderRequest): Promise<void> {
  const inserted = (await client`
    INSERT INTO orders (id, user_id, sku, qty, amount, status)
    VALUES (${req.orderId}, ${req.userId}, ${req.sku}, ${req.qty}, ${req.amount}, 'PENDING')
    ON CONFLICT (id) DO NOTHING
    RETURNING user_id, sku, qty, amount
  `) as OrderRow[];

  if (inserted.length > 0) {
    return;
  }

  const [order] = (await client`
    SELECT user_id, sku, qty, amount
    FROM orders
    WHERE id = ${req.orderId}
  `) as OrderRow[];

  if (
    order?.user_id === req.userId &&
    order.sku === req.sku &&
    order.qty === req.qty &&
    order.amount === req.amount
  ) {
    return;
  }

  throw new Error(`order already exists with different data: ${req.orderId}`);
}

export async function confirmOrder(client: DbClient, orderId: string): Promise<void> {
  const result = await client`
    UPDATE orders
    SET status = 'CONFIRMED'
    WHERE id = ${orderId}
  `;

  if (result.count === 0) {
    throw new Error(`order not found: ${orderId}`);
  }
}

export async function cancelOrder(client: DbClient, orderId: string): Promise<void> {
  const result = await client`
    UPDATE orders
    SET status = 'CANCELLED'
    WHERE id = ${orderId}
  `;

  if (result.count === 0) {
    throw new Error(`order not found: ${orderId}`);
  }
}
