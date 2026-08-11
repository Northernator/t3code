import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_FoundryApprovedContracts", (it) => {
  it.effect("creates contract identity, founder, and signed-event uniqueness constraints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 41 });

      const insertContract = (contractHash: string, featureId: string, version: number) => sql`
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
          ${contractHash},
          ${"project-one"},
          ${featureId},
          ${version},
          ${"registry-hash"},
          ${"approval-subject"},
          ${`dispatch-${contractHash}`},
          ${"{}"},
          ${"{}"},
          ${"packet-digest"},
          ${"2026-08-11T00:00:00.000Z"}
        )
      `;

      yield* insertContract("contract-one", "feature-one", 1);
      yield* sql`
        INSERT INTO foundry_approval_events (
          contract_hash,
          approval_index,
          founder_id,
          proof_format,
          event_id,
          created_at_epoch_seconds,
          encoded_event
        ) VALUES (
          ${"contract-one"},
          ${0},
          ${"founder-one"},
          ${"buzz-nostr-event/v1"},
          ${"event-one"},
          ${1},
          ${"event-one-bytes"}
        )
      `;

      const logicalVersionError = yield* Effect.flip(
        insertContract("contract-two", "feature-one", 1),
      );
      assert.equal(logicalVersionError._tag, "SqlError");

      yield* insertContract("contract-three", "feature-two", 1);
      const replayError = yield* Effect.flip(sql`
        INSERT INTO foundry_approval_events (
          contract_hash,
          approval_index,
          founder_id,
          proof_format,
          event_id,
          created_at_epoch_seconds,
          encoded_event
        ) VALUES (
          ${"contract-three"},
          ${0},
          ${"founder-three"},
          ${"buzz-nostr-event/v1"},
          ${"event-one"},
          ${2},
          ${"replayed-event-bytes"}
        )
      `);
      assert.equal(replayError._tag, "SqlError");

      const foreignKeys = yield* sql<{
        readonly table: string;
        readonly onDelete: string;
      }>`
        SELECT
          "table" AS "table",
          on_delete AS "onDelete"
        FROM pragma_foreign_key_list('foundry_approval_events')
      `;
      assert.deepEqual(foreignKeys, [
        {
          table: "foundry_approved_contracts",
          onDelete: "RESTRICT",
        },
      ]);
    }),
  );
});
