import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  FOUNDRY_APPROVED_CONTRACT_PACKET_MAX_BYTES,
  FoundryApprovedContractIngestError,
  FoundryApprovedContractIngestResult,
  FoundryApprovedContractPacket,
  FoundryApprovedContractRecord,
  FoundryBuzzRelayUrl,
  FoundryClaimDispatchResult,
  FoundryDispatchAttemptRecord,
  FoundryDispatchReport,
  FoundryDispatchRpcError,
  FoundryDispatchStatus,
  FoundryFounderRegistry,
  FoundryGetDispatchInput,
  FoundryHeartbeatDispatchInput,
  FoundryReportDispatchInput,
  decodeFoundryApprovedContractPacket,
  decodeFoundryBuzzApprovalContent,
  decodeFoundryBuzzNostrEvent,
  decodeFoundryFeatureContractBody,
} from "./foundry.ts";
import { WS_METHODS } from "./rpc.ts";

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
const decodeDispatchAttempt = Schema.decodeUnknownSync(FoundryDispatchAttemptRecord);
const decodeDispatchReport = Schema.decodeUnknownSync(FoundryDispatchReport);
const decodeDispatchStatus = Schema.decodeUnknownSync(FoundryDispatchStatus);
const decodeClaimDispatchResult = Schema.decodeUnknownSync(FoundryClaimDispatchResult);
const decodeHeartbeatDispatchInput = Schema.decodeUnknownSync(FoundryHeartbeatDispatchInput);
const decodeReportDispatchInput = Schema.decodeUnknownSync(FoundryReportDispatchInput);
const decodeGetDispatchInput = Schema.decodeUnknownSync(FoundryGetDispatchInput);
const decodeDispatchRpcError = Schema.decodeUnknownSync(FoundryDispatchRpcError);

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

const storedRecord = {
  contractHash: "3".repeat(64),
  projectId: "hotpaste",
  featureId: "clipboard-history",
  version: 1,
  founderRegistryHash: "4".repeat(64),
  approvalSubject: "foundry.contract.approve/v1\nhotpaste\nclipboard-history",
  dispatchIdempotencyKey: "5".repeat(64),
  acceptedAt: "2026-08-11T12:00:00.000Z",
  approvals: [
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
  ],
} as const;

const runningAttempt = {
  attemptNumber: 1,
  fenceToken: 1,
  state: "running",
  claimedAt: "2026-08-11T12:01:00.000Z",
  lastHeartbeatAt: "2026-08-11T12:01:00.000Z",
  leaseExpiresAt: "2026-08-11T12:02:00.000Z",
  completedAt: null,
  failureCode: null,
} as const;

