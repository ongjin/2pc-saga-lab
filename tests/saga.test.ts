import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDbs } from '../src/db.js';
import { DemoFailure, type OrderRequest } from '../src/domain.js';
import { markSagaStep, readSagaLog } from '../src/saga/log.js';
import { runSaga } from '../src/saga/orchestrator.js';
import { applySchema } from '../src/setup.js';
import { readFinalState, resetAllData } from '../src/test-support.js';

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

describe('saga', () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetAllData();
  });

  afterAll(async () => {
    await closeDbs();
  });

  test('happy path commits each step', async () => {
    const req = request();

    const result = await runSaga(req);

    expect(result.events.map((event) => event.line)).toContain('  -> step:order_confirmed DONE');

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CONFIRMED', qty: 1, amount: 10000 });
    expect(final.payment).toEqual({ status: 'CHARGED', amount: 10000 });
    expect(final.stock.qty).toBe(9);

    const log = await readSagaLog(req.orderId);
    expect(log.map((row) => [row.step, row.status])).toEqual([
      ['order_created', 'DONE'],
      ['payment_charged', 'DONE'],
      ['stock_reserved', 'DONE'],
      ['order_confirmed', 'DONE'],
    ]);
  });

  test('payment failure leaves cancelled order trace', async () => {
    const req = request({ amount: -1 });

    await expect(runSaga(req)).rejects.toThrow('amount must be positive');

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CANCELLED', qty: 1, amount: -1 });
    expect(final.payment).toBeNull();
    expect(final.stock.qty).toBe(10);

    const log = await readSagaLog(req.orderId);
    expect(log.map((row) => [row.step, row.status])).toEqual([
      ['order_created', 'COMPENSATED'],
      ['payment_charged', 'STARTED'],
    ]);
  });

  test('inventory failure refunds payment and cancels order', async () => {
    const req = request({ qty: 999 });

    await expect(runSaga(req)).rejects.toThrow('insufficient stock');

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CANCELLED', qty: 999, amount: 10000 });
    expect(final.payment).toEqual({ status: 'REFUNDED', amount: 10000 });
    expect(final.stock.qty).toBe(10);

    const log = await readSagaLog(req.orderId);
    expect(log.map((row) => [row.step, row.status])).toEqual([
      ['order_created', 'COMPENSATED'],
      ['payment_charged', 'COMPENSATED'],
      ['stock_reserved', 'STARTED'],
    ]);
  });

  test('compensates charged payment when payment DONE logging fails', async () => {
    const req = request();

    await expect(
      runSaga(req, {
        dependencies: {
          markStep: async (orderId, step, status, payload) => {
            if (step === 'payment_charged' && status === 'DONE') {
              throw new Error('payment DONE log unavailable');
            }

            await markSagaStep(orderId, step, status, payload);
          },
        },
      }),
    ).rejects.toThrow('payment DONE log unavailable');

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CANCELLED', qty: 1, amount: 10000 });
    expect(final.payment).toEqual({ status: 'REFUNDED', amount: 10000 });
    expect(final.stock.qty).toBe(10);

    const log = await readSagaLog(req.orderId);
    expect(log.map((row) => [row.step, row.status])).toEqual([
      ['order_created', 'COMPENSATED'],
      ['payment_charged', 'COMPENSATED'],
    ]);
  });

  test('does not rerun compensation action when COMPENSATED logging is retried', async () => {
    const req = request();
    let compensationRuns = 0;
    let compensatedLogAttempts = 0;
    let failure: unknown;

    try {
      await runSaga(req, {
        dependencies: {
          steps: [
            {
              name: 'order_created',
              run: async () => {},
              compensate: async () => {
                compensationRuns += 1;
              },
            },
            {
              name: 'payment_charged',
              run: async () => {
                throw new Error('payment step failed');
              },
            },
          ],
          markStep: async (_orderId, step, status) => {
            if (step === 'order_created' && status === 'COMPENSATED') {
              compensatedLogAttempts += 1;
              if (compensatedLogAttempts < 3) {
                throw new Error('COMPENSATED log unavailable');
              }
            }
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DemoFailure);
    expect((failure as DemoFailure).message).toBe('payment step failed');
    expect(compensationRuns).toBe(1);
    expect(compensatedLogAttempts).toBe(3);
    expect((failure as DemoFailure).events.filter((event) => event.line.includes('COMPENSATED'))).toEqual([
      { line: '  <- compensate:order_created COMPENSATED' },
    ]);
  });

  test('continues compensating earlier steps after a permanent COMPENSATED log failure', async () => {
    const req = request({ qty: 999 });

    await expect(
      runSaga(req, {
        dependencies: {
          markStep: async (orderId, step, status, payload) => {
            if (step === 'payment_charged' && status === 'COMPENSATED') {
              throw new Error('payment COMPENSATED log unavailable');
            }

            await markSagaStep(orderId, step, status, payload);
          },
        },
      }),
    ).rejects.toThrow('payment COMPENSATED log unavailable');

    const final = await readFinalState(req.orderId);
    expect(final.order).toEqual({ status: 'CANCELLED', qty: 999, amount: 10000 });
    expect(final.payment).toEqual({ status: 'REFUNDED', amount: 10000 });
    expect(final.stock.qty).toBe(10);
  });
});
