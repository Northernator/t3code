import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CommandId,
  FoundryDispatchReport,
  ThreadId,
  TurnId,
  type FoundryApprovedContractPacket,
  type FoundryApprovedContractRecord,
  type FoundryBuzzNostrEvent,
  type FoundryFeatureContractBody,
} from "@t3tools/contracts";
import {
  ingestApprovedContractPacket,
  makeBuzzNostrIdentityAdapter,
  queueFeatureDispatch,
} from "@t3tools/foundry-governance";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  FoundryApprovedContractStore,
  type FoundryApprovedContractStoreShape,
} from "../persistence/Services/FoundryApprovedContractStore.ts";
import {
  FoundryDispatchEvidenceConflictError,
  FoundryDispatchLeaseError,
  FoundryDispatchStore,
  type FoundryDispatchClaim as StoredFoundryDispatchClaim,
  type FoundryDispatchStatus as StoredFoundryDispatchStatus,
  type FoundryDispatchStoreShape,
} from "../persistence/Services/FoundryDispatchStore.ts";
import {
  FOUNDRY_DISPATCH_LEASE_MILLISECONDS,
  FoundryDispatch,
  FoundryDispatchLive,
} from "./FoundryDispatch.ts";
import { foundryConfigLayer, type FoundryConfigState } from "./FoundryConfig.ts";

const ALICE_PUBLIC_KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const BOB_PUBLIC_KEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const BUZZ_RELAY_URL = "wss://buzz.example/";
const CONTRACT_HASH = "1d5ff27e3ade2a6b249dd396c83af954182a7f6c71852fdf1196d9396bf8fca8";
const FOUNDER_REGISTRY_HASH = "673468a875ce32d4abc10d2a51d6746bcecd90cfda482d428cdb4987d318c0da";
const ACCEPTED_AT = "2026-08-11T12:00:00.000Z";
const CLAIMED_AT = "2026-08-11T12:01:00.000Z";
const LEASE_EXPIRES_AT = "2026-08-11T12:02:00.000Z";
const RUNNER_SESSION_ID = "5".repeat(64);
const decodeDispatchReportJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(FoundryDispatchReport),
);
const APPROVAL_SUBJECT = [
  "foundry.contract.approve/v1",
  "hotpaste",
  "clipboard-history",
  "1",
  CONTRACT_HASH,
  FOUNDER_REGISTRY_HASH,
].join("\n");

const founders = [
  { id: "founder-alice", publicKey: ALICE_PUBLIC_KEY },
  { id: "founder-bob", publicKey: BOB_PUBLIC_KEY },
] as const;

