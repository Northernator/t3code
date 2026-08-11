import * as Schema from "effect/Schema";

import { CheckpointRef, CommandId, IsoDateTime, ThreadId, TurnId } from "./baseSchemas.ts";

const strictDecodeOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isTrimmed(),
);
const ShortText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isTrimmed(),
);
const LongText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8_192),
  Schema.isTrimmed(),
);
const ContractList = Schema.Array(LongText).check(Schema.isMaxLength(100));
const FeatureId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
);
const GitObjectId = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i));
const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Hex128 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/));
export const FoundryDispatchId = Schema.String.check(Schema.isPattern(/^dispatch_[0-9a-f]{24}$/));
export type FoundryDispatchId = typeof FoundryDispatchId.Type;
export const FoundryDispatchIdempotencyKey = Hex64;
export type FoundryDispatchIdempotencyKey = typeof FoundryDispatchIdempotencyKey.Type;
export const FoundryRunnerId = Identifier;
export type FoundryRunnerId = typeof FoundryRunnerId.Type;
export const FoundryDispatchFenceToken = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export type FoundryDispatchFenceToken = typeof FoundryDispatchFenceToken.Type;
export const FoundryDispatchAttemptNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export type FoundryDispatchAttemptNumber = typeof FoundryDispatchAttemptNumber.Type;
export const FoundryDispatchEvidenceKey = Hex64;
export type FoundryDispatchEvidenceKey = typeof FoundryDispatchEvidenceKey.Type;
export const FoundryDispatchReportId = Hex64;
export type FoundryDispatchReportId = typeof FoundryDispatchReportId.Type;
const FoundryDispatchTimestamp = IsoDateTime.check(
  Schema.makeFilter((value) => {
    const epochMilliseconds = Date.parse(value);
    return (
      (Number.isFinite(epochMilliseconds) && new Date(epochMilliseconds).toISOString() === value) ||
      "Foundry dispatch timestamps must be canonical UTC ISO timestamps."
    );
  }),
);

export const FOUNDRY_APPROVED_CONTRACT_PACKET_MAX_BYTES = 256 * 1_024;

export const FoundryFounderIdentity = Schema.Struct({
  id: Identifier,
  publicKey: Hex64,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryFounderIdentity = typeof FoundryFounderIdentity.Type;

export const FoundryFounderRegistry = Schema.Tuple([FoundryFounderIdentity, FoundryFounderIdentity])
  .check(
    Schema.makeFilter(([first, second]) => {
      const issues: Array<Schema.FilterIssue> = [];
      if (first.id >= second.id) {
        issues.push("Founder IDs must be distinct and ordered lexicographically.");
      }
      if (first.publicKey === second.publicKey) {
        issues.push("Founder public keys must be distinct.");
      }
      return issues;
    }),
  )
  .annotate({ parseOptions: strictDecodeOptions });
export type FoundryFounderRegistry = typeof FoundryFounderRegistry.Type;

export const FoundryRuntimeMode = Schema.Literal("approval-required");
export type FoundryRuntimeMode = typeof FoundryRuntimeMode.Type;

export const FoundryFeatureContractBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectId: Identifier,
  featureId: FeatureId,
  version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  title: ShortText,
  objective: LongText,
  inScope: ContractList,
  outOfScope: ContractList,
  constraints: ContractList,
  acceptanceCriteria: ContractList,
  verificationCommands: ContractList,
  repository: Schema.Struct({
    remoteId: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(512),
      Schema.isTrimmed(),
    ),
    baseBranch: ShortText,
    baseSha: GitObjectId,
  }),
  execution: Schema.Struct({
    environmentId: Identifier,
    provider: ShortText,
    model: ShortText,
    runtimeMode: FoundryRuntimeMode,
    limits: Schema.Struct({
      maximumTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
      maximumRetries: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    }),
  }),
  riskFlags: Schema.Array(ShortText).check(Schema.isMaxLength(50)),
});
export type FoundryFeatureContractBody = typeof FoundryFeatureContractBody.Type;

export const FoundrySignedEventFormat = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9./-]*[a-z0-9])?$/),
);
export type FoundrySignedEventFormat = typeof FoundrySignedEventFormat.Type;

