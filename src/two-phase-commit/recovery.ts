import type postgres from 'postgres';
import { inventoryDb, orderDb, paymentDb } from '../db.js';
import type { DemoEvent } from '../domain.js';

const GID_PREFIX = '2pc-saga-lab:';
const MAX_FINISH_ATTEMPTS = 3;

export type TwoPhaseParticipantName = 'order-db' | 'payment-db' | 'inventory-db';
export type TwoPhaseDecision = 'COMMIT' | 'ROLLBACK';

export type TwoPhaseRecoveryOrder = {
  orderId: string;
  decision: TwoPhaseDecision;
  events: DemoEvent[];
};

export type TwoPhaseRecoveryResult = {
  events: DemoEvent[];
  recoveredOrders: TwoPhaseRecoveryOrder[];
};

type TwoPhaseParticipant = {
  name: TwoPhaseParticipantName;
  db: postgres.Sql;
};

type PreparedRow = {
  gid: string;
};

type PreparedScan = {
  gid: string;
  orderId: string;
  participant: TwoPhaseParticipantName;
};

type DecisionRow = {
  decision: TwoPhaseDecision;
};

export const twoPhaseParticipants: readonly TwoPhaseParticipant[] = [
  { name: 'order-db', db: orderDb },
  { name: 'payment-db', db: paymentDb },
  { name: 'inventory-db', db: inventoryDb },
];

export function twoPhaseGid(orderId: string, participant: TwoPhaseParticipantName): string {
  return `${GID_PREFIX}${orderId}:${participant}`;
}

export async function recordTwoPhaseDecision(
  orderId: string,
  decision: TwoPhaseDecision,
): Promise<void> {
  await orderDb`
    INSERT INTO two_phase_decisions (order_id, decision)
    VALUES (${orderId}, ${decision})
    ON CONFLICT (order_id) DO NOTHING
  `;

  const existingDecision = await readTwoPhaseDecision(orderId);
  if (existingDecision !== decision) {
    throw new Error(
      `2PC decision already recorded as ${existingDecision ?? 'unknown'} for order ${orderId}`,
    );
  }
}

export async function readTwoPhaseDecision(orderId: string): Promise<TwoPhaseDecision | null> {
  const [row] = (await orderDb`
    SELECT decision
    FROM two_phase_decisions
    WHERE order_id = ${orderId}
  `) as DecisionRow[];

  return row?.decision ?? null;
}

export async function commitPrepared(
  orderId: string,
  participantName: TwoPhaseParticipantName,
): Promise<boolean> {
  const participant = getParticipant(participantName);
  return finishPrepared(participant, twoPhaseGid(orderId, participantName), 'COMMIT');
}

export async function rollbackPrepared(
  orderId: string,
  participantName: TwoPhaseParticipantName,
): Promise<boolean> {
  const participant = getParticipant(participantName);
  return finishPrepared(participant, twoPhaseGid(orderId, participantName), 'ROLLBACK');
}

export async function finishTwoPhaseOrder(
  orderId: string,
  decision: TwoPhaseDecision,
): Promise<DemoEvent[]> {
  const events: DemoEvent[] = [];
  const failures: Array<{ participant: TwoPhaseParticipantName; error: unknown }> = [];

  for (const participant of twoPhaseParticipants) {
    try {
      const finished =
        decision === 'COMMIT'
          ? await commitPrepared(orderId, participant.name)
          : await rollbackPrepared(orderId, participant.name);
      const suffix = finished ? '' : ' (already finished)';
      events.push({ line: `[2PC] ${participant.name} -> ${decision} PREPARED${suffix}` });
    } catch (error) {
      failures.push({ participant: participant.name, error });
      events.push({
        line: `[2PC] ${participant.name} -> ${decision} PREPARED failed (${getErrorMessage(error)})`,
      });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `failed to ${decision.toLowerCase()} prepared 2PC participants for order ${orderId}: ${failures
        .map((failure) => failure.participant)
        .join(', ')}`,
    );
  }

  return events;
}

export async function recoverTwoPhaseCommit(): Promise<DemoEvent[]> {
  return (await recoverTwoPhaseCommitDetailed()).events;
}

