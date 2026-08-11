import {
  type CheckpointRef,
  type CommandId,
  type FoundryDispatchClaim,
  type FoundryDispatchFailureCode,
  type FoundryDispatchReport,
  type FoundryHeartbeatDispatchInput,
  type FoundryReportDispatchInput,
  type FoundryRunnerSessionId,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
  type VcsCreateWorktreeResult,
  type VcsRef,
} from "@t3tools/contracts";
import {
  ingestApprovedContractPacket,
  makeBuzzNostrIdentityAdapter,
  queueFeatureDispatch,
  sha256,
  type FoundryDispatch,
  type VerifiedFeatureProposal,
} from "@t3tools/foundry-governance";
import * as Effect from "effect/Effect";

import {
  compileApprovedTurn,
  compileApprovedWorktree,
  type CompiledT3Turn,
  type CompiledT3Worktree,
  type ExistingT3Thread,
  type LocalRunnerBinding,
} from "./compileTurn.ts";
import type { FoundryRunnerAuthorityConfig } from "./config.ts";

export type FoundryRunnerRetryMode = "none" | "reattach" | "after-lease-expiry";

export class FoundryRunnerError extends Error {
  override readonly name = "FoundryRunnerError";
  readonly code: FoundryDispatchFailureCode;
  readonly retryable: boolean;
  readonly retryMode: FoundryRunnerRetryMode;
  readonly retryDelayMilliseconds: number | null;
  readonly terminalReported: boolean;
  override readonly cause: unknown;

  constructor(
    code: FoundryDispatchFailureCode,
    message: string,
    cause?: unknown,
    retryMode: FoundryRunnerRetryMode = code === "internal" ? "reattach" : "none",
    retryDelayMilliseconds: number | null = null,
    terminalReported = false,
  ) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.retryMode = retryMode;
    this.retryable = retryMode !== "none";
    this.retryDelayMilliseconds = retryDelayMilliseconds;
    this.terminalReported = terminalReported;
  }

  withRetryDelayMilliseconds(retryDelayMilliseconds: number): FoundryRunnerError {
    return new FoundryRunnerError(
      this.code,
      this.message,
      this.cause,
      this.retryMode,
      retryDelayMilliseconds,
      this.terminalReported,
    );
  }

  withTerminalReported(): FoundryRunnerError {
    return new FoundryRunnerError(
      this.code,
      this.message,
      this.cause,
      this.retryMode,
      this.retryDelayMilliseconds,
      true,
    );
  }
}

export type ObservedT3Thread = ExistingT3Thread & Pick<OrchestrationThreadShell, "latestTurn">;

export interface FoundryT3Inventory {
  readonly existingRef: VcsRef | null;
  readonly existingWorktree: VcsCreateWorktreeResult | null;
  readonly existingThread: ObservedT3Thread | null;
}

export interface FoundryTurnTerminalSuccess {
  readonly outcome: "succeeded";
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly turnId: TurnId;
  readonly checkpointRef: CheckpointRef;
}

export interface FoundryTurnTerminalFailure {
  readonly outcome: "failed";
  readonly failureCode: Extract<FoundryDispatchFailureCode, "thread-failed" | "turn-failed">;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly turnId: TurnId | null;
}

export type FoundryTurnTerminal = FoundryTurnTerminalSuccess | FoundryTurnTerminalFailure;

export interface FoundryTurnStart {
  readonly turnId: TurnId;
  readonly origin: "started" | "adopted";
}

export interface FoundryT3Driver {
  readonly inspect: (input: {
    readonly proposal: VerifiedFeatureProposal;
    readonly dispatch: FoundryDispatch;
    readonly binding: LocalRunnerBinding;
  }) => Effect.Effect<FoundryT3Inventory, FoundryRunnerError>;
  readonly prepareWorktree: (input: {
    readonly plan: CompiledT3Worktree;
    readonly proposal: VerifiedFeatureProposal;
    readonly dispatch: FoundryDispatch;
    readonly binding: LocalRunnerBinding;
  }) => Effect.Effect<VcsCreateWorktreeResult, FoundryRunnerError>;
  readonly ensureTurnStarted: (input: {
    readonly turn: CompiledT3Turn;
    readonly existingThread: ObservedT3Thread | null;
  }) => Effect.Effect<FoundryTurnStart, FoundryRunnerError>;
  readonly awaitTurnTerminal: (input: {
    readonly turn: CompiledT3Turn;
    readonly turnId: TurnId;
    readonly origin: FoundryTurnStart["origin"];
  }) => Effect.Effect<FoundryTurnTerminal, FoundryRunnerError>;
}

