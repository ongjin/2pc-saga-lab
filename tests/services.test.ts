import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDbs, inventoryDb, orderDb, paymentDb } from '../src/db.js';
import { applySchema } from '../src/setup.js';
import { cancelOrder, confirmOrder, createOrder } from '../src/services/order.js';
import { chargePayment, refundPayment } from '../src/services/payment.js';
import { releaseStock, reserveStock } from '../src/services/inventory.js';
import { readFinalState, resetAllData } from '../src/test-support.js';
import type { OrderRequest } from '../src/domain.js';

function baseRequest() {
  return {
    orderId: randomUUID(),
    userId: 'user-1',
    sku: 'SKU-1',
    qty: 1,
    amount: 10000,
  };
}

async function countPayments(orderId: string): Promise<number> {
  const [row] = (await paymentDb`
    SELECT count(*)::int AS count
    FROM payments
    WHERE order_id = ${orderId}
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

async function countOrders(orderId: string): Promise<number> {
  const [row] = (await orderDb`
    SELECT count(*)::int AS count
    FROM orders
    WHERE id = ${orderId}
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

async function reserveStockInTransaction(req: OrderRequest): Promise<void> {
  await inventoryDb.begin(async (tx) => {
    await reserveStock(tx, req);
  });
}

async function releaseStockInTransaction(orderId: string): Promise<void> {
  await inventoryDb.begin(async (tx) => {
    await releaseStock(tx, orderId);
  });
}

if (false) {
  // @ts-expect-error inventory reservations require an explicit transaction client
  void reserveStock(inventoryDb, baseRequest());
  // @ts-expect-error inventory releases require an explicit transaction client
  void releaseStock(inventoryDb, randomUUID());
}

describe('services', () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetAllData();
  });

  afterAll(async () => {
    await closeDbs();
  });

  test('create, confirm, and cancel order', async () => {
    const req = baseRequest();

    await createOrder(orderDb, req);
    await confirmOrder(orderDb, req.orderId);
    await cancelOrder(orderDb, req.orderId);

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CANCELLED', qty: 1, amount: 10000 });
  });

  test('charge and refund payment', async () => {
    const req = baseRequest();

    await chargePayment(paymentDb, req);
    await refundPayment(paymentDb, req.orderId);

    const final = await readFinalState(req.orderId);
    expect(final.payment).toEqual({ status: 'REFUNDED', amount: 10000 });
  });

  test('reject non-positive payment amount', async () => {
    const req = { ...baseRequest(), amount: -1 };

    await expect(chargePayment(paymentDb, req)).rejects.toThrow('amount must be positive');

    const final = await readFinalState(req.orderId);
    expect(final.payment).toBeNull();
  });

  test('reserve and release stock', async () => {
    const req = baseRequest();

    await reserveStockInTransaction(req);

    const afterReserve = await readFinalState(req.orderId);
    expect(afterReserve.stock.qty).toBe(9);
    expect(afterReserve.reservations).toBe(1);

    await releaseStockInTransaction(req.orderId);

    const afterRelease = await readFinalState(req.orderId);
    expect(afterRelease.stock.qty).toBe(10);
    expect(afterRelease.reservations).toBe(0);
  });

  test('reject insufficient stock', async () => {
    const req = { ...baseRequest(), qty: 999 };

    await expect(reserveStockInTransaction(req)).rejects.toThrow('insufficient stock');

    const final = await readFinalState(req.orderId);
    expect(final.stock.qty).toBe(10);
    expect(final.reservations).toBe(0);
  });

  test('reject non-positive inventory quantity', async () => {
    const req = { ...baseRequest(), qty: -1 };

    await expect(reserveStockInTransaction(req)).rejects.toThrow('qty must be positive');

    const final = await readFinalState(req.orderId);
    expect(final.stock.qty).toBe(10);
    expect(final.reservations).toBe(0);
  });

  test('retrying createOrder with identical data succeeds', async () => {
    const req = baseRequest();

    await createOrder(orderDb, req);
    await createOrder(orderDb, req);

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'PENDING', qty: 1, amount: 10000 });
    expect(await countOrders(req.orderId)).toBe(1);
  });

  test('rejects retrying createOrder with different data', async () => {
    const req = baseRequest();

    await createOrder(orderDb, req);

    await expect(createOrder(orderDb, { ...req, amount: 20000 })).rejects.toThrow(
      `order already exists with different data: ${req.orderId}`,
    );

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'PENDING', qty: 1, amount: 10000 });
    expect(await countOrders(req.orderId)).toBe(1);
  });

  test('accepts transaction-scoped clients', async () => {
    const req = baseRequest();

    await orderDb.begin(async (tx) => {
      await createOrder(tx, req);
      await confirmOrder(tx, req.orderId);
    });
    await paymentDb.begin(async (tx) => {
      await chargePayment(tx, req);
    });
    await inventoryDb.begin(async (tx) => {
      await reserveStock(tx, req);
    });

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CONFIRMED', qty: 1, amount: 10000 });
    expect(final.payment).toEqual({ status: 'CHARGED', amount: 10000 });
    expect(final.stock.qty).toBe(9);
    expect(final.reservations).toBe(1);
  });

  test('retrying chargePayment does not double-charge', async () => {
    const req = baseRequest();

    await chargePayment(paymentDb, req);
    await chargePayment(paymentDb, req);

    const final = await readFinalState(req.orderId);
    expect(final.payment).toEqual({ status: 'CHARGED', amount: 10000 });
    expect(await countPayments(req.orderId)).toBe(1);
  });

  test('rejects retrying chargePayment with a different amount', async () => {
    const req = baseRequest();

    await chargePayment(paymentDb, req);

    await expect(chargePayment(paymentDb, { ...req, amount: 20000 })).rejects.toThrow(
      `payment already exists for order ${req.orderId} with amount 10000`,
    );

    const final = await readFinalState(req.orderId);
    expect(final.payment).toEqual({ status: 'CHARGED', amount: 10000 });
    expect(await countPayments(req.orderId)).toBe(1);
  });

  test('rejects charging an already refunded payment', async () => {
    const req = baseRequest();

    await chargePayment(paymentDb, req);
    await refundPayment(paymentDb, req.orderId);

    await expect(chargePayment(paymentDb, req)).rejects.toThrow(`payment already refunded: ${req.orderId}`);

    const final = await readFinalState(req.orderId);
    expect(final.payment).toEqual({ status: 'REFUNDED', amount: 10000 });
    expect(await countPayments(req.orderId)).toBe(1);
  });

  test('retrying refundPayment succeeds after refund is already applied', async () => {
    const req = baseRequest();

    await chargePayment(paymentDb, req);
    await refundPayment(paymentDb, req.orderId);
    await refundPayment(paymentDb, req.orderId);

    const final = await readFinalState(req.orderId);
    expect(final.payment).toEqual({ status: 'REFUNDED', amount: 10000 });
    expect(await countPayments(req.orderId)).toBe(1);
  });

  test('retrying reserveStock does not double-decrement stock', async () => {
    const req = baseRequest();

    await reserveStockInTransaction(req);
    await reserveStockInTransaction(req);

    const final = await readFinalState(req.orderId);
    expect(final.stock.qty).toBe(9);
    expect(final.reservations).toBe(1);
  });

  test('rejects retrying reserveStock with a different quantity', async () => {
    const req = baseRequest();

    await reserveStockInTransaction(req);

    await expect(reserveStockInTransaction({ ...req, qty: 2 })).rejects.toThrow(
      `reservation already exists for order ${req.orderId} sku SKU-1 with qty 1`,
    );

    const final = await readFinalState(req.orderId);
    expect(final.stock.qty).toBe(9);
    expect(final.reservations).toBe(1);
  });

  test('retrying releaseStock succeeds after release is already applied', async () => {
    const req = baseRequest();

    await reserveStockInTransaction(req);
    await releaseStockInTransaction(req.orderId);
    await releaseStockInTransaction(req.orderId);

    const final = await readFinalState(req.orderId);
    expect(final.stock.qty).toBe(10);
    expect(final.reservations).toBe(0);
  });
});
