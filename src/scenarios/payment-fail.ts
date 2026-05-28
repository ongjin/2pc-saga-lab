import type { OrderRequest } from '../domain.js';
import { happyRequest } from './happy.js';

export function paymentFailRequest(): OrderRequest {
  return {
    ...happyRequest(),
    amount: -1,
  };
}
