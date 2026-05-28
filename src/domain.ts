import type postgres from 'postgres';

export type Pattern = '2pc' | 'saga';
export type ScenarioName = 'happy' | 'payment-fail' | 'inventory-fail' | 'crash';

export type DbClient = postgres.Sql | postgres.TransactionSql;
export type TransactionDbClient = postgres.TransactionSql;

export type OrderRequest = {
  orderId: string;
  userId: string;
  sku: string;
  qty: number;
  amount: number;
};

export type DemoEvent = {
  line: string;
};

export type DemoResult = {
  orderId: string;
  events: DemoEvent[];
};

export class DemoFailure extends Error {
  readonly orderId: string;
  readonly events: DemoEvent[];
  readonly originalError: unknown;

  constructor(message: string, orderId: string, events: DemoEvent[], originalError: unknown) {
    super(message);
    this.name = 'DemoFailure';
    this.orderId = orderId;
    this.events = events;
    this.originalError = originalError;
  }
}
