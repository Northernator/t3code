import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
  isProviderAvailable,
  type CheckpointRef,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadStreamItem,
  type TurnId,
  type VcsCreateWorktreeResult,
  type VcsRef,
} from "@t3tools/contracts";
import type { FoundryDispatch } from "@t3tools/foundry-governance";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CompiledT3Turn } from "./compileTurn.ts";
import type { FoundryRunnerRetryGate } from "./retryGate.ts";
import {
  FoundryRunnerError,
  type FoundryRunnerRetryMode,
  type FoundryT3Driver,
  type FoundryT3Inventory,
  type FoundryTurnTerminal,
} from "./runClaim.ts";

export interface FoundryGitRefInspection {
  readonly headSha: string;
  readonly baseIsAncestor: boolean;
}

export interface FoundryGitWorktreeInspection extends FoundryGitRefInspection {
  readonly rootPath: string;
  readonly branch: string;
  readonly hasWorkingTreeChanges: boolean;
}

export interface FoundryGitRepositoryInspection {
  readonly rootPath: string;
  readonly remoteName: string;
  readonly canonicalKey: string;
}

export interface FoundryGitInspector {
  readonly inspectRepository: (input: {
    readonly cwd: string;
  }) => Effect.Effect<FoundryGitRepositoryInspection, FoundryRunnerError>;
  readonly inspectRef: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly baseSha: string;
  }) => Effect.Effect<FoundryGitRefInspection, FoundryRunnerError>;
  readonly inspectWorktree: (input: {
    readonly worktreePath: string;
    readonly baseSha: string;
  }) => Effect.Effect<FoundryGitWorktreeInspection, FoundryRunnerError>;
}

interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function t3Error(
  code: ConstructorParameters<typeof FoundryRunnerError>[0],
  message: string,
  cause?: unknown,
): FoundryRunnerError {
  return new FoundryRunnerError(code, message, cause);
}

function retryableT3Error(
  code: ConstructorParameters<typeof FoundryRunnerError>[0],
  message: string,
  cause?: unknown,
  retryMode: Exclude<FoundryRunnerRetryMode, "none"> = "reattach",
): FoundryRunnerError {
  return new FoundryRunnerError(code, message, cause, retryMode);
}

function normalizeGitRemoteUrl(value: string): string {
  const normalized = value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositoryPath = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/");
      if (url.hostname && repositoryPath.includes("/")) {
        return `${url.hostname}/${repositoryPath}`;
      }
    } catch {
      return normalized;
    }
  }

  const scpStyleHostAndPath = /^git@([^:/\s]+)[:/]([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scpStyleHostAndPath?.[1] && scpStyleHostAndPath[2]) {
    return `${scpStyleHostAndPath[1]}/${scpStyleHostAndPath[2]}`;
  }
  return normalized;
}

function parseRemoteFetchUrls(stdout: string): ReadonlyMap<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match?.[1] && match[2]) {
      remotes.set(match[1], match[2]);
    }
  }
  return remotes;
}

function primaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const remoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(remoteName);
    if (remoteUrl) {
      return { remoteName, remoteUrl };
    }
  }
  const [remoteName, remoteUrl] = [...remotes.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )[0] ?? [undefined, undefined];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function canonicalKeyMatchesRemoteId(canonicalKey: string, remoteId: string): boolean {
  const expected = normalizeGitRemoteUrl(remoteId);
  return canonicalKey === expected || canonicalKey.endsWith(`/${expected}`);
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function commandId(turn: CompiledT3Turn) {
  const value = turn.input.commandId;
  if (value === undefined) {
    throw t3Error("thread-failed", "The compiled Foundry turn has no command identifier.");
  }
  return value;
}

function createdAt(turn: CompiledT3Turn) {
  const value = turn.input.createdAt;
  if (value === undefined) {
    throw t3Error("thread-failed", "The compiled Foundry turn has no creation timestamp.");
  }
  return value;
}

function expectedThreadId(dispatch: FoundryDispatch) {
  return ThreadId.make(`foundry-thread-${dispatch.idempotencyKey.slice(0, 32)}`);
}

function worktreeResult(ref: VcsRef): VcsCreateWorktreeResult | null {
  return ref.worktreePath === null
    ? null
    : { worktree: { path: ref.worktreePath, refName: ref.name } };
}

function exactDispatchRef(refs: ReadonlyArray<VcsRef>, branch: string): VcsRef | null {
  const matches = refs.filter((ref) => ref.name === branch && ref.isRemote !== true);
  if (matches.length > 1) {
    throw t3Error("worktree-failed", "T3 returned more than one local dispatch ref.");
  }
  return matches[0] ?? null;
}

function requireSnapshot<A>(
  snapshot: Option.Option<A>,
  message: string,
): Effect.Effect<A, FoundryRunnerError> {
  return Option.match(snapshot, {
    onNone: () => Effect.fail(retryableT3Error("thread-failed", message)),
    onSome: Effect.succeed,
  });
}

export const makeNodeFoundryGitInspector = Effect.fn("FoundryT3Driver.makeNodeFoundryGitInspector")(
  function* (): Effect.fn.Return<
    FoundryGitInspector,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const runGit = Effect.fn("FoundryT3Driver.runGit")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ): Effect.fn.Return<GitCommandResult, FoundryRunnerError> {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
          return yield* Effect.all(
            {
              exitCode: handle.exitCode,
              stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
              stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
            },
            { concurrency: "unbounded" },
          );
        }),
      ).pipe(
        Effect.mapError((cause) =>
          t3Error(
            "worktree-failed",
            "The Foundry runner could not inspect local Git state.",
            cause,
          ),
        ),
      );
      return {
        exitCode: Number(result.exitCode),
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    });

    const requireGitOutput = Effect.fn("FoundryT3Driver.requireGitOutput")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
      description: string,
    ) {
      const result = yield* runGit(cwd, args);
      if (result.exitCode !== 0 || result.stdout.length === 0) {
        return yield* Effect.fail(
          t3Error("worktree-failed", `Git could not resolve ${description}.`, result.stderr),
        );
      }
      return result.stdout;
    });

    const isAncestor = Effect.fn("FoundryT3Driver.isAncestor")(function* (
      cwd: string,
      baseSha: string,
      headSha: string,
    ) {
      const result = yield* runGit(cwd, ["merge-base", "--is-ancestor", baseSha, headSha]);
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* Effect.fail(
          t3Error(
            "worktree-failed",
            "Git could not compare the approved base commit.",
            result.stderr,
          ),
        );
      }
      return result.exitCode === 0;
    });

    const inspectRepository: FoundryGitInspector["inspectRepository"] = Effect.fn(
      "FoundryT3Driver.inspectRepository",
    )(function* (input) {
      const rootPath = yield* requireGitOutput(
        input.cwd,
        ["rev-parse", "--show-toplevel"],
        "the project repository root",
      );
      const remoteResult = yield* runGit(input.cwd, ["remote", "-v"]);
      if (remoteResult.exitCode !== 0) {
        return yield* Effect.fail(
          t3Error(
            "project-unavailable",
            "Git could not inspect the project repository remote.",
            remoteResult.stderr,
          ),
        );
      }
      const remote = primaryRemote(parseRemoteFetchUrls(remoteResult.stdout));
      if (remote === null) {
        return yield* Effect.fail(
          t3Error("project-unavailable", "The project repository has no fetch remote."),
        );
      }
      return {
        rootPath,
        remoteName: remote.remoteName,
        canonicalKey: normalizeGitRemoteUrl(remote.remoteUrl),
      };
    });

    const inspectRef: FoundryGitInspector["inspectRef"] = Effect.fn("FoundryT3Driver.inspectRef")(
      function* (input) {
        const headSha = yield* requireGitOutput(
          input.cwd,
          ["rev-parse", "--verify", `refs/heads/${input.refName}^{commit}`],
          "the deterministic dispatch ref",
        );
        return {
          headSha,
          baseIsAncestor: yield* isAncestor(input.cwd, input.baseSha, headSha),
        };
      },
    );

    const inspectWorktree: FoundryGitInspector["inspectWorktree"] = Effect.fn(
      "FoundryT3Driver.inspectWorktree",
    )(function* (input) {
      const rootPath = yield* requireGitOutput(
        input.worktreePath,
        ["rev-parse", "--show-toplevel"],
        "the dispatch worktree root",
      );
      const branch = yield* requireGitOutput(
        input.worktreePath,
        ["branch", "--show-current"],
        "the dispatch worktree branch",
      );
      const headSha = yield* requireGitOutput(
        input.worktreePath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "the dispatch worktree head",
      );
      const status = yield* runGit(input.worktreePath, ["status", "--porcelain=v1"]);
      if (status.exitCode !== 0) {
        return yield* Effect.fail(
          t3Error("worktree-failed", "Git could not read dispatch worktree status.", status.stderr),
        );
      }
      return {
        rootPath,
        branch,
        headSha,
        baseIsAncestor: yield* isAncestor(input.worktreePath, input.baseSha, headSha),
        hasWorkingTreeChanges: status.stdout.length > 0,
      };
    });

    return { inspectRepository, inspectRef, inspectWorktree };
  },
);

