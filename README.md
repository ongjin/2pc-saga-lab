# 2PC vs Saga Lab

분산 트랜잭션 패턴인 Two-Phase Commit(2PC)과 Saga orchestration을 같은 주문 시나리오로 비교하는 로컬 데모 레포입니다.

## Stack

- Node.js 24
- TypeScript
- postgres-js
- Postgres 16 x 3
- Vitest
- Mermaid CLI

## Databases

| Service | Port | Database |
| --- | ---: | --- |
| order-db | 5433 | orderdb |
| payment-db | 5434 | paymentdb |
| inventory-db | 5435 | inventorydb |

`docker-compose.yml` starts each PostgreSQL container with `max_prepared_transactions=20` so the 2PC demo can use PostgreSQL prepared transactions.

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d --wait
npm run setup
```

## Run Demos

```bash
npm run demo -- 2pc happy
npm run demo -- 2pc payment-fail
npm run demo -- 2pc inventory-fail
npm run demo -- saga happy
npm run demo -- saga payment-fail
npm run demo -- saga inventory-fail
```

Each demo prints the step log and a final state snapshot for the order, payment, stock, and reservation count.

## Crash Recovery

```bash
npm run demo -- 2pc crash
npm run demo -- 2pc recover
```

The 2PC crash command intentionally exits with code `1` after the coordinator records its commit decision and before participant `COMMIT PREPARED` calls finish. Run `npm run demo -- 2pc recover` afterward. Recovery is manual so the prepared transaction state and the Saga contrast stay visible. See [Crash Recovery Manual](docs/crash.manual.md) for inspection and recovery commands, including the Saga crash behavior.

## Scenarios

| Scenario | 2PC | Saga |
| --- | --- | --- |
| happy | All participants prepare, then the coordinator commits every prepared transaction. | Local steps complete in order: create order, charge payment, reserve stock, confirm order. |
| payment-fail | Payment prepare fails, so any prepared participant is rolled back and no partial business rows remain committed. | The failing payment step triggers compensation for completed steps, canceling the created order. |
| inventory-fail | Inventory prepare fails, so prepared order and payment work is rolled back with `ROLLBACK PREPARED`. | Stock reservation failure triggers compensation in reverse order, including payment refund and order cancellation. |
| crash | The process exits after all participants are prepared and before `COMMIT PREPARED`; normal reads do not show the pending rows until recovery commits them. | The process exits after `payment_charged`; committed local Saga state remains visible, with no database-level prepared transaction. |

## Tests

```bash
npm test
npm run typecheck
```

## Companion Write-Up

Companion write-up will link here once published.
