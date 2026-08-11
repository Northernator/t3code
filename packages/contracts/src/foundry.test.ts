import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  FOUNDRY_APPROVED_CONTRACT_PACKET_MAX_BYTES,
  FoundryApprovedContractIngestError,
  FoundryApprovedContractIngestResult,
  FoundryApprovedContractPacket,
  FoundryApprovedContractRecord,
  FoundryBuzzRelayUrl,
  FoundryFounderRegistry,
  decodeFoundryApprovedContractPacket,
  decodeFoundryBuzzApprovalContent,
  decodeFoundryBuzzNostrEvent,
  decodeFoundryFeatureContractBody,
} from "./foundry.ts";

const decodeApprovedContractPacketSchema = Schema.decodeUnknownSync(FoundryApprovedContractPacket);
const decodeBuzzRelayUrl = Schema.decodeUnknownSync(FoundryBuzzRelayUrl);
const decodeFounderRegistry = Schema.decodeUnknownSync(FoundryFounderRegistry);
const decodeApprovedContractRecord = Schema.decodeUnknownSync(FoundryApprovedContractRecord);
const decodeApprovedContractIngestResult = Schema.decodeUnknownSync(
  FoundryApprovedContractIngestResult,
);
const decodeApprovedContractIngestError = Schema.decodeUnknownSync(
  FoundryApprovedContractIngestError,
);

const body = {
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
} as const;

const proof = {
  format: "buzz-nostr-event/v1",
  encodedEvent: '  {"signed":true}',
} as const;

const packet = {
  protocolVersion: 1,
  body,
  approvals: [
    { founderId: "founder-alice", proof },
    { founderId: "founder-bob", proof: { ...proof, encodedEvent: '{"signed":true}' } },
  ],
} as const satisfies FoundryApprovedContractPacket;

