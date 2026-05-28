import type postgres from 'postgres';
import { orderDb } from '../db.js';

export type SagaStep = 'order_created' | 'payment_charged' | 'stock_reserved' | 'order_confirmed';
export type SagaStepStatus = 'STARTED' | 'DONE' | 'COMPENSATED';
export type SagaLogPayload = postgres.JSONValue;

export type SagaLogRow = {
  orderId: string;
  step: SagaStep;
  status: SagaStepStatus;
  payload: SagaLogPayload;
  createdAt: Date;
};

type SagaLogDbRow = {
  order_id: string;
  step: SagaStep;
  status: SagaStepStatus;
  payload: SagaLogPayload | null;
  created_at: Date;
};

export async function markSagaStep(
  orderId: string,
  step: SagaStep,
  status: SagaStepStatus,
  payload: SagaLogPayload = {},
): Promise<void> {
  await orderDb`
    INSERT INTO saga_log (order_id, step, status, payload, created_at)
    VALUES (${orderId}, ${step}, ${status}, ${orderDb.json(payload)}, now())
    ON CONFLICT (order_id, step) DO UPDATE
    SET status = EXCLUDED.status,
        payload = EXCLUDED.payload
  `;
}

export async function readSagaLog(orderId: string): Promise<SagaLogRow[]> {
  const rows = (await orderDb`
    SELECT order_id, step, status, payload, created_at
    FROM saga_log
    WHERE order_id = ${orderId}
    ORDER BY CASE step
        WHEN 'order_created' THEN 1
        WHEN 'payment_charged' THEN 2
        WHEN 'stock_reserved' THEN 3
        WHEN 'order_confirmed' THEN 4
        ELSE 99
      END ASC
  `) as SagaLogDbRow[];

  return rows.map((row) => ({
    orderId: row.order_id,
    step: row.step,
    status: row.status,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  }));
}
