import postgres from 'postgres';
import { requiredEnv } from './config.js';

export const orderDb = postgres(requiredEnv('ORDER_DB_URL'), { max: 5 });
export const paymentDb = postgres(requiredEnv('PAYMENT_DB_URL'), { max: 5 });
export const inventoryDb = postgres(requiredEnv('INVENTORY_DB_URL'), { max: 5 });

export async function closeDbs(): Promise<void> {
  await Promise.all([
    orderDb.end({ timeout: 5 }),
    paymentDb.end({ timeout: 5 }),
    inventoryDb.end({ timeout: 5 }),
  ]);
}
