import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceSqlError,
} from "../Errors.ts";
import {
  FoundryDispatchAttempt,
  FoundryDispatchEvidence,
  FoundryDispatchEvidenceConflictError,
  FoundryDispatchJob,
  FoundryDispatchLeaseError,
  FoundryDispatchStore,
  RecordFoundryDispatchEvidenceInput,
  type FoundryDispatchClaim,
  type FoundryDispatchStatus,
  type FoundryDispatchStoreShape,
} from "../Services/FoundryDispatchStore.ts";

const DispatchIdempotencyKeyRequest = Schema.Struct({
  dispatchIdempotencyKey: Schema.String,
});

const DispatchAttemptRequest = Schema.Struct({
  dispatchId: Schema.String,
  attemptNumber: Schema.Int,
});

const InsertedEvidenceRow = Schema.Struct({
  sequence: Schema.Int,
});
const decodeDispatchJob = Schema.decodeUnknownEffect(FoundryDispatchJob);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeFoundryDispatchStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findJobByIdempotencyKey = SqlSchema.findOneOption({
    Request: DispatchIdempotencyKeyRequest,
    Result: FoundryDispatchJob,
    execute: ({ dispatchIdempotencyKey }) => sql`
      SELECT
        dispatch_id AS "dispatchId",
        dispatch_idempotency_key AS "dispatchIdempotencyKey",
        contract_hash AS "contractHash",
        environment_id AS "environmentId",
        branch,
        base_sha AS "baseSha",
        state,
        fence_token AS "fenceToken",
        attempt_count AS "attemptCount",
        max_attempts AS "maxAttempts",
        lease_owner AS "leaseOwner",
        lease_session_id AS "leaseSessionId",
        lease_expires_at AS "leaseExpiresAt",
        command_created_at AS "commandCreatedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt",
        failure_code AS "failureCode"
      FROM foundry_dispatch_jobs
      WHERE dispatch_idempotency_key = ${dispatchIdempotencyKey}
    `,
  });

  const listAttempts = SqlSchema.findAll({
    Request: Schema.Struct({ dispatchId: Schema.String }),
    Result: FoundryDispatchAttempt,
    execute: ({ dispatchId }) => sql`
      SELECT
        dispatch_id AS "dispatchId",
        attempt_number AS "attemptNumber",
        fence_token AS "fenceToken",
        runner_id AS "runnerId",
        runner_session_id AS "runnerSessionId",
        state,
        claimed_at AS "claimedAt",
        last_heartbeat_at AS "lastHeartbeatAt",
        lease_expires_at AS "leaseExpiresAt",
        completed_at AS "completedAt",
        failure_code AS "failureCode"
      FROM foundry_dispatch_attempts
      WHERE dispatch_id = ${dispatchId}
      ORDER BY attempt_number ASC
    `,
  });

  const findAttempt = SqlSchema.findOneOption({
    Request: DispatchAttemptRequest,
    Result: FoundryDispatchAttempt,
    execute: ({ dispatchId, attemptNumber }) => sql`
      SELECT
        dispatch_id AS "dispatchId",
        attempt_number AS "attemptNumber",
        fence_token AS "fenceToken",
        runner_id AS "runnerId",
        runner_session_id AS "runnerSessionId",
        state,
        claimed_at AS "claimedAt",
        last_heartbeat_at AS "lastHeartbeatAt",
        lease_expires_at AS "leaseExpiresAt",
        completed_at AS "completedAt",
        failure_code AS "failureCode"
      FROM foundry_dispatch_attempts
      WHERE dispatch_id = ${dispatchId}
        AND attempt_number = ${attemptNumber}
    `,
  });

  const listEvidence = SqlSchema.findAll({
    Request: Schema.Struct({ dispatchId: Schema.String }),
    Result: FoundryDispatchEvidence,
    execute: ({ dispatchId }) => sql`
      SELECT
        sequence,
        dispatch_id AS "dispatchId",
        attempt_number AS "attemptNumber",
        fence_token AS "fenceToken",
        report_id AS "reportId",
        kind,
        payload_json AS "payloadJson",
        recorded_at AS "recordedAt"
      FROM foundry_dispatch_evidence
      WHERE dispatch_id = ${dispatchId}
      ORDER BY sequence ASC
    `,
  });

  const findEvidence = SqlSchema.findOneOption({
    Request: Schema.Struct({
      dispatchId: Schema.String,
      attemptNumber: Schema.Int,
      reportId: Schema.String,
    }),
    Result: FoundryDispatchEvidence,
    execute: ({ dispatchId, attemptNumber, reportId }) => sql`
      SELECT
        sequence,
        dispatch_id AS "dispatchId",
        attempt_number AS "attemptNumber",
        fence_token AS "fenceToken",
        report_id AS "reportId",
        kind,
        payload_json AS "payloadJson",
        recorded_at AS "recordedAt"
      FROM foundry_dispatch_evidence
      WHERE dispatch_id = ${dispatchId}
        AND attempt_number = ${attemptNumber}
        AND report_id = ${reportId}
    `,
  });

  const loadStatus = Effect.fn("FoundryDispatchStore.loadStatus")(function* (
    job: typeof FoundryDispatchJob.Type,
  ) {
    const attempts = yield* listAttempts({ dispatchId: job.dispatchId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FoundryDispatchStore.loadStatus:attemptQuery",
          "FoundryDispatchStore.loadStatus:decodeAttempts",
        ),
      ),
    );
    const evidence = yield* listEvidence({ dispatchId: job.dispatchId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FoundryDispatchStore.loadStatus:evidenceQuery",
          "FoundryDispatchStore.loadStatus:decodeEvidence",
        ),
      ),
    );
    return { job, attempts, evidence } satisfies FoundryDispatchStatus;
  });

  const loadClaim = Effect.fn("FoundryDispatchStore.loadClaim")(function* (
    job: typeof FoundryDispatchJob.Type,
  ) {
    const attempt = yield* findAttempt({
      dispatchId: job.dispatchId,
      attemptNumber: job.attemptCount,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FoundryDispatchStore.loadClaim:attemptQuery",
          "FoundryDispatchStore.loadClaim:decodeAttempt",
        ),
      ),
    );
    if (Option.isNone(attempt)) {
      return yield* new PersistenceDecodeError({
        operation: "FoundryDispatchStore.loadClaim",
        issue: "MissingCurrentAttempt",
      });
    }
    return { job, attempt: attempt.value } satisfies FoundryDispatchClaim;
  });

  const findJob = Effect.fn("FoundryDispatchStore.findJob")(function* (
    dispatchIdempotencyKey: string,
  ) {
    return yield* findJobByIdempotencyKey({ dispatchIdempotencyKey }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FoundryDispatchStore.findJob:query",
          "FoundryDispatchStore.findJob:decodeJob",
        ),
      ),
    );
  });

  const leaseLost = (dispatchIdempotencyKey: string) =>
    new FoundryDispatchLeaseError({ dispatchIdempotencyKey, reason: "lease-lost" });

  const invalidLease = (dispatchIdempotencyKey = "") =>
    new FoundryDispatchLeaseError({ dispatchIdempotencyKey, reason: "invalid-lease" });

  const claimNext: FoundryDispatchStoreShape["claimNext"] = Effect.fn(
    "FoundryDispatchStore.claimNext",
  )(function* (input) {
    if (input.leaseExpiresAt <= input.claimedAt) {
      return yield* invalidLease();
    }

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const reattachedRows = yield* sql<typeof FoundryDispatchJob.Type>`
            UPDATE foundry_dispatch_jobs
            SET
              lease_expires_at = CASE
                WHEN lease_expires_at < ${input.leaseExpiresAt} THEN ${input.leaseExpiresAt}
                ELSE lease_expires_at
              END,
              updated_at = ${input.claimedAt}
            WHERE dispatch_id = (
              SELECT dispatch_id
              FROM foundry_dispatch_jobs
              WHERE environment_id = ${input.environmentId}
                AND state = 'running'
                AND lease_owner = ${input.runnerId}
                AND lease_session_id = ${input.runnerSessionId}
                AND lease_expires_at > ${input.claimedAt}
              ORDER BY created_at ASC, dispatch_id ASC
              LIMIT 1
            )
              AND environment_id = ${input.environmentId}
              AND state = 'running'
              AND lease_owner = ${input.runnerId}
              AND lease_session_id = ${input.runnerSessionId}
              AND lease_expires_at > ${input.claimedAt}
            RETURNING
              dispatch_id AS "dispatchId",
              dispatch_idempotency_key AS "dispatchIdempotencyKey",
              contract_hash AS "contractHash",
              environment_id AS "environmentId",
              branch,
              base_sha AS "baseSha",
              state,
              fence_token AS "fenceToken",
              attempt_count AS "attemptCount",
              max_attempts AS "maxAttempts",
              lease_owner AS "leaseOwner",
              lease_session_id AS "leaseSessionId",
              lease_expires_at AS "leaseExpiresAt",
              command_created_at AS "commandCreatedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              completed_at AS "completedAt",
              failure_code AS "failureCode"
          `;
          if (reattachedRows.length === 1) {
            const job = yield* decodeDispatchJob(reattachedRows[0]).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "FoundryDispatchStore.claimNext:decodeReattachedJob",
                  cause,
                ),
              ),
            );
            const renewedAttempts = yield* sql<{ readonly dispatchId: string }>`
              UPDATE foundry_dispatch_attempts
              SET
                last_heartbeat_at = ${input.claimedAt},
                lease_expires_at = ${job.leaseExpiresAt}
              WHERE dispatch_id = ${job.dispatchId}
                AND attempt_number = ${job.attemptCount}
                AND fence_token = ${job.fenceToken}
                AND runner_id = ${input.runnerId}
                AND runner_session_id = ${input.runnerSessionId}
                AND state = 'running'
              RETURNING dispatch_id AS "dispatchId"
            `;
            if (renewedAttempts.length !== 1) {
              return yield* new PersistenceDecodeError({
                operation: "FoundryDispatchStore.claimNext",
                issue: "MissingReattachedAttempt",
              });
            }
            return Option.some(yield* loadClaim(job));
          }

          yield* sql`
            UPDATE foundry_dispatch_attempts
            SET
              state = 'abandoned',
              completed_at = ${input.claimedAt}
            WHERE state = 'running'
              AND EXISTS (
                SELECT 1
                FROM foundry_dispatch_jobs jobs
                WHERE jobs.dispatch_id = foundry_dispatch_attempts.dispatch_id
                  AND jobs.environment_id = ${input.environmentId}
                  AND jobs.state = 'running'
                  AND jobs.lease_expires_at <= ${input.claimedAt}
                  AND jobs.attempt_count >= jobs.max_attempts
              )
          `;
          yield* sql`
            UPDATE foundry_dispatch_jobs
            SET
              state = 'failed',
              lease_owner = NULL,
              lease_session_id = NULL,
              lease_expires_at = NULL,
              updated_at = ${input.claimedAt},
              completed_at = ${input.claimedAt},
              failure_code = 'lease-lost'
            WHERE environment_id = ${input.environmentId}
              AND state = 'running'
              AND lease_expires_at <= ${input.claimedAt}
              AND attempt_count >= max_attempts
          `;

          const claimedRows = yield* sql<typeof FoundryDispatchJob.Type>`
            UPDATE foundry_dispatch_jobs
            SET
              state = 'running',
              fence_token = fence_token + 1,
              attempt_count = attempt_count + 1,
              lease_owner = ${input.runnerId},
              lease_session_id = ${input.runnerSessionId},
              lease_expires_at = ${input.leaseExpiresAt},
              updated_at = ${input.claimedAt},
              completed_at = NULL,
              failure_code = NULL
            WHERE dispatch_id = (
              SELECT dispatch_id
              FROM foundry_dispatch_jobs
              WHERE environment_id = ${input.environmentId}
                AND (
                  state = 'queued'
                  OR (
                    state = 'running'
                    AND lease_expires_at <= ${input.claimedAt}
                    AND attempt_count < max_attempts
                  )
                )
              ORDER BY
                CASE
                  WHEN lease_owner = ${input.runnerId}
                    AND lease_session_id = ${input.runnerSessionId}
                  THEN 0
                  ELSE 1
                END ASC,
                created_at ASC,
                dispatch_id ASC
              LIMIT 1
            )
              AND environment_id = ${input.environmentId}
              AND (
                state = 'queued'
                OR (
                  state = 'running'
                  AND lease_expires_at <= ${input.claimedAt}
                  AND attempt_count < max_attempts
                )
              )
            RETURNING
              dispatch_id AS "dispatchId",
              dispatch_idempotency_key AS "dispatchIdempotencyKey",
              contract_hash AS "contractHash",
              environment_id AS "environmentId",
              branch,
              base_sha AS "baseSha",
              state,
              fence_token AS "fenceToken",
              attempt_count AS "attemptCount",
              max_attempts AS "maxAttempts",
              lease_owner AS "leaseOwner",
              lease_session_id AS "leaseSessionId",
              lease_expires_at AS "leaseExpiresAt",
              command_created_at AS "commandCreatedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              completed_at AS "completedAt",
              failure_code AS "failureCode"
          `;
          if (claimedRows.length === 0) {
            return Option.none<FoundryDispatchClaim>();
          }

          const job = yield* decodeDispatchJob(claimedRows[0]).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "FoundryDispatchStore.claimNext:decodeClaimedJob",
                cause,
              ),
            ),
          );

          yield* sql`
            UPDATE foundry_dispatch_attempts
            SET
              state = 'abandoned',
              completed_at = ${input.claimedAt}
            WHERE dispatch_id = ${job.dispatchId}
              AND state = 'running'
              AND attempt_number < ${job.attemptCount}
          `;

          yield* sql`
            INSERT INTO foundry_dispatch_attempts (
              dispatch_id,
              attempt_number,
              fence_token,
              runner_id,
              runner_session_id,
              state,
              claimed_at,
              last_heartbeat_at,
              lease_expires_at,
              completed_at,
              failure_code
            ) VALUES (
              ${job.dispatchId},
              ${job.attemptCount},
              ${job.fenceToken},
              ${input.runnerId},
              ${input.runnerSessionId},
              ${"running"},
              ${input.claimedAt},
              ${input.claimedAt},
              ${input.leaseExpiresAt},
              ${null},
              ${null}
            )
          `;

          return Option.some(yield* loadClaim(job));
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError("FoundryDispatchStore.claimNext:transaction")(cause)),
        ),
      );
  });

  const heartbeat: FoundryDispatchStoreShape["heartbeat"] = Effect.fn(
    "FoundryDispatchStore.heartbeat",
  )(function* (input) {
    if (input.leaseExpiresAt <= input.heartbeatAt) {
      return yield* invalidLease(input.dispatchIdempotencyKey);
    }

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const jobs = yield* sql<typeof FoundryDispatchJob.Type>`
            UPDATE foundry_dispatch_jobs
            SET
              lease_expires_at = CASE
                WHEN lease_expires_at < ${input.leaseExpiresAt} THEN ${input.leaseExpiresAt}
                ELSE lease_expires_at
              END,
              updated_at = ${input.heartbeatAt}
            WHERE dispatch_idempotency_key = ${input.dispatchIdempotencyKey}
              AND state = 'running'
              AND lease_owner = ${input.runnerId}
              AND lease_session_id = ${input.runnerSessionId}
              AND fence_token = ${input.fenceToken}
              AND lease_expires_at > ${input.heartbeatAt}
            RETURNING
              dispatch_id AS "dispatchId",
              dispatch_idempotency_key AS "dispatchIdempotencyKey",
              contract_hash AS "contractHash",
              environment_id AS "environmentId",
              branch,
              base_sha AS "baseSha",
              state,
              fence_token AS "fenceToken",
              attempt_count AS "attemptCount",
              max_attempts AS "maxAttempts",
              lease_owner AS "leaseOwner",
              lease_session_id AS "leaseSessionId",
              lease_expires_at AS "leaseExpiresAt",
              command_created_at AS "commandCreatedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              completed_at AS "completedAt",
              failure_code AS "failureCode"
          `;
          if (jobs.length === 0) {
            return yield* leaseLost(input.dispatchIdempotencyKey);
          }
          const job = yield* decodeDispatchJob(jobs[0]).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "FoundryDispatchStore.heartbeat:decodeJob",
                cause,
              ),
            ),
          );
          const heartbeatAttempts = yield* sql<{ readonly dispatchId: string }>`
            UPDATE foundry_dispatch_attempts
            SET
              last_heartbeat_at = ${input.heartbeatAt},
              lease_expires_at = ${job.leaseExpiresAt}
            WHERE dispatch_id = ${job.dispatchId}
              AND attempt_number = ${job.attemptCount}
              AND fence_token = ${input.fenceToken}
              AND runner_id = ${input.runnerId}
              AND runner_session_id = ${input.runnerSessionId}
              AND state = 'running'
            RETURNING dispatch_id AS "dispatchId"
          `;
          if (heartbeatAttempts.length !== 1) {
            return yield* new PersistenceDecodeError({
              operation: "FoundryDispatchStore.heartbeat",
              issue: "MissingCurrentAttempt",
            });
          }
          return yield* loadClaim(job);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError("FoundryDispatchStore.heartbeat:transaction")(cause)),
        ),
      );
  });

  const completeInTransaction = Effect.fn("FoundryDispatchStore.completeInTransaction")(function* (
    input: Parameters<FoundryDispatchStoreShape["complete"]>[0],
  ) {
    if (
      (input.outcome === "succeeded" && input.failureCode !== null) ||
      (input.outcome === "failed" && input.failureCode === null)
    ) {
      return yield* leaseLost(input.dispatchIdempotencyKey);
    }

    const completed = yield* sql<typeof FoundryDispatchJob.Type>`
            UPDATE foundry_dispatch_jobs
            SET
              state = ${input.outcome},
              lease_owner = NULL,
              lease_session_id = NULL,
              lease_expires_at = NULL,
              updated_at = ${input.completedAt},
              completed_at = ${input.completedAt},
              failure_code = ${input.failureCode}
            WHERE dispatch_idempotency_key = ${input.dispatchIdempotencyKey}
              AND state = 'running'
              AND lease_owner = ${input.runnerId}
              AND lease_session_id = ${input.runnerSessionId}
              AND fence_token = ${input.fenceToken}
              AND lease_expires_at > ${input.completedAt}
            RETURNING
              dispatch_id AS "dispatchId",
              dispatch_idempotency_key AS "dispatchIdempotencyKey",
              contract_hash AS "contractHash",
              environment_id AS "environmentId",
              branch,
              base_sha AS "baseSha",
              state,
              fence_token AS "fenceToken",
              attempt_count AS "attemptCount",
              max_attempts AS "maxAttempts",
              lease_owner AS "leaseOwner",
              lease_session_id AS "leaseSessionId",
              lease_expires_at AS "leaseExpiresAt",
              command_created_at AS "commandCreatedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              completed_at AS "completedAt",
              failure_code AS "failureCode"
          `;

    let job: typeof FoundryDispatchJob.Type;
    if (completed.length === 0) {
      const existing = yield* findJob(input.dispatchIdempotencyKey);
      if (
        Option.isNone(existing) ||
        existing.value.state !== input.outcome ||
        existing.value.fenceToken !== input.fenceToken ||
        existing.value.failureCode !== input.failureCode
      ) {
        return yield* leaseLost(input.dispatchIdempotencyKey);
      }
      const existingAttempt = yield* findAttempt({
        dispatchId: existing.value.dispatchId,
        attemptNumber: existing.value.attemptCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "FoundryDispatchStore.complete:existingAttemptQuery",
            "FoundryDispatchStore.complete:decodeExistingAttempt",
          ),
        ),
      );
      if (
        Option.isNone(existingAttempt) ||
        existingAttempt.value.runnerId !== input.runnerId ||
        existingAttempt.value.runnerSessionId !== input.runnerSessionId ||
        existingAttempt.value.fenceToken !== input.fenceToken
      ) {
        return yield* leaseLost(input.dispatchIdempotencyKey);
      }
      job = existing.value;
    } else {
      job = yield* decodeDispatchJob(completed[0]).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("FoundryDispatchStore.complete:decodeJob", cause),
        ),
      );
      const completedAttempts = yield* sql<{ readonly dispatchId: string }>`
              UPDATE foundry_dispatch_attempts
              SET
                state = ${input.outcome},
                completed_at = ${input.completedAt},
                failure_code = ${input.failureCode}
              WHERE dispatch_id = ${job.dispatchId}
                AND attempt_number = ${job.attemptCount}
                AND fence_token = ${input.fenceToken}
                AND runner_id = ${input.runnerId}
                AND runner_session_id = ${input.runnerSessionId}
                AND state = 'running'
              RETURNING dispatch_id AS "dispatchId"
            `;
      if (completedAttempts.length !== 1) {
        return yield* new PersistenceDecodeError({
          operation: "FoundryDispatchStore.complete",
          issue: "MissingCurrentAttempt",
        });
      }
    }
    return yield* loadStatus(job);
  });

  const complete: FoundryDispatchStoreShape["complete"] = Effect.fn(
    "FoundryDispatchStore.complete",
  )(function* (input) {
    return yield* sql
      .withTransaction(completeInTransaction(input))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError("FoundryDispatchStore.complete:transaction")(cause)),
        ),
      );
  });

  const recordEvidenceInTransaction = Effect.fn("FoundryDispatchStore.recordEvidenceInTransaction")(
    function* (input: Parameters<FoundryDispatchStoreShape["recordEvidence"]>[0]) {
      const job = yield* findJob(input.dispatchIdempotencyKey);
      if (Option.isNone(job)) {
        return yield* leaseLost(input.dispatchIdempotencyKey);
      }

      const existing = yield* findEvidence({
        dispatchId: job.value.dispatchId,
        attemptNumber: job.value.attemptCount,
        reportId: input.reportId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "FoundryDispatchStore.recordEvidence:existingQuery",
            "FoundryDispatchStore.recordEvidence:decodeExisting",
          ),
        ),
      );
      if (Option.isSome(existing)) {
        const existingAttempt = yield* findAttempt({
          dispatchId: job.value.dispatchId,
          attemptNumber: existing.value.attemptNumber,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "FoundryDispatchStore.recordEvidence:existingAttemptQuery",
              "FoundryDispatchStore.recordEvidence:decodeExistingAttempt",
            ),
          ),
        );
        if (Option.isNone(existingAttempt)) {
          return yield* new PersistenceDecodeError({
            operation: "FoundryDispatchStore.recordEvidence",
            issue: "MissingEvidenceAttempt",
          });
        }
        if (
          existingAttempt.value.runnerId !== input.runnerId ||
          existingAttempt.value.runnerSessionId !== input.runnerSessionId ||
          existingAttempt.value.fenceToken !== input.fenceToken ||
          existing.value.fenceToken !== input.fenceToken
        ) {
          return yield* leaseLost(input.dispatchIdempotencyKey);
        }
        if (
          existing.value.kind !== input.kind ||
          existing.value.payloadJson !== input.payloadJson
        ) {
          return yield* new FoundryDispatchEvidenceConflictError({
            dispatchIdempotencyKey: input.dispatchIdempotencyKey,
            reportId: input.reportId,
          });
        }
        if (
          job.value.attemptCount !== existing.value.attemptNumber ||
          job.value.fenceToken !== input.fenceToken
        ) {
          return yield* leaseLost(input.dispatchIdempotencyKey);
        }
        return { disposition: "replayed", evidence: existing.value } as const;
      }

      if (
        job.value.state !== "running" ||
        job.value.leaseOwner !== input.runnerId ||
        job.value.leaseSessionId !== input.runnerSessionId ||
        job.value.fenceToken !== input.fenceToken ||
        job.value.leaseExpiresAt === null ||
        job.value.leaseExpiresAt <= input.recordedAt
      ) {
        return yield* leaseLost(input.dispatchIdempotencyKey);
      }

      const inserted = yield* SqlSchema.findAll({
        Request: RecordFoundryDispatchEvidenceInput,
        Result: InsertedEvidenceRow,
        execute: (request) => sql`
              INSERT INTO foundry_dispatch_evidence (
                dispatch_id,
                attempt_number,
                fence_token,
                report_id,
                kind,
                payload_json,
                recorded_at
              ) VALUES (
                ${job.value.dispatchId},
                ${job.value.attemptCount},
                ${request.fenceToken},
                ${request.reportId},
                ${request.kind},
                ${request.payloadJson},
                ${request.recordedAt}
              )
              RETURNING sequence
            `,
      })(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "FoundryDispatchStore.recordEvidence:insert",
            "FoundryDispatchStore.recordEvidence:encode",
          ),
        ),
      );
      if (inserted.length !== 1) {
        return yield* new PersistenceDecodeError({
          operation: "FoundryDispatchStore.recordEvidence",
          issue: "MissingInsertedEvidence",
        });
      }
      return {
        disposition: "recorded",
        evidence: {
          sequence: inserted[0]!.sequence,
          dispatchId: job.value.dispatchId,
          attemptNumber: job.value.attemptCount,
          fenceToken: input.fenceToken,
          reportId: input.reportId,
          kind: input.kind,
          payloadJson: input.payloadJson,
          recordedAt: input.recordedAt,
        },
      } as const;
    },
  );

  const recordEvidence: FoundryDispatchStoreShape["recordEvidence"] = Effect.fn(
    "FoundryDispatchStore.recordEvidence",
  )(function* (input) {
    return yield* sql
      .withTransaction(recordEvidenceInTransaction(input))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("FoundryDispatchStore.recordEvidence:transaction")(cause),
          ),
        ),
      );
  });

  const finalizeWithEvidence: FoundryDispatchStoreShape["finalizeWithEvidence"] = Effect.fn(
    "FoundryDispatchStore.finalizeWithEvidence",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const evidence = yield* recordEvidenceInTransaction(input);
          const status = yield* completeInTransaction({
            dispatchIdempotencyKey: input.dispatchIdempotencyKey,
            runnerId: input.runnerId,
            runnerSessionId: input.runnerSessionId,
            fenceToken: input.fenceToken,
            completedAt: input.recordedAt,
            outcome: input.outcome,
            failureCode: input.failureCode,
          });
          return { ...evidence, status };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("FoundryDispatchStore.finalizeWithEvidence:transaction")(cause),
          ),
        ),
      );
  });

  const readStatus: FoundryDispatchStoreShape["readStatus"] = Effect.fn(
    "FoundryDispatchStore.readStatus",
  )(function* (dispatchIdempotencyKey) {
    const job = yield* findJob(dispatchIdempotencyKey);
    return Option.isNone(job)
      ? Option.none<FoundryDispatchStatus>()
      : Option.some(yield* loadStatus(job.value));
  });

  return FoundryDispatchStore.of({
    claimNext,
    heartbeat,
    complete,
    recordEvidence,
    finalizeWithEvidence,
    readStatus,
  });
});

export const FoundryDispatchStoreLive = Layer.effect(
  FoundryDispatchStore,
  makeFoundryDispatchStore,
);