describe("Foundry wire contracts", () => {
  it("strictly decodes an approved contract packet without rewriting signed event bytes", () => {
    const decoded = decodeFoundryApprovedContractPacket(packet);

    expect(decoded).toEqual(packet);
    expect(decoded.approvals[0].proof.encodedEvent).toBe('  {"signed":true}');
  });

  it("rejects unexpected top-level and nested fields", () => {
    expect(() => decodeFoundryApprovedContractPacket({ ...packet, trusted: true })).toThrow();
    expect(() =>
      decodeFoundryApprovedContractPacket({
        ...packet,
        body: { ...packet.body, repository: { ...packet.body.repository, ref: "main" } },
      }),
    ).toThrow();
    expect(() =>
      decodeFoundryApprovedContractPacket({
        ...packet,
        approvals: [
          { ...packet.approvals[0], proof: { ...proof, verified: true } },
          packet.approvals[1],
        ],
      }),
    ).toThrow();
  });

  it("carries strict excess-property parsing into ordinary and RPC-style decoding", () => {
    expect(() => decodeApprovedContractPacketSchema({ ...packet, trusted: true })).toThrow();
    expect(() =>
      decodeApprovedContractPacketSchema({
        ...packet,
        approvals: [
          packet.approvals[0],
          { ...packet.approvals[1], proof: { ...packet.approvals[1].proof, verified: true } },
        ],
      }),
    ).toThrow();
  });

  it("rejects malformed versions, Git object IDs, limits, and approval counts", () => {
    expect(() => decodeFoundryApprovedContractPacket({ ...packet, protocolVersion: 2 })).toThrow();
    expect(() =>
      decodeFoundryApprovedContractPacket({
        ...packet,
        body: { ...packet.body, repository: { ...packet.body.repository, baseSha: "main" } },
      }),
    ).toThrow();
    expect(() =>
      decodeFoundryApprovedContractPacket({
        ...packet,
        body: {
          ...packet.body,
          execution: {
            ...packet.body.execution,
            limits: { maximumTurns: 1_001, maximumRetries: 2 },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeFoundryApprovedContractPacket({ ...packet, approvals: [packet.approvals[0]] }),
    ).toThrow();
  });

  it("rejects oversized contract fields and encoded events", () => {
    expect(() =>
      decodeFoundryFeatureContractBody({ ...body, objective: "x".repeat(8_193) }),
    ).toThrow();
    expect(() =>
      decodeFoundryApprovedContractPacket({
        ...packet,
        approvals: [
          {
            ...packet.approvals[0],
            proof: { ...proof, encodedEvent: "x".repeat(65_537) },
          },
          packet.approvals[1],
        ],
      }),
    ).toThrow();
  });

  it("limits the canonical decoded packet to 256 KiB", () => {
    expect(FOUNDRY_APPROVED_CONTRACT_PACKET_MAX_BYTES).toBe(256 * 1_024);
    expect(() =>
      decodeApprovedContractPacketSchema({
        ...packet,
        body: {
          ...packet.body,
          constraints: Array.from({ length: 40 }, () => "x".repeat(8_192)),
        },
      }),
    ).toThrow();
  });

  it("requires a distinct, canonically ordered two-founder registry", () => {
    const alice = { id: "founder-alice", publicKey: "a".repeat(64) };
    const bob = { id: "founder-bob", publicKey: "b".repeat(64) };

    expect(decodeFounderRegistry([alice, bob])).toEqual([alice, bob]);
    expect(() => decodeFounderRegistry([bob, alice])).toThrow();
    expect(() => decodeFounderRegistry([alice, { ...bob, id: alice.id }])).toThrow();
    expect(() => decodeFounderRegistry([alice, { ...bob, publicKey: alice.publicKey }])).toThrow();
    expect(() => decodeFounderRegistry([alice, { ...bob, publicKey: "B".repeat(64) }])).toThrow();
    expect(() => decodeFounderRegistry([{ ...alice, role: "owner" }, bob])).toThrow();
  });

  it("accepts only canonical credential-free Buzz WebSocket relay URLs", () => {
    expect(decodeBuzzRelayUrl("wss://buzz.example/")).toBe("wss://buzz.example/");
    expect(decodeBuzzRelayUrl("ws://127.0.0.1:3000/nostr")).toBe("ws://127.0.0.1:3000/nostr");

    for (const relayUrl of [
      "https://buzz.example/",
      "wss://founder:secret@buzz.example/",
      "wss://buzz.example/?token=secret",
      "wss://buzz.example/?",
      "wss://buzz.example/#workspace",
      "wss://buzz.example/#",
      "WSS://BUZZ.EXAMPLE",
      "wss://buzz.example",
    ]) {
      expect(() => decodeBuzzRelayUrl(relayUrl)).toThrow();
    }
  });

  it("requires the signed approval content to carry a canonical relay URL", () => {
    const content = {
      type: "foundry.contract.approval/v1",
      subject: "foundry.contract.approve/v1\nhotpaste\nclipboard-history",
      relayUrl: "wss://buzz.example/",
    } as const;

    expect(decodeFoundryBuzzApprovalContent(content)).toEqual(content);
    expect(() =>
      decodeFoundryBuzzApprovalContent({
        type: content.type,
        subject: content.subject,
      }),
    ).toThrow();
    expect(() =>
      decodeFoundryBuzzApprovalContent({ ...content, relayUrl: "https://buzz.example/" }),
    ).toThrow();
  });

  it("decodes stored approval records, ingest results, and coarse errors", () => {
    const approvals = [
      {
        founderId: "founder-alice",
        format: "buzz-nostr-event/v1",
        eventId: "1".repeat(64),
        createdAtEpochSeconds: 1_786_377_600,
      },
      {
        founderId: "founder-bob",
        format: "buzz-nostr-event/v1",
        eventId: "2".repeat(64),
        createdAtEpochSeconds: 1_786_377_601,
      },
    ] as const;
    const record = {
      contractHash: "3".repeat(64),
      projectId: "hotpaste",
      featureId: "clipboard-history",
      version: 1,
      founderRegistryHash: "4".repeat(64),
      approvalSubject: "foundry.contract.approve/v1\nhotpaste\nclipboard-history",
      dispatchIdempotencyKey: "5".repeat(64),
      acceptedAt: "2026-08-11T12:00:00.000Z",
      approvals,
    } as const;
    const result = { disposition: "stored", record } as const;

    expect(decodeApprovedContractRecord(record)).toEqual(record);
    expect(decodeApprovedContractIngestResult(result)).toEqual(result);

    const error = decodeApprovedContractIngestError({
      _tag: "FoundryApprovedContractIngestError",
      code: "policy-rejected",
    });
    expect(error.code).toBe("policy-rejected");
    expect(error.message).toBe("The approved contract packet was rejected by Foundry policy.");
    expect(() =>
      decodeApprovedContractIngestError({
        _tag: "FoundryApprovedContractIngestError",
        code: "invalid-signature",
      }),
    ).toThrow();
  });

  it("strictly decodes the complete Nostr event shape", () => {
    const event = {
      id: "0".repeat(64),
      pubkey: "1".repeat(64),
      created_at: 1_786_377_600,
      kind: 9,
      tags: [
        ["h", "foundry-hotpaste"],
        ["t", "foundry.contract.approval/v1"],
      ],
      content:
        '{"type":"foundry.contract.approval/v1","subject":"subject","relayUrl":"wss://buzz.example/"}',
      sig: "2".repeat(128),
    };

    expect(decodeFoundryBuzzNostrEvent(event)).toEqual(event);
    expect(() => decodeFoundryBuzzNostrEvent({ ...event, verified: true })).toThrow();
  });
});
