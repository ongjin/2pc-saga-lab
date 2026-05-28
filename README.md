# 2PC vs Saga 실험실

분산 트랜잭션 패턴인 Two-Phase Commit(2PC)과 Saga 오케스트레이션을 같은 주문 시나리오로 비교하는 로컬 데모 저장소입니다.

## 기술 스택

- Node.js 24
- TypeScript
- postgres-js
- Postgres 16 3개 인스턴스
- Vitest
- Mermaid CLI

## 데이터베이스

| 서비스 | 포트 | 데이터베이스 |
| --- | ---: | --- |
| order-db | 5433 | orderdb |
| payment-db | 5434 | paymentdb |
| inventory-db | 5435 | inventorydb |

`docker-compose.yml`은 각 PostgreSQL 컨테이너를 `max_prepared_transactions=20`으로 시작합니다. 이 설정이 있어야 2PC 데모에서 PostgreSQL prepared transaction을 사용할 수 있습니다.

## 시작하기

```bash
npm install
cp .env.example .env
docker compose up -d --wait
npm run setup
```

## 데모 실행

```bash
npm run demo -- 2pc happy
npm run demo -- 2pc payment-fail
npm run demo -- 2pc inventory-fail
npm run demo -- saga happy
npm run demo -- saga payment-fail
npm run demo -- saga inventory-fail
```

각 데모는 단계별 로그와 함께 주문, 결제, 재고, 예약 건수의 최종 상태를 출력합니다.

## 크래시 복구

```bash
npm run demo -- 2pc crash
npm run demo -- 2pc recover
```

`2pc crash` 명령은 코디네이터가 커밋 결정을 durable하게 기록한 뒤, 각 참여자의 `COMMIT PREPARED`가 끝나기 전에 의도적으로 exit code `1`로 종료합니다. 이후 `npm run demo -- 2pc recover`를 실행해 복구합니다. 복구를 수동으로 남겨 둔 이유는 prepared transaction 상태와 Saga 방식의 차이를 직접 확인하기 위해서입니다. 자세한 점검 및 복구 명령은 [크래시 복구 매뉴얼](docs/crash.manual.md)을 참고하세요.

복구는 durable 코디네이터 결정이 `COMMIT`일 때만 prepared transaction을 커밋합니다. prepared transaction은 남아 있지만 `two_phase_decisions` 행이 없으면, 참여자 상태만 보고 커밋을 추론하지 않고 `ROLLBACK`을 기록한 뒤 롤백합니다.

## 시나리오

| 시나리오 | 2PC | Saga |
| --- | --- | --- |
| `happy` | 모든 참여자가 prepare에 성공한 뒤 코디네이터가 각 prepared transaction을 커밋합니다. | 주문 생성, 결제 승인, 재고 예약, 주문 확정 로컬 단계가 순서대로 완료됩니다. |
| `payment-fail` | 결제 prepare가 실패하므로 이미 prepare된 참여자를 롤백하고 부분 커밋된 비즈니스 행을 남기지 않습니다. | 결제 단계 실패가 완료된 단계의 보상을 트리거하며, 생성된 주문을 취소합니다. |
| `inventory-fail` | 재고 prepare가 실패하므로 prepare된 주문과 결제 작업을 `ROLLBACK PREPARED`로 되돌립니다. | 재고 예약 실패가 역순 보상을 트리거하며, 결제 환불과 주문 취소를 수행합니다. |
| `crash` | 모든 참여자가 prepare된 뒤 `COMMIT PREPARED` 전에 프로세스가 종료됩니다. 일반 조회에서는 복구 전까지 pending 행이 보이지 않습니다. | `payment_charged` 이후 프로세스가 종료됩니다. 로컬 Saga 상태는 커밋되어 보이지만 데이터베이스 수준의 prepared transaction은 없습니다. |

## 테스트

```bash
npm test
npm run typecheck
```

## 연계 글

[2PC vs Saga — 분산 트랜잭션 두 패턴을 같은 데모로 짜봤다](https://zerry.co.kr/blog/2pc-vs-saga-distributed-transaction-lab)
