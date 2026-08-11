import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE foundry_dispatch_jobs
    ADD COLUMN lease_session_id TEXT
  `;

  yield* sql`
    ALTER TABLE foundry_dispatch_attempts
    ADD COLUMN runner_session_id TEXT
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS foundry_dispatch_jobs_active_session_uq
    ON foundry_dispatch_jobs (environment_id, lease_owner, lease_session_id)
    WHERE state = 'running'
      AND lease_owner IS NOT NULL
      AND lease_session_id IS NOT NULL
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS foundry_dispatch_jobs_session_insert_guard
    BEFORE INSERT ON foundry_dispatch_jobs
    WHEN
      (NEW.state = 'running' AND NEW.lease_session_id IS NULL)
      OR
      (NEW.state <> 'running' AND NEW.lease_session_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'foundry dispatch lease session does not match job state');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS foundry_dispatch_jobs_session_update_guard
    BEFORE UPDATE ON foundry_dispatch_jobs
    WHEN
      (NEW.state = 'running' AND NEW.lease_session_id IS NULL)
      OR
      (NEW.state <> 'running' AND NEW.lease_session_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'foundry dispatch lease session does not match job state');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS foundry_dispatch_attempts_session_insert_guard
    BEFORE INSERT ON foundry_dispatch_attempts
    WHEN NEW.state = 'running' AND NEW.runner_session_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'running foundry attempt requires a runner session');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS foundry_dispatch_attempts_session_update_guard
    BEFORE UPDATE ON foundry_dispatch_attempts
    WHEN NEW.state = 'running' AND NEW.runner_session_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'running foundry attempt requires a runner session');
    END
  `;
});
