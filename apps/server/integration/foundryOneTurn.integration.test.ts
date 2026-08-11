// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { schnorr } from "@noble/curves/secp256k1";
import {
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type FoundryApprovedContractPacket,
  ProjectId,
  ProviderDriverKind,
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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  compileApprovedTurn,
  compileApprovedWorktree,
  type LocalRunnerBinding,
} from "../../foundry-runner/src/compileTurn.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import {
  gitRefExists,
  gitShowFileAtRef,
  makeOrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";

const ALICE_PRIVATE_KEY = `${"00".repeat(31)}01`;
const BOB_PRIVATE_KEY = `${"00".repeat(31)}02`;
const BUZZ_GROUP_ID = "foundry-one-turn";
const BUZZ_RELAY_URL = "wss://buzz.example/";
const CREATED_AT = "2026-08-11T10:00:00.000Z";
const ENVIRONMENT_ID = "founder-alice-laptop";
const PROVIDER = ProviderDriverKind.make("codex");

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const founders = [
  { id: "founder-alice", publicKey: toHex(schnorr.getPublicKey(ALICE_PRIVATE_KEY)) },
  { id: "founder-bob", publicKey: toHex(schnorr.getPublicKey(BOB_PRIVATE_KEY)) },
] as const;

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

function approvedPacket(body: FeatureContractBody): FoundryApprovedContractPacket {
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

it.live("executes one signed Foundry contract as a deterministic approval-required T3 turn", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({
      provider: PROVIDER,
      localRefNameForCwd: (cwd) => runGit(cwd, ["branch", "--show-current"]) || null,
    }),
    (harness) =>
      Effect.gen(function* () {
        const baseSha = runGit(harness.workspaceDir, ["rev-parse", "HEAD"]);
        const model = DEFAULT_MODEL_BY_PROVIDER[PROVIDER] ?? DEFAULT_MODEL;
        const providerInstanceId = defaultInstanceIdForDriver(PROVIDER);
        const body: FeatureContractBody = {
          schemaVersion: 1,
          projectId: "hotpaste",
          featureId: "signed-one-turn",
          version: 1,
          title: "Signed Foundry one-turn proof",
          objective: "Write one fixture artifact through the T3 orchestration engine.",
          inScope: ["Create foundry-proof.txt"],
          outOfScope: ["Call a paid or remote model"],
          constraints: ["Run in approval-required mode"],
          acceptanceCriteria: ["A ready checkpoint contains foundry-proof.txt"],
          verificationCommands: ["git show refs/t3/checkpoints/<thread>/turn/1:foundry-proof.txt"],
          repository: {
            remoteId: "fixture/hotpaste",
            baseBranch: "main",
            baseSha,
          },
          execution: {
            environmentId: ENVIRONMENT_ID,
            provider: PROVIDER,
            model,
            runtimeMode: "approval-required",
            limits: { maximumTurns: 1, maximumRetries: 2 },
          },
          riskFlags: [],
        };
        const packet = approvedPacket(body);
        const ingestion = ingestApprovedContractPacket({
          packet,
          founders,
          identityAdapters: [
            makeBuzzNostrIdentityAdapter({
              groupId: BUZZ_GROUP_ID,
              relayUrl: BUZZ_RELAY_URL,
            }),
          ],
        });
        const dispatch = queueFeatureDispatch({
          proposal: ingestion.proposal,
          environmentId: ENVIRONMENT_ID,
        });
        const projectId = ProjectId.make("foundry-fixture-project");
        const binding: LocalRunnerBinding = {
          environmentId: ENVIRONMENT_ID,
          repositoryRemoteId: body.repository.remoteId,
          foundryProjectId: body.projectId,
          t3ProjectId: projectId,
          projectCwd: harness.workspaceDir,
          provider: PROVIDER,
          providerInstanceId,
          allowedModels: [model],
          allowedBaseBranches: [body.repository.baseBranch],
        };

        const worktreePlan = compileApprovedWorktree({
          proposal: ingestion.proposal,
          dispatch,
          binding,
          existingRef: null,
          existingWorktree: null,
        });
        assert.equal(worktreePlan.action, "create");
        assert.equal(worktreePlan.input?.refName, baseSha);
        assert.equal(worktreePlan.input?.newRefName, dispatch.branch);

        const worktreePath = NodePath.join(harness.rootDir, "foundry-worktree");
        runGit(harness.workspaceDir, [
          "worktree",
          "add",
          "-b",
          dispatch.branch,
          worktreePath,
          baseSha,
        ]);
        assert.equal(runGit(worktreePath, ["branch", "--show-current"]), dispatch.branch);
        const worktree: VcsCreateWorktreeResult = {
          worktree: { path: worktreePath, refName: dispatch.branch },
        };
        const turn = compileApprovedTurn({
          proposal: ingestion.proposal,
          dispatch,
          binding,
          worktree,
          existingThread: null,
          createdAt: CREATED_AT,
        });
        assert.equal(turn.threadAction, "create");
        assert.equal(turn.input.runtimeMode, "approval-required");
        const idSuffix = dispatch.idempotencyKey.slice(0, 32);
        assert.equal(turn.input.threadId, `foundry-thread-${idSuffix}`);
        assert.equal(turn.input.commandId, `foundry-command-${idSuffix}`);
        assert.equal(turn.input.message.messageId, `foundry-message-${idSuffix}`);

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("foundry-fixture-project-create"),
          projectId,
          title: "Foundry Fixture Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId: providerInstanceId, model },
          createdAt: CREATED_AT,
        });

        const createThread = turn.input.bootstrap?.createThread;
        if (!createThread) {
          throw new Error(
            "Expected the first compiled turn to bootstrap its deterministic thread.",
          );
        }
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("foundry-fixture-thread-create"),
          threadId: turn.input.threadId,
          projectId: createThread.projectId,
          title: createThread.title,
          modelSelection: createThread.modelSelection,
          runtimeMode: createThread.runtimeMode,
          interactionMode: createThread.interactionMode,
          branch: createThread.branch,
          worktreePath: createThread.worktreePath,
          createdAt: createThread.createdAt,
        });

        const response: TestTurnResponse = {
          events: [
            {
              type: "turn.started",
              eventId: EventId.make("foundry-fixture-turn-started"),
              provider: PROVIDER,
              createdAt: "2026-08-11T10:00:01.000Z",
              threadId: turn.input.threadId,
              turnId: "foundry-fixture-provider-turn",
            },
            {
              type: "message.delta",
              eventId: EventId.make("foundry-fixture-message-delta"),
              provider: PROVIDER,
              createdAt: "2026-08-11T10:00:02.000Z",
              threadId: turn.input.threadId,
              turnId: "foundry-fixture-provider-turn",
              delta: "Implemented the signed fixture contract.\n",
            },
            {
              type: "turn.completed",
              eventId: EventId.make("foundry-fixture-turn-completed"),
              provider: PROVIDER,
              createdAt: "2026-08-11T10:00:03.000Z",
              threadId: turn.input.threadId,
              turnId: "foundry-fixture-provider-turn",
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              NodeFS.writeFileSync(
                NodePath.join(cwd, "foundry-proof.txt"),
                `${ingestion.proposal.contentHash}\n`,
                "utf8",
              );
            }),
        };
        yield* harness.adapterHarness!.queueTurnResponseForNextSession(response);
        const { bootstrap: _bootstrap, ...turnStartInput } = turn.input;
        if (!turnStartInput.commandId || !turnStartInput.createdAt) {
          throw new Error("Expected the compiled turn to have durable command metadata.");
        }
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          ...turnStartInput,
          message: { ...turnStartInput.message, attachments: [] },
          commandId: turnStartInput.commandId,
          createdAt: turnStartInput.createdAt,
        });

        const finalized = yield* harness.waitForReceipt(
          (receipt): receipt is CheckpointDiffFinalizedReceipt =>
            receipt.type === "checkpoint.diff.finalized" &&
            receipt.threadId === turn.input.threadId &&
            receipt.checkpointTurnCount === 1,
        );
        if (finalized.type !== "checkpoint.diff.finalized") {
          throw new Error("Expected a checkpoint.diff.finalized receipt.");
        }
        assert.equal(finalized.status, "ready");
        assert.equal(finalized.turnId, "turn-1");
        const quiesced = yield* harness.waitForReceipt(
          (receipt): receipt is TurnProcessingQuiescedReceipt =>
            receipt.type === "turn.processing.quiesced" &&
            receipt.threadId === turn.input.threadId &&
            receipt.checkpointTurnCount === 1,
        );
        if (quiesced.type !== "turn.processing.quiesced") {
          throw new Error("Expected a turn.processing.quiesced receipt.");
        }
        assert.equal(quiesced.turnId, "turn-1");
        yield* harness.drainProviderRuntime;
        yield* harness.drainCheckpointReactor;

        const thread = yield* harness.waitForThread(
          turn.input.threadId,
          (entry) => entry.session?.status === "ready" && entry.checkpoints.length === 1,
        );
        assert.equal(thread.id, turn.input.threadId);
        assert.equal(thread.projectId, projectId);
        assert.equal(thread.runtimeMode, "approval-required");
        assert.equal(thread.branch, dispatch.branch);
        assert.equal(thread.worktreePath, worktreePath);
        assert.deepEqual(thread.modelSelection, { instanceId: providerInstanceId, model });
        assert.equal(thread.session?.providerName, PROVIDER);
        assert.equal(thread.session?.runtimeMode, "approval-required");
        assert.equal(thread.session?.status, "ready");
        assert.equal(thread.latestTurn?.turnId, "turn-1");
        assert.equal(thread.latestTurn?.state, "completed");
        assert.equal(thread.messages.filter((message) => message.role === "user").length, 1);
        assert.equal(thread.messages[0]?.id, turn.input.message.messageId);
        assert.equal(
          thread.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.text === "Implemented the signed fixture contract.\n",
          ),
          true,
        );
        assert.equal(thread.checkpoints[0]?.status, "ready");
        assert.equal(harness.adapterHarness!.getStartCount(), 1);

        const checkpointRef = checkpointRefForThreadTurn(turn.input.threadId, 1);
        assert.equal(finalized.checkpointRef, checkpointRef);
        assert.equal(thread.checkpoints[0]?.checkpointRef, checkpointRef);
        const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
          threadId: turn.input.threadId,
        });
        assert.equal(checkpointRows.length, 1);
        assert.equal(checkpointRows[0]?.checkpointRef, checkpointRef);
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(turn.input.threadId, 0)),
          true,
        );
        assert.equal(gitRefExists(harness.workspaceDir, checkpointRef), true);
        assert.equal(
          gitShowFileAtRef(harness.workspaceDir, checkpointRef, "foundry-proof.txt"),
          `${ingestion.proposal.contentHash}\n`,
        );
        assert.equal(NodeFS.existsSync(harness.dbPath), true);
        const project = yield* harness.snapshotQuery
          .getProjectShellById(projectId)
          .pipe(Effect.map(Option.getOrUndefined));
        assert.deepEqual(project?.defaultModelSelection, { instanceId: providerInstanceId, model });

        const adoptedTurn = compileApprovedTurn({
          proposal: ingestion.proposal,
          dispatch,
          binding,
          worktree,
          existingThread: thread,
          createdAt: CREATED_AT,
        });
        assert.equal(adoptedTurn.threadAction, "adopt");
        assert.equal(adoptedTurn.input.bootstrap, undefined);
        if (!adoptedTurn.input.commandId || !adoptedTurn.input.createdAt) {
          throw new Error("Expected the adopted turn to retain durable command metadata.");
        }
        const beforeReplaySequence = yield* harness.engine.latestSequence;
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          ...adoptedTurn.input,
          message: { ...adoptedTurn.input.message, attachments: [] },
          commandId: adoptedTurn.input.commandId,
          createdAt: adoptedTurn.input.createdAt,
        });
        const afterReplaySequence = yield* harness.engine.latestSequence;
        assert.equal(afterReplaySequence, beforeReplaySequence);
        const afterReplay = yield* harness.snapshotQuery
          .getThreadDetailById(turn.input.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (!afterReplay) {
          throw new Error("Expected the deterministic thread after command replay.");
        }
        assert.equal(afterReplay.messages.filter((message) => message.role === "user").length, 1);
        assert.equal(afterReplay.checkpoints.length, 1);
        assert.equal(harness.adapterHarness!.getStartCount(), 1);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);