const body: FoundryFeatureContractBody = {
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

const approvalContent = JSON.stringify({
  type: "foundry.contract.approval/v1",
  subject: APPROVAL_SUBJECT,
  relayUrl: BUZZ_RELAY_URL,
});

const aliceEvent: FoundryBuzzNostrEvent = {
  pubkey: ALICE_PUBLIC_KEY,
  created_at: 1_786_377_600,
  kind: 9,
  tags: [
    ["h", "foundry-hotpaste"],
    ["t", "foundry.contract.approval/v1"],
  ],
  content: approvalContent,
  id: "b7efe8986c6e0b9fac0e565584a355490e1ca98a94fdb1c8a3e64b60c2640d8f",
  sig: "60cfaf3d1130d31fe8a7da04155956235423451358b992e7b9168831468cba63a23e2f18a3832b37253571d4ea886d7ad2588109c54ed681b56ee62c1c0de2ba",
};

const bobEvent: FoundryBuzzNostrEvent = {
  pubkey: BOB_PUBLIC_KEY,
  created_at: 1_786_377_601,
  kind: 9,
  tags: [
    ["h", "foundry-hotpaste"],
    ["t", "foundry.contract.approval/v1"],
  ],
  content: approvalContent,
  id: "8cd8833746ec0d6fc6b092d09dc42e2c8720c71c6a8ccbf8dc34ac8ded5b7555",
  sig: "414be8149785c3f4db88aa2aee0a949071323960d63f29ab136a2b2ce7015043c6f78b00fc681f9252c78baf45f60a776532356a90547a985d14cf1125e657bd",
};

function approval(founderId: string, event: FoundryBuzzNostrEvent) {
  return {
    founderId,
    proof: {
      format: "buzz-nostr-event/v1" as const,
      encodedEvent: JSON.stringify(event),
    },
  };
}

const packet: FoundryApprovedContractPacket = {
  protocolVersion: 1,
  body,
  approvals: [approval("founder-alice", aliceEvent), approval("founder-bob", bobEvent)],
};

const configured = {
  configured: true,
  protocolVersion: 1,
  environmentId: body.execution.environmentId,
  buzzRelayUrl: BUZZ_RELAY_URL,
  buzzGroupId: "foundry-hotpaste",
  founders,
} as const satisfies FoundryConfigState;

const verified = ingestApprovedContractPacket({
  packet,
  founders,
  identityAdapters: [
    makeBuzzNostrIdentityAdapter({
      relayUrl: BUZZ_RELAY_URL,
      groupId: configured.buzzGroupId,
    }),
  ],
});
const queued = queueFeatureDispatch({
  proposal: verified.proposal,
  environmentId: configured.environmentId,
});
const record: FoundryApprovedContractRecord = {
  contractHash: verified.proposal.contentHash,
  projectId: body.projectId,
  featureId: body.featureId,
  version: body.version,
  founderRegistryHash: verified.proposal.founderRegistryHash,
  approvalSubject: verified.proposal.approvalSubject,
  dispatchIdempotencyKey: queued.idempotencyKey,
  acceptedAt: ACCEPTED_AT,
  approvals: [verified.evidence[0]!, verified.evidence[1]!],
};

const runningAttempt = {
  dispatchId: queued.id,
  attemptNumber: 1,
  fenceToken: 1,
  runnerId: "runner-one",
  runnerSessionId: RUNNER_SESSION_ID,
  state: "running",
  claimedAt: CLAIMED_AT,
  lastHeartbeatAt: CLAIMED_AT,
  leaseExpiresAt: LEASE_EXPIRES_AT,
  completedAt: null,
  failureCode: null,
} as const;

const runningJob = {
  dispatchId: queued.id,
  dispatchIdempotencyKey: queued.idempotencyKey,
  contractHash: queued.contractHash,
  environmentId: queued.environmentId,
  branch: queued.branch,
  baseSha: queued.baseSha,
  state: "running",
  fenceToken: 1,
  attemptCount: 1,
  maxAttempts: 3,
  leaseOwner: "runner-one",
  leaseSessionId: RUNNER_SESSION_ID,
  leaseExpiresAt: LEASE_EXPIRES_AT,
  commandCreatedAt: ACCEPTED_AT,
  createdAt: ACCEPTED_AT,
  updatedAt: CLAIMED_AT,
  completedAt: null,
  failureCode: null,
} as const;

const storedClaim: StoredFoundryDispatchClaim = {
  job: runningJob,
  attempt: runningAttempt,
};
const runningStatus: StoredFoundryDispatchStatus = {
  job: runningJob,
  attempts: [runningAttempt],
  evidence: [],
};

function testLayer(input: {
  readonly config?: FoundryConfigState;
  readonly approved?: Partial<FoundryApprovedContractStoreShape>;
  readonly dispatch?: Partial<FoundryDispatchStoreShape>;
}) {
  const approvedStore = FoundryApprovedContractStore.of({
    storeVerified: () => Effect.die("unused approved-contract write"),
    readPacketByContractHash: () => Effect.succeed(Option.some(packet)),
    readRecordByContractHash: () => Effect.succeed(Option.some(record)),
    ...input.approved,
  });
  const dispatchStore = FoundryDispatchStore.of({
    claimNext: () => Effect.succeed(Option.some(storedClaim)),
    heartbeat: () => Effect.succeed(storedClaim),
    complete: () => Effect.succeed(runningStatus),
    recordEvidence: (evidence) =>
      Effect.succeed({
        disposition: "recorded",
        evidence: {
          sequence: 1,
          dispatchId: runningJob.dispatchId,
          attemptNumber: runningAttempt.attemptNumber,
          fenceToken: evidence.fenceToken,
          reportId: evidence.reportId,
          kind: evidence.kind,
          payloadJson: evidence.payloadJson,
          recordedAt: evidence.recordedAt,
        },
      }),
    finalizeWithEvidence: (evidence) =>
      Effect.succeed({
        disposition: "recorded",
        evidence: {
          sequence: 1,
          dispatchId: runningJob.dispatchId,
          attemptNumber: runningAttempt.attemptNumber,
          fenceToken: evidence.fenceToken,
          reportId: evidence.reportId,
          kind: evidence.kind,
          payloadJson: evidence.payloadJson,
          recordedAt: evidence.recordedAt,
        },
        status: runningStatus,
      }),
    readStatus: () => Effect.succeed(Option.some(runningStatus)),
    ...input.dispatch,
  });
  return FoundryDispatchLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        foundryConfigLayer(input.config ?? configured),
        Layer.succeed(FoundryApprovedContractStore, approvedStore),
        Layer.succeed(FoundryDispatchStore, dispatchStore),
      ),
    ),
  );
}

