import {
  FoundryApprovedContractRecord,
  FoundryDispatchAttemptNumber,
  FoundryDispatchAttemptState,
  FoundryDispatchFailureCode,
  FoundryDispatchFenceToken,
  FoundryDispatchId,
  FoundryDispatchIdempotencyKey,
  FoundryDispatchReportId,
  FoundryDispatchState,
  FoundryRunnerId,
  FoundryRunnerSessionId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192));
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isTrimmed(),
);
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const MaximumAttempts = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 101 }));

export const FoundryDispatchTerminalState = Schema.Literals(["succeeded", "failed"]);
export type FoundryDispatchTerminalState = typeof FoundryDispatchTerminalState.Type;

export const FoundryDispatchCreationInput = Schema.Struct({
  dispatchId: FoundryDispatchId,
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  environmentId: Identifier,
  branch: NonEmptyText,
  baseSha: NonEmptyText,
  maxAttempts: MaximumAttempts,
});
export type FoundryDispatchCreationInput = typeof FoundryDispatchCreationInput.Type;

export const FoundryDispatchJob = Schema.Struct({
  dispatchId: FoundryDispatchId,
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  contractHash: FoundryApprovedContractRecord.fields.contractHash,
  environmentId: Identifier,
  branch: NonEmptyText,
  baseSha: NonEmptyText,
  state: FoundryDispatchState,
  fenceToken: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxAttempts: MaximumAttempts,
  leaseOwner: Schema.NullOr(Identifier),
  leaseSessionId: Schema.NullOr(FoundryRunnerSessionId),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  commandCreatedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  failureCode: Schema.NullOr(FoundryDispatchFailureCode),
});
export type FoundryDispatchJob = typeof FoundryDispatchJob.Type;

export const FoundryDispatchAttempt = Schema.Struct({
  dispatchId: FoundryDispatchId,
  attemptNumber: FoundryDispatchAttemptNumber,
  fenceToken: FoundryDispatchFenceToken,
  runnerId: FoundryRunnerId,
  runnerSessionId: Schema.NullOr(FoundryRunnerSessionId),
  state: FoundryDispatchAttemptState,
  claimedAt: IsoDateTime,
  lastHeartbeatAt: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  failureCode: Schema.NullOr(FoundryDispatchFailureCode),
});
export type FoundryDispatchAttempt = typeof FoundryDispatchAttempt.Type;

export const FoundryDispatchEvidence = Schema.Struct({
  sequence: PositiveInteger,
  dispatchId: FoundryDispatchId,
  attemptNumber: FoundryDispatchAttemptNumber,
  fenceToken: FoundryDispatchFenceToken,
  reportId: FoundryDispatchReportId,
  kind: Identifier,
  payloadJson: Schema.String.check(Schema.isMaxLength(262_144)),
  recordedAt: IsoDateTime,
});
export type FoundryDispatchEvidence = typeof FoundryDispatchEvidence.Type;

export const FoundryDispatchEvidenceResult = Schema.Struct({
  disposition: Schema.Literals(["recorded", "replayed"]),
  evidence: FoundryDispatchEvidence,
});
export type FoundryDispatchEvidenceResult = typeof FoundryDispatchEvidenceResult.Type;

export const FoundryDispatchClaim = Schema.Struct({
  job: FoundryDispatchJob,
  attempt: FoundryDispatchAttempt,
});
export type FoundryDispatchClaim = typeof FoundryDispatchClaim.Type;

export const FoundryDispatchStatus = Schema.Struct({
  job: FoundryDispatchJob,
  attempts: Schema.Array(FoundryDispatchAttempt),
  evidence: Schema.Array(FoundryDispatchEvidence),
});
export type FoundryDispatchStatus = typeof FoundryDispatchStatus.Type;

export const ClaimFoundryDispatchInput = Schema.Struct({
  environmentId: Identifier,
  runnerId: FoundryRunnerId,
  runnerSessionId: FoundryRunnerSessionId,
  claimedAt: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
});
export type ClaimFoundryDispatchInput = typeof ClaimFoundryDispatchInput.Type;

export const HeartbeatFoundryDispatchInput = Schema.Struct({
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  runnerId: FoundryRunnerId,
  runnerSessionId: FoundryRunnerSessionId,
  fenceToken: FoundryDispatchFenceToken,
  heartbeatAt: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
});
export type HeartbeatFoundryDispatchInput = typeof HeartbeatFoundryDispatchInput.Type;

