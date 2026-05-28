import { randomUUID } from 'node:crypto';
import { DEFAULT_SKU, DEFAULT_USER_ID } from '../config.js';
import type { OrderRequest } from '../domain.js';

export function happyRequest(): OrderRequest {
  return {
    orderId: randomUUID(),
    userId: DEFAULT_USER_ID,
    sku: DEFAULT_SKU,
    qty: 1,
    amount: 10000,
  };
}