it.effect("claims with a server-owned lease and returns the raw reverified packet", () => {
  const claims: Parameters<FoundryDispatchStoreShape["claimNext"]>[0][] = [];
  return Effect.gen(function* () {
    const dispatch = yield* FoundryDispatch;
    yield* TestClock.setTime(Date.parse(CLAIMED_AT));
    const result = yield* dispatch.claim({
      environmentId: configured.environmentId,
      runnerId: "runner-one",
      runnerSessionId: RUNNER_SESSION_ID,
    });

    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.claimedAt, CLAIMED_AT);
    assert.equal(claims[0]?.runnerSessionId, RUNNER_SESSION_ID);
    assert.equal(claims[0]?.leaseExpiresAt, LEASE_EXPIRES_AT);
    assert.equal(
      Date.parse(claims[0]!.leaseExpiresAt) - Date.parse(claims[0]!.claimedAt),
      FOUNDRY_DISPATCH_LEASE_MILLISECONDS,
    );
    assert.deepEqual(result.claim?.packet, packet);
    assert.deepEqual(result.claim?.record, record);
    assert.equal(result.claim?.job.dispatchIdempotencyKey, queued.idempotencyKey);
    assert.equal(result.claim?.attempt.fenceToken, 1);
    assert.notProperty(result.claim?.job, "leaseOwner");
    assert.notProperty(result.claim?.job, "leaseSessionId");
    assert.notProperty(result.claim?.attempt, "runnerSessionId");
  }).pipe(
    Effect.provide(
      testLayer({
        dispatch: {
          claimNext: (input) =>
            Effect.sync(() => {
              claims.push(input);
              return Option.some({
                job: {
                  ...runningJob,
                  leaseExpiresAt: input.leaseExpiresAt,
                  updatedAt: input.claimedAt,
                },
                attempt: {
                  ...runningAttempt,
                  claimedAt: input.claimedAt,
                  lastHeartbeatAt: input.claimedAt,
                  leaseExpiresAt: input.leaseExpiresAt,
                },
              });
            }),
        },
      }),
    ),
  );
});