export interface FoundryDispatchGateway {
  readonly heartbeat: (
    input: FoundryHeartbeatDispatchInput,
  ) => Effect.Effect<void, FoundryRunnerError>;
  readonly report: (input: FoundryReportDispatchInput) => Effect.Effect<void, FoundryRunnerError>;
}

function deterministicEvidenceKey(dispatchIdempotencyKey: string, kind: string): string {
  return sha256(["foundry.dispatch-evidence/v1", dispatchIdempotencyKey, kind].join("\n"));
}

function deterministicReportId(input: {
  readonly dispatchIdempotencyKey: string;
  readonly attemptNumber: number;
  readonly kind: string;
}): string {
  return sha256(
    [
      "foundry.dispatch-report/v1",
      input.dispatchIdempotencyKey,
      String(input.attemptNumber),
      input.kind,
    ].join("\n"),
  );
}

function claimDispatch(input: {
  readonly claim: FoundryDispatchClaim;
  readonly authority: FoundryRunnerAuthorityConfig;
}): { readonly proposal: VerifiedFeatureProposal; readonly dispatch: FoundryDispatch } {
  let proposal: VerifiedFeatureProposal;
  try {
    proposal = ingestApprovedContractPacket({
      packet: input.claim.packet,
      founders: input.authority.founders,
      identityAdapters: [
        makeBuzzNostrIdentityAdapter({
          relayUrl: input.authority.buzzRelayUrl,
          groupId: input.authority.buzzGroupId,
        }),
      ],
    }).proposal;
  } catch (cause) {
    throw new FoundryRunnerError(
      "approval-invalid",
      "The claimed packet failed local founder verification.",
      cause,
    );
  }

  const dispatch = queueFeatureDispatch({
    proposal,
    environmentId: proposal.body.execution.environmentId,
  });
  if (
    dispatch.id !== input.claim.job.dispatchId ||
    dispatch.idempotencyKey !== input.claim.job.dispatchIdempotencyKey ||
    dispatch.contractHash !== input.claim.job.contractHash ||
    dispatch.environmentId !== input.claim.job.environmentId ||
    input.claim.record.contractHash !== dispatch.contractHash ||
    input.claim.record.dispatchIdempotencyKey !== dispatch.idempotencyKey
  ) {
    throw new FoundryRunnerError(
      "approval-invalid",
      "The claimed dispatch does not match the locally verified packet.",
    );
  }
  if (input.authority.environmentId !== dispatch.environmentId) {
    throw new FoundryRunnerError(
      "environment-mismatch",
      "The claimed dispatch targets another Foundry authority environment.",
    );
  }
  return { proposal, dispatch };
}

function reportInput(input: {
  readonly claim: FoundryDispatchClaim;
  readonly runnerId: string;
  readonly runnerSessionId: FoundryRunnerSessionId;
  readonly report: FoundryDispatchReport;
}): FoundryReportDispatchInput {
  return {
    dispatchIdempotencyKey: input.claim.job.dispatchIdempotencyKey,
    runnerId: input.runnerId,
    runnerSessionId: input.runnerSessionId,
    fenceToken: input.claim.attempt.fenceToken,
    reportId: deterministicReportId({
      dispatchIdempotencyKey: input.claim.job.dispatchIdempotencyKey,
      attemptNumber: input.claim.attempt.attemptNumber,
      kind: input.report.kind,
    }),
    report: input.report,
  };
}

function correlation(turn: CompiledT3Turn, turnId: TurnId | null) {
  return {
    threadId: turn.input.threadId,
    commandId: compiledCommandId(turn),
    turnId,
  };
}

function compiledCommandId(turn: CompiledT3Turn): CommandId {
  if (!turn.input.commandId) {
    throw new FoundryRunnerError("thread-failed", "The compiled turn has no command identifier.");
  }
  return turn.input.commandId;
}