function mapRpcError(code: ConstructorParameters<typeof FoundryRunnerError>[0], message: string) {
  return (cause: unknown) =>
    cause instanceof FoundryRunnerError ? cause : retryableT3Error(code, message, cause);
}

function firstShellSnapshot(
  client: WsRpcProtocolClient,
): Effect.Effect<OrchestrationShellSnapshot, FoundryRunnerError> {
  return client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
    Stream.filter(
      (item): item is Extract<OrchestrationShellStreamItem, { readonly kind: "snapshot" }> =>
        item.kind === "snapshot",
    ),
    Stream.map((item) => item.snapshot),
    Stream.runHead,
    Effect.flatMap((snapshot) =>
      requireSnapshot(snapshot, "T3 ended the shell stream before sending its initial snapshot."),
    ),
    Effect.mapError(mapRpcError("environment-mismatch", "T3 shell inventory is unavailable.")),
  );
}

function firstThreadSnapshot(
  client: WsRpcProtocolClient,
  threadId: ThreadId,
): Effect.Effect<OrchestrationThread, FoundryRunnerError> {
  return client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
    Stream.filter(
      (item): item is Extract<OrchestrationThreadStreamItem, { readonly kind: "snapshot" }> =>
        item.kind === "snapshot",
    ),
    Stream.map((item) => item.snapshot.thread),
    Stream.runHead,
    Effect.flatMap((snapshot) =>
      requireSnapshot(snapshot, "T3 ended the thread stream before sending its initial snapshot."),
    ),
    Effect.mapError(mapRpcError("thread-failed", "The deterministic T3 thread is unavailable.")),
  );
}

function validateWorktreeInspection(input: {
  readonly inspection: FoundryGitWorktreeInspection;
  readonly worktree: VcsCreateWorktreeResult;
  readonly dispatch: FoundryDispatch;
  readonly requirePristineBase: boolean;
}): void {
  if (
    !sameFilesystemPath(input.inspection.rootPath, input.worktree.worktree.path) ||
    input.inspection.branch !== input.dispatch.branch ||
    !input.inspection.baseIsAncestor ||
    (input.requirePristineBase &&
      (input.inspection.headSha !== input.dispatch.baseSha ||
        input.inspection.hasWorkingTreeChanges))
  ) {
    throw t3Error(
      "worktree-failed",
      "The deterministic worktree does not match the approved branch and base commit.",
    );
  }
}

