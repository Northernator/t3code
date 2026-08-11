import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  TurnId,
  WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerConfig,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import {
  approveFeatureContract,
  type ApprovalProofVerifier,
  type FeatureContractBody,
  type FounderIdentity,
  proposeFeatureContract,
  queueFeatureDispatch,
  verifyApprovedFeatureProposal,
} from "@t3tools/foundry-governance";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import {
  compileApprovedTurn,
  compileApprovedWorktree,
  type CompiledT3Turn,
  type LocalRunnerBinding,
} from "./compileTurn.ts";
import { FoundryRunnerError } from "./runClaim.ts";
import {
  makeFoundryT3Driver as makeFoundryT3DriverBase,
  type FoundryGitInspector,
  type FoundryGitWorktreeInspection,
} from "./t3Driver.ts";
import { makeFoundryRunnerRetryGate } from "./retryGate.ts";

const now = "2026-08-10T12:02:00.000Z";

function testRetryGate() {
  const gate = makeFoundryRunnerRetryGate(() => Date.parse(now));
  gate.setActiveLeaseDurationMilliseconds(60_000);
  return gate;
}

function makeFoundryT3Driver(
  input: Omit<Parameters<typeof makeFoundryT3DriverBase>[0], "retryGate"> & {
    readonly retryGate?: Parameters<typeof makeFoundryT3DriverBase>[0]["retryGate"];
  },
) {
  return makeFoundryT3DriverBase({ ...input, retryGate: input.retryGate ?? testRetryGate() });
}
const founders = [
  { id: "founder-alice", publicKey: "alice-public-key" },
  { id: "founder-bob", publicKey: "bob-public-key" },
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

const verifier: ApprovalProofVerifier = {
  verify: ({ founder, subject, proof }) =>
    proof.format === "test/v1" && proof.encodedEvent === `${founder.publicKey}:${subject}`,
};

function approvedRun() {
  const proposal = proposeFeatureContract({ body, founders });
  const alice = approveFeatureContract({
    proposal,
    approval: {
      founderId: founders[0].id,
      contentHash: proposal.contentHash,
      proof: {
        format: "test/v1",
        encodedEvent: `${founders[0].publicKey}:${proposal.approvalSubject}`,
      },
    },
    founders,
    verifier,
  });
  const approved = approveFeatureContract({
    proposal: alice,
    approval: {
      founderId: founders[1].id,
      contentHash: proposal.contentHash,
      proof: {
        format: "test/v1",
        encodedEvent: `${founders[1].publicKey}:${proposal.approvalSubject}`,
      },
    },
    founders,
    verifier,
  });
  const verified = verifyApprovedFeatureProposal({ proposal: approved, founders, verifier });
  return {
    proposal: verified,
    dispatch: queueFeatureDispatch({
      proposal: verified,
      environmentId: body.execution.environmentId,
    }),
  };
}

function preparedWorktree(run: ReturnType<typeof approvedRun>): VcsCreateWorktreeResult {
  return {
    worktree: {
      path: "C:\\dev\\hotpaste-worktrees\\clipboard-history",
      refName: run.dispatch.branch,
    },
  };
}

function compiledTurn(run: ReturnType<typeof approvedRun>) {
  return compileApprovedTurn({
    ...run,
    binding,
    worktree: preparedWorktree(run),
    createdAt: now,
  });
}

function latestTurn(state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("foundry-turn-1"),
    state,
    requestedAt: now,
    startedAt: now,
    completedAt: state === "running" ? null : now,
    assistantMessageId: state === "running" ? null : MessageId.make("assistant-1"),
  };
}

function threadShell(
  turn: CompiledT3Turn,
  latest: OrchestrationLatestTurn | null,
): OrchestrationThreadShell {
  const expected = turn.expectedThread;
  return {
    id: expected.id,
    projectId: expected.projectId,
    title: expected.title,
    modelSelection: expected.modelSelection,
    runtimeMode: expected.runtimeMode,
    interactionMode: expected.interactionMode,
    branch: expected.branch,
    worktreePath: expected.worktreePath,
    latestTurn: latest,
    createdAt: expected.createdAt,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    session: null,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    planProgress: null,
  };
}