const runningJob = {
  dispatchId: `dispatch_${"5".repeat(24)}`,
  dispatchIdempotencyKey: storedRecord.dispatchIdempotencyKey,
  contractHash: storedRecord.contractHash,
  environmentId: body.execution.environmentId,
  state: "running",
  fenceToken: 1,
  attemptCount: 1,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:01:00.000Z",
  completedAt: null,
  attempts: [runningAttempt],
  evidence: [],
} as const;

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
    const result = { disposition: "stored", record: storedRecord } as const;

    expect(decodeApprovedContractRecord(storedRecord)).toEqual(storedRecord);
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

  it("decodes a raw-packet dispatch claim and rejects inconsistent claim records", () => {
    const result = {
      claim: {
        job: runningJob,
        record: storedRecord,
        packet,
        attempt: runningAttempt,
      },
    } as const;

    expect(decodeClaimDispatchResult(result)).toEqual(result);
    expect(decodeClaimDispatchResult({ claim: null })).toEqual({ claim: null });
    expect(() =>
      decodeClaimDispatchResult({
        claim: {
          ...result.claim,
          job: { ...runningJob, fenceToken: 2 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeClaimDispatchResult({
        claim: { ...result.claim, leaseToken: "secret" },
      }),
    ).toThrow();
  });

  it("strictly fences heartbeat and report inputs by dispatch, runner, and token", () => {
    const lease = {
      dispatchIdempotencyKey: storedRecord.dispatchIdempotencyKey,
      runnerId: "foundry-runner-a",
      fenceToken: 1,
    } as const;
    const report = {
      ...lease,
      reportId: "6".repeat(64),
      report: {
        kind: "turn-planned",
        evidenceKey: "7".repeat(64),
        threadId: "foundry-thread-1",
        commandId: "foundry-command-1",
        createdAt: "2026-08-11T12:01:00.000Z",
      },
    } as const;

    expect(decodeHeartbeatDispatchInput(lease)).toEqual(lease);
    expect(decodeReportDispatchInput(report)).toEqual(report);
    expect(
      decodeGetDispatchInput({ dispatchIdempotencyKey: storedRecord.dispatchIdempotencyKey }),
    ).toEqual({ dispatchIdempotencyKey: storedRecord.dispatchIdempotencyKey });
    expect(() => decodeHeartbeatDispatchInput({ ...lease, fenceToken: 0 })).toThrow();
    expect(() => decodeHeartbeatDispatchInput({ ...lease, leaseToken: "secret" })).toThrow();
    expect(() =>
      decodeReportDispatchInput({
        ...report,
        report: { ...report.report, createdAt: "2026-08-11 12:01:00" },
      }),
    ).toThrow();
  });

  it("records bounded execution correlations without paths or raw diagnostics", () => {
    const succeeded = {
      kind: "succeeded",
      evidenceKey: "8".repeat(64),
      threadId: "foundry-thread-1",
      commandId: "foundry-command-1",
      turnId: "turn-1",
      checkpoint: {
        status: "ready",
        checkpointRef: "refs/t3/checkpoints/foundry-thread-1/turn/1",
      },
    } as const;
    const failed = {
      kind: "failed",
      failureCode: "turn-failed",
      correlation: {
        threadId: "foundry-thread-1",
        commandId: "foundry-command-1",
        turnId: "turn-1",
      },
    } as const;

    expect(decodeDispatchReport(succeeded)).toEqual(succeeded);
    expect(decodeDispatchReport(failed)).toEqual(failed);
    expect(() => decodeDispatchReport({ ...succeeded, worktreePath: "C:\\secret" })).toThrow();
    expect(() => decodeDispatchReport({ ...failed, diagnostics: "provider stderr" })).toThrow();
    expect(() =>
      decodeDispatchReport({
        ...succeeded,
        checkpoint: { status: "missing" },
      }),
    ).toThrow();
  });

  it("enforces coherent job and attempt terminal states", () => {
    expect(decodeDispatchAttempt(runningAttempt)).toEqual(runningAttempt);
    expect(decodeDispatchStatus(runningJob)).toEqual(runningJob);
    expect(() =>
      decodeDispatchAttempt({
        ...runningAttempt,
        state: "failed",
        completedAt: "2026-08-11T12:03:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeDispatchStatus({
        ...runningJob,
        state: "succeeded",
      }),
    ).toThrow();
  });

  it("publishes the four Foundry dispatch RPC method names and coarse RPC errors", () => {
    expect(WS_METHODS.foundryClaimDispatch).toBe("foundry.claimDispatch");
    expect(WS_METHODS.foundryHeartbeatDispatch).toBe("foundry.heartbeatDispatch");
    expect(WS_METHODS.foundryReportDispatch).toBe("foundry.reportDispatch");
    expect(WS_METHODS.foundryGetDispatch).toBe("foundry.getDispatch");

    const error = decodeDispatchRpcError({
      _tag: "FoundryDispatchRpcError",
      code: "lease-lost",
    });
    expect(error.message).toBe("The Foundry dispatch lease is no longer current.");
    expect(() =>
      decodeDispatchRpcError({
        _tag: "FoundryDispatchRpcError",
        code: "lease-lost",
        diagnostics: "runner id and local path",
      }),
    ).toThrow();
  });
});
