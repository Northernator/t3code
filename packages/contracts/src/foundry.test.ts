import { describe, expect, it } from "vite-plus/test";

import {
  decodeFoundryApprovedContractPacket,
  decodeFoundryBuzzNostrEvent,
  decodeFoundryFeatureContractBody,
  type FoundryApprovedContractPacket,
} from "./foundry.ts";

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
      content: '{"type":"foundry.contract.approval/v1","subject":"subject"}',
      sig: "2".repeat(128),
    };

    expect(decodeFoundryBuzzNostrEvent(event)).toEqual(event);
    expect(() => decodeFoundryBuzzNostrEvent({ ...event, verified: true })).toThrow();
  });
});
