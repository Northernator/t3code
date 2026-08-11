import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS foundry_dispatch_jobs (
      dispatch_id TEXT PRIMARY KEY,
      dispatch_idempotency_key TEXT NOT NULL UNIQUE,
      contract_hash TEXT NOT NULL UNIQUE
        REFERENCES foundry_approved_contracts(contract_hash)
        ON DELETE RESTRICT,
      environment_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
      fence_token INTEGER NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      lease_owner TEXT,
      lease_expires_at TEXT,
      command_created_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      failure_code TEXT,
      CHECK (
        (state = 'queued' AND lease_owner IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL AND failure_code IS NULL)
        OR
        (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL AND failure_code IS NULL)
        OR
        (state = 'succeeded' AND lease_owner IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL AND failure_code IS NULL)
        OR
        (state = 'failed' AND lease_owner IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS foundry_dispatch_jobs_claimable_idx
    ON foundry_dispatch_jobs (environment_id, state, lease_expires_at, created_at, dispatch_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS foundry_dispatch_attempts (
      dispatch_id TEXT NOT NULL
        REFERENCES foundry_dispatch_jobs(dispatch_id)
        ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      fence_token INTEGER NOT NULL CHECK (fence_token > 0),
      runner_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'abandoned')),
      claimed_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      completed_at TEXT,
      failure_code TEXT,
      PRIMARY KEY (dispatch_id, attempt_number),
      UNIQUE (dispatch_id, fence_token),
      CHECK (
        (state = 'running' AND completed_at IS NULL AND failure_code IS NULL)
        OR
        (state IN ('succeeded', 'abandoned') AND completed_at IS NOT NULL AND failure_code IS NULL)
        OR
        (state = 'failed' AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS foundry_dispatch_evidence (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      fence_token INTEGER NOT NULL CHECK (fence_token > 0),
      report_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE (dispatch_id, attempt_number, report_id),
      FOREIGN KEY (dispatch_id, attempt_number)
        REFERENCES foundry_dispatch_attempts(dispatch_id, attempt_number)
        ON DELETE RESTRICT
    )
  `;
});
