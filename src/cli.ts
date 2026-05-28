import type { DemoEvent, Pattern, ScenarioName } from './domain.js';
import type { FinalState } from './test-support.js';

type DbBackedModules = {
  DemoFailure: typeof import('./domain.js').DemoFailure;
  runSaga: typeof import('./saga/orchestrator.js').runSaga;
  buildScenarioRequest: typeof import('./scenarios/index.js').buildScenarioRequest;
  readFinalState: typeof import('./test-support.js').readFinalState;
  resetAllData: typeof import('./test-support.js').resetAllData;
  runTwoPhaseCommit: typeof import('./two-phase-commit/coordinator.js').runTwoPhaseCommit;
  recoverTwoPhaseCommitDetailed: typeof import('./two-phase-commit/recovery.js').recoverTwoPhaseCommitDetailed;
};

const scenarioNames = ['happy', 'payment-fail', 'inventory-fail', 'crash'] as const;
let closeLoadedDbs: (() => Promise<void>) | undefined;

class UsageError extends Error {
  constructor() {
    super('usage requested');
    this.name = 'UsageError';
  }
}

function isPattern(value: unknown): value is Pattern {
  return value === '2pc' || value === 'saga';
}

function isScenarioName(value: unknown): value is ScenarioName {
  return typeof value === 'string' && scenarioNames.includes(value as ScenarioName);
}

function usage(): never {
  console.log('Usage: npm run demo -- <2pc|saga> <happy|payment-fail|inventory-fail|crash>');
  console.log('Recovery: npm run demo -- 2pc recover');
  process.exitCode = 2;
  throw new UsageError();
}

function printEvents(events: readonly DemoEvent[]): void {
  for (const event of events) {
    console.log(event.line);
  }
}

async function printFinalState(
  orderId: string,
  readFinalState: (orderId: string) => Promise<FinalState>,
): Promise<void> {
  const final = await readFinalState(orderId);
  const orderStatus = final.order?.status ?? 'NONE';
  const paymentStatus = final.payment
    ? `${final.payment.status} amount=${final.payment.amount}`
    : 'NONE';

  console.log('[final state]');
  console.log(`  order:     ${orderStatus}`);
  console.log(`  payment:   ${paymentStatus}`);
  console.log(`  stock:     ${final.stock.sku} qty=${final.stock.qty}`);
  console.log(`  reservations: ${final.reservations}`);
}

async function loadDbBackedModules(): Promise<DbBackedModules> {
  const db = await import('./db.js');
  closeLoadedDbs = db.closeDbs;

  const [domain, saga, scenarios, testSupport, coordinator, recovery] = await Promise.all([
    import('./domain.js'),
    import('./saga/orchestrator.js'),
    import('./scenarios/index.js'),
    import('./test-support.js'),
    import('./two-phase-commit/coordinator.js'),
    import('./two-phase-commit/recovery.js'),
  ]);

  return {
    DemoFailure: domain.DemoFailure,
    runSaga: saga.runSaga,
    buildScenarioRequest: scenarios.buildScenarioRequest,
    readFinalState: testSupport.readFinalState,
    resetAllData: testSupport.resetAllData,
    runTwoPhaseCommit: coordinator.runTwoPhaseCommit,
    recoverTwoPhaseCommitDetailed: recovery.recoverTwoPhaseCommitDetailed,
  };
}

async function runRecovery(modules: DbBackedModules): Promise<void> {
  const result = await modules.recoverTwoPhaseCommitDetailed();
  if (result.recoveredOrders.length === 0) {
    console.log('[2PC][recovery] nothing to recover');
    return;
  }

  printEvents(result.events);
  for (const recovered of result.recoveredOrders) {
    await printFinalState(recovered.orderId, modules.readFinalState);
  }
}

async function runDemo(
  pattern: Pattern,
  scenarioName: ScenarioName,
  modules: DbBackedModules,
): Promise<void> {
  const req = modules.buildScenarioRequest(scenarioName);
  await modules.resetAllData();

  try {
    try {
      const result =
        pattern === '2pc'
          ? await modules.runTwoPhaseCommit(req, { crashAfterPrepare: scenarioName === 'crash' })
          : await modules.runSaga(req, {
              crashAfterStep: scenarioName === 'crash' ? 'payment_charged' : undefined,
            });

      printEvents(result.events);
      await printFinalState(result.orderId, modules.readFinalState);
    } catch (error) {
      if (!(error instanceof modules.DemoFailure)) {
        throw error;
      }

      process.exitCode = 1;
      printEvents(error.events);
      await printFinalState(error.orderId, modules.readFinalState);
    }
  } finally {
    // Crash scenarios hard-exit inside the runner before this cleanup can run,
    // preserving prepared/logged state for recovery demos.
    await modules.resetAllData();
  }
}

async function main(): Promise<void> {
  const [patternArg, scenarioArg, ...extraArgs] = process.argv.slice(2);
  if (extraArgs.length > 0 || !patternArg || !scenarioArg) {
    usage();
  }

  if (patternArg === '2pc' && scenarioArg === 'recover') {
    const modules = await loadDbBackedModules();
    await runRecovery(modules);
    return;
  }

  if (!isPattern(patternArg) || !isScenarioName(scenarioArg)) {
    usage();
  }

  const modules = await loadDbBackedModules();
  await runDemo(patternArg, scenarioArg, modules);
}

try {
  await main();
} catch (error) {
  if (!(error instanceof UsageError)) {
    console.error(getErrorMessage(error));
    process.exitCode = 1;
  }
} finally {
  await closeLoadedDbs?.();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
