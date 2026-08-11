import {
  FoundryDispatchReport,
  FoundryDispatchRpcError,
  FoundryDispatchStatus as FoundryDispatchStatusSchema,
  type FoundryClaimDispatchInput,
  type FoundryClaimDispatchResult,
  type FoundryApprovedContractPacket,
  type FoundryDispatchAttemptRecord,
  type FoundryDispatchFailureCode,
  type FoundryDispatchStatus,
  type FoundryGetDispatchInput,
  type FoundryGetDispatchResult,
  type FoundryHeartbeatDispatchInput,
  type FoundryHeartbeatDispatchResult,
  type FoundryReportDispatchInput,
  type FoundryReportDispatchResult,
} from "@t3tools/contracts";
import {
  canonicalizeJson,
  ingestApprovedContractPacket,
  makeBuzzNostrIdentityAdapter,
  queueFeatureDispatch,
  type VerifiedApprovalEvidence,
} from "@t3tools/foundry-governance";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { FoundryApprovedContractStore } from "../persistence/Services/FoundryApprovedContractStore.ts";
import {
  FoundryDispatchEvidenceConflictError,
  FoundryDispatchLeaseError,
  FoundryDispatchStore,
  type FoundryDispatchClaim as StoredFoundryDispatchClaim,
  type FoundryDispatchStatus as StoredFoundryDispatchStatus,
  type FoundryDispatchStoreError,
} from "../persistence/Services/FoundryDispatchStore.ts";
import { FoundryConfig, type FoundryConfiguredRuntime } from "./FoundryConfig.ts";

export const FOUNDRY_DISPATCH_LEASE_MILLISECONDS = 60_000;

const decodeStoredReport = Schema.decodeUnknownEffect(Schema.fromJsonString(FoundryDispatchReport));
const decodeDispatchStatus = Schema.decodeUnknownEffect(FoundryDispatchStatusSchema);
const isFoundryDispatchLeaseError = Schema.is(FoundryDispatchLeaseError);
const isFoundryDispatchEvidenceConflictError = Schema.is(FoundryDispatchEvidenceConflictError);

function wireError(
  code: ConstructorParameters<typeof FoundryDispatchRpcError>[0]["code"],
): FoundryDispatchRpcError {
  return new FoundryDispatchRpcError({ code });
}

function mapStoreError(error: FoundryDispatchStoreError): FoundryDispatchRpcError {
  if (isFoundryDispatchLeaseError(error)) {
    return wireError(error.reason === "lease-lost" ? "lease-lost" : "unavailable");
  }
  if (isFoundryDispatchEvidenceConflictError(error)) {
    return wireError("conflict");
  }
  return wireError("unavailable");
}

function leaseWindow(now: DateTime.Utc): {
  readonly observedAt: string;
  readonly expiresAt: string;
} {
  return {
    observedAt: DateTime.formatIso(now),
    expiresAt: DateTime.formatIso(
      DateTime.add(now, { milliseconds: FOUNDRY_DISPATCH_LEASE_MILLISECONDS }),
    ),
  };
}

function toWireAttempt(
  attempt: StoredFoundryDispatchStatus["attempts"][number],
): FoundryDispatchAttemptRecord {
  return {
    attemptNumber: attempt.attemptNumber,
    fenceToken: attempt.fenceToken,
    state: attempt.state,
    claimedAt: attempt.claimedAt,
    lastHeartbeatAt: attempt.lastHeartbeatAt,
    leaseExpiresAt: attempt.leaseExpiresAt,
    completedAt: attempt.completedAt,
    failureCode: attempt.failureCode,
  };
}

const toWireStatus = Effect.fn("FoundryDispatch.toWireStatus")(function* (
  status: StoredFoundryDispatchStatus,
) {
  const evidence = yield* Effect.forEach(status.evidence, (entry) =>
    decodeStoredReport(entry.payloadJson).pipe(
      Effect.flatMap((report) =>
        report.kind === entry.kind
          ? Effect.succeed({
              sequence: entry.sequence,
              attemptNumber: entry.attemptNumber,
              fenceToken: entry.fenceToken,
              reportId: entry.reportId,
              recordedAt: entry.recordedAt,
              report,
            })
          : Effect.fail(wireError("unavailable")),
      ),
      Effect.mapError(() => wireError("unavailable")),
    ),
  );
  return yield* decodeDispatchStatus({
    dispatchId: status.job.dispatchId,
    dispatchIdempotencyKey: status.job.dispatchIdempotencyKey,
    contractHash: status.job.contractHash,
    environmentId: status.job.environmentId,
    state: status.job.state,
    failureCode: status.job.failureCode,
    fenceToken: status.job.fenceToken,
    attemptCount: status.job.attemptCount,
    createdAt: status.job.createdAt,
    updatedAt: status.job.updatedAt,
    completedAt: status.job.completedAt,
    attempts: status.attempts.map(toWireAttempt),
    evidence,
  }).pipe(Effect.mapError(() => wireError("unavailable")));
});

