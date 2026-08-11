import {
  FoundryApprovedContractIngestError,
  type FoundryApprovedContractIngestResult,
  type FoundryApprovedContractPacket,
  type FoundryApprovedContractRecord,
  type FoundryApprovalPacket,
  type FoundryStoredApprovalEvidence,
} from "@t3tools/contracts";
import {
  canonicalizeJson,
  FoundryGovernanceError,
  FoundryPacketIngestionError,
  ingestApprovedContractPacket,
  makeBuzzNostrIdentityAdapter,
  queueFeatureDispatch,
  sha256,
  type FounderApproval,
  type VerifiedApprovalEvidence,
} from "@t3tools/foundry-governance";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  FoundryApprovedContractStore,
  type FoundryApprovalStorageInput,
  type StoreVerifiedFoundryApprovedContractInput,
} from "../persistence/Services/FoundryApprovedContractStore.ts";
import { FoundryConfig, type FoundryConfiguredRuntime } from "./FoundryConfig.ts";

const packetDigestFor = (packetJson: string) =>
  sha256(["foundry.approved-contract-packet/v1", packetJson].join("\n"));

function wireError(
  code: ConstructorParameters<typeof FoundryApprovedContractIngestError>[0]["code"],
) {
  return new FoundryApprovedContractIngestError({ code });
}

function mapGovernanceError(error: unknown): FoundryApprovedContractIngestError {
  if (error instanceof FoundryPacketIngestionError) {
    return wireError(error.code === "invalid-packet" ? "invalid-packet" : "policy-rejected");
  }
  if (error instanceof FoundryGovernanceError) {
    return wireError("policy-rejected");
  }
  return wireError("unavailable");
}

function approvalForFounder(
  approvals: ReadonlyArray<FounderApproval>,
  founderId: string,
): FounderApproval {
  const approval = approvals.find((candidate) => candidate.founderId === founderId);
  if (!approval) {
    throw new Error("Verified approval set does not match the configured founder registry.");
  }
  return approval;
}

function evidenceForFounder(
  evidence: ReadonlyArray<VerifiedApprovalEvidence>,
  founderId: string,
): VerifiedApprovalEvidence {
  const entry = evidence.find((candidate) => candidate.founderId === founderId);
  if (!entry) {
    throw new Error("Verified evidence does not match the configured founder registry.");
  }
  return entry;
}

function packetApproval(approval: FounderApproval): FoundryApprovalPacket {
  return {
    founderId: approval.founderId,
    proof: approval.proof,
  };
}

function storedEvidence(evidence: VerifiedApprovalEvidence): FoundryStoredApprovalEvidence {
  return {
    founderId: evidence.founderId,
    format: evidence.format,
    eventId: evidence.eventId,
    createdAtEpochSeconds: evidence.createdAtEpochSeconds,
  };
}

function storageApproval(
  evidence: VerifiedApprovalEvidence,
  approval: FounderApproval,
): FoundryApprovalStorageInput {
  return {
    ...storedEvidence(evidence),
    encodedEvent: approval.proof.encodedEvent,
  };
}

function prepareVerifiedContract(input: {
  readonly packet: unknown;
  readonly config: FoundryConfiguredRuntime;
}): Omit<StoreVerifiedFoundryApprovedContractInput, "record"> & {
  readonly record: Omit<FoundryApprovedContractRecord, "acceptedAt">;
} {
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

  if (proposal.body.execution.environmentId !== input.config.environmentId) {
    throw new FoundryGovernanceError(
      "environment-mismatch",
      "The approved contract targets another environment.",
    );
  }

  const dispatch = queueFeatureDispatch({
    proposal,
    environmentId: input.config.environmentId,
  });
  const firstApproval = approvalForFounder(proposal.approvals, input.config.founders[0].id);
  const secondApproval = approvalForFounder(proposal.approvals, input.config.founders[1].id);
  const firstEvidence = evidenceForFounder(verified.evidence, input.config.founders[0].id);
  const secondEvidence = evidenceForFounder(verified.evidence, input.config.founders[1].id);
  const normalizedApprovals = [
    packetApproval(firstApproval),
    packetApproval(secondApproval),
  ] as const;
  const normalizedPacket: FoundryApprovedContractPacket = {
    protocolVersion: 1,
    body: proposal.body,
    approvals: normalizedApprovals,
  };
  const packetJson = canonicalizeJson(normalizedPacket);
  const record: Omit<FoundryApprovedContractRecord, "acceptedAt"> = {
    contractHash: proposal.contentHash,
    projectId: proposal.body.projectId,
    featureId: proposal.body.featureId,
    version: proposal.body.version,
    founderRegistryHash: proposal.founderRegistryHash,
    approvalSubject: proposal.approvalSubject,
    dispatchIdempotencyKey: dispatch.idempotencyKey,
    approvals: [storedEvidence(firstEvidence), storedEvidence(secondEvidence)],
  };

  return {
    record,
    canonicalBodyJson: proposal.canonicalBody,
    packetJson,
    packetDigest: packetDigestFor(packetJson),
    approvals: [
      storageApproval(firstEvidence, firstApproval),
      storageApproval(secondEvidence, secondApproval),
    ],
  };
}

export interface FoundryApprovedContractIngestionShape {
  readonly ingest: (
    packet: unknown,
  ) => Effect.Effect<FoundryApprovedContractIngestResult, FoundryApprovedContractIngestError>;
}

export class FoundryApprovedContractIngestion extends Context.Service<
  FoundryApprovedContractIngestion,
  FoundryApprovedContractIngestionShape
>()("t3/foundry/FoundryApprovedContractIngestion") {}

const makeFoundryApprovedContractIngestion = Effect.gen(function* () {
  const config = yield* FoundryConfig;
  const store = yield* FoundryApprovedContractStore;

  const ingest: FoundryApprovedContractIngestionShape["ingest"] = Effect.fn(
    "FoundryApprovedContractIngestion.ingest",
  )(function* (packet) {
    if (!config.configured) {
      return yield* wireError("not-configured");
    }

    const prepared = yield* Effect.try({
      try: () => prepareVerifiedContract({ packet, config }),
      catch: mapGovernanceError,
    });
    const acceptedAt = DateTime.formatIso(yield* DateTime.now);

    return yield* store
      .storeVerified({
        ...prepared,
        record: { ...prepared.record, acceptedAt },
      })
      .pipe(
        Effect.mapError((error) =>
          wireError(
            error._tag === "FoundryApprovedContractConflictError" ? "conflict" : "unavailable",
          ),
        ),
      );
  });

  return FoundryApprovedContractIngestion.of({ ingest });
});

export const FoundryApprovedContractIngestionLive = Layer.effect(
  FoundryApprovedContractIngestion,
  makeFoundryApprovedContractIngestion,
);
