import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDbs, inventoryDb, orderDb, paymentDb } from '../src/db.js';
import { DemoFailure, type OrderRequest } from '../src/domain.js';
import { applySchema } from '../src/setup.js';
import { reserveStock } from '../src/services/inventory.js';
import { confirmOrder, createOrder } from '../src/services/order.js';
import { chargePayment } from '../src/services/payment.js';
import { readFinalState, resetAllData } from '../src/test-support.js';
import { runTwoPhaseCommit } from '../src/two-phase-commit/coordinator.js';
import {
  commitPrepared,
  finishTwoPhaseOrder,
  readTwoPhaseDecision,
  recordTwoPhaseDecision,
  recoverTwoPhaseCommit,
  twoPhaseGid,
} from '../src/two-phase-commit/recovery.js';

function request(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    orderId: randomUUID(),
    userId: 'user-1',
    sku: 'SKU-1',
    qty: 1,
    amount: 10000,
    ...overrides,
  };
}

async function prepareAllParticipants(req: OrderRequest): Promise<void> {
  await orderDb.begin('read write', async (tx) => {
    await createOrder(tx, req);
    await confirmOrder(tx, req.orderId);
    await tx.prepare(twoPhaseGid(req.orderId, 'order-db'));
  });

  await paymentDb.begin('read write', async (tx) => {
    await chargePayment(tx, req);
    await tx.prepare(twoPhaseGid(req.orderId, 'payment-db'));
  });

  await inventoryDb.begin('read write', async (tx) => {
    await reserveStock(tx, req);
    await tx.prepare(twoPhaseGid(req.orderId, 'inventory-db'));
  });
}

async function countPreparedTransactions(): Promise<number> {
  const counts = await Promise.all([
    countPreparedTransactionsIn(orderDb),
    countPreparedTransactionsIn(paymentDb),
    countPreparedTransactionsIn(inventoryDb),
  ]);

  return counts.reduce((total, count) => total + count, 0);
}

async function countPreparedTransactionsIn(db: typeof orderDb): Promise<number> {
  const [row] = (await db`
    SELECT count(*)::int AS count
    FROM pg_prepared_xacts
    WHERE database = current_database()
      AND gid LIKE '2pc-saga-lab:%'
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

async function restoreTwoPhaseDecisionTable(): Promise<void> {
  await orderDb`
    CREATE TABLE IF NOT EXISTS two_phase_decisions (
      order_id    uuid PRIMARY KEY,
      decision    text NOT NULL CHECK (decision IN ('COMMIT', 'ROLLBACK')),
      created_at  timestamptz DEFAULT now()
    )
  `;
}

describe('two-phase commit', () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await recoverTwoPhaseCommit();
    await resetAllData();
  });

  afterAll(async () => {
    await recoverTwoPhaseCommit();
    await closeDbs();
  });

  test('happy path commits all participants', async () => {
    const req = request();

    const result = await runTwoPhaseCommit(req);

    expect(result.orderId).toBe(req.orderId);
    expect(result.events).toContainEqual({ line: '[2PC] all prepared -> COMMIT PREPARED' });

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CONFIRMED', qty: 1, amount: 10000 });
    expect(final.payment).toEqual({ status: 'CHARGED', amount: 10000 });
    expect(final.stock.qty).toBe(9);
    expect(await countPreparedTransactions()).toBe(0);
  });

  test('payment failure rolls back every participant', async () => {
    const req = request({ amount: -1 });

    await expect(runTwoPhaseCommit(req)).rejects.toThrow('amount must be positive');

    const final = await readFinalState(req.orderId);
    expect(final.order).toBeNull();
    expect(final.payment).toBeNull();
    expect(final.stock.qty).toBe(10);
    expect(await countPreparedTransactions()).toBe(0);
  });

  test('inventory failure rolls back prepared order and payment', async () => {
    const req = request({ qty: 999 });

    await expect(runTwoPhaseCommit(req)).rejects.toThrow('insufficient stock');

    const final = await readFinalState(req.orderId);
    expect(final.order).toBeNull();
    expect(final.payment).toBeNull();
    expect(final.stock.qty).toBe(10);
    expect(await countPreparedTransactions()).toBe(0);
  });

  test('conflicting durable rollback decision rolls back prepared participants', async () => {
    const req = request();
    await recordTwoPhaseDecision(req.orderId, 'ROLLBACK');

    await expect(runTwoPhaseCommit(req)).rejects.toThrow('2PC decision already recorded as ROLLBACK');

    const final = await readFinalState(req.orderId);
    expect(final.order).toBeNull();
    expect(final.payment).toBeNull();
    expect(final.stock.qty).toBe(10);
    expect(await countPreparedTransactions()).toBe(0);
  });

  test('unknown decision state leaves prepared participants for recovery', async () => {
    const req = request();
    let failure: unknown;

    await orderDb`DROP TABLE two_phase_decisions`;
    try {
      try {
        await runTwoPhaseCommit(req);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(DemoFailure);
      expect((failure as DemoFailure).events).toContainEqual({
        line: expect.stringContaining('decision state unknown -> leave prepared transactions for recovery'),
      });
      expect(await countPreparedTransactions()).toBe(3);
    } finally {
      await finishTwoPhaseOrder(req.orderId, 'COMMIT');
      await restoreTwoPhaseDecisionTable();
    }

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CONFIRMED', qty: 1, amount: 10000 });
    expect(final.payment).toEqual({ status: 'CHARGED', amount: 10000 });
    expect(final.stock.qty).toBe(9);
    expect(await countPreparedTransactions()).toBe(0);
  });

  test('recovery rolls back prepared participants without a durable decision', async () => {
    const req = request();
    await prepareAllParticipants(req);

    const events = await recoverTwoPhaseCommit();

    const final = await readFinalState(req.orderId);
    expect(events).toContainEqual({
      line: `[2PC][recovery] ${req.orderId} no durable decision -> ROLLBACK PREPARED`,
    });
    expect(final.order).toBeNull();
    expect(final.payment).toBeNull();
    expect(final.stock.qty).toBe(10);
    expect(await countPreparedTransactions()).toBe(0);
  });

  test('recovery follows durable commit decision after one participant committed', async () => {
    const req = request();
    await prepareAllParticipants(req);
    await recordTwoPhaseDecision(req.orderId, 'COMMIT');
    await commitPrepared(req.orderId, 'order-db');

    expect(await readTwoPhaseDecision(req.orderId)).toBe('COMMIT');

    await recoverTwoPhaseCommit();

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CONFIRMED', qty: 1, amount: 10000 });
    expect(final.payment).toEqual({ status: 'CHARGED', amount: 10000 });
    expect(final.stock.qty).toBe(9);
    expect(await countPreparedTransactions()).toBe(0);
  });
});
