import { schnorr } from "@noble/curves/secp256k1";
import { it } from "@effect/vitest";
import {
  CheckpointRef,
  FoundryRunnerSessionId,
  type FoundryApprovedContractPacket,
  type FoundryDispatchClaim,
  type FoundryReportDispatchInput,
  TurnId,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import {
  computeBuzzNostrEventId,
  FOUNDRY_BUZZ_APPROVAL_EVENT_KIND,
  FOUNDRY_BUZZ_APPROVAL_TAG,
  FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT,
  ingestApprovedContractPacket,
  makeBuzzNostrIdentityAdapter,
  proposeFeatureContract,
  queueFeatureDispatch,
  type FeatureContractBody,
} from "@t3tools/foundry-governance";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vite-plus/test";

import type { LocalRunnerBinding } from "./compileTurn.ts";
import type { FoundryRunnerAuthorityConfig } from "./config.ts";
import {
  FoundryRunnerError,
  runClaimedDispatch,
  type FoundryDispatchGateway,
  type FoundryT3Driver,
  type ObservedT3Thread,
} from "./runClaim.ts";

const ALICE_PRIVATE_KEY = `${"00".repeat(31)}01`;
const BOB_PRIVATE_KEY = `${"00".repeat(31)}02`;
const BUZZ_GROUP_ID = "foundry-hotpaste";
const BUZZ_RELAY_URL = "wss://buzz.example/";
const CREATED_AT = "2026-08-11T10:00:00.000Z";
const RUNNER_SESSION_ID = FoundryRunnerSessionId.make("a".repeat(64));

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const founders = [
  { id: "founder-alice", publicKey: toHex(schnorr.getPublicKey(ALICE_PRIVATE_KEY)) },
  { id: "founder-bob", publicKey: toHex(schnorr.getPublicKey(BOB_PRIVATE_KEY)) },
] as const;

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
    provider: "codex-primary",
    model: "gpt-5.6-sol-ultra",
    runtimeMode: "approval-required",
    limits: { maximumTurns: 20, maximumRetries: 2 },
  },
  riskFlags: ["clipboard-data"],
};

const binding: LocalRunnerBinding = {
  environmentId: body.execution.environmentId,
  repositoryRemoteId: body.repository.remoteId,
  foundryProjectId: body.projectId,
  t3ProjectId: "local-hotpaste-project",
  projectCwd: "C:\\dev\\hotpaste",
  provider: body.execution.provider,
  providerInstanceId: "codex-work",
  allowedModels: [body.execution.model],
  allowedBaseBranches: [body.repository.baseBranch],
};

const authority: FoundryRunnerAuthorityConfig = {
  protocolVersion: 1,
  environmentId: body.execution.environmentId,
  buzzRelayUrl: BUZZ_RELAY_URL,
  buzzGroupId: BUZZ_GROUP_ID,
  founders,
};

function signedEvent(privateKey: string, subject: string, createdAt: number) {
  const eventBody = {
    pubkey: toHex(schnorr.getPublicKey(privateKey)),
    created_at: createdAt,
    kind: FOUNDRY_BUZZ_APPROVAL_EVENT_KIND,
    tags: [
      ["h", BUZZ_GROUP_ID],
      ["t", FOUNDRY_BUZZ_APPROVAL_TAG],
    ],
    content: JSON.stringify({
      type: "foundry.contract.approval/v1",
      subject,
      relayUrl: BUZZ_RELAY_URL,
    }),
  };
  const id = computeBuzzNostrEventId(eventBody);
  return {
    ...eventBody,
    id,
    sig: toHex(schnorr.sign(id, privateKey, new Uint8Array(32))),
  };
}

function approvedPacket(): FoundryApprovedContractPacket {
  const proposal = proposeFeatureContract({ body, founders });
  return {
    protocolVersion: 1,
    body,
    approvals: [
      {
        founderId: founders[0].id,
        proof: {
          format: FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT,
          encodedEvent: JSON.stringify(signedEvent(ALICE_PRIVATE_KEY, proposal.approvalSubject, 1)),
        },
      },
      {
        founderId: founders[1].id,
        proof: {
          format: FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT,
          encodedEvent: JSON.stringify(signedEvent(BOB_PRIVATE_KEY, proposal.approvalSubject, 2)),
        },
      },
    ],
  };
}