function evidenceMatches(
  expected: ReadonlyArray<VerifiedApprovalEvidence>,
  stored: ReadonlyArray<{
    readonly founderId: string;
    readonly format: string;
    readonly eventId: string;
    readonly createdAtEpochSeconds: number;
  }>,
): boolean {
  return (
    expected.length === stored.length &&
    expected.every((entry, index) => {
      const candidate = stored[index];
      return (
        candidate !== undefined &&
        candidate.founderId === entry.founderId &&
        candidate.format === entry.format &&
        candidate.eventId === entry.eventId &&
        candidate.createdAtEpochSeconds === entry.createdAtEpochSeconds
      );
    })
  );
}

function claimedContractMatches(input: {
  readonly claim: StoredFoundryDispatchClaim;
  readonly config: FoundryConfiguredRuntime;
  readonly packet: FoundryApprovedContractPacket;
  readonly record: NonNullable<FoundryClaimDispatchResult["claim"]>["record"];
}): boolean {
  const verified = ingestApprovedContractPacket({
    packet: input.packet,
    founders: input.config.founders,
    identityAdapters: [
      makeBuzzNostrIdentityAdapter({
        relayUrl: input.config.buzzRelayUrl,
        groupId: input.config.buzzGroupId,
      }),
    ],
  });
  const proposal = verified.proposal;
  const dispatch = queueFeatureDispatch({
    proposal,
    environmentId: input.config.environmentId,
  });
  const { job } = input.claim;
  const { record } = input;

  return (
    proposal.body.execution.environmentId === input.config.environmentId &&
    dispatch.id === job.dispatchId &&
    dispatch.idempotencyKey === job.dispatchIdempotencyKey &&
    dispatch.contractHash === job.contractHash &&
    dispatch.environmentId === job.environmentId &&
    dispatch.branch === job.branch &&
    dispatch.baseSha === job.baseSha &&
    proposal.body.execution.limits.maximumRetries + 1 === job.maxAttempts &&
    record.contractHash === proposal.contentHash &&
    record.projectId === proposal.body.projectId &&
    record.featureId === proposal.body.featureId &&
    record.version === proposal.body.version &&
    record.founderRegistryHash === proposal.founderRegistryHash &&
    record.approvalSubject === proposal.approvalSubject &&
    record.dispatchIdempotencyKey === dispatch.idempotencyKey &&
    record.acceptedAt === job.commandCreatedAt &&
    evidenceMatches(verified.evidence, record.approvals)
  );
}

export interface FoundryDispatchShape {
  readonly claim: (
    input: FoundryClaimDispatchInput,
  ) => Effect.Effect<FoundryClaimDispatchResult, FoundryDispatchRpcError>;
  readonly heartbeat: (
    input: FoundryHeartbeatDispatchInput,
  ) => Effect.Effect<FoundryHeartbeatDispatchResult, FoundryDispatchRpcError>;
  readonly report: (
    input: FoundryReportDispatchInput,
  ) => Effect.Effect<FoundryReportDispatchResult, FoundryDispatchRpcError>;
  readonly get: (
    input: FoundryGetDispatchInput,
  ) => Effect.Effect<FoundryGetDispatchResult, FoundryDispatchRpcError>;
}

export class FoundryDispatch extends Context.Service<FoundryDispatch, FoundryDispatchShape>()(
  "t3/foundry/FoundryDispatch",
) {}

