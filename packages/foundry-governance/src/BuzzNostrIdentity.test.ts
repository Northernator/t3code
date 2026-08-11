import { schnorr } from "@noble/curves/secp256k1";
import type { FoundryApprovedContractPacket, FoundryBuzzNostrEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BuzzNostrIdentityAdapter,
  computeBuzzNostrEventId,
  FOUNDRY_BUZZ_APPROVAL_EVENT_KIND,
  FOUNDRY_BUZZ_APPROVAL_TAG,
  FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT,
} from "./BuzzNostrIdentity.ts";
import {
  type FeatureContractBody,
  type FounderIdentity,
  FoundryGovernanceError,
  proposeFeatureContract,
  queueFeatureDispatch,
  type VerifiedFeatureProposal,
} from "./Governance.ts";
import {
  FoundryPacketIngestionError,
  ingestApprovedContractPacket,
} from "./IngestApprovedContract.ts";

const ALICE_PRIVATE_KEY = `${"00".repeat(31)}01`;
const BOB_PRIVATE_KEY = `${"00".repeat(31)}02`;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const founders = [
  { id: "founder-alice", publicKey: toHex(schnorr.getPublicKey(ALICE_PRIVATE_KEY)) },
  { id: "founder-bob", publicKey: toHex(schnorr.getPublicKey(BOB_PRIVATE_KEY)) },
] as const satisfies ReadonlyArray<FounderIdentity>;

const body: FeatureContractBody = {
  schemaVersion: 1,
  projectId: "hotpaste",
  featureId: "clipboard-history",
  version: 1,
  title: "Clipboard history",
  objective: "Let the user reopen a recently copied item.",
  inScope: ["Store ten recent text items"],
  outOfScope: ["Cloud synchronization"],
  constraints: ["Never persist secret fields"],
  acceptanceCriteria: ["A copied item can be selected again"],
  verificationCommands: ["vp test run clipboard-history.test.ts"],
  repository: {
    remoteId: "midlow/hotpaste",
    baseBranch: "main",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
  },
  execution: {
    environmentId: "founder-alice-laptop",
    provider: "codex",
    model: "gpt-5.6-sol-ultra",
    runtimeMode: "approval-required",
    limits: { maximumTurns: 20, maximumRetries: 2 },
  },
  riskFlags: ["clipboard-data"],
};

function signedApprovalEvent(input: {
  readonly privateKey: string;
  readonly subject: string;
  readonly createdAt: number;
}): FoundryBuzzNostrEvent {
  const eventBody = {
    pubkey: toHex(schnorr.getPublicKey(input.privateKey)),
    created_at: input.createdAt,
    kind: FOUNDRY_BUZZ_APPROVAL_EVENT_KIND,
    tags: [
      ["h", "foundry-hotpaste"],
      ["t", FOUNDRY_BUZZ_APPROVAL_TAG],
    ],
    content: JSON.stringify({
      type: "foundry.contract.approval/v1",
      subject: input.subject,
    }),
  } as const;
  const id = computeBuzzNostrEventId(eventBody);
  return {
    ...eventBody,
    id,
    sig: toHex(schnorr.sign(id, input.privateKey, new Uint8Array(32))),
  };
}

function packetFor(input?: {
  readonly aliceSubject?: string;
  readonly bobSubject?: string;
}): FoundryApprovedContractPacket {
  const proposal = proposeFeatureContract({ body, founders });
  const aliceEvent = signedApprovalEvent({
    privateKey: ALICE_PRIVATE_KEY,
    subject: input?.aliceSubject ?? proposal.approvalSubject,
    createdAt: 1_786_377_600,
  });
  const bobEvent = signedApprovalEvent({
    privateKey: BOB_PRIVATE_KEY,
    subject: input?.bobSubject ?? proposal.approvalSubject,
    createdAt: 1_786_377_601,
  });
  return {
    protocolVersion: 1,
    body,
    approvals: [
      {
        founderId: founders[0].id,
        proof: {
          format: FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT,
          encodedEvent: JSON.stringify(aliceEvent),
        },
      },
      {
        founderId: founders[1].id,
        proof: {
          format: FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT,
          encodedEvent: JSON.stringify(bobEvent),
        },
      },
    ],
  };
}

function expectIngestionError(
  action: () => unknown,
  code: FoundryPacketIngestionError["code"],
  reason?: FoundryPacketIngestionError["reason"],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FoundryPacketIngestionError);
    expect((error as FoundryPacketIngestionError).code).toBe(code);
    if (reason !== undefined) {
      expect((error as FoundryPacketIngestionError).reason).toBe(reason);
    }
    return;
  }
  throw new Error(`Expected FoundryPacketIngestionError '${code}'.`);
}

function withEncodedEvent(
  packet: FoundryApprovedContractPacket,
  index: 0 | 1,
  update: (event: FoundryBuzzNostrEvent) => unknown,
): FoundryApprovedContractPacket {
  const approval = packet.approvals[index];
  const event = JSON.parse(approval.proof.encodedEvent) as FoundryBuzzNostrEvent;
  const approvals = [...packet.approvals] as [
    FoundryApprovedContractPacket["approvals"][0],
    FoundryApprovedContractPacket["approvals"][1],
  ];
  approvals[index] = {
    ...approval,
    proof: { ...approval.proof, encodedEvent: JSON.stringify(update(event)) },
  };
  return { ...packet, approvals };
}

