# 크래시 복구 매뉴얼

이 데모에서는 크래시 복구를 자동으로 숨기지 않고 일부러 수동 절차로 남겨 두었습니다. 그래야 2PC에서 PostgreSQL prepared transaction이 실제로 어떤 상태로 남는지, 그리고 각 로컬 트랜잭션을 바로 커밋하는 Saga와 무엇이 다른지 눈으로 확인할 수 있습니다.

## 2PC 크래시

먼저 데이터베이스를 깨끗한 상태로 준비합니다.

```bash
docker compose up -d --wait
npm run setup
```

크래시 시나리오를 실행합니다.

```bash
npm run demo -- 2pc crash
```

예상되는 결과는 다음과 같습니다.

- 세 참여자 모두 `PREPARE TRANSACTION`까지 끝난 뒤 프로세스가 exit code `1`로 종료됩니다.
- prepared transaction 안에 들어 있는 비즈니스 행은 일반 `SELECT` 조회에서 아직 보이지 않습니다.
- `order-db`, `payment-db`, `inventory-db` 각각에 `pg_prepared_xacts` 행이 하나씩 남습니다.

출력에 보이는 `[2PC] all prepared -> COMMIT PREPARED`는 모든 참여자에게 실제 `COMMIT PREPARED`를 끝냈다는 뜻이 아닙니다. 이 줄은 코디네이터가 전역 `COMMIT` 결정을 내렸고, 그 결정을 `two_phase_decisions`에 영속적으로 기록했다는 뜻입니다. 이 크래시 경로는 그 직후, 참여자별 `COMMIT PREPARED`를 실행하기 전에 종료됩니다.

복구할 때 기준이 되는 값은 참여자 상태가 아니라 코디네이터의 영속 결정입니다. prepared transaction이 모두 남아 있더라도 `two_phase_decisions`에 결정이 없으면, 이 데모는 커밋을 추론하지 않고 판단 보류 상태로 보고 `ROLLBACK`을 기록한 뒤 롤백합니다.

먼저 일반 테이블에서 prepared 상태의 행이 보이는지 확인합니다.

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT id, status, sku, qty, amount FROM orders ORDER BY created_at;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT order_id, status, amount FROM payments ORDER BY created_at;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT order_id, sku, qty FROM reservations ORDER BY created_at;"
```

코디네이터가 기록한 영속 결정도 확인합니다.

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT order_id, decision FROM two_phase_decisions ORDER BY created_at;"
```

세 데이터베이스에 남아 있는 prepared transaction을 확인합니다.

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT gid, prepared, owner, database FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT gid, prepared, owner, database FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT gid, prepared, owner, database FROM pg_prepared_xacts ORDER BY gid;"
```

이제 prepared transaction을 복구합니다.

```bash
npm run demo -- 2pc recover
```

복구 후 기대하는 상태는 다음과 같습니다.

- 복구 명령이 같은 주문에 묶인 prepared transaction들을 찾습니다.
- 앞의 크래시 경로에서 영속적인 `COMMIT` 결정이 기록되어 있으므로, 복구 경로는 각 참여자에 `COMMIT PREPARED`를 실행합니다.
- 복구가 끝나면 `pg_prepared_xacts`가 비어 있어야 합니다.
- CLI는 복구된 주문의 최종 상태를 출력합니다.

prepared transaction이 더 이상 남아 있지 않은지 확인합니다.

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
```

## Saga 크래시

2PC 크래시를 실행한 뒤 아직 복구하지 않았다면 먼저 복구부터 마칩니다.

```bash
npm run demo -- 2pc recover
```

일반 비즈니스 행은 데모 명령이 매번 초기화하지만, 대기 중인 prepared transaction은 명시적으로 복구해야 합니다. 그대로 두면 락이 남아 다음 setup이나 데모 실행을 막을 수 있습니다.

새로운 Saga 크래시 실험을 하려면 다시 깨끗한 데이터베이스에서 시작합니다.

```bash
docker compose up -d --wait
npm run setup
```

Saga 크래시 시나리오를 실행합니다.

```bash
npm run demo -- saga crash
```

예상되는 결과는 다음과 같습니다.

- `payment_charged` 단계가 끝난 뒤 프로세스가 exit code `1`로 종료됩니다.
- Saga는 각 단계의 로컬 트랜잭션을 즉시 커밋하므로, 주문 행과 결제 승인 행이 일반 조회에서 보입니다.
- 정확한 상태는 주문 `PENDING`, 결제 `CHARGED`입니다. `saga_log`에는 `order_created DONE`과 `payment_charged DONE`이 남습니다.
- 데이터베이스 수준의 prepared transaction은 없습니다.

Saga 상태를 직접 확인합니다.

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT id, status, sku, qty, amount FROM orders ORDER BY created_at;"
docker compose exec order-db psql -U app -d orderdb -c "SELECT order_id, step, status, payload FROM saga_log ORDER BY created_at;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT order_id, status, amount FROM payments ORDER BY created_at;"
```

prepared transaction이 없다는 점도 확인합니다.

```bash
docker compose exec order-db psql -U app -d orderdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec payment-db psql -U app -d paymentdb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
docker compose exec inventory-db psql -U app -d inventorydb -c "SELECT gid FROM pg_prepared_xacts ORDER BY gid;"
```

이 실험에서는 Saga 크래시 자동 재개까지 구현하지 않습니다. 실제 서비스에서 Saga 복구를 제대로 만들려면 각 단계의 멱등성, 영속적인 오케스트레이션 상태, 보상 작업 재시도 정책을 함께 설계해야 합니다.