function validateTurnThread(turn: CompiledT3Turn, thread: OrchestrationThread): void {
  const expected = turn.expectedThread;
  if (
    thread.id !== expected.id ||
    thread.projectId !== expected.projectId ||
    thread.title !== expected.title ||
    thread.createdAt !== expected.createdAt ||
    thread.modelSelection.instanceId !== expected.modelSelection.instanceId ||
    thread.modelSelection.model !== expected.modelSelection.model ||
    thread.runtimeMode !== expected.runtimeMode ||
    thread.interactionMode !== expected.interactionMode ||
    thread.branch !== expected.branch ||
    thread.worktreePath !== expected.worktreePath
  ) {
    throw t3Error("thread-failed", "The deterministic T3 thread no longer matches its turn plan.");
  }

  const plannedMessage = thread.messages.find(
    (message) => message.id === turn.input.message.messageId,
  );
  if (
    plannedMessage &&
    (plannedMessage.role !== "user" || plannedMessage.text !== turn.input.message.text)
  ) {
    throw t3Error("thread-failed", "The deterministic T3 message ID has conflicting content.");
  }
  if (
    thread.messages.some(
      (message) => message.role === "user" && message.id !== turn.input.message.messageId,
    )
  ) {
    throw t3Error("thread-failed", "The deterministic Foundry thread contains another user turn.");
  }
  if (thread.latestTurn !== null && plannedMessage === undefined) {
    throw t3Error(
      "thread-failed",
      "The deterministic T3 turn is not correlated to its planned message.",
    );
  }
}

function turnIdFromItem(item: OrchestrationThreadStreamItem): TurnId | null {
  if (item.kind === "snapshot") {
    return item.snapshot.thread.latestTurn?.turnId ?? null;
  }
  if (item.kind !== "event") {
    return null;
  }
  const event = item.event;
  if (event.type === "thread.session-set") {
    return event.payload.session.activeTurnId;
  }
  if (event.type === "thread.turn-diff-completed") {
    return event.payload.turnId;
  }
  if (event.type === "thread.message-sent") {
    return event.payload.turnId;
  }
  return null;
}

function awaitObservedTurnId(
  client: WsRpcProtocolClient,
  turn: CompiledT3Turn,
): Effect.Effect<TurnId, FoundryRunnerError> {
  return client[ORCHESTRATION_WS_METHODS.subscribeThread]({
    threadId: turn.input.threadId,
  }).pipe(
    Stream.mapEffect((item) =>
      Effect.try({
        try: () => {
          if (item.kind === "snapshot") {
            validateTurnThread(turn, item.snapshot.thread);
          }
          if (
            item.kind === "event" &&
            item.event.type === "thread.session-set" &&
            item.event.payload.session.status === "error" &&
            item.event.payload.session.activeTurnId === null
          ) {
            throw t3Error("thread-failed", "T3 failed before assigning the Foundry turn ID.");
          }
          return turnIdFromItem(item);
        },
        catch: (cause) =>
          cause instanceof FoundryRunnerError
            ? cause
            : t3Error("thread-failed", "The T3 turn stream was invalid.", cause),
      }),
    ),
    Stream.filter((turnId): turnId is TurnId => turnId !== null),
    Stream.runHead,
    Effect.flatMap((turnId) => requireSnapshot(turnId, "T3 never assigned the Foundry turn ID.")),
    Effect.mapError(mapRpcError("thread-failed", "The T3 turn could not be observed.")),
  );
}

type TerminalObservation =
  | {
      readonly kind: "turn-state";
      readonly turnId: TurnId;
      readonly state: "running" | "completed" | "interrupted" | "error";
    }
  | {
      readonly kind: "checkpoint";
      readonly turnId: TurnId;
      readonly status: "ready" | "missing" | "error";
      readonly checkpointRef: CheckpointRef;
    }
  | { readonly kind: "thread-removed" };

function terminalObservationsFromThreadItem(
  item: OrchestrationThreadStreamItem,
): ReadonlyArray<TerminalObservation> {
  if (item.kind === "snapshot") {
    const latest = item.snapshot.thread.latestTurn;
    return [
      ...(latest
        ? [{ kind: "turn-state", turnId: latest.turnId, state: latest.state } as const]
        : []),
      ...item.snapshot.thread.checkpoints.map(
        (checkpoint) =>
          ({
            kind: "checkpoint",
            turnId: checkpoint.turnId,
            status: checkpoint.status,
            checkpointRef: checkpoint.checkpointRef,
          }) as const,
      ),
    ];
  }
  if (item.kind !== "event") {
    return [];
  }
  if (item.event.type === "thread.deleted") {
    return [{ kind: "thread-removed" }];
  }
  if (item.event.type === "thread.turn-diff-completed") {
    return [
      {
        kind: "checkpoint",
        turnId: item.event.payload.turnId,
        status: item.event.payload.status,
        checkpointRef: item.event.payload.checkpointRef,
      },
    ];
  }
  return [];
}

