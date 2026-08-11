import type { FoundryApprovalProof, FoundrySignedEventFormat } from "@t3tools/contracts";

import type { ApprovalProofVerifier, FounderIdentity } from "./Governance.ts";

export type SignedEventVerificationFailureReason =
  | "malformed-event"
  | "signer-mismatch"
  | "subject-mismatch"
  | "event-id-mismatch"
  | "invalid-signature";

export type SignedEventVerification =
  | {
      readonly ok: true;
      readonly eventId: string;
      readonly createdAtEpochSeconds: number;
    }
  | {
      readonly ok: false;
      readonly reason: SignedEventVerificationFailureReason;
    };

export interface SignedEventIdentityAdapter {
  readonly format: FoundrySignedEventFormat;
  readonly verify: (input: {
    readonly founder: FounderIdentity;
    readonly subject: string;
    readonly encodedEvent: string;
  }) => SignedEventVerification;
}

export interface VerifiedApprovalEvidence {
  readonly founderId: string;
  readonly format: FoundrySignedEventFormat;
  readonly eventId: string;
  readonly createdAtEpochSeconds: number;
}

export function identityAdapterFor(
  adapters: ReadonlyArray<SignedEventIdentityAdapter>,
  proof: FoundryApprovalProof,
): SignedEventIdentityAdapter | null {
  return adapters.find(({ format }) => format === proof.format) ?? null;
}

export function createApprovalProofVerifier(
  adapters: ReadonlyArray<SignedEventIdentityAdapter>,
): ApprovalProofVerifier {
  return {
    verify: ({ founder, subject, proof }) => {
      const adapter = identityAdapterFor(adapters, proof);
      return adapter?.verify({ founder, subject, encodedEvent: proof.encodedEvent }).ok === true;
    },
  };
}
