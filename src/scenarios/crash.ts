import type { OrderRequest } from '../domain.js';
import { happyRequest } from './happy.js';

export function crashRequest(): OrderRequest {
  return happyRequest();
}