export const runClaimedDispatch = Effect.fn("FoundryRunner.runClaimedDispatch")(function* (input: {
  readonly claim: FoundryDispatchClaim;
  readonly runnerId: string;
  readonly runnerSessionId: FoundryRunnerSessionId;
  readonly authority: FoundryRunnerAuthorityConfig;
  readonly binding: LocalRunnerBinding;
  readonly gateway: FoundryDispatchGateway;
  readonly t3: FoundryT3Driver;
}) {
  let turn: CompiledT3Turn | null = null;
  let observedTurnId: TurnId | null = null;

  const execute = Effect.gen(function* () {
    const { proposal, dispatch } = yield* Effect.try({
      try: () => claimDispatch({ claim: input.claim, authority: input.authority }),
      catch: (cause) =>
        cause instanceof FoundryRunnerError
          ? cause
          : new FoundryRunnerError("approval-invalid", "Dispatch verification failed.", cause),
    });
    const inventory = yield* input.t3.inspect({ proposal, dispatch, binding: input.binding });
    const worktreePlan = yield* Effect.try({
      try: () =>
        compileApprovedWorktree({
          proposal,
          dispatch,
          binding: input.binding,
          existingRef: inventory.existingRef,
          existingWorktree: inventory.existingWorktree,
        }),
      catch: (cause) =>
        new FoundryRunnerError("worktree-failed", "Worktree reconciliation failed.", cause),
    });

    yield* input.gateway.report(
      reportInput({
        claim: input.claim,
        runnerId: input.runnerId,
        runnerSessionId: input.runnerSessionId,
        report: {
          kind: "worktree-planned",
          evidenceKey: deterministicEvidenceKey(dispatch.idempotencyKey, "worktree-planned"),
          branch: dispatch.branch,
        },
      }),
    );
    const worktree = yield* input.t3.prepareWorktree({
      plan: worktreePlan,
      proposal,
      dispatch,
      binding: input.binding,
    });
    yield* input.gateway.report(
      reportInput({
        claim: input.claim,
        runnerId: input.runnerId,
        runnerSessionId: input.runnerSessionId,
        report: {
          kind: "worktree-ready",
          evidenceKey: deterministicEvidenceKey(dispatch.idempotencyKey, "worktree-ready"),
          branch: dispatch.branch,
        },
      }),
    );

    turn = yield* Effect.try({
      try: () =>
        compileApprovedTurn({
          proposal,
          dispatch,
          binding: input.binding,
          worktree,
          existingThread: inventory.existingThread,
          createdAt: input.claim.job.createdAt,
        }),
      catch: (cause) => new FoundryRunnerError("thread-failed", "Turn compilation failed.", cause),
    });
    yield* input.gateway.report(
      reportInput({
        claim: input.claim,
        runnerId: input.runnerId,
        runnerSessionId: input.runnerSessionId,
        report: {
          kind: "turn-planned",
          evidenceKey: deterministicEvidenceKey(dispatch.idempotencyKey, "turn-planned"),
          threadId: turn.input.threadId,
          commandId: compiledCommandId(turn),
          messageId: turn.input.message.messageId,
          createdAt: input.claim.job.createdAt,
        },
      }),
    );

    const startedTurn = yield* input.t3.ensureTurnStarted({
      turn,
      existingThread: inventory.existingThread,
    });
    observedTurnId = startedTurn.turnId;
    yield* input.gateway.report(
      reportInput({
        claim: input.claim,
        runnerId: input.runnerId,
        runnerSessionId: input.runnerSessionId,
        report: {
          kind: "turn-started",
          evidenceKey: deterministicEvidenceKey(dispatch.idempotencyKey, "turn-started"),
          threadId: turn.input.threadId,
          commandId: compiledCommandId(turn),
          turnId: observedTurnId,
        },
      }),
    );

    const terminal = yield* input.t3.awaitTurnTerminal({
      turn,
      turnId: observedTurnId,
      origin: startedTurn.origin,
    });
    if (terminal.outcome === "failed") {
      return yield* Effect.fail(
        new FoundryRunnerError(terminal.failureCode, "The T3 turn did not complete successfully."),
      );
    }
    yield* input.gateway.report(
      reportInput({
        claim: input.claim,
        runnerId: input.runnerId,
        runnerSessionId: input.runnerSessionId,
        report: {
          kind: "succeeded",
          evidenceKey: deterministicEvidenceKey(dispatch.idempotencyKey, "succeeded"),
          threadId: terminal.threadId,
          commandId: terminal.commandId,
          turnId: terminal.turnId,
          checkpoint: { status: "ready", checkpointRef: terminal.checkpointRef },
        },
      }),
    );
    return terminal;
  });

  return yield* execute.pipe(
    Effect.catch((cause) => {
      const failure =
        cause instanceof FoundryRunnerError
          ? cause
          : new FoundryRunnerError("internal", "The Foundry runner failed.", cause);
      if (failure.code === "lease-lost" || failure.retryable) {
        return Effect.fail(failure);
      }
      return input.gateway
        .report(
          reportInput({
            claim: input.claim,
            runnerId: input.runnerId,
            runnerSessionId: input.runnerSessionId,
            report: {
              kind: "failed",
              failureCode: failure.code,
              correlation: turn ? correlation(turn, observedTurnId) : null,
            },
          }),
        )
        .pipe(
          Effect.matchEffect({
            onFailure: Effect.fail,
            onSuccess: () => Effect.fail(failure.withTerminalReported()),
          }),
        );
    }),
  );
});