export const FoundryApprovalProof = Schema.Struct({
  format: FoundrySignedEventFormat,
  encodedEvent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
});
export type FoundryApprovalProof = typeof FoundryApprovalProof.Type;

export const FoundryApprovalPacket = Schema.Struct({
  founderId: Identifier,
  proof: FoundryApprovalProof,
});
export type FoundryApprovalPacket = typeof FoundryApprovalPacket.Type;

export const FoundryApprovedContractPacket = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  body: FoundryFeatureContractBody,
  approvals: Schema.Tuple([FoundryApprovalPacket, FoundryApprovalPacket]),
})
  .check(
    Schema.makeFilter((packet) => {
      // Struct decoding normalizes property order before this UTF-8 size check.
      const byteLength = new TextEncoder().encode(JSON.stringify(packet)).byteLength;
      return (
        byteLength <= FOUNDRY_APPROVED_CONTRACT_PACKET_MAX_BYTES ||
        `Approved contract packet exceeds ${FOUNDRY_APPROVED_CONTRACT_PACKET_MAX_BYTES} bytes.`
      );
    }),
  )
  .annotate({ parseOptions: strictDecodeOptions });
export type FoundryApprovedContractPacket = typeof FoundryApprovedContractPacket.Type;

const NostrTagValue = Schema.String.check(Schema.isMaxLength(2_048));
const NostrTag = Schema.Array(NostrTagValue).check(Schema.isMinLength(1), Schema.isMaxLength(16));

export const FoundryBuzzRelayUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        ((url.protocol === "ws:" || url.protocol === "wss:") &&
          url.username.length === 0 &&
          url.password.length === 0 &&
          url.search.length === 0 &&
          url.hash.length === 0 &&
          !value.includes("?") &&
          !value.includes("#") &&
          url.toString() === value) ||
        "Buzz relay URL must be a canonical ws:// or wss:// URL without credentials, query, or fragment."
      );
    } catch {
      return "Buzz relay URL must be a valid canonical URL.";
    }
  }),
);
export type FoundryBuzzRelayUrl = typeof FoundryBuzzRelayUrl.Type;

