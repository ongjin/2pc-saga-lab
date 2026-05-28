import type postgres from 'postgres';
import { inventoryDb, orderDb, paymentDb } from '../db.js';
import { DemoFailure, type DemoEvent, type DemoResult, type OrderRequest } from '../domain.js';
import { reserveStock } from '../services/inventory.js';
import { confirmOrder, createOrder } from '../services/order.js';
import { chargePayment } from '../services/payment.js';
import {
  finishTwoPhaseOrder,
  recordTwoPhaseDecision,
  readTwoPhaseDecision,
  type TwoPhaseParticipantName,
  twoPhaseGid,
} from './recovery.js';

type TwoPhaseParticipant = {
  name: TwoPhaseParticipantName;
  db: postgres.Sql;
  prepare: (tx: postgres.TransactionSql, req: OrderRequest) => Promise<void>;
};

type TwoPhaseOptions = {
  crashAfterPrepare?: boolean;
};

const participants: readonly TwoPhaseParticipant[] = [
  {
    name: 'order-db',
    db: orderDb,
    prepare: async (tx, req) => {
      await createOrder(tx, req);
      await confirmOrder(tx, req.orderId);
    },
  },
  {
    name: 'payment-db',
    db: paymentDb,
    prepare: async (tx, req) => {
      await chargePayment(tx, req);
    },
  },
  {
    name: 'inventory-db',
    db: inventoryDb,
    prepare: async (tx, req) => {
      await reserveStock(tx, req);
    },
  },
];

export async function runTwoPhaseCommit(
  req: OrderRequest,
  options: TwoPhaseOptions = {},
): Promise<DemoResult> {
  const events: DemoEvent[] = [];

  try {
    for (const participant of participants) {
      const gid = twoPhaseGid(req.orderId, participant.name);
      await participant.db.begin('read write', async (tx) => {
        await participant.prepare(tx, req);
        await tx.prepare(gid);
      });
      events.push({ line: `[2PC] ${participant.name} prepared` });
    }
  } catch (error) {
    const message = getErrorMessage(error);
    events.push({ line: `[2PC] prepare failed (${message}) -> ROLLBACK PREPARED` });
    events.push(...(await finishTwoPhaseOrder(req.orderId, 'ROLLBACK')));
    throw new DemoFailure(message, req.orderId, events, error);
  }

  events.push({ line: '[2PC] all prepared -> COMMIT PREPARED' });
  await recordCommitDecisionOrRollback(req.orderId, events);

  if (shouldCrashAfterPrepare(options)) {
    console.log(events.map((event) => event.line).join('\n'));
    process.exit(1);
  }

  events.push(...(await finishTwoPhaseOrder(req.orderId, 'COMMIT')));
  return { orderId: req.orderId, events };
}

async function recordCommitDecisionOrRollback(orderId: string, events: DemoEvent[]): Promise<void> {
  try {
    await recordTwoPhaseDecision(orderId, 'COMMIT');
    return;
  } catch (error) {
    let durableDecision: Awaited<ReturnType<typeof readTwoPhaseDecision>> = null;
    try {
      durableDecision = await readTwoPhaseDecision(orderId);
    } catch (readError) {
      const message = getErrorMessage(error);
      events.push({
        line: `[2PC] decision state unknown -> leave prepared transactions for recovery (${getErrorMessage(
          readError,
        )})`,
      });
      throw new DemoFailure(message, orderId, events, error);
    }

    if (durableDecision === 'COMMIT') {
      events.push({ line: '[2PC] durable COMMIT decision found -> COMMIT PREPARED' });
      return;
    }

    const message = getErrorMessage(error);
    events.push({ line: `[2PC] decision record failed (${message}) -> ROLLBACK PREPARED` });
    try {
      events.push(...(await finishTwoPhaseOrder(orderId, 'ROLLBACK')));
    } catch (rollbackError) {
      throw new DemoFailure(
        `${message}; rollback failed: ${getErrorMessage(rollbackError)}`,
        orderId,
        events,
        rollbackError,
      );
    }

    throw new DemoFailure(message, orderId, events, error);
  }
}

function shouldCrashAfterPrepare(options: TwoPhaseOptions): boolean {
  return options.crashAfterPrepare === true || process.env.TWO_PHASE_COMMIT_CRASH_AFTER_PREPARE === '1';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
