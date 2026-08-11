import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_FoundryRunnerSessions", (it) => {
  it.effect("adds session fencing and expires leases that predate session ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 42 });

      yield* sql`
        INSERT INTO foundry_approved_contracts (
          contract_hash,
          project_id,
          feature_id,
          contract_version,
          founder_registry_hash,
          approval_subject,
          dispatch_idempotency_key,
          canonical_body_json,
          packet_json,
          packet_digest,
          accepted_at
        ) VALUES (
          ${"1".repeat(64)},
          ${"project-one"},
          ${"feature-one"},
          ${1},
          ${"2".repeat(64)},
          ${"approval-subject"},
          ${"3".repeat(64)},
          ${"{}"},
          ${"{}"},
          ${"4".repeat(64)},
          ${"2026-08-11T00:00:00.000Z"}
        )
      `;

      const dispatchId = `dispatch_${"3".repeat(24)}`;
      yield* sql`
        INSERT INTO foundry_dispatch_jobs (
          dispatch_id,
          dispatch_idempotency_key,
          contract_hash,
          environment_id,
          branch,
          base_sha,
          state,
          fence_token,
          attempt_count,
          max_attempts,
          lease_owner,
          lease_expires_at,
          command_created_at,
          created_at,
          updated_at,
          completed_at,
          failure_code
        ) VALUES (
          ${dispatchId},
          ${"3".repeat(64)},
          ${"1".repeat(64)},
          ${"environment-one"},
          ${"foundry/feature-one-v1"},
          ${"5".repeat(40)},
          ${"running"},
          ${1},
          ${1},
          ${3},
          ${"runner-one"},
          ${"2099-01-01T00:00:00.000Z"},
          ${"2026-08-11T00:00:00.000Z"},
          ${"2026-08-11T00:00:00.000Z"},
          ${"2026-08-11T00:00:00.000Z"},
          ${null},
          ${null}
        )
      `;
      yield* sql`
        INSERT INTO foundry_dispatch_attempts (
          dispatch_id,
          attempt_number,
          fence_token,
          runner_id,
          state,
          claimed_at,
          last_heartbeat_at,
          lease_expires_at,
          completed_at,
          failure_code
        ) VALUES (
          ${dispatchId},
          ${1},
          ${1},
          ${"runner-one"},
          ${"running"},
          ${"2026-08-11T00:00:00.000Z"},
          ${"2026-08-11T00:00:00.000Z"},
          ${"2099-01-01T00:00:00.000Z"},
          ${null},
          ${null}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const jobs = yield* sql<{
        readonly leaseExpiresAt: string;
        readonly leaseSessionId: string | null;
      }>`
        SELECT
          lease_expires_at AS "leaseExpiresAt",
          lease_session_id AS "leaseSessionId"
        FROM foundry_dispatch_jobs
        WHERE dispatch_id = ${dispatchId}
      `;
      const attempts = yield* sql<{ readonly runnerSessionId: string | null }>`
        SELECT runner_session_id AS "runnerSessionId"
        FROM foundry_dispatch_attempts
        WHERE dispatch_id = ${dispatchId}
      `;

      assert.deepEqual(jobs, [
        { leaseExpiresAt: "1970-01-01T00:00:00.000Z", leaseSessionId: null },
      ]);
      assert.deepEqual(attempts, [{ runnerSessionId: null }]);

      const invalidSessionState = yield* Effect.flip(sql`
        UPDATE foundry_dispatch_jobs
        SET
          state = 'queued',
          lease_owner = NULL,
          lease_expires_at = NULL,
          lease_session_id = ${"5".repeat(64)}
        WHERE dispatch_id = ${dispatchId}
      `);
      assert.equal(invalidSessionState._tag, "SqlError");
    }),
  );
});