export const FoundryStoredApprovalEvidence = Schema.Struct({
  founderId: Identifier,
  format: FoundrySignedEventFormat,
  eventId: Hex64,
  createdAtEpochSeconds: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type FoundryStoredApprovalEvidence = typeof FoundryStoredApprovalEvidence.Type;

export const FoundryApprovedContractRecord = Schema.Struct({
  contractHash: Hex64,
  projectId: Identifier,
  featureId: FeatureId,
  version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  founderRegistryHash: Hex64,
  approvalSubject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  dispatchIdempotencyKey: Hex64,
  acceptedAt: IsoDateTime,
  approvals: Schema.Tuple([FoundryStoredApprovalEvidence, FoundryStoredApprovalEvidence]),
});
export type FoundryApprovedContractRecord = typeof FoundryApprovedContractRecord.Type;

export const FoundryApprovedContractIngestResult = Schema.Struct({
  disposition: Schema.Literals(["stored", "replayed"]),
  record: FoundryApprovedContractRecord,
});
export type FoundryApprovedContractIngestResult = typeof FoundryApprovedContractIngestResult.Type;

export const FoundryApprovedContractIngestErrorCode = Schema.Literals([
  "not-configured",
  "invalid-packet",
  "policy-rejected",
  "conflict",
  "unavailable",
]);
export type FoundryApprovedContractIngestErrorCode =
  typeof FoundryApprovedContractIngestErrorCode.Type;

export class FoundryApprovedContractIngestError extends Schema.TaggedErrorClass<FoundryApprovedContractIngestError>()(
  "FoundryApprovedContractIngestError",
  {
    code: FoundryApprovedContractIngestErrorCode,
  },
) {
  override get message(): string {
    switch (this.code) {
      case "not-configured":
        return "Foundry approval ingestion is not configured.";
      case "invalid-packet":
        return "The approved contract packet is invalid.";
      case "policy-rejected":
        return "The approved contract packet was rejected by Foundry policy.";
      case "conflict":
        return "The approved contract conflicts with an existing Foundry record.";
      case "unavailable":
        return "Foundry approval ingestion is temporarily unavailable.";
    }
  }
}

export const FoundryDispatchState = Schema.Literals(["queued", "running", "succeeded", "failed"]);
export type FoundryDispatchState = typeof FoundryDispatchState.Type;

export const FoundryDispatchAttemptState = Schema.Literals([
  "running",
  "abandoned",
  "succeeded",
  "failed",
]);
export type FoundryDispatchAttemptState = typeof FoundryDispatchAttemptState.Type;

/** Coarse runner failures safe to expose to authenticated status clients. */
export const FoundryDispatchFailureCode = Schema.Literals([
  "approval-invalid",
  "environment-mismatch",
  "project-unavailable",
  "provider-unavailable",
  "model-unavailable",
  "base-revision-unavailable",
  "worktree-failed",
  "thread-failed",
  "turn-failed",
  "lease-lost",
  "internal",
]);
export type FoundryDispatchFailureCode = typeof FoundryDispatchFailureCode.Type;

const FoundryWorktreePlannedReport = Schema.Struct({
  kind: Schema.Literal("worktree-planned"),
  evidenceKey: FoundryDispatchEvidenceKey,
  branch: ShortText,
});
const FoundryWorktreeReadyReport = Schema.Struct({
  kind: Schema.Literal("worktree-ready"),
  evidenceKey: FoundryDispatchEvidenceKey,
  branch: ShortText,
});
const FoundryTurnPlannedReport = Schema.Struct({
  kind: Schema.Literal("turn-planned"),
  evidenceKey: FoundryDispatchEvidenceKey,
  threadId: ThreadId,
  commandId: CommandId,
  createdAt: FoundryDispatchTimestamp,
});
const FoundryTurnStartedReport = Schema.Struct({
  kind: Schema.Literal("turn-started"),
  evidenceKey: FoundryDispatchEvidenceKey,
  threadId: ThreadId,
  commandId: CommandId,
  turnId: TurnId,
});
const FoundryDispatchCheckpoint = Schema.Struct({
  status: Schema.Literal("ready"),
  checkpointRef: CheckpointRef,
});
const FoundryDispatchFailureCorrelation = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  turnId: Schema.NullOr(TurnId),
});
const FoundryDispatchSucceededReport = Schema.Struct({
  kind: Schema.Literal("succeeded"),
  evidenceKey: FoundryDispatchEvidenceKey,
  threadId: ThreadId,
  commandId: CommandId,
  turnId: TurnId,
  checkpoint: FoundryDispatchCheckpoint,
});
const FoundryDispatchFailedReport = Schema.Struct({
  kind: Schema.Literal("failed"),
  failureCode: FoundryDispatchFailureCode,
  correlation: Schema.NullOr(FoundryDispatchFailureCorrelation),
});

/**
 * The runner reports only deterministic resource identifiers and coarse
 * outcomes. Local paths, provider output, prompts, and raw diagnostics never
 * cross this status boundary.
 */
export const FoundryDispatchReport = Schema.Union([
  FoundryWorktreePlannedReport,
  FoundryWorktreeReadyReport,
  FoundryTurnPlannedReport,
  FoundryTurnStartedReport,
  FoundryDispatchSucceededReport,
  FoundryDispatchFailedReport,
]).annotate({ parseOptions: strictDecodeOptions });
export type FoundryDispatchReport = typeof FoundryDispatchReport.Type;

export const FoundryDispatchAttemptRecord = Schema.Struct({
  attemptNumber: FoundryDispatchAttemptNumber,
  fenceToken: FoundryDispatchFenceToken,
  state: FoundryDispatchAttemptState,
  claimedAt: FoundryDispatchTimestamp,
  lastHeartbeatAt: FoundryDispatchTimestamp,
  leaseExpiresAt: FoundryDispatchTimestamp,
  completedAt: Schema.NullOr(FoundryDispatchTimestamp),
  failureCode: Schema.NullOr(FoundryDispatchFailureCode),
})
  .check(
    Schema.makeFilter((attempt) => {
      if (attempt.state === "running") {
        return (
          (attempt.completedAt === null && attempt.failureCode === null) ||
          "A running Foundry attempt cannot have a completion or failure."
        );
      }
      if (attempt.state === "failed") {
        return (
          (attempt.completedAt !== null && attempt.failureCode !== null) ||
          "A failed Foundry attempt needs a completion and failure code."
        );
      }
      return (
        (attempt.completedAt !== null && attempt.failureCode === null) ||
        "A completed Foundry attempt cannot carry a failure code."
      );
    }),
  )
  .annotate({ parseOptions: strictDecodeOptions });