function shellTurnObservation(
  thread: OrchestrationThreadShell | undefined,
  turnId: TurnId,
): ReadonlyArray<TerminalObservation> {
  const latest = thread?.latestTurn;
  return latest?.turnId === turnId ? [{ kind: "turn-state", turnId, state: latest.state }] : [];
}

function terminalObservationsFromShellItem(
  item: OrchestrationShellStreamItem,
  threadId: ThreadId,
  turnId: TurnId,
): ReadonlyArray<TerminalObservation> {
  if (item.kind === "snapshot") {
    const thread = item.snapshot.threads.find((candidate) => candidate.id === threadId);
    return thread ? shellTurnObservation(thread, turnId) : [{ kind: "thread-removed" }];
  }
  if (item.kind === "thread-removed" && item.threadId === threadId) {
    return [{ kind: "thread-removed" }];
  }
  if (item.kind === "thread-upserted" && item.thread.id === threadId) {
    return shellTurnObservation(item.thread, turnId);
  }
  return [];
}

function hasPendingApprovalForTurn(
  item: OrchestrationShellStreamItem,
  threadId: ThreadId,
  turnId: TurnId,
): boolean {
  const thread =
    item.kind === "snapshot"
      ? item.snapshot.threads.find((candidate) => candidate.id === threadId)
      : item.kind === "thread-upserted" && item.thread.id === threadId
        ? item.thread
        : undefined;
  return (
    thread?.latestTurn?.turnId === turnId &&
    thread.latestTurn.state === "running" &&
    thread.hasPendingApprovals
  );
}

interface TerminalAccumulator {
  readonly completed: boolean;
  readonly checkpointRef: CheckpointRef | null;
}

function reduceTerminalObservation(input: {
  readonly state: TerminalAccumulator;
  readonly observation: TerminalObservation;
  readonly turn: CompiledT3Turn;
  readonly turnId: TurnId;
}): readonly [TerminalAccumulator, ReadonlyArray<FoundryTurnTerminal>] {
  if (input.observation.kind === "thread-removed") {
    return [
      input.state,
      [
        {
          outcome: "failed",
          failureCode: "thread-failed",
          threadId: input.turn.input.threadId,
          commandId: commandId(input.turn),
          turnId: input.turnId,
        },
      ],
    ];
  }
  if (input.observation.turnId !== input.turnId) {
    return [input.state, []];
  }
  if (
    (input.observation.kind === "turn-state" &&
      (input.observation.state === "interrupted" || input.observation.state === "error")) ||
    (input.observation.kind === "checkpoint" && input.observation.status !== "ready")
  ) {
    return [
      input.state,
      [
        {
          outcome: "failed",
          failureCode: "turn-failed",
          threadId: input.turn.input.threadId,
          commandId: commandId(input.turn),
          turnId: input.turnId,
        },
      ],
    ];
  }

  const state = {
    completed:
      input.state.completed ||
      (input.observation.kind === "turn-state" && input.observation.state === "completed"),
    checkpointRef:
      input.observation.kind === "checkpoint" && input.observation.status === "ready"
        ? input.observation.checkpointRef
        : input.state.checkpointRef,
  };
  return state.completed && state.checkpointRef !== null
    ? [
        state,
        [
          {
            outcome: "succeeded",
            threadId: input.turn.input.threadId,
            commandId: commandId(input.turn),
            turnId: input.turnId,
            checkpointRef: state.checkpointRef,
          },
        ],
      ]
    : [state, []];
}