it.effect("fails a claimed job when its stored founder proof no longer verifies", () => {
  const completions: Parameters<FoundryDispatchStoreShape["complete"]>[0][] = [];
  const invalidPacket = {
    ...packet,
    approvals: [
      {
        ...packet.approvals[0],
        proof: { ...packet.approvals[0].proof, encodedEvent: "{}" },
      },
      packet.approvals[1],
    ],
  } satisfies FoundryApprovedContractPacket;

  return Effect.gen(function* () {
    const dispatch = yield* FoundryDispatch;
    yield* TestClock.setTime(Date.parse(CLAIMED_AT));
    const error = yield* dispatch
      .claim({
        environmentId: configured.environmentId,
        runnerId: "runner-one",
        runnerSessionId: RUNNER_SESSION_ID,
      })
      .pipe(Effect.flip);

    assert.equal(error.code, "conflict");
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.outcome, "failed");
    assert.equal(completions[0]?.failureCode, "approval-invalid");
    assert.equal(completions[0]?.runnerSessionId, RUNNER_SESSION_ID);
  }).pipe(
    Effect.provide(
      testLayer({
        approved: {
          readPacketByContractHash: () => Effect.succeed(Option.some(invalidPacket)),
        },
        dispatch: {
          complete: (input) =>
            Effect.sync(() => {
              completions.push(input);
              return runningStatus;
            }),
        },
      }),
    ),
  );
});

it.effect("renews only the current fenced lease and maps stale ownership coarsely", () => {
  const heartbeats: Parameters<FoundryDispatchStoreShape["heartbeat"]>[0][] = [];
  return Effect.gen(function* () {
    const dispatch = yield* FoundryDispatch;
    yield* TestClock.setTime(Date.parse(CLAIMED_AT));
    const renewed = yield* dispatch.heartbeat({
      dispatchIdempotencyKey: queued.idempotencyKey,
      runnerId: "runner-one",
      runnerSessionId: RUNNER_SESSION_ID,
      fenceToken: 1,
    });
    const error = yield* dispatch
      .heartbeat({
        dispatchIdempotencyKey: queued.idempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: "6".repeat(64),
        fenceToken: 1,
      })
      .pipe(Effect.flip);

    assert.equal(renewed.leaseExpiresAt, LEASE_EXPIRES_AT);
    assert.equal(heartbeats[0]?.heartbeatAt, CLAIMED_AT);
    assert.equal(heartbeats[0]?.leaseExpiresAt, LEASE_EXPIRES_AT);
    assert.equal(error.code, "lease-lost");
  }).pipe(
    Effect.provide(
      testLayer({
        dispatch: {
          heartbeat: (input) => {
            heartbeats.push(input);
            return input.runnerSessionId === RUNNER_SESSION_ID
              ? Effect.succeed({
                  job: { ...runningJob, leaseExpiresAt: input.leaseExpiresAt },
                  attempt: { ...runningAttempt, leaseExpiresAt: input.leaseExpiresAt },
                })
              : Effect.fail(
                  new FoundryDispatchLeaseError({
                    dispatchIdempotencyKey: input.dispatchIdempotencyKey,
                    reason: "lease-lost",
                  }),
                );
          },
        },
      }),
    ),
  );
});