describe("Buzz Nostr approval ingestion", () => {
  it("reconstructs and re-verifies two founder approvals", () => {
    const packet = packetFor();
    const first = ingestApprovedContractPacket({
      packet,
      founders,
      identityAdapters: [BuzzNostrIdentityAdapter],
    });
    const replay = ingestApprovedContractPacket({
      packet: JSON.parse(JSON.stringify(packet)),
      founders,
      identityAdapters: [BuzzNostrIdentityAdapter],
    });

    expect(first.proposal.state).toBe("approved");
    expect(first.evidence.map(({ founderId }) => founderId)).toEqual([
      "founder-alice",
      "founder-bob",
    ]);
    expect(first.evidence.map(({ createdAtEpochSeconds }) => createdAtEpochSeconds)).toEqual([
      1_786_377_600, 1_786_377_601,
    ]);
    expect(replay.proposal.contentHash).toBe(first.proposal.contentHash);
    expect(
      queueFeatureDispatch({
        proposal: replay.proposal,
        environmentId: body.execution.environmentId,
      }),
    ).toEqual(
      queueFeatureDispatch({
        proposal: first.proposal,
        environmentId: body.execution.environmentId,
      }),
    );

    expect(() =>
      queueFeatureDispatch({
        proposal: JSON.parse(JSON.stringify(first.proposal)) as VerifiedFeatureProposal,
        environmentId: body.execution.environmentId,
      }),
    ).toThrow(FoundryGovernanceError);
  });

  it("rejects a signed event from the wrong founder key", () => {
    const packet = packetFor();
    const wrongSigner = withEncodedEvent(packet, 0, () =>
      signedApprovalEvent({
        privateKey: BOB_PRIVATE_KEY,
        subject: proposeFeatureContract({ body, founders }).approvalSubject,
        createdAt: 1_786_377_600,
      }),
    );

    expectIngestionError(
      () =>
        ingestApprovedContractPacket({
          packet: wrongSigner,
          founders,
          identityAdapters: [BuzzNostrIdentityAdapter],
        }),
      "approval-proof-rejected",
      "signer-mismatch",
    );
  });

  it("rejects a correctly signed event for another contract subject", () => {
    expectIngestionError(
      () =>
        ingestApprovedContractPacket({
          packet: packetFor({ aliceSubject: "foundry.contract.approve/v1\nother" }),
          founders,
          identityAdapters: [BuzzNostrIdentityAdapter],
        }),
      "approval-proof-rejected",
      "subject-mismatch",
    );
  });

  it("rejects event-id, timestamp, signature, and event-shape tampering", () => {
    const packet = packetFor();
    const cases = [
      {
        packet: withEncodedEvent(packet, 0, (event) => ({
          ...event,
          created_at: event.created_at + 1,
        })),
        reason: "event-id-mismatch",
      },
      {
        packet: withEncodedEvent(packet, 0, (event) => ({
          ...event,
          sig: "0".repeat(128),
        })),
        reason: "invalid-signature",
      },
      {
        packet: withEncodedEvent(packet, 0, (event) => ({ ...event, trusted: true })),
        reason: "malformed-event",
      },
      {
        packet: withEncodedEvent(packet, 0, (event) => ({ ...event, kind: 1 })),
        reason: "malformed-event",
      },
    ] as const;

    for (const testCase of cases) {
      expectIngestionError(
        () =>
          ingestApprovedContractPacket({
            packet: testCase.packet,
            founders,
            identityAdapters: [BuzzNostrIdentityAdapter],
          }),
        "approval-proof-rejected",
        testCase.reason,
      );
    }
  });

  it("rejects unsupported proof formats after strict packet decoding", () => {
    const packet = packetFor();
    expectIngestionError(
      () =>
        ingestApprovedContractPacket({
          packet: {
            ...packet,
            approvals: [
              {
                ...packet.approvals[0],
                proof: { ...packet.approvals[0].proof, format: "future-proof/v2" },
              },
              packet.approvals[1],
            ],
          },
          founders,
          identityAdapters: [BuzzNostrIdentityAdapter],
        }),
      "unsupported-proof-format",
    );
  });

  it("rejects malformed packets before any identity adapter runs", () => {
    let verificationCalls = 0;
    expectIngestionError(
      () =>
        ingestApprovedContractPacket({
          packet: { ...packetFor(), trusted: true },
          founders,
          identityAdapters: [
            {
              ...BuzzNostrIdentityAdapter,
              verify: (input) => {
                verificationCalls += 1;
                return BuzzNostrIdentityAdapter.verify(input);
              },
            },
          ],
        }),
      "invalid-packet",
    );
    expect(verificationCalls).toBe(0);
  });

  it("does not let one founder satisfy both approval slots", () => {
    const packet = packetFor();
    expect(() =>
      ingestApprovedContractPacket({
        packet: {
          ...packet,
          approvals: [
            packet.approvals[0],
            { ...packet.approvals[0], proof: { ...packet.approvals[0].proof } },
          ],
        },
        founders,
        identityAdapters: [BuzzNostrIdentityAdapter],
      }),
    ).toThrow(FoundryGovernanceError);
  });
});