export async function recoverTwoPhaseCommitDetailed(): Promise<TwoPhaseRecoveryResult> {
  const scans = await Promise.all(twoPhaseParticipants.map(scanPreparedTransactions));
  const preparedByOrder = new Map<string, Set<TwoPhaseParticipantName>>();

  for (const prepared of scans.flat()) {
    const participantSet = preparedByOrder.get(prepared.orderId) ?? new Set<TwoPhaseParticipantName>();
    participantSet.add(prepared.participant);
    preparedByOrder.set(prepared.orderId, participantSet);
  }

  const events: DemoEvent[] = [];
  const recoveredOrders: TwoPhaseRecoveryOrder[] = [];
  for (const [orderId, participantSet] of preparedByOrder) {
    const isComplete = twoPhaseParticipants.every((participant) => participantSet.has(participant.name));
    const durableDecision = await readTwoPhaseDecision(orderId);
    const decision: TwoPhaseDecision = durableDecision ?? 'ROLLBACK';
    const state =
      durableDecision === null
        ? isComplete
          ? 'no durable decision'
          : 'incomplete prepared set'
        : `durable ${durableDecision} decision`;
    if (durableDecision === null) {
      await recordTwoPhaseDecision(orderId, decision);
    }
    const orderEvents = [
      { line: `[2PC][recovery] ${orderId} ${state} -> ${decision} PREPARED` },
      ...(await finishTwoPhaseOrder(orderId, decision)),
    ];
    events.push(...orderEvents);
    recoveredOrders.push({ orderId, decision, events: orderEvents });
  }

  return { events, recoveredOrders };
}

async function scanPreparedTransactions(participant: TwoPhaseParticipant): Promise<PreparedScan[]> {
  const rows = (await participant.db`
    SELECT gid
    FROM pg_prepared_xacts
    WHERE database = current_database()
      AND gid LIKE ${`${GID_PREFIX}%`}
    ORDER BY gid
  `) as PreparedRow[];

  return rows.flatMap((row) => {
    const parsed = parsePreparedGid(row.gid);
    if (!parsed || parsed.participant !== participant.name) {
      return [];
    }

    return [{ ...parsed, gid: row.gid }];
  });
}

function parsePreparedGid(gid: string): null | Omit<PreparedScan, 'gid'> {
  if (!gid.startsWith(GID_PREFIX)) {
    return null;
  }

  const rest = gid.slice(GID_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0) {
    return null;
  }

  const orderId = rest.slice(0, separator);
  const participant = rest.slice(separator + 1);
  if (!isParticipantName(participant)) {
    return null;
  }

  return { orderId, participant };
}

async function finishPrepared(
  participant: TwoPhaseParticipant,
  gid: string,
  decision: TwoPhaseDecision,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_FINISH_ATTEMPTS; attempt += 1) {
    if (!(await hasPreparedTransaction(participant, gid))) {
      return false;
    }

    try {
      await participant.db.unsafe(`${decision} PREPARED ${quotePreparedTransactionId(gid)}`);
      return true;
    } catch (error) {
      if (isMissingPreparedTransaction(error)) {
        return false;
      }

      if (attempt === MAX_FINISH_ATTEMPTS) {
        throw error;
      }
    }
  }

  return false;
}

async function hasPreparedTransaction(participant: TwoPhaseParticipant, gid: string): Promise<boolean> {
  const [row] = (await participant.db`
    SELECT EXISTS (
      SELECT 1
      FROM pg_prepared_xacts
      WHERE database = current_database()
        AND gid = ${gid}
    ) AS exists
  `) as Array<{ exists: boolean }>;

  return row?.exists ?? false;
}

function quotePreparedTransactionId(gid: string): string {
  if (gid.includes('\0')) {
    throw new Error('prepared transaction id cannot contain null bytes');
  }

  return `'${gid.replaceAll("'", "''")}'`;
}

function getParticipant(name: TwoPhaseParticipantName): TwoPhaseParticipant {
  const participant = twoPhaseParticipants.find((candidate) => candidate.name === name);
  if (!participant) {
    throw new Error(`unknown 2PC participant: ${name}`);
  }

  return participant;
}

function isParticipantName(value: string): value is TwoPhaseParticipantName {
  return twoPhaseParticipants.some((participant) => participant.name === value);
}

function isMissingPreparedTransaction(error: unknown): boolean {
  return (
    getErrorCode(error) === '42704' ||
    getErrorMessage(error).includes('prepared transaction with identifier') ||
    getErrorMessage(error).includes('does not exist')
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