export type FoundryDispatchAttemptRecord = typeof FoundryDispatchAttemptRecord.Type;

export const FoundryDispatchEvidenceRecord = Schema.Struct({
  sequence: FoundryDispatchAttemptNumber,
  attemptNumber: FoundryDispatchAttemptNumber,
  fenceToken: FoundryDispatchFenceToken,
  reportId: FoundryDispatchReportId,
  recordedAt: FoundryDispatchTimestamp,
  report: FoundryDispatchReport,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryDispatchEvidenceRecord = typeof FoundryDispatchEvidenceRecord.Type;

export const FoundryDispatchStatus = Schema.Struct({
  dispatchId: FoundryDispatchId,
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  contractHash: Hex64,
  environmentId: Identifier,
  state: FoundryDispatchState,
  fenceToken: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  attemptCount: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  createdAt: FoundryDispatchTimestamp,
  updatedAt: FoundryDispatchTimestamp,
  completedAt: Schema.NullOr(FoundryDispatchTimestamp),
  attempts: Schema.Array(FoundryDispatchAttemptRecord).check(Schema.isMaxLength(101)),
  evidence: Schema.Array(FoundryDispatchEvidenceRecord).check(Schema.isMaxLength(1_024)),
})
  .check(
    Schema.makeFilter((dispatch) => {
      const terminal = dispatch.state === "succeeded" || dispatch.state === "failed";
      return (
        (terminal && dispatch.completedAt !== null) ||
        (!terminal && dispatch.completedAt === null) ||
        "Foundry dispatch completion must match its state."
      );
    }),
  )
  .annotate({ parseOptions: strictDecodeOptions });
export type FoundryDispatchStatus = typeof FoundryDispatchStatus.Type;

export const FoundryClaimDispatchInput = Schema.Struct({
  environmentId: Identifier,
  runnerId: FoundryRunnerId,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryClaimDispatchInput = typeof FoundryClaimDispatchInput.Type;

export const FoundryDispatchClaim = Schema.Struct({
  job: FoundryDispatchStatus,
  record: FoundryApprovedContractRecord,
  packet: FoundryApprovedContractPacket,
  attempt: FoundryDispatchAttemptRecord,
})
  .check(
    Schema.makeFilter((claim) => {
      return (
        (claim.job.state === "running" &&
          claim.attempt.state === "running" &&
          claim.record.dispatchIdempotencyKey === claim.job.dispatchIdempotencyKey &&
          claim.record.contractHash === claim.job.contractHash &&
          claim.packet.body.execution.environmentId === claim.job.environmentId &&
          claim.attempt.attemptNumber === claim.job.attemptCount &&
          claim.attempt.fenceToken === claim.job.fenceToken) ||
        "The Foundry dispatch claim contains inconsistent job, contract, or attempt records."
      );
    }),
  )
  .annotate({ parseOptions: strictDecodeOptions });
export type FoundryDispatchClaim = typeof FoundryDispatchClaim.Type;

export const FoundryClaimDispatchResult = Schema.Struct({
  claim: Schema.NullOr(FoundryDispatchClaim),
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryClaimDispatchResult = typeof FoundryClaimDispatchResult.Type;

const FoundryDispatchLeaseInputFields = {
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  runnerId: FoundryRunnerId,
  fenceToken: FoundryDispatchFenceToken,
} as const;

export const FoundryHeartbeatDispatchInput = Schema.Struct({
  ...FoundryDispatchLeaseInputFields,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryHeartbeatDispatchInput = typeof FoundryHeartbeatDispatchInput.Type;

export const FoundryHeartbeatDispatchResult = Schema.Struct({
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
  fenceToken: FoundryDispatchFenceToken,
  leaseExpiresAt: FoundryDispatchTimestamp,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryHeartbeatDispatchResult = typeof FoundryHeartbeatDispatchResult.Type;

export const FoundryReportDispatchInput = Schema.Struct({
  ...FoundryDispatchLeaseInputFields,
  reportId: FoundryDispatchReportId,
  report: FoundryDispatchReport,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryReportDispatchInput = typeof FoundryReportDispatchInput.Type;

export const FoundryReportDispatchResult = Schema.Struct({
  disposition: Schema.Literals(["recorded", "replayed"]),
  job: FoundryDispatchStatus,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryReportDispatchResult = typeof FoundryReportDispatchResult.Type;

export const FoundryGetDispatchInput = Schema.Struct({
  dispatchIdempotencyKey: FoundryDispatchIdempotencyKey,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryGetDispatchInput = typeof FoundryGetDispatchInput.Type;

export const FoundryGetDispatchResult = Schema.Struct({
  job: FoundryDispatchStatus,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryGetDispatchResult = typeof FoundryGetDispatchResult.Type;

export const FoundryDispatchRpcErrorCode = Schema.Literals([
  "not-configured",
  "not-found",
  "lease-lost",
  "invalid-transition",
  "conflict",
  "unavailable",
]);
export type FoundryDispatchRpcErrorCode = typeof FoundryDispatchRpcErrorCode.Type;

export class FoundryDispatchRpcError extends Schema.TaggedErrorClass<FoundryDispatchRpcError>()(
  "FoundryDispatchRpcError",
  {
    code: FoundryDispatchRpcErrorCode,
  },
  { parseOptions: strictDecodeOptions },
) {
  override get message(): string {
    switch (this.code) {
      case "not-configured":
        return "Foundry dispatch is not configured.";
      case "not-found":
        return "The Foundry dispatch was not found.";
      case "lease-lost":
        return "The Foundry dispatch lease is no longer current.";
      case "invalid-transition":
        return "The Foundry dispatch cannot accept that state transition.";
      case "conflict":
        return "The Foundry dispatch report conflicts with an existing record.";
      case "unavailable":
        return "Foundry dispatch is temporarily unavailable.";
    }
  }
}

export const FoundryBuzzNostrEvent = Schema.Struct({
  id: Hex64,
  pubkey: Hex64,
  created_at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })),
  tags: Schema.Array(NostrTag).check(Schema.isMaxLength(128)),
  content: Schema.String.check(Schema.isMaxLength(65_536)),
  sig: Hex128,
});
export type FoundryBuzzNostrEvent = typeof FoundryBuzzNostrEvent.Type;

export const FoundryBuzzApprovalContent = Schema.Struct({
  type: Schema.Literal("foundry.contract.approval/v1"),
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  relayUrl: FoundryBuzzRelayUrl,
});
export type FoundryBuzzApprovalContent = typeof FoundryBuzzApprovalContent.Type;

const decodeFeatureContractBody = Schema.decodeUnknownSync(FoundryFeatureContractBody);
const decodeApprovedContractPacket = Schema.decodeUnknownSync(FoundryApprovedContractPacket);
const decodeBuzzNostrEvent = Schema.decodeUnknownSync(FoundryBuzzNostrEvent);
const decodeBuzzApprovalContent = Schema.decodeUnknownSync(FoundryBuzzApprovalContent);

export const decodeFoundryFeatureContractBody = (input: unknown): FoundryFeatureContractBody =>
  decodeFeatureContractBody(input, strictDecodeOptions);

export const decodeFoundryApprovedContractPacket = (
  input: unknown,
): FoundryApprovedContractPacket => decodeApprovedContractPacket(input, strictDecodeOptions);

export const decodeFoundryBuzzNostrEvent = (input: unknown): FoundryBuzzNostrEvent =>
  decodeBuzzNostrEvent(input, strictDecodeOptions);

export const decodeFoundryBuzzApprovalContent = (input: unknown): FoundryBuzzApprovalContent =>
  decodeBuzzApprovalContent(input, strictDecodeOptions);
