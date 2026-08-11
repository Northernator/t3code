import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS foundry_approved_contracts (
      contract_hash TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      contract_version INTEGER NOT NULL CHECK (contract_version > 0),
      founder_registry_hash TEXT NOT NULL,
      approval_subject TEXT NOT NULL,
      dispatch_idempotency_key TEXT NOT NULL,
      canonical_body_json TEXT NOT NULL,
      packet_json TEXT NOT NULL,
      packet_digest TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      UNIQUE (dispatch_idempotency_key),
      UNIQUE (project_id, feature_id, contract_version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS foundry_approval_events (
      contract_hash TEXT NOT NULL
        REFERENCES foundry_approved_contracts(contract_hash)
        ON DELETE RESTRICT,
      approval_index INTEGER NOT NULL CHECK (approval_index IN (0, 1)),
      founder_id TEXT NOT NULL,
      proof_format TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at_epoch_seconds INTEGER NOT NULL CHECK (created_at_epoch_seconds >= 0),
      encoded_event TEXT NOT NULL,
      PRIMARY KEY (contract_hash, approval_index),
      UNIQUE (contract_hash, founder_id),
      UNIQUE (proof_format, event_id)
    )
  `;
});
