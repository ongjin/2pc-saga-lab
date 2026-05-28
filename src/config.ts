import 'dotenv/config';

export const DEFAULT_SKU = 'SKU-1';
export const DEFAULT_USER_ID = 'user-1';
export const INITIAL_STOCK_QTY = 10;

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
