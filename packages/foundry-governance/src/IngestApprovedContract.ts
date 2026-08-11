import {
  decodeFoundryApprovedContractPacket,
  type FoundryApprovedContractPacket,
} from "@t3tools/contracts";

import {
  approveFeatureContract,
  proposeFeatureContract,
  verifyApprovedFeatureProposal,
  type FounderIdentity,
  type VerifiedFeatureProposal,
} from "./Governance.ts";
import {
  createApprovalProofVerifier,
  identityAdapterFor,
  type SignedEventIdentityAdapter,
  type SignedEventVerificationFailureReason,
  type VerifiedApprovalEvidence,
} from "./SignedEventIdentity.ts";

export type FoundryPacketIngestionErrorCode =
  | "invalid-packet"
  | "unknown-founder"
  | "unsupported-proof-format"
  | "approval-proof-rejected";

export class FoundryPacketIngestionError extends Error {
  override readonly name = "FoundryPacketIngestionError";
  readonly code: FoundryPacketIngestionErrorCode;
  readonly reason: SignedEventVerificationFailureReason | undefined;

  constructor(
    code: FoundryPacketIngestionErrorCode,
    message: string,
    reason?: SignedEventVerificationFailureReason,
  ) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

function decodePacket(input: unknown): FoundryApprovedContractPacket {
  try {
    return decodeFoundryApprovedContractPacket(input);
  } catch {
    throw new FoundryPacketIngestionError(
      "invalid-packet",
      "The approved contract packet does not match the strict wire schema.",
    );
  }
}

export function ingestApprovedContractPacket(input: {
  readonly packet: unknown;
  readonly founders: ReadonlyArray<FounderIdentity>;
  readonly identityAdapters: ReadonlyArray<SignedEventIdentityAdapter>;
}): {
  readonly proposal: VerifiedFeatureProposal;
  readonly evidence: ReadonlyArray<VerifiedApprovalEvidence>;
} {
  const packet = decodePacket(input.packet);
  const initialProposal = proposeFeatureContract({ body: packet.body, founders: input.founders });
  const verifier = createApprovalProofVerifier(input.identityAdapters);
  const evidence: Array<VerifiedApprovalEvidence> = [];

  const approvedProposal = packet.approvals.reduce((proposal, approval) => {
    const founder = input.founders.find(({ id }) => id === approval.founderId);
    if (!founder) {
      throw new FoundryPacketIngestionError(
        "unknown-founder",
        "The packet contains an approval from an unregistered founder.",
      );
    }
    const adapter = identityAdapterFor(input.identityAdapters, approval.proof);
    if (!adapter) {
      throw new FoundryPacketIngestionError(
        "unsupported-proof-format",
        `No identity adapter is registered for '${approval.proof.format}'.`,
      );
    }
    const verification = adapter.verify({
      founder,
      subject: initialProposal.approvalSubject,
      encodedEvent: approval.proof.encodedEvent,
    });
    if (!verification.ok) {
      throw new FoundryPacketIngestionError(
        "approval-proof-rejected",
        `The approval proof for '${approval.founderId}' was rejected.`,
        verification.reason,
      );
    }
    evidence.push(
      Object.freeze({
        founderId: approval.founderId,
        format: approval.proof.format,
        eventId: verification.eventId,
        createdAtEpochSeconds: verification.createdAtEpochSeconds,
      }),
    );

    return approveFeatureContract({
      proposal,
      approval: {
        founderId: approval.founderId,
        contentHash: initialProposal.contentHash,
        proof: approval.proof,
      },
      founders: input.founders,
      verifier,
    });
  }, initialProposal);

  return Object.freeze({
    proposal: verifyApprovedFeatureProposal({
      proposal: approvedProposal,
      founders: input.founders,
      verifier,
    }),
    evidence: Object.freeze(evidence),
  });
}
