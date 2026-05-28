import type { OrderRequest, ScenarioName } from '../domain.js';
import { crashRequest } from './crash.js';
import { happyRequest } from './happy.js';
import { inventoryFailRequest } from './inventory-fail.js';
import { paymentFailRequest } from './payment-fail.js';

export const builders: Record<ScenarioName, () => OrderRequest> = {
  happy: happyRequest,
  'payment-fail': paymentFailRequest,
  'inventory-fail': inventoryFailRequest,
  crash: crashRequest,
};

export function buildScenarioRequest(name: ScenarioName): OrderRequest {
  return builders[name]();
}

export function isScenarioName(value: unknown): value is ScenarioName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(builders, value);
}
