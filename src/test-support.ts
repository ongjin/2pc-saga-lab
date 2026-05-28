import { DEFAULT_SKU, INITIAL_STOCK_QTY } from './config.js';
import { inventoryDb, orderDb, paymentDb } from './db.js';

export type FinalState = {
  order: null | { status: string; qty: number; amount: number };
  payment: null | { status: string; amount: number };
  stock: { sku: string; qty: number };
  reservations: number;
};

export async function resetAllData(): Promise<void> {
  await Promise.all([
    orderDb`TRUNCATE saga_log, orders`,
    paymentDb`TRUNCATE payments`,
    inventoryDb`TRUNCATE reservations, stocks`,
  ]);

  await inventoryDb`
    INSERT INTO stocks (sku, qty)
    VALUES (${DEFAULT_SKU}, ${INITIAL_STOCK_QTY})
  `;
}

export async function readFinalState(orderId: string, sku = DEFAULT_SKU): Promise<FinalState> {
  const [order] = (await orderDb`
    SELECT status, qty, amount
    FROM orders
    WHERE id = ${orderId}
  `) as Array<{ status: string; qty: number; amount: number }>;

  const [payment] = (await paymentDb`
    SELECT status, amount
    FROM payments
    WHERE order_id = ${orderId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ status: string; amount: number }>;

  const [stock] = (await inventoryDb`
    SELECT sku, qty
    FROM stocks
    WHERE sku = ${sku}
  `) as Array<{ sku: string; qty: number }>;

  const [reservationCount] = (await inventoryDb`
    SELECT count(*)::int AS count
    FROM reservations
    WHERE order_id = ${orderId}
  `) as Array<{ count: number }>;

  if (!stock) {
    throw new Error(`Missing stock row for sku: ${sku}`);
  }

  return {
    order: order ?? null,
    payment: payment ?? null,
    stock,
    reservations: reservationCount?.count ?? 0,
  };
}