it.effect("atomically finalizes typed terminal evidence and preserves replay disposition", () => {
  const finalizations: Parameters<FoundryDispatchStoreShape["finalizeWithEvidence"]>[0][] = [];
  const succeeded: FoundryDispatchReport = {
    kind: "succeeded",
    evidenceKey: "8".repeat(64),
    threadId: ThreadId.make("foundry-thread-1"),
    commandId: CommandId.make("foundry-command-1"),
    turnId: TurnId.make("turn-1"),
    checkpoint: {
      status: "ready",
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/foundry-thread-1/turn/1"),
    },
  };

  return Effect.gen(function* () {
    const dispatch = yield* FoundryDispatch;
    yield* TestClock.setTime(Date.parse(CLAIMED_AT));
    const result = yield* dispatch.report({
      dispatchIdempotencyKey: queued.idempotencyKey,
      runnerId: "runner-one",
      runnerSessionId: RUNNER_SESSION_ID,
      fenceToken: 1,
      reportId: "9".repeat(64),
      report: succeeded,
    });

    assert.equal(result.disposition, "replayed");
    assert.equal(result.job.state, "succeeded");
    assert.equal(result.job.evidence[0]?.report.kind, "succeeded");
    assert.equal(finalizations.length, 1);
    assert.equal(finalizations[0]?.kind, "succeeded");
    assert.equal(finalizations[0]?.runnerSessionId, RUNNER_SESSION_ID);
    assert.deepEqual(decodeDispatchReportJson(finalizations[0]!.payloadJson), succeeded);
    assert.equal(finalizations[0]?.outcome, "succeeded");
    assert.equal(finalizations[0]?.failureCode, null);
  }).pipe(
    Effect.provide(
      testLayer({
        dispatch: {
          recordEvidence: () => Effect.die("terminal report used non-atomic evidence path"),
          complete: () => Effect.die("terminal report used non-atomic completion path"),
          finalizeWithEvidence: (input) => {
            finalizations.push(input);
            return Effect.succeed({
              disposition: "replayed",
              evidence: {
                sequence: 1,
                dispatchId: runningJob.dispatchId,
                attemptNumber: 1,
                fenceToken: input.fenceToken,
                reportId: input.reportId,
                kind: input.kind,
                payloadJson: input.payloadJson,
                recordedAt: input.recordedAt,
              },
              status: {
                job: {
                  ...runningJob,
                  state: "succeeded",
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  updatedAt: input.recordedAt,
                  completedAt: input.recordedAt,
                },
                attempts: [
                  {
                    ...runningAttempt,
                    state: "succeeded",
                    completedAt: input.recordedAt,
                  },
                ],
                evidence: [
                  {
                    sequence: 1,
                    dispatchId: runningJob.dispatchId,
                    attemptNumber: 1,
                    fenceToken: input.fenceToken,
                    reportId: "9".repeat(64),
                    kind: succeeded.kind,
                    payloadJson: JSON.stringify(succeeded),
                    recordedAt: input.recordedAt,
                  },
                ],
              },
            });
          },
        },
      }),
    ),
  );
});

it.effect("decodes status evidence and never exposes malformed stored diagnostics", () => {
  const malformedStatus: StoredFoundryDispatchStatus = {
    ...runningStatus,
    evidence: [
      {
        sequence: 1,
        dispatchId: runningJob.dispatchId,
        attemptNumber: 1,
        fenceToken: 1,
        reportId: "a".repeat(64),
        kind: "turn-started",
        payloadJson: '{"kind":"turn-started","worktreePath":"C:\\\\secret"}',
        recordedAt: CLAIMED_AT,
      },
    ],
  };

  return Effect.gen(function* () {
    const dispatch = yield* FoundryDispatch;
    const malformed = yield* dispatch
      .get({ dispatchIdempotencyKey: queued.idempotencyKey })
      .pipe(Effect.flip);
    assert.equal(malformed.code, "unavailable");
  }).pipe(
    Effect.provide(
      testLayer({
        dispatch: {
          readStatus: () => Effect.succeed(Option.some(malformedStatus)),
        },
      }),
    ),
  );
});

it.effect("maps evidence conflicts without returning stored payloads", () =>
  Effect.gen(function* () {
    const dispatch = yield* FoundryDispatch;
    const error = yield* dispatch
      .report({
        dispatchIdempotencyKey: queued.idempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: RUNNER_SESSION_ID,
        fenceToken: 1,
        reportId: "b".repeat(64),
        report: {
          kind: "failed",
          failureCode: "turn-failed",
          correlation: null,
        },
      })
      .pipe(Effect.flip);

    assert.equal(error.code, "conflict");
    assert.notProperty(error, "payloadJson");
  }).pipe(
    Effect.provide(
      testLayer({
        dispatch: {
          finalizeWithEvidence: (input) =>
            Effect.fail(
              new FoundryDispatchEvidenceConflictError({
                dispatchIdempotencyKey: input.dispatchIdempotencyKey,
                reportId: input.reportId,
              }),
            ),
        },
      }),
    ),
  ),
);
