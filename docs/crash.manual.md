# Crash Recovery Manual

This demo intentionally keeps crash recovery manual. The manual steps make the 2PC prepared transaction state visible and show how it differs from Saga orchestration, where each local transaction commits immediately and recovery depends on durable orchestration state plus compensating actions.

## 2PC Crash

Start from a clean database:

```bash
docker compose up -d --wait
npm run setup
```

Run the crash scenario:

```bash
npm run demo -- 2pc crash
```

Expected result:

- The process exits with code `1` after all three participants have prepared.
- Business rows from the prepared work are not visible through normal `SELECT` queries.
- Each database has one row in `pg_prepared_xacts`.

The CLI line `[2PC] all prepared -> COMMIT PREPARED` means the coordinator has reached and durably recorded the global `COMMIT` decision. It is not evidence that each participant's `COMMIT PREPARED` call finished; this crash path exits before those participant commit calls run.

The durable decision is the source of truth during recovery. Prepared transactions without a matching `two_phase_decisions` row are treated as in-doubt and rolled back by this lab instead of being committed only because every participant reached `PREPARE`.

Inspect normal table visibility:

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT id, status, sku, qty, amount FROM orders ORDER BY created_at;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT order_id, status, amount FROM payments ORDER BY created_at;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT order_id, sku, qty FROM reservations ORDER BY created_at;"
```

Inspect the durable coordinator decision:

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT order_id, decision FROM two_phase_decisions ORDER BY created_at;"
```

Inspect prepared transactions in all three databases:

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT gid, prepared, owner, database FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT gid, prepared, owner, database FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT gid, prepared, owner, database FROM pg_prepared_xacts ORDER BY gid;"
```

Recover the prepared transactions:

```bash
npm run demo -- 2pc recover
```

Expected recovery result:

- Recovery finds prepared transactions for the same order across the participants.
- Because the crash path recorded a durable `COMMIT` decision, the recovery path commits them with `COMMIT PREPARED`.
- `pg_prepared_xacts` is empty after recovery.
- The CLI prints the recovered final state.

Verify that no prepared transactions remain:

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
```

## Saga Crash

If you are continuing from the 2PC crash section and have not recovered it yet, recover the pending prepared transactions first:

```bash
npm run demo -- 2pc recover
```

Demo commands reset ordinary business rows, but pending prepared transactions must be recovered explicitly because they can hold locks that block setup.

For a fresh Saga crash demo, start from a clean database:

```bash
docker compose up -d --wait
npm run setup
```

Run the Saga crash scenario:

```bash
npm run demo -- saga crash
```

Expected result:

- The process exits with code `1` after `payment_charged`.
- The order row and charged payment are visible because Saga commits local transactions as each step completes.
- Exact state: the order is `PENDING`, the payment is `CHARGED`, and `saga_log` contains `order_created DONE` plus `payment_charged DONE`.
- There is no database-level prepared transaction.

Inspect the Saga state:

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT id, status, sku, qty, amount FROM orders ORDER BY created_at;"
docker compose exec order-db psql -U app -d orderdb -c "SELECT order_id, step, status, payload FROM saga_log ORDER BY created_at;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT order_id, status, amount FROM payments ORDER BY created_at;"
```

Confirm there are no prepared transactions:

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
```

Automated Saga crash resume is out of scope for this lab. A production Saga needs idempotent steps, durable orchestration state, and a compensation retry policy.
