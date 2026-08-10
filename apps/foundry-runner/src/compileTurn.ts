import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import {
  CommandId,
  MessageId,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import {
  isVerifiedFeatureProposal,
  queueFeatureDispatch,
  type FoundryDispatch,
  type VerifiedFeatureProposal,
} from "@t3tools/foundry-governance";

export interface LocalRunnerBinding {
  readonly environmentId: string;
  readonly repositoryRemoteId: string;
  readonly foundryProjectId: string;
  readonly t3ProjectId: string;
  readonly projectCwd: string;
  readonly provider: string;
  readonly providerInstanceId: string;
  readonly allowedModels: ReadonlyArray<string>;
  readonly allowedBaseBranches: ReadonlyArray<string>;
}

export interface CompiledT3Turn {
  readonly environmentId: string;
  readonly threadAction: "create" | "adopt";
  readonly input: StartThreadTurnInput;
}

export type ExistingT3Thread = Pick<
  OrchestrationThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "branch"
  | "worktreePath"
  | "createdAt"
>;

export type CompiledT3Worktree =
  | {
      readonly environmentId: string;
      readonly action: "create";
      readonly input: VcsCreateWorktreeInput;
      readonly worktree: null;
    }
  | {
      readonly environmentId: string;
      readonly action: "adopt";
      readonly input: null;
      readonly worktree: VcsCreateWorktreeResult;
    };

export type CompileTurnErrorCode =
  | "contract-not-approved"
  | "dispatch-mismatch"
  | "environment-not-allowed"
  | "project-not-allowed"
  | "repository-not-allowed"
  | "provider-not-allowed"
  | "model-not-allowed"
  | "base-branch-not-allowed"
  | "worktree-mismatch"
  | "thread-mismatch"
  | "invalid-local-binding";

export class CompileTurnError extends Error {
  override readonly name = "CompileTurnError";
  readonly code: CompileTurnErrorCode;

  constructor(code: CompileTurnErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: CompileTurnErrorCode, message: string): never {
  throw new CompileTurnError(code, message);
}

function requireLocalValue(field: string, value: string): void {
  if (value.trim().length === 0) {
    fail("invalid-local-binding", `${field} must not be empty.`);
  }
}

function validateLocalBinding(binding: LocalRunnerBinding): void {
  requireLocalValue("environmentId", binding.environmentId);
  requireLocalValue("repositoryRemoteId", binding.repositoryRemoteId);
  requireLocalValue("foundryProjectId", binding.foundryProjectId);
  requireLocalValue("t3ProjectId", binding.t3ProjectId);
  requireLocalValue("projectCwd", binding.projectCwd);
  requireLocalValue("provider", binding.provider);
  requireLocalValue("providerInstanceId", binding.providerInstanceId);
  if (binding.allowedModels.length === 0 || binding.allowedBaseBranches.length === 0) {
    fail("invalid-local-binding", "The local binding needs a model and base-branch allow-list.");
  }
}

function list(title: string, entries: ReadonlyArray<string>): string {
  return `${title}:\n${entries.length === 0 ? "- None" : entries.map((entry) => `- ${entry}`).join("\n")}`;
}

export function renderApprovedFeaturePrompt(proposal: VerifiedFeatureProposal): string {
  const { body } = proposal;
  return [
    `Implement approved Foundry contract ${proposal.contentHash}.`,
    "",
    `Feature: ${body.title}`,
    `Objective: ${body.objective}`,
    "",
    list("In scope", body.inScope),
    "",
    list("Out of scope", body.outOfScope),
    "",
    list("Constraints", body.constraints),
    "",
    list("Acceptance criteria", body.acceptanceCriteria),
    "",
    list("Verification commands", body.verificationCommands),
    "",
    `Base commit: ${body.repository.baseSha}`,
    `Maximum turns: ${body.execution.limits.maximumTurns}`,
    `Maximum repair retries: ${body.execution.limits.maximumRetries}`,
    "Do not expand scope. If the contract cannot be met safely, stop and report the blocker.",
  ].join("\n");
}

function validateApprovedRun(input: {
  readonly proposal: VerifiedFeatureProposal;
  readonly dispatch: FoundryDispatch;
  readonly binding: LocalRunnerBinding;
}): FoundryDispatch {
  validateLocalBinding(input.binding);
  if (!isVerifiedFeatureProposal(input.proposal)) {
    fail("contract-not-approved", "The runner only compiles fully verified proposals.");
  }

  const expectedDispatch = queueFeatureDispatch({
    proposal: input.proposal,
    environmentId: input.proposal.body.execution.environmentId,
  });
  if (
    input.dispatch.id !== expectedDispatch.id ||
    input.dispatch.idempotencyKey !== expectedDispatch.idempotencyKey ||
    input.dispatch.contractHash !== expectedDispatch.contractHash ||
    input.dispatch.environmentId !== expectedDispatch.environmentId ||
    input.dispatch.branch !== expectedDispatch.branch ||
    input.dispatch.baseSha !== expectedDispatch.baseSha ||
    input.dispatch.state !== expectedDispatch.state
  ) {
    fail("dispatch-mismatch", "The dispatch does not match the approved contract.");
  }
  if (input.binding.environmentId !== expectedDispatch.environmentId) {
    fail("environment-not-allowed", "This runner is not bound to the approved environment.");
  }
  if (input.binding.foundryProjectId !== input.proposal.body.projectId) {
    fail("project-not-allowed", "This runner is not bound to the approved Foundry project.");
  }
  if (input.binding.repositoryRemoteId !== input.proposal.body.repository.remoteId) {
    fail("repository-not-allowed", "This runner is not bound to the approved repository.");
  }
  if (input.binding.provider !== input.proposal.body.execution.provider) {
    fail("provider-not-allowed", "The approved provider is not mapped by this runner.");
  }
  if (!input.binding.allowedModels.includes(input.proposal.body.execution.model)) {
    fail("model-not-allowed", "The approved model is not in this runner's allow-list.");
  }
  if (!input.binding.allowedBaseBranches.includes(input.proposal.body.repository.baseBranch)) {
    fail("base-branch-not-allowed", "The approved base branch is not in this runner's allow-list.");
  }

  return expectedDispatch;
}

export function compileApprovedWorktree(input: {
  readonly proposal: VerifiedFeatureProposal;
  readonly dispatch: FoundryDispatch;
  readonly binding: LocalRunnerBinding;
  readonly existingWorktree?: VcsCreateWorktreeResult | null;
}): CompiledT3Worktree {
  const dispatch = validateApprovedRun(input);
  if (input.existingWorktree) {
    if (
      input.existingWorktree.worktree.refName !== dispatch.branch ||
      input.existingWorktree.worktree.path.trim().length === 0
    ) {
      fail("worktree-mismatch", "The existing worktree does not match the approved dispatch.");
    }
    return {
      environmentId: input.binding.environmentId,
      action: "adopt",
      input: null,
      worktree: input.existingWorktree,
    };
  }

  return {
    environmentId: input.binding.environmentId,
    action: "create",
    input: {
      cwd: input.binding.projectCwd,
      refName: input.proposal.body.repository.baseSha,
      newRefName: dispatch.branch,
      baseRefName: input.proposal.body.repository.baseBranch,
      path: null,
    },
    worktree: null,
  };
}

export function compileApprovedTurn(input: {
  readonly proposal: VerifiedFeatureProposal;
  readonly dispatch: FoundryDispatch;
  readonly binding: LocalRunnerBinding;
  readonly worktree: VcsCreateWorktreeResult;
  readonly existingThread?: ExistingT3Thread | null;
  readonly createdAt: string;
}): CompiledT3Turn {
  const dispatch = validateApprovedRun(input);
  if (
    input.worktree.worktree.refName !== dispatch.branch ||
    input.worktree.worktree.path.trim().length === 0
  ) {
    fail("worktree-mismatch", "The prepared worktree does not match the approved dispatch branch.");
  }
  requireLocalValue("createdAt", input.createdAt);

  const idSuffix = dispatch.idempotencyKey.slice(0, 32);
  const threadId = ThreadId.make(`foundry-thread-${idSuffix}`);
  const t3ProjectId = ProjectId.make(input.binding.t3ProjectId);
  const modelSelection = {
    instanceId: ProviderInstanceId.make(input.binding.providerInstanceId),
    model: input.proposal.body.execution.model,
  };
  if (
    input.existingThread &&
    (input.existingThread.id !== threadId ||
      input.existingThread.projectId !== t3ProjectId ||
      input.existingThread.title !== input.proposal.body.title ||
      input.existingThread.modelSelection.instanceId !== modelSelection.instanceId ||
      input.existingThread.modelSelection.model !== modelSelection.model ||
      input.existingThread.runtimeMode !== "approval-required" ||
      input.existingThread.interactionMode !== "default" ||
      input.existingThread.branch !== dispatch.branch ||
      input.existingThread.worktreePath !== input.worktree.worktree.path ||
      input.existingThread.createdAt !== input.createdAt)
  ) {
    fail("thread-mismatch", "The existing T3 thread does not match the approved dispatch.");
  }

  const createThread = {
    projectId: t3ProjectId,
    title: input.proposal.body.title,
    modelSelection,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: input.worktree.worktree.refName,
    worktreePath: input.worktree.worktree.path,
    createdAt: input.createdAt,
  };

  return {
    environmentId: input.binding.environmentId,
    threadAction: input.existingThread ? "adopt" : "create",
    input: {
      commandId: CommandId.make(`foundry-command-${idSuffix}`),
      threadId,
      message: {
        messageId: MessageId.make(`foundry-message-${idSuffix}`),
        role: "user",
        text: renderApprovedFeaturePrompt(input.proposal),
        attachments: [],
      },
      modelSelection,
      titleSeed: input.proposal.body.title,
      runtimeMode: "approval-required",
      interactionMode: "default",
      ...(input.existingThread ? {} : { bootstrap: { createThread, runSetupScript: false } }),
      createdAt: input.createdAt,
    },
  };
}
