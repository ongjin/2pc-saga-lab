import { randomUUID } from 'node:crypto';
import type { DbClient, OrderRequest } from '../domain.js';

type PaymentRow = {
  status: string;
  amount: number;
};

export async function chargePayment(client: DbClient, req: OrderRequest): Promise<void> {
  if (req.amount <= 0) {
    throw new Error('amount must be positive');
  }

  const inserted = (await client`
    INSERT INTO payments (id, order_id, amount, status)
    VALUES (${randomUUID()}, ${req.orderId}, ${req.amount}, 'CHARGED')
    ON CONFLICT (order_id) DO NOTHING
    RETURNING status, amount
  `) as PaymentRow[];

  if (inserted.length > 0) {
    return;
  }

  const [payment] = (await client`
    SELECT status, amount
    FROM payments
    WHERE order_id = ${req.orderId}
  `) as PaymentRow[];

  if (!payment) {
    throw new Error(`payment conflict could not be loaded: ${req.orderId}`);
  }

  if (payment.status === 'REFUNDED') {
    throw new Error(`payment already refunded: ${req.orderId}`);
  }

  if (payment.amount !== req.amount) {
    throw new Error(`payment already exists for order ${req.orderId} with amount ${payment.amount}`);
  }
}

export async function refundPayment(client: DbClient, orderId: string): Promise<void> {
  const refunded = await client`
    UPDATE payments
    SET status = 'REFUNDED'
    WHERE order_id = ${orderId}
      AND status = 'CHARGED'
    RETURNING status
  `;

  if (refunded.count > 0) {
    return;
  }

  const [payment] = (await client`
    SELECT status, amount
    FROM payments
    WHERE order_id = ${orderId}
  `) as PaymentRow[];

  if (payment?.status === 'REFUNDED') {
    return;
  }

  throw new Error(`charged payment not found: ${orderId}`);
}
