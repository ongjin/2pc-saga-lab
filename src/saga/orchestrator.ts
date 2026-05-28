import { inventoryDb, orderDb, paymentDb } from '../db.js';
import { DemoFailure, type DemoEvent, type DemoResult, type OrderRequest } from '../domain.js';
import { releaseStock, reserveStock } from '../services/inventory.js';
import { cancelOrder, confirmOrder, createOrder } from '../services/order.js';
import { chargePayment, refundPayment } from '../services/payment.js';
import { markSagaStep, type SagaLogPayload, type SagaStep, type SagaStepStatus } from './log.js';

export type SagaOptions = {
  crashAfterStep?: SagaStep;
  dependencies?: Partial<SagaDependencies>;
};

export type SagaStepDefinition = {
  name: SagaStep;
  run: (req: OrderRequest) => Promise<void>;
  compensate?: (req: OrderRequest) => Promise<void>;
};

export type SagaMarkStep = (
  orderId: string,
  step: SagaStep,
  status: SagaStepStatus,
  payload?: SagaLogPayload,
) => Promise<void>;

export type SagaDependencies = {
  steps: readonly SagaStepDefinition[];
  markStep: SagaMarkStep;
};

type CompensationFailure = {
  step: SagaStep;
  phase: 'action' | 'log';
  error: unknown;
};

const defaultSteps: readonly SagaStepDefinition[] = [
  {
    name: 'order_created',
    run: async (req) => {
      await orderDb.begin(async (tx) => {
        await createOrder(tx, req);
      });
    },
    compensate: async (req) => {
      await orderDb.begin(async (tx) => {
        await cancelOrder(tx, req.orderId);
      });
    },
  },
  {
    name: 'payment_charged',
    run: async (req) => {
      await paymentDb.begin(async (tx) => {
        await chargePayment(tx, req);
      });
    },
    compensate: async (req) => {
      await paymentDb.begin(async (tx) => {
        await refundPayment(tx, req.orderId);
      });
    },
  },
  {
    name: 'stock_reserved',
    run: async (req) => {
      await inventoryDb.begin(async (tx) => {
        await reserveStock(tx, req);
      });
    },
    compensate: async (req) => {
      await inventoryDb.begin(async (tx) => {
        await releaseStock(tx, req.orderId);
      });
    },
  },
  {
    name: 'order_confirmed',
    run: async (req) => {
      await orderDb.begin(async (tx) => {
        await confirmOrder(tx, req.orderId);
      });
    },
  },
];

export async function runSaga(req: OrderRequest, options: SagaOptions = {}): Promise<DemoResult> {
  const events: DemoEvent[] = [];
  const completed: SagaStepDefinition[] = [];
  let failedStep: SagaStepDefinition | null = null;
  const { markStep, steps } = sagaDependencies(options);

  try {
    for (const step of steps) {
      failedStep = step;
      await markStep(req.orderId, step.name, 'STARTED');
      await step.run(req);
      completed.push(step);
      await markStep(req.orderId, step.name, 'DONE');
      events.push({ line: `  -> step:${step.name} DONE` });
      crashIfRequested(step.name, options, events);
    }

    return { orderId: req.orderId, events };
  } catch (error) {
    const message = getErrorMessage(error);
    events.push({ line: `  -> step:${failedStep?.name ?? 'unknown'} FAILED (${message})` });

    const compensationFailures = await compensateCompletedSteps(completed, req, events, markStep);
    if (compensationFailures.length > 0) {
      throw new DemoFailure(
        `${message}; compensation failed: ${formatCompensationFailures(compensationFailures)}`,
        req.orderId,
        events,
        new AggregateError(
          compensationFailures.map((failure) => failure.error),
          'compensation failed',
        ),
      );
    }

    throw new DemoFailure(message, req.orderId, events, error);
  }
}

async function compensateCompletedSteps(
  completed: readonly SagaStepDefinition[],
  req: OrderRequest,
  events: DemoEvent[],
  markStep: SagaMarkStep,
): Promise<CompensationFailure[]> {
  const failures: CompensationFailure[] = [];

  for (const step of completed.slice().reverse()) {
    const failure = await compensateStep(step, req, events, markStep);
    if (failure) {
      failures.push(failure);
    }
  }

  return failures;
}

async function compensateStep(
  step: SagaStepDefinition,
  req: OrderRequest,
  events: DemoEvent[],
  markStep: SagaMarkStep,
): Promise<CompensationFailure | null> {
  if (!step.compensate) {
    return null;
  }

  let attempt: number;
  try {
    attempt = await retryCompensationAction(step, req);
  } catch (error) {
    events.push({ line: `  <- compensate:${step.name} FAILED (${getErrorMessage(error)})` });
    return { step: step.name, phase: 'action', error };
  }

  try {
    await retryCompensatedLog(markStep, req.orderId, step.name, { attempt });
  } catch (error) {
    events.push({ line: `  <- compensate:${step.name} LOG_FAILED (${getErrorMessage(error)})` });
    return { step: step.name, phase: 'log', error };
  }

  events.push({ line: `  <- compensate:${step.name} COMPENSATED` });
  return null;
}

async function retryCompensationAction(step: SagaStepDefinition, req: OrderRequest): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await step.compensate?.(req);
      return attempt;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function retryCompensatedLog(
  markStep: SagaMarkStep,
  orderId: string,
  step: SagaStep,
  payload: SagaLogPayload,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await markStep(orderId, step, 'COMPENSATED', payload);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function sagaDependencies(options: SagaOptions): SagaDependencies {
  return {
    steps: options.dependencies?.steps ?? defaultSteps,
    markStep: options.dependencies?.markStep ?? markSagaStep,
  };
}

function formatCompensationFailures(failures: readonly CompensationFailure[]): string {
  return failures
    .map((failure) => `${failure.step} ${failure.phase} failed (${getErrorMessage(failure.error)})`)
    .join('; ');
}

function crashIfRequested(step: SagaStep, options: SagaOptions, events: DemoEvent[]): void {
  if (options.crashAfterStep !== step) {
    return;
  }

  console.log(events.map((event) => event.line).join('\n'));
  process.exit(1);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