function makeClaim(attemptNumber = 1): FoundryDispatchClaim {
  const packet = approvedPacket();
  const ingestion = ingestApprovedContractPacket({
    packet,
    founders,
    identityAdapters: [
      makeBuzzNostrIdentityAdapter({ groupId: BUZZ_GROUP_ID, relayUrl: BUZZ_RELAY_URL }),
    ],
  });
  const dispatch = queueFeatureDispatch({
    proposal: ingestion.proposal,
    environmentId: body.execution.environmentId,
  });
  const attempt = {
    attemptNumber,
    fenceToken: attemptNumber,
    state: "running" as const,
    claimedAt: CREATED_AT,
    lastHeartbeatAt: CREATED_AT,
    leaseExpiresAt: "2026-08-11T10:01:00.000Z",
    completedAt: null,
    failureCode: null,
  };
  return {
    packet,
    record: {
      contractHash: ingestion.proposal.contentHash,
      projectId: body.projectId,
      featureId: body.featureId,
      version: body.version,
      founderRegistryHash: "0".repeat(64),
      approvalSubject: ingestion.proposal.approvalSubject,
      dispatchIdempotencyKey: dispatch.idempotencyKey,
      acceptedAt: CREATED_AT,
      approvals: [ingestion.evidence[0]!, ingestion.evidence[1]!],
    },
    job: {
      dispatchId: dispatch.id,
      dispatchIdempotencyKey: dispatch.idempotencyKey,
      contractHash: dispatch.contractHash,
      environmentId: dispatch.environmentId,
      state: "running",
      fenceToken: attemptNumber,
      attemptCount: attemptNumber,
      failureCode: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      completedAt: null,
      attempts: [attempt],
      evidence: [],
    },
    attempt,
  };
}

function worktreeFor(claim: FoundryDispatchClaim): VcsCreateWorktreeResult {
  const ingestion = ingestApprovedContractPacket({
    packet: claim.packet,
    founders,
    identityAdapters: [
      makeBuzzNostrIdentityAdapter({ groupId: BUZZ_GROUP_ID, relayUrl: BUZZ_RELAY_URL }),
    ],
  });
  const dispatch = queueFeatureDispatch({
    proposal: ingestion.proposal,
    environmentId: body.execution.environmentId,
  });
  return {
    worktree: {
      path: "C:\\dev\\hotpaste-worktrees\\clipboard-history",
      refName: dispatch.branch,
    },
  };
}

function gateway(
  timeline: Array<string>,
  reports: Array<FoundryReportDispatchInput> = [],
): FoundryDispatchGateway {
  return {
    heartbeat: () => Effect.void,
    report: (input) =>
      Effect.sync(() => {
        reports.push(input);
        timeline.push(`report:${input.report.kind}`);
      }),
  };
}

function successfulDriver(input: {
  readonly claim: FoundryDispatchClaim;
  readonly timeline: Array<string>;
}): FoundryT3Driver {
  const worktree = worktreeFor(input.claim);
  return {
    inspect: () =>
      Effect.succeed({ existingRef: null, existingWorktree: null, existingThread: null }),
    prepareWorktree: ({ plan }) =>
      Effect.sync(() => {
        input.timeline.push(`worktree:${plan.action}`);
        return worktree;
      }),
    ensureTurnStarted: ({ turn }) =>
      Effect.sync(() => {
        input.timeline.push(`turn:${turn.threadAction}`);
        return { turnId: TurnId.make("turn-one"), origin: "started" as const };
      }),
    awaitTurnTerminal: ({ turn, turnId }) =>
      Effect.succeed({
        outcome: "succeeded",
        threadId: turn.input.threadId,
        commandId: turn.input.commandId!,
        turnId,
        checkpointRef: CheckpointRef.make("checkpoint-one"),
      }),
  };
}