export const CompleteFoundryDispatchInput = Schema.Struct({
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  runnerId: FoundryRunnerId,
  runnerSessionId: FoundryRunnerSessionId,
  fenceToken: FoundryDispatchFenceToken,
  completedAt: IsoDateTime,
  outcome: FoundryDispatchTerminalState,
  failureCode: Schema.NullOr(FoundryDispatchFailureCode),
});
export type CompleteFoundryDispatchInput = typeof CompleteFoundryDispatchInput.Type;

export const RecordFoundryDispatchEvidenceInput = Schema.Struct({
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  runnerId: FoundryRunnerId,
  runnerSessionId: FoundryRunnerSessionId,
  fenceToken: FoundryDispatchFenceToken,
  reportId: FoundryDispatchReportId,
  kind: Identifier,
  payloadJson: Schema.String.check(Schema.isMaxLength(262_144)),
  recordedAt: IsoDateTime,
});
export type RecordFoundryDispatchEvidenceInput = typeof RecordFoundryDispatchEvidenceInput.Type;

export const FinalizeFoundryDispatchInput = Schema.Struct({
  ...RecordFoundryDispatchEvidenceInput.fields,
  outcome: FoundryDispatchTerminalState,
  failureCode: Schema.NullOr(FoundryDispatchFailureCode),
});
export type FinalizeFoundryDispatchInput = typeof FinalizeFoundryDispatchInput.Type;

export interface FoundryDispatchFinalizationResult {
  readonly disposition: FoundryDispatchEvidenceResult["disposition"];
  readonly evidence: FoundryDispatchEvidence;
  readonly status: FoundryDispatchStatus;
}

export class FoundryDispatchLeaseError extends Schema.TaggedErrorClass<FoundryDispatchLeaseError>()(
  "FoundryDispatchLeaseError",
  {
    dispatchIdempotencyKey: Schema.String,
    reason: Schema.Literals(["invalid-lease", "lease-lost"]),
  },
) {
  override get message(): string {
    return this.reason === "invalid-lease"
      ? "The dispatch lease must expire after the operation timestamp."
      : "The dispatch lease is no longer owned by this runner session and fencing token.";
  }
}

export class FoundryDispatchEvidenceConflictError extends Schema.TaggedErrorClass<FoundryDispatchEvidenceConflictError>()(
  "FoundryDispatchEvidenceConflictError",
  {
    dispatchIdempotencyKey: Schema.String,
    reportId: Schema.String,
  },
) {
  override get message(): string {
    return "The dispatch evidence key is already bound to different evidence.";
  }
}

export type FoundryDispatchStoreError =
  | FoundryDispatchLeaseError
  | FoundryDispatchEvidenceConflictError
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface FoundryDispatchStoreShape {
  readonly claimNext: (
    input: ClaimFoundryDispatchInput,
  ) => Effect.Effect<Option.Option<FoundryDispatchClaim>, FoundryDispatchStoreError>;

  readonly heartbeat: (
    input: HeartbeatFoundryDispatchInput,
  ) => Effect.Effect<FoundryDispatchClaim, FoundryDispatchStoreError>;

  readonly complete: (
    input: CompleteFoundryDispatchInput,
  ) => Effect.Effect<FoundryDispatchStatus, FoundryDispatchStoreError>;

  readonly recordEvidence: (
    input: RecordFoundryDispatchEvidenceInput,
  ) => Effect.Effect<FoundryDispatchEvidenceResult, FoundryDispatchStoreError>;

  readonly finalizeWithEvidence: (
    input: FinalizeFoundryDispatchInput,
  ) => Effect.Effect<FoundryDispatchFinalizationResult, FoundryDispatchStoreError>;

  readonly readStatus: (
    dispatchIdempotencyKey: string,
  ) => Effect.Effect<
    Option.Option<FoundryDispatchStatus>,
    PersistenceSqlError | PersistenceDecodeError
  >;
}

export class FoundryDispatchStore extends Context.Service<
  FoundryDispatchStore,
  FoundryDispatchStoreShape
>()("t3/persistence/Services/FoundryDispatchStore") {}