const makeFoundryDispatch = Effect.gen(function* () {
  const config = yield* FoundryConfig;
  const approvedContractStore = yield* FoundryApprovedContractStore;
  const dispatchStore = yield* FoundryDispatchStore;

  const ensureConfigured = (): Effect.Effect<FoundryConfiguredRuntime, FoundryDispatchRpcError> =>
    config.configured ? Effect.succeed(config) : Effect.fail(wireError("not-configured"));

  const readRequiredStatus = Effect.fn("FoundryDispatch.readRequiredStatus")(function* (
    dispatchIdempotencyKey: string,
  ): Effect.fn.Return<FoundryDispatchStatus, FoundryDispatchRpcError> {
    const stored = yield* dispatchStore
      .readStatus(dispatchIdempotencyKey)
      .pipe(Effect.mapError(() => wireError("unavailable")));
    if (Option.isNone(stored)) {
      return yield* wireError("not-found");
    }
    return yield* toWireStatus(stored.value);
  });

  const failClaim = Effect.fn("FoundryDispatch.failClaim")(function* (
    claim: StoredFoundryDispatchClaim,
    failureCode: FoundryDispatchFailureCode,
  ): Effect.fn.Return<never, FoundryDispatchRpcError> {
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    yield* dispatchStore
      .complete({
        dispatchIdempotencyKey: claim.job.dispatchIdempotencyKey,
        runnerId: claim.attempt.runnerId,
        fenceToken: claim.attempt.fenceToken,
        completedAt,
        outcome: "failed",
        failureCode,
      })
      .pipe(Effect.ignore);
    return yield* wireError("conflict");
  });

  const claim: FoundryDispatchShape["claim"] = Effect.fn("FoundryDispatch.claim")(
    function* (input) {
      const configured = yield* ensureConfigured();
      if (input.environmentId !== configured.environmentId) {
        return { claim: null };
      }
      const now = yield* DateTime.now;
      const lease = leaseWindow(now);
      const claimed = yield* dispatchStore
        .claimNext({
          environmentId: configured.environmentId,
          runnerId: input.runnerId,
          claimedAt: lease.observedAt,
          leaseExpiresAt: lease.expiresAt,
        })
        .pipe(Effect.mapError(mapStoreError));
      if (Option.isNone(claimed)) {
        return { claim: null };
      }

      const [packet, record] = yield* Effect.all(
        [
          approvedContractStore.readPacketByContractHash(claimed.value.job.contractHash),
          approvedContractStore.readRecordByContractHash(claimed.value.job.contractHash),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(() => wireError("unavailable")));
      if (Option.isNone(packet) || Option.isNone(record)) {
        return yield* failClaim(claimed.value, "internal");
      }

      const matches = yield* Effect.try({
        try: () =>
          claimedContractMatches({
            claim: claimed.value,
            config: configured,
            packet: packet.value,
            record: record.value,
          }),
        catch: () => wireError("conflict"),
      }).pipe(Effect.catch(() => failClaim(claimed.value, "approval-invalid")));
      if (!matches) {
        return yield* failClaim(claimed.value, "approval-invalid");
      }

      const status = yield* readRequiredStatus(claimed.value.job.dispatchIdempotencyKey);
      return {
        claim: {
          job: status,
          record: record.value,
          packet: packet.value,
          attempt: toWireAttempt(claimed.value.attempt),
        },
      };
    },
  );

  const heartbeat: FoundryDispatchShape["heartbeat"] = Effect.fn("FoundryDispatch.heartbeat")(
    function* (input) {
      yield* ensureConfigured();
      const lease = leaseWindow(yield* DateTime.now);
      const claim = yield* dispatchStore
        .heartbeat({
          ...input,
          heartbeatAt: lease.observedAt,
          leaseExpiresAt: lease.expiresAt,
        })
        .pipe(Effect.mapError(mapStoreError));
      if (claim.job.leaseExpiresAt === null) {
        return yield* wireError("unavailable");
      }
      return {
        dispatchIdempotencyKey: claim.job.dispatchIdempotencyKey,
        fenceToken: claim.job.fenceToken,
        leaseExpiresAt: claim.job.leaseExpiresAt,
      };
    },
  );

  const report: FoundryDispatchShape["report"] = Effect.fn("FoundryDispatch.report")(
    function* (input) {
      yield* ensureConfigured();
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const evidence = yield* dispatchStore
        .recordEvidence({
          dispatchIdempotencyKey: input.dispatchIdempotencyKey,
          runnerId: input.runnerId,
          fenceToken: input.fenceToken,
          reportId: input.reportId,
          kind: input.report.kind,
          payloadJson: canonicalizeJson(input.report),
          recordedAt,
        })
        .pipe(Effect.mapError(mapStoreError));

      let storedStatus: StoredFoundryDispatchStatus;
      if (input.report.kind === "succeeded" || input.report.kind === "failed") {
        storedStatus = yield* dispatchStore
          .complete({
            dispatchIdempotencyKey: input.dispatchIdempotencyKey,
            runnerId: input.runnerId,
            fenceToken: input.fenceToken,
            completedAt: recordedAt,
            outcome: input.report.kind,
            failureCode: input.report.kind === "failed" ? input.report.failureCode : null,
          })
          .pipe(Effect.mapError(mapStoreError));
      } else {
        const current = yield* dispatchStore
          .readStatus(input.dispatchIdempotencyKey)
          .pipe(Effect.mapError(() => wireError("unavailable")));
        if (Option.isNone(current)) {
          return yield* wireError("not-found");
        }
        storedStatus = current.value;
      }
      return {
        disposition: evidence.disposition,
        job: yield* toWireStatus(storedStatus),
      };
    },
  );

  const get: FoundryDispatchShape["get"] = Effect.fn("FoundryDispatch.get")(function* (input) {
    yield* ensureConfigured();
    return { job: yield* readRequiredStatus(input.dispatchIdempotencyKey) };
  });

  return FoundryDispatch.of({ claim, heartbeat, report, get });
});

export const FoundryDispatchLive = Layer.effect(FoundryDispatch, makeFoundryDispatch);