export function makeFoundryT3Driver(input: {
  readonly client: WsRpcProtocolClient;
  readonly git: FoundryGitInspector;
  readonly retryGate: FoundryRunnerRetryGate;
}): FoundryT3Driver {
  const inspect: FoundryT3Driver["inspect"] = Effect.fn("FoundryT3Driver.inspect")(function* ({
    proposal,
    dispatch,
    binding,
  }) {
    const config = yield* input.client[WS_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(
        mapRpcError("environment-mismatch", "The T3 server configuration is unavailable."),
      ),
    );
    const snapshot = yield* firstShellSnapshot(input.client);
    const inventory = yield* Effect.try({
      try: () => {
        if (config.environment.environmentId !== binding.environmentId) {
          throw t3Error(
            "environment-mismatch",
            "The connected T3 server has another environment ID.",
          );
        }
        const project = snapshot.projects.find((item) => item.id === binding.t3ProjectId);
        if (!project || !sameFilesystemPath(project.workspaceRoot, binding.projectCwd)) {
          throw t3Error(
            "project-unavailable",
            "The configured T3 project and workspace root are not present in this environment.",
          );
        }
        const provider = config.providers.find(
          (item) => item.instanceId === binding.providerInstanceId,
        );
        if (
          !provider ||
          !provider.enabled ||
          !provider.installed ||
          !isProviderAvailable(provider) ||
          provider.status !== "ready" ||
          provider.auth.status !== "authenticated"
        ) {
          throw t3Error(
            "provider-unavailable",
            "The approved T3 provider instance is not installed, enabled, available, ready, and authenticated.",
          );
        }
        if (!provider.models.some((model) => model.slug === proposal.body.execution.model)) {
          throw t3Error(
            "model-unavailable",
            "The approved model is absent from the current T3 provider inventory.",
          );
        }
        return {
          project,
          existingThread:
            snapshot.threads.find((thread) => thread.id === expectedThreadId(dispatch)) ?? null,
        };
      },
      catch: (cause) =>
        cause instanceof FoundryRunnerError
          ? cause
          : t3Error("project-unavailable", "T3 inventory validation failed.", cause),
    });
    const repository = yield* input.git.inspectRepository({ cwd: binding.projectCwd });
    yield* Effect.try({
      try: () => {
        const identity = inventory.project.repositoryIdentity;
        if (
          identity === null ||
          identity === undefined ||
          !sameFilesystemPath(identity.rootPath ?? "", binding.projectCwd) ||
          !sameFilesystemPath(repository.rootPath, binding.projectCwd) ||
          identity.locator.remoteName !== repository.remoteName ||
          normalizeGitRemoteUrl(identity.locator.remoteUrl) !== identity.canonicalKey ||
          repository.canonicalKey !== identity.canonicalKey ||
          !canonicalKeyMatchesRemoteId(identity.canonicalKey, binding.repositoryRemoteId)
        ) {
          throw t3Error(
            "project-unavailable",
            "The T3 project and local Git remote do not match the bound repository identity.",
          );
        }
      },
      catch: (cause) =>
        cause instanceof FoundryRunnerError
          ? cause
          : t3Error("project-unavailable", "Repository identity validation failed.", cause),
    });
    const { existingThread } = inventory;

    const refs = yield* input.client[WS_METHODS.vcsListRefs]({
      cwd: binding.projectCwd,
      query: dispatch.branch,
      refKind: "local",
      refresh: true,
      limit: 100,
    }).pipe(Effect.mapError(mapRpcError("worktree-failed", "T3 could not list dispatch refs.")));
    if (!refs.isRepo) {
      return yield* Effect.fail(
        t3Error("worktree-failed", "The configured T3 project is not a Git repository."),
      );
    }

    const existingRef = yield* Effect.try({
      try: () => exactDispatchRef(refs.refs, dispatch.branch),
      catch: (cause) =>
        cause instanceof FoundryRunnerError
          ? cause
          : t3Error("worktree-failed", "T3 ref reconciliation failed.", cause),
    });
    const existingWorktree = existingRef ? worktreeResult(existingRef) : null;
    if (existingThread && !existingWorktree) {
      return yield* Effect.fail(
        t3Error("worktree-failed", "The deterministic thread has lost its dispatch worktree."),
      );
    }
    if (
      existingThread &&
      existingWorktree &&
      !sameFilesystemPath(existingThread.worktreePath ?? "", existingWorktree.worktree.path)
    ) {
      return yield* Effect.fail(
        t3Error("worktree-failed", "The deterministic thread points at another worktree."),
      );
    }
    if (
      existingWorktree &&
      sameFilesystemPath(existingWorktree.worktree.path, binding.projectCwd)
    ) {
      return yield* Effect.fail(
        t3Error(
          "worktree-failed",
          "The dispatch branch is attached to the primary project checkout.",
        ),
      );
    }

    if (existingWorktree) {
      const inspection = yield* input.git.inspectWorktree({
        worktreePath: existingWorktree.worktree.path,
        baseSha: dispatch.baseSha,
      });
      yield* Effect.try({
        try: () =>
          validateWorktreeInspection({
            inspection,
            worktree: existingWorktree,
            dispatch,
            requirePristineBase: existingThread === null,
          }),
        catch: (cause) =>
          cause instanceof FoundryRunnerError
            ? cause
            : t3Error("worktree-failed", "Worktree validation failed.", cause),
      });
    } else if (existingRef) {
      const inspection = yield* input.git.inspectRef({
        cwd: binding.projectCwd,
        refName: existingRef.name,
        baseSha: dispatch.baseSha,
      });
      if (!inspection.baseIsAncestor || inspection.headSha !== dispatch.baseSha) {
        return yield* Effect.fail(
          t3Error(
            "worktree-failed",
            "The unattached dispatch ref is not at the approved base commit.",
          ),
        );
      }
    }

    return { existingRef, existingWorktree, existingThread } satisfies FoundryT3Inventory;
  });

  const prepareWorktree: FoundryT3Driver["prepareWorktree"] = Effect.fn(
    "FoundryT3Driver.prepareWorktree",
  )(function* ({ plan, dispatch, binding }) {
    if (plan.action === "adopt") {
      if (sameFilesystemPath(plan.worktree.worktree.path, binding.projectCwd)) {
        return yield* Effect.fail(
          t3Error(
            "worktree-failed",
            "The dispatch branch is attached to the primary project checkout.",
          ),
        );
      }
      const inspection = yield* input.git.inspectWorktree({
        worktreePath: plan.worktree.worktree.path,
        baseSha: dispatch.baseSha,
      });
      yield* Effect.try({
        try: () =>
          validateWorktreeInspection({
            inspection,
            worktree: plan.worktree,
            dispatch,
            requirePristineBase: false,
          }),
        catch: (cause) =>
          cause instanceof FoundryRunnerError
            ? cause
            : t3Error("worktree-failed", "Worktree adoption validation failed.", cause),
      });
      return plan.worktree;
    }

    const created = yield* input.client[WS_METHODS.vcsCreateWorktree](plan.input).pipe(
      Effect.mapError(mapRpcError("worktree-failed", "T3 could not create the dispatch worktree.")),
      Effect.catch((createFailure) =>
        input.client[WS_METHODS.vcsListRefs]({
          cwd: binding.projectCwd,
          query: dispatch.branch,
          refKind: "local",
          refresh: true,
          limit: 100,
        }).pipe(
          Effect.mapError(
            mapRpcError("worktree-failed", "T3 could not reconcile worktree creation."),
          ),
          Effect.flatMap((refs) =>
            Effect.try({
              try: () => {
                const ref = exactDispatchRef(refs.refs, dispatch.branch);
                const adopted = ref ? worktreeResult(ref) : null;
                if (!adopted) {
                  throw createFailure;
                }
                return adopted;
              },
              catch: (cause) =>
                cause instanceof FoundryRunnerError
                  ? cause
                  : t3Error("worktree-failed", "Worktree reconciliation failed.", cause),
            }),
          ),
        ),
      ),
    );
    if (sameFilesystemPath(created.worktree.path, binding.projectCwd)) {
      return yield* Effect.fail(
        t3Error("worktree-failed", "T3 returned the primary project checkout as a worktree."),
      );
    }
    const inspection = yield* input.git.inspectWorktree({
      worktreePath: created.worktree.path,
      baseSha: dispatch.baseSha,
    });
    yield* Effect.try({
      try: () =>
        validateWorktreeInspection({
          inspection,
          worktree: created,
          dispatch,
          requirePristineBase: true,
        }),
      catch: (cause) =>
        cause instanceof FoundryRunnerError
          ? cause
          : t3Error("worktree-failed", "Created worktree validation failed.", cause),
    });
    return created;
  });

  const ensureTurnStarted: FoundryT3Driver["ensureTurnStarted"] = Effect.fn(
    "FoundryT3Driver.ensureTurnStarted",
  )(function* ({ turn, existingThread }) {
    let shouldDispatch = existingThread === null;
    if (existingThread) {
      const thread = yield* firstThreadSnapshot(input.client, turn.input.threadId);
      yield* Effect.try({
        try: () => validateTurnThread(turn, thread),
        catch: (cause) =>
          cause instanceof FoundryRunnerError
            ? cause
            : t3Error("thread-failed", "Existing thread validation failed.", cause),
      });
      const messageAlreadyStored = thread.messages.some(
        (message) => message.id === turn.input.message.messageId,
      );
      shouldDispatch = !messageAlreadyStored && thread.latestTurn === null;
      if (thread.latestTurn !== null) {
        return { turnId: thread.latestTurn.turnId, origin: "adopted" };
      }
    }

    if (shouldDispatch) {
      yield* input.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        ...turn.input,
        type: "thread.turn.start",
        commandId: commandId(turn),
        createdAt: createdAt(turn),
      }).pipe(Effect.mapError(mapRpcError("thread-failed", "T3 rejected the Foundry turn.")));
    }
    return {
      turnId: yield* awaitObservedTurnId(input.client, turn),
      origin: shouldDispatch ? "started" : "adopted",
    };
  });

  const awaitTurnTerminal: FoundryT3Driver["awaitTurnTerminal"] = Effect.fn(
    "FoundryT3Driver.awaitTurnTerminal",
  )(function* ({ turn, turnId, origin }) {
    const threadObservations = input.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
      threadId: turn.input.threadId,
    }).pipe(
      Stream.tap((item) =>
        item.kind === "snapshot"
          ? Effect.try({
              try: () => validateTurnThread(turn, item.snapshot.thread),
              catch: (cause) =>
                cause instanceof FoundryRunnerError
                  ? cause
                  : t3Error("thread-failed", "The T3 thread snapshot was invalid.", cause),
            })
          : Effect.void,
      ),
      Stream.flatMap((item) => Stream.fromIterable(terminalObservationsFromThreadItem(item))),
    );
    const shellObservations = input.client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
      Stream.mapEffect((item) => {
        if (origin === "adopted" && hasPendingApprovalForTurn(item, turn.input.threadId, turnId)) {
          input.retryGate.deferActiveLeaseFromNow();
          return Effect.fail(
            retryableT3Error(
              "turn-failed",
              "The adopted T3 turn has a pending approval whose callback cannot be proven live after recovery.",
              undefined,
              "after-lease-expiry",
            ),
          );
        }
        return Effect.succeed(item);
      }),
      Stream.flatMap((item) =>
        Stream.fromIterable(terminalObservationsFromShellItem(item, turn.input.threadId, turnId)),
      ),
    );
    const terminal = yield* Stream.merge(threadObservations, shellObservations).pipe(
      Stream.mapAccum(
        (): TerminalAccumulator => ({ completed: false, checkpointRef: null }),
        (state, observation) => reduceTerminalObservation({ state, observation, turn, turnId }),
      ),
      Stream.runHead,
      Effect.flatMap((result) =>
        requireSnapshot(result, "T3 ended before the Foundry turn reached a terminal state."),
      ),
      Effect.mapError(mapRpcError("thread-failed", "The T3 terminal turn stream failed.")),
    );
    return terminal;
  });

  return { inspect, prepareWorktree, ensureTurnStarted, awaitTurnTerminal };
}