function detailThread(input: {
  readonly turn: CompiledT3Turn;
  readonly latest: OrchestrationLatestTurn | null;
  readonly includeMessage?: boolean;
  readonly checkpoints?: OrchestrationThread["checkpoints"];
}): OrchestrationThread {
  const shell = threadShell(input.turn, input.latest);
  return {
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    latestTurn: shell.latestTurn,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    deletedAt: null,
    messages:
      input.includeMessage === false
        ? []
        : [
            {
              id: input.turn.input.message.messageId,
              role: "user",
              text: input.turn.input.message.text,
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
    proposedPlans: [],
    activities: [],
    checkpoints: input.checkpoints ?? [],
    session: null,
  };
}

function shellSnapshot(
  turn: CompiledT3Turn,
  threads: ReadonlyArray<OrchestrationThreadShell> = [],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: ProjectId.make(binding.t3ProjectId),
        title: "Hotpaste",
        workspaceRoot: binding.projectCwd,
        repositoryIdentity: {
          canonicalKey: "github.com/midlow/hotpaste",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.com:midlow/hotpaste.git",
          },
          rootPath: binding.projectCwd,
          provider: "github",
          owner: "midlow",
          name: "hotpaste",
        },
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    threads,
    updatedAt: now,
  };
}

function serverConfig(): ServerConfig {
  return {
    environment: {
      environmentId: binding.environmentId,
      label: "Foundry laptop",
      platform: { os: "windows", arch: "x64" },
      serverVersion: "test",
      capabilities: { repositoryIdentity: true },
    },
    providers: [
      {
        instanceId: ProviderInstanceId.make(binding.providerInstanceId),
        driver: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: now,
        availability: "available",
        models: [
          {
            slug: body.execution.model,
            name: "GPT 5.6 Sol Ultra",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
  } as unknown as ServerConfig;
}

function client(methods: Record<string, unknown>): WsRpcProtocolClient {
  return methods as unknown as WsRpcProtocolClient;
}

function worktreeInspection(
  run: ReturnType<typeof approvedRun>,
  changes: Partial<FoundryGitWorktreeInspection> = {},
): FoundryGitWorktreeInspection {
  return {
    rootPath: preparedWorktree(run).worktree.path,
    branch: run.dispatch.branch,
    headSha: run.dispatch.baseSha,
    baseIsAncestor: true,
    hasWorkingTreeChanges: false,
    ...changes,
  };
}

function gitInspector(
  run: ReturnType<typeof approvedRun>,
  changes: Partial<FoundryGitWorktreeInspection> = {},
): FoundryGitInspector {
  return {
    inspectRepository: () =>
      Effect.succeed({
        rootPath: binding.projectCwd,
        remoteName: "origin",
        canonicalKey: "github.com/midlow/hotpaste",
      }),
    inspectRef: () => Effect.succeed({ headSha: run.dispatch.baseSha, baseIsAncestor: true }),
    inspectWorktree: () => Effect.succeed(worktreeInspection(run, changes)),
  };
}

function eventBase(sequence: number) {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread" as const,
    occurredAt: now,
    commandId: CommandId.make("foundry-command"),
    causationEventId: null,
    correlationId: CommandId.make("foundry-command"),
    metadata: {},
  };
}

describe("makeFoundryT3Driver", () => {
  it.effect("resolves exact inventory and adopts a locally verified deterministic worktree", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const worktree = preparedWorktree(run);
      const shell = threadShell(turn, latestTurn("running"));
      const driver = makeFoundryT3Driver({
        client: client({
          [WS_METHODS.serverGetConfig]: () => Effect.succeed(serverConfig()),
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.make({ kind: "snapshot", snapshot: shellSnapshot(turn, [shell]) }),
          [WS_METHODS.vcsListRefs]: () =>
            Effect.succeed({
              refs: [
                {
                  name: run.dispatch.branch,
                  current: false,
                  isDefault: false,
                  worktreePath: worktree.worktree.path,
                },
              ],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 1,
            }),
        }),
        git: gitInspector(run, { hasWorkingTreeChanges: true }),
      });

      const inventory = yield* driver.inspect({ ...run, binding });

      expect(inventory.existingRef?.name).toBe(run.dispatch.branch);
      expect(inventory.existingWorktree).toEqual(worktree);
      expect(inventory.existingThread?.id).toBe(turn.input.threadId);
    }),
  );

  it.effect("rejects a dirty dispatch worktree before its deterministic thread exists", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const worktree = preparedWorktree(run);
      const driver = makeFoundryT3Driver({
        client: client({
          [WS_METHODS.serverGetConfig]: () => Effect.succeed(serverConfig()),
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.make({ kind: "snapshot", snapshot: shellSnapshot(turn) }),
          [WS_METHODS.vcsListRefs]: () =>
            Effect.succeed({
              refs: [
                {
                  name: run.dispatch.branch,
                  current: false,
                  isDefault: false,
                  worktreePath: worktree.worktree.path,
                },
              ],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 1,
            }),
        }),
        git: gitInspector(run, { hasWorkingTreeChanges: true }),
      });

      const failure = yield* driver.inspect({ ...run, binding }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(FoundryRunnerError);
      expect(failure.code).toBe("worktree-failed");
    }),
  );

  it.effect("reports exact project, provider, and model inventory failures", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const baseConfig = serverConfig();
      const baseSnapshot = shellSnapshot(turn);
      const provider = baseConfig.providers[0]!;
      const cases = [
        {
          expected: "project-unavailable" as const,
          config: baseConfig,
          snapshot: { ...baseSnapshot, projects: [] },
        },
        {
          expected: "provider-unavailable" as const,
          config: { ...baseConfig, providers: [] },
          snapshot: baseSnapshot,
        },
        {
          expected: "model-unavailable" as const,
          config: { ...baseConfig, providers: [{ ...provider, models: [] }] },
          snapshot: baseSnapshot,
        },
      ];

      yield* Effect.forEach(cases, (testCase) =>
        Effect.gen(function* () {
          const driver = makeFoundryT3Driver({
            client: client({
              [WS_METHODS.serverGetConfig]: () => Effect.succeed(testCase.config),
              [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
                Stream.make({ kind: "snapshot", snapshot: testCase.snapshot }),
            }),
            git: gitInspector(run),
          });

          const failure = yield* driver.inspect({ ...run, binding }).pipe(Effect.flip);
          expect(failure.code).toBe(testCase.expected);
        }),
      );
    }),
  );

  it.effect("attests both T3 and local Git repository identities against the binding", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const baseSnapshot = shellSnapshot(turn);
      const project = baseSnapshot.projects[0]!;
      const otherIdentity = {
        canonicalKey: "github.com/midlow/other",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:midlow/other.git",
        },
        rootPath: binding.projectCwd,
      };
      const cases = [
        {
          snapshot: {
            ...baseSnapshot,
            projects: [{ ...project, repositoryIdentity: otherIdentity }],
          },
          repository: {
            rootPath: binding.projectCwd,
            remoteName: "origin",
            canonicalKey: otherIdentity.canonicalKey,
          },
        },
        {
          snapshot: baseSnapshot,
          repository: {
            rootPath: binding.projectCwd,
            remoteName: "origin",
            canonicalKey: otherIdentity.canonicalKey,
          },
        },
      ];

      yield* Effect.forEach(cases, (testCase) =>
        Effect.gen(function* () {
          const driver = makeFoundryT3Driver({
            client: client({
              [WS_METHODS.serverGetConfig]: () => Effect.succeed(serverConfig()),
              [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
                Stream.make({ kind: "snapshot", snapshot: testCase.snapshot }),
            }),
            git: {
              ...gitInspector(run),
              inspectRepository: () => Effect.succeed(testCase.repository),
            },
          });

          const failure = yield* driver.inspect({ ...run, binding }).pipe(Effect.flip);
          expect(failure.code).toBe("project-unavailable");
          expect(failure.retryable).toBe(false);
        }),
      );
    }),
  );

  it.effect("classifies unavailable T3 inventory transport as retryable", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const driver = makeFoundryT3Driver({
        client: client({
          [WS_METHODS.serverGetConfig]: () =>
            Effect.fail({ _tag: "SocketClosed" as const, message: "socket closed" }),
        }),
        git: gitInspector(run),
      });

      const failure = yield* driver.inspect({ ...run, binding }).pipe(Effect.flip);

      expect(failure.code).toBe("environment-mismatch");
      expect(failure.retryable).toBe(true);
      expect(failure.retryMode).toBe("reattach");
    }),
  );

  it.effect("adopts the exact worktree after losing a concurrent create race", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const worktree = preparedWorktree(run);
      const create = vi.fn((_: unknown) =>
        Effect.fail(new FoundryRunnerError("worktree-failed", "already attached")),
      );
      const driver = makeFoundryT3Driver({
        client: client({
          [WS_METHODS.vcsCreateWorktree]: create,
          [WS_METHODS.vcsListRefs]: () =>
            Effect.succeed({
              refs: [
                {
                  name: run.dispatch.branch,
                  current: false,
                  isDefault: false,
                  worktreePath: worktree.worktree.path,
                },
              ],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 1,
            }),
        }),
        git: gitInspector(run),
      });
      const plan = compileApprovedWorktree({ ...run, binding });

      const prepared = yield* driver.prepareWorktree({ plan, ...run, binding });

      expect(prepared).toEqual(worktree);
      expect(create).toHaveBeenCalledOnce();
    }),
  );

  it.effect("retries worktree creation when reconciliation finds no created worktree", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const driver = makeFoundryT3Driver({
        client: client({
          [WS_METHODS.vcsCreateWorktree]: () =>
            Effect.fail({ _tag: "SocketClosed" as const, message: "socket closed" }),
          [WS_METHODS.vcsListRefs]: () =>
            Effect.succeed({
              refs: [],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 0,
            }),
        }),
        git: gitInspector(run),
      });
      const plan = compileApprovedWorktree({ ...run, binding });

      const failure = yield* driver.prepareWorktree({ plan, ...run, binding }).pipe(Effect.flip);

      expect(failure.code).toBe("worktree-failed");
      expect(failure.retryMode).toBe("reattach");
    }),
  );

  it.effect("dispatches one approval-required deterministic turn and learns its turn ID", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const dispatched = vi.fn((_: unknown) => Effect.succeed({ sequence: 2 }));
      const driver = makeFoundryT3Driver({
        client: client({
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatched,
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.make({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: 2,
                thread: detailThread({ turn, latest: latestTurn("running") }),
              },
            }),
        }),
        git: gitInspector(run),
      });

      const started = yield* driver.ensureTurnStarted({ turn, existingThread: null });

      expect(started).toEqual({ turnId: "foundry-turn-1", origin: "started" });
      expect(dispatched).toHaveBeenCalledOnce();
      expect(dispatched.mock.calls[0]?.[0]).toMatchObject({
        type: "thread.turn.start",
        commandId: turn.input.commandId,
        threadId: turn.input.threadId,
        runtimeMode: "approval-required",
      });
    }),
  );

  it.effect("recovers a stored turn command without dispatching a duplicate", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const shell = threadShell(turn, null);
      const dispatched = vi.fn((_: unknown) => Effect.succeed({ sequence: 2 }));
      let subscriptions = 0;
      const sessionEvent = {
        ...eventBase(3),
        aggregateId: turn.input.threadId,
        type: "thread.session-set",
        payload: {
          threadId: turn.input.threadId,
          session: {
            threadId: turn.input.threadId,
            status: "running",
            providerName: "Codex",
            providerInstanceId: ProviderInstanceId.make(binding.providerInstanceId),
            runtimeMode: "approval-required",
            activeTurnId: TurnId.make("foundry-turn-1"),
            lastError: null,
            updatedAt: now,
          },
        },
      } satisfies OrchestrationEvent;
      const driver = makeFoundryT3Driver({
        client: client({
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatched,
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () => {
            subscriptions += 1;
            return subscriptions === 1
              ? Stream.make({
                  kind: "snapshot",
                  snapshot: {
                    snapshotSequence: 2,
                    thread: detailThread({ turn, latest: null }),
                  },
                })
              : Stream.make({ kind: "event", event: sessionEvent });
          },
        }),
        git: gitInspector(run),
      });

      const started = yield* driver.ensureTurnStarted({ turn, existingThread: shell });

      expect(started).toEqual({ turnId: "foundry-turn-1", origin: "adopted" });
      expect(dispatched).not.toHaveBeenCalled();
      expect(subscriptions).toBe(2);
    }),
  );

  it.effect("re-attests adopted thread execution coordinates from the detail snapshot", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const initialTurn = compiledTurn(run);
      const existingThread = threadShell(initialTurn, latestTurn("running"));
      const turn = compileApprovedTurn({
        ...run,
        binding,
        worktree: preparedWorktree(run),
        existingThread,
        createdAt: now,
      });
      const driver = makeFoundryT3Driver({
        client: client({
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.make({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: 2,
                thread: {
                  ...detailThread({ turn, latest: latestTurn("running") }),
                  branch: "foundry/retargeted-branch",
                },
              },
            }),
        }),
        git: gitInspector(run),
      });

      const failure = yield* driver.ensureTurnStarted({ turn, existingThread }).pipe(Effect.flip);

      expect(failure.code).toBe("thread-failed");
    }),
  );

  it.effect("waits for both completed state and a ready checkpoint across approval pause", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const runningShell = {
        ...threadShell(turn, latestTurn("running")),
        hasPendingApprovals: true,
      };
      const completedShell = {
        ...runningShell,
        latestTurn: latestTurn("completed"),
        hasPendingApprovals: false,
      };
      const checkpointEvent = {
        ...eventBase(4),
        aggregateId: turn.input.threadId,
        type: "thread.turn-diff-completed",
        payload: {
          threadId: turn.input.threadId,
          turnId: TurnId.make("foundry-turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/foundry-turn-1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-1"),
          completedAt: now,
        },
      } satisfies OrchestrationEvent;
      const driver = makeFoundryT3Driver({
        client: client({
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.make(
              {
                kind: "snapshot",
                snapshot: {
                  snapshotSequence: 3,
                  thread: detailThread({ turn, latest: latestTurn("running") }),
                },
              },
              { kind: "event", event: checkpointEvent },
            ),
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.make(
              { kind: "snapshot", snapshot: shellSnapshot(turn, [runningShell]) },
              { kind: "thread-upserted", sequence: 5, thread: completedShell },
            ),
        }),
        git: gitInspector(run),
      });

      const terminal = yield* driver.awaitTurnTerminal({
        turn,
        turnId: TurnId.make("foundry-turn-1"),
        origin: "started",
      });

      expect(terminal).toEqual({
        outcome: "succeeded",
        threadId: turn.input.threadId,
        commandId: turn.input.commandId,
        turnId: TurnId.make("foundry-turn-1"),
        checkpointRef: CheckpointRef.make("refs/t3/checkpoints/foundry-turn-1"),
      });
    }),
  );

  it.effect("requeues an adopted turn whose approval callback cannot be proven live", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const pendingShell = {
        ...threadShell(turn, latestTurn("running")),
        hasPendingApprovals: true,
      };
      const retryGate = testRetryGate();
      const driver = makeFoundryT3Driver({
        client: client({
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.make({ kind: "snapshot", snapshot: shellSnapshot(turn, [pendingShell]) }),
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () => Stream.never,
        }),
        git: gitInspector(run),
        retryGate,
      });

      const failure = yield* driver
        .awaitTurnTerminal({
          turn,
          turnId: TurnId.make("foundry-turn-1"),
          origin: "adopted",
        })
        .pipe(Effect.flip);

      expect(failure.code).toBe("turn-failed");
      expect(failure.retryable).toBe(true);
      expect(failure.retryMode).toBe("after-lease-expiry");
      expect(retryGate.remainingDelayMilliseconds()).toBe(60_000);
    }),
  );

  it.effect("detects a pending approval that appears after the adopted shell snapshot", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const runningShell = {
        ...threadShell(turn, latestTurn("running")),
        hasPendingApprovals: false,
      };
      const pendingShell = { ...runningShell, hasPendingApprovals: true };
      const retryGate = testRetryGate();
      const driver = makeFoundryT3Driver({
        client: client({
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.make(
              { kind: "snapshot", snapshot: shellSnapshot(turn, [runningShell]) },
              { kind: "thread-upserted", sequence: 4, thread: pendingShell },
            ),
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () => Stream.never,
        }),
        git: gitInspector(run),
        retryGate,
      });

      const failure = yield* driver
        .awaitTurnTerminal({
          turn,
          turnId: TurnId.make("foundry-turn-1"),
          origin: "adopted",
        })
        .pipe(Effect.flip);

      expect(failure.retryMode).toBe("after-lease-expiry");
      expect(retryGate.remainingDelayMilliseconds()).toBe(60_000);
    }),
  );

  it.effect("fails a stale turn when T3 reports an error terminal state", () =>
    Effect.gen(function* () {
      const run = approvedRun();
      const turn = compiledTurn(run);
      const errorShell = threadShell(turn, latestTurn("error"));
      const driver = makeFoundryT3Driver({
        client: client({
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.make({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: 3,
                thread: detailThread({ turn, latest: latestTurn("error") }),
              },
            }),
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.make({ kind: "snapshot", snapshot: shellSnapshot(turn, [errorShell]) }),
        }),
        git: gitInspector(run),
      });

      const terminal = yield* driver.awaitTurnTerminal({
        turn,
        turnId: TurnId.make("foundry-turn-1"),
        origin: "started",
      });

      expect(terminal).toMatchObject({ outcome: "failed", failureCode: "turn-failed" });
    }),
  );
});
