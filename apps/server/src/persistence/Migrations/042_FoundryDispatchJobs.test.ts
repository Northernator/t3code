import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_FoundryDispatchJobs", (it) => {
  it.effect("adds fenced dispatch storage without scheduling historical approvals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 41 });

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

      yield* runMigrations({ toMigrationInclusive: 42 });

      const historicalJobs = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM foundry_dispatch_jobs
      `;
      assert.deepEqual(historicalJobs, [{ count: 0 }]);

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
          ${`dispatch_${"3".repeat(24)}`},
          ${"3".repeat(64)},
          ${"1".repeat(64)},
          ${"environment-one"},
          ${"foundry/feature-one-v1"},
          ${"5".repeat(40)},
          ${"queued"},
          ${0},
          ${0},
          ${3},
          ${null},
          ${null},
          ${"2026-08-11T00:00:00.000Z"},
          ${"2026-08-11T00:00:00.000Z"},
          ${"2026-08-11T00:00:00.000Z"},
          ${null},
          ${null}
        )
      `;

      const invalidLeaseState = yield* Effect.flip(sql`
        UPDATE foundry_dispatch_jobs
        SET state = 'running'
        WHERE dispatch_idempotency_key = ${"3".repeat(64)}
      `);
      assert.equal(invalidLeaseState._tag, "SqlError");

      const foreignKeys = yield* sql<{ readonly table: string; readonly onDelete: string }>`
        SELECT "table" AS "table", on_delete AS "onDelete"
        FROM pragma_foreign_key_list('foundry_dispatch_evidence')
      `;
      assert.deepEqual(foreignKeys, [
        { table: "foundry_dispatch_attempts", onDelete: "RESTRICT" },
        { table: "foundry_dispatch_attempts", onDelete: "RESTRICT" },
      ]);
    }),
  );
});