describe("runClaimedDispatch", () => {
  it.effect("reverifies the signed packet and persists intent before each T3 mutation", () =>
    Effect.gen(function* () {
      const claim = makeClaim();
      const timeline: Array<string> = [];
      const reports: Array<FoundryReportDispatchInput> = [];

      yield* runClaimedDispatch({
        claim,
        runnerId: "runner-one",
        runnerSessionId: RUNNER_SESSION_ID,
        authority,
        binding,
        gateway: gateway(timeline, reports),
        t3: successfulDriver({ claim, timeline }),
      });

      expect(timeline).toEqual([
        "report:worktree-planned",
        "worktree:create",
        "report:worktree-ready",
        "report:turn-planned",
        "turn:create",
        "report:turn-started",
        "report:succeeded",
      ]);
      expect(reports.every((report) => report.runnerSessionId === RUNNER_SESSION_ID)).toBe(true);
    }),
  );

  it.effect("rejects a packet that no longer verifies before inspecting T3", () =>
    Effect.gen(function* () {
      const claim = makeClaim();
      const timeline: Array<string> = [];
      const tampered = {
        ...claim,
        packet: {
          ...claim.packet,
          body: { ...claim.packet.body, title: "Tampered title" },
        },
      } as FoundryDispatchClaim;
      const t3 = successfulDriver({ claim, timeline });

      const failure = yield* runClaimedDispatch({
        claim: tampered,
        runnerId: "runner-one",
        runnerSessionId: RUNNER_SESSION_ID,
        authority,
        binding,
        gateway: gateway(timeline),
        t3: { ...t3, inspect: () => Effect.die("inspect must not run") },
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(FoundryRunnerError);
      expect(failure.code).toBe("approval-invalid");
      expect(failure.terminalReported).toBe(true);
      expect(timeline).toEqual(["report:failed"]);
    }),
  );

  it.effect("adopts a worktree after a crash without creating it twice", () =>
    Effect.gen(function* () {
      const firstClaim = makeClaim();
      const secondClaim = makeClaim(2);
      const worktree = worktreeFor(firstClaim);
      const prepared = yield* Deferred.make<void>();
      let existingWorktree: VcsCreateWorktreeResult | null = null;
      let createCount = 0;
      const firstDriver: FoundryT3Driver = {
        ...successfulDriver({ claim: firstClaim, timeline: [] }),
        inspect: () =>
          Effect.succeed({ existingRef: null, existingWorktree: null, existingThread: null }),
        prepareWorktree: () =>
          Effect.sync(() => {
            createCount += 1;
            existingWorktree = worktree;
          }).pipe(
            Effect.andThen(Deferred.succeed(prepared, undefined)),
            Effect.andThen(Effect.never),
          ),
      };
      const firstFiber = yield* Effect.forkChild(
        runClaimedDispatch({
          claim: firstClaim,
          runnerId: "runner-one",
          runnerSessionId: RUNNER_SESSION_ID,
          authority,
          binding,
          gateway: gateway([]),
          t3: firstDriver,
        }),
      );
      yield* Deferred.await(prepared);
      yield* Fiber.interrupt(firstFiber);

      const secondTimeline: Array<string> = [];
      const secondDriver = successfulDriver({ claim: secondClaim, timeline: secondTimeline });
      yield* runClaimedDispatch({
        claim: secondClaim,
        runnerId: "runner-two",
        runnerSessionId: RUNNER_SESSION_ID,
        authority,
        binding,
        gateway: gateway(secondTimeline),
        t3: {
          ...secondDriver,
          inspect: () =>
            Effect.succeed({ existingRef: null, existingWorktree, existingThread: null }),
          prepareWorktree: ({ plan }) =>
            Effect.sync(() => {
              expect(plan.action).toBe("adopt");
              return worktree;
            }),
        },
      });

      expect(createCount).toBe(1);
      expect(secondTimeline).toContain("turn:create");
    }),
  );

  it.effect("adopts a started deterministic thread after a crash without dispatching twice", () =>
    Effect.gen(function* () {
      const firstClaim = makeClaim();
      const secondClaim = makeClaim(2);
      const worktree = worktreeFor(firstClaim);
      const started = yield* Deferred.make<void>();
      let existingThread: ObservedT3Thread | null = null;
      let dispatchCount = 0;
      const firstDriver: FoundryT3Driver = {
        ...successfulDriver({ claim: firstClaim, timeline: [] }),
        inspect: () =>
          Effect.succeed({ existingRef: null, existingWorktree: worktree, existingThread: null }),
        ensureTurnStarted: ({ turn }) => {
          const created = turn.input.bootstrap?.createThread;
          if (!created) {
            return Effect.die("expected a new thread");
          }
          return Effect.sync(() => {
            dispatchCount += 1;
            existingThread = {
              id: turn.input.threadId,
              projectId: created.projectId,
              title: created.title,
              modelSelection: created.modelSelection,
              runtimeMode: created.runtimeMode,
              interactionMode: created.interactionMode,
              branch: created.branch,
              worktreePath: created.worktreePath,
              createdAt: created.createdAt,
              latestTurn: {
                turnId: TurnId.make("turn-one"),
                state: "running",
                requestedAt: CREATED_AT,
                startedAt: CREATED_AT,
                completedAt: null,
                assistantMessageId: null,
              },
            };
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
          );
        },
      };
      const firstFiber = yield* Effect.forkChild(
        runClaimedDispatch({
          claim: firstClaim,
          runnerId: "runner-one",
          runnerSessionId: RUNNER_SESSION_ID,
          authority,
          binding,
          gateway: gateway([]),
          t3: firstDriver,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(firstFiber);

      const secondDriver = successfulDriver({ claim: secondClaim, timeline: [] });
      yield* runClaimedDispatch({
        claim: secondClaim,
        runnerId: "runner-two",
        runnerSessionId: RUNNER_SESSION_ID,
        authority,
        binding,
        gateway: gateway([]),
        t3: {
          ...secondDriver,
          inspect: () =>
            Effect.succeed({ existingRef: null, existingWorktree: worktree, existingThread }),
          ensureTurnStarted: ({ existingThread: observed }) => {
            expect(observed?.latestTurn?.turnId).toBe("turn-one");
            return Effect.succeed({ turnId: TurnId.make("turn-one"), origin: "adopted" });
          },
        },
      });

      expect(dispatchCount).toBe(1);
    }),
  );

  it.effect("does not attempt a stale failure report after the lease is lost", () =>
    Effect.gen(function* () {
      const claim = makeClaim();
      let reports = 0;
      const failure = yield* runClaimedDispatch({
        claim,
        runnerId: "runner-one",
        runnerSessionId: RUNNER_SESSION_ID,
        authority,
        binding,
        gateway: {
          heartbeat: () => Effect.void,
          report: () => {
            reports += 1;
            return Effect.fail(new FoundryRunnerError("lease-lost", "stale worker"));
          },
        },
        t3: successfulDriver({ claim, timeline: [] }),
      }).pipe(Effect.flip);

      expect(failure.code).toBe("lease-lost");
      expect(reports).toBe(1);
    }),
  );

  it.effect("leaves retryable unknown outcomes non-terminal for lease-bounded recovery", () =>
    Effect.gen(function* () {
      const claim = makeClaim();
      const timeline: Array<string> = [];
      const t3 = successfulDriver({ claim, timeline });
      const failure = yield* runClaimedDispatch({
        claim,
        runnerId: "runner-one",
        runnerSessionId: RUNNER_SESSION_ID,
        authority,
        binding,
        gateway: gateway(timeline),
        t3: {
          ...t3,
          awaitTurnTerminal: () =>
            Effect.fail(
              new FoundryRunnerError(
                "turn-failed",
                "The recovered approval callback cannot be proven live.",
                undefined,
                "after-lease-expiry",
              ),
            ),
        },
      }).pipe(Effect.flip);

      expect(failure.retryable).toBe(true);
      expect(failure.retryMode).toBe("after-lease-expiry");
      expect(failure.terminalReported).toBe(false);
      expect(timeline).toEqual([
        "report:worktree-planned",
        "worktree:create",
        "report:worktree-ready",
        "report:turn-planned",
        "turn:create",
        "report:turn-started",
      ]);
    }),
  );
});
