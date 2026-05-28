import type { OrderRequest } from '../domain.js';
import { happyRequest } from './happy.js';

export function inventoryFailRequest(): OrderRequest {
  return {
    ...happyRequest(),
    qty: 999,
  };
}
