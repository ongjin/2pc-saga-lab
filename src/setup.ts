import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { closeDbs, inventoryDb, orderDb, paymentDb } from './db.js';

type Db = ReturnType<typeof postgres>;

const schemas: Array<{ db: Db; file: URL }> = [
  { db: orderDb, file: new URL('../sql/01-order.sql', import.meta.url) },
  { db: paymentDb, file: new URL('../sql/02-payment.sql', import.meta.url) },
  { db: inventoryDb, file: new URL('../sql/03-inventory.sql', import.meta.url) },
];

export async function applySchema(): Promise<void> {
  for (const { db, file } of schemas) {
    const sqlText = await readFile(file, 'utf8');
    await db.unsafe(sqlText);
  }
}

function isDirectRun(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    await applySchema();
    console.log('[setup] schema and seed applied');
  } finally {
    await closeDbs();
  }
}
