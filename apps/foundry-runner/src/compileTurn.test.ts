import {
  approveFeatureContract,
  type ApprovalProofVerifier,
  type FeatureContractBody,
  type FounderIdentity,
  proposeFeatureContract,
  queueFeatureDispatch,
  verifyApprovedFeatureProposal,
} from "@t3tools/foundry-governance";
import { describe, expect, it } from "vite-plus/test";

import {
  compileApprovedTurn,
  compileApprovedWorktree,
  CompileTurnError,
  type CompileTurnErrorCode,
  type LocalRunnerBinding,
} from "./compileTurn.ts";

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

const verifier: ApprovalProofVerifier = {
  verify: ({ founder, subject, proof }) =>
    proof.format === "test/v1" && proof.encodedEvent === `${founder.publicKey}:${subject}`,
};

const binding: LocalRunnerBinding = {
  environmentId: "founder-alice-laptop",
  repositoryRemoteId: "midlow/hotpaste",
  foundryProjectId: "hotpaste",
  t3ProjectId: "local-hotpaste-project",
  projectCwd: "C:\\dev\\hotpaste",
  provider: "codex-primary",
  providerInstanceId: "codex-work",
  allowedModels: ["gpt-5.6-sol-ultra"],
  allowedBaseBranches: ["main"],
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
      environmentId: "founder-alice-laptop",
    }),
  };
}

function preparedWorktree(run: ReturnType<typeof approvedRun>) {
  return {
    worktree: {
      path: "C:\\dev\\hotpaste-worktrees\\clipboard-history",
      refName: run.dispatch.branch,
    },
  };
}

function expectCompileError(action: () => unknown, code: CompileTurnErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CompileTurnError);
    expect((error as CompileTurnError).code).toBe(code);
    return;
  }
  throw new Error(`Expected CompileTurnError '${code}'.`);
}

function createdThreadFrom(compiled: ReturnType<typeof compileApprovedTurn>) {
  const created = compiled.input.bootstrap?.createThread;
  if (!created) {
    throw new Error("Expected a bootstrapped thread.");
  }
  return {
    id: compiled.input.threadId,
    projectId: created.projectId,
    title: created.title,
    modelSelection: created.modelSelection,
    runtimeMode: created.runtimeMode,
    interactionMode: created.interactionMode,
    branch: created.branch,
    worktreePath: created.worktreePath,
    createdAt: created.createdAt,
  };
}

describe("compileApprovedTurn", () => {
  it("compiles a deterministic supervised T3 worktree turn", () => {
    const run = approvedRun();
    const first = compileApprovedTurn({
      ...run,
      binding,
      worktree: preparedWorktree(run),
      createdAt: "2026-08-10T12:02:00.000Z",
    });
    const existingThread = createdThreadFrom(first);
    const replay = compileApprovedTurn({
      ...run,
      binding,
      worktree: preparedWorktree(run),
      existingThread,
      createdAt: "2026-08-10T12:02:00.000Z",
    });

    expect(replay.input.commandId).toBe(first.input.commandId);
    expect(replay.input.threadId).toBe(first.input.threadId);
    expect(replay.input.message).toEqual(first.input.message);
    expect(first.threadAction).toBe("create");
    expect(replay.threadAction).toBe("adopt");
    expect(first.expectedThread.title).toBe(body.title);
    expect(replay.expectedThread.title).toBe(body.title);
    expect(replay.input.bootstrap).toBeUndefined();
    expect(first.environmentId).toBe(binding.environmentId);
    expect(first.input.runtimeMode).toBe("approval-required");
    expect(first.input.titleSeed).toBeUndefined();
    expect(first.input.bootstrap?.createThread?.runtimeMode).toBe("approval-required");
    expect(first.input.bootstrap?.createThread?.branch).toBe(run.dispatch.branch);
    expect(first.input.bootstrap?.createThread?.worktreePath).toBe(
      preparedWorktree(run).worktree.path,
    );
    expect(first.input.bootstrap?.prepareWorktree).toBeUndefined();
    expect(first.input.bootstrap?.runSetupScript).toBe(false);
    expect(first.input.message.text).toContain(run.proposal.contentHash);
    expect(first.input.message.text).not.toContain(binding.projectCwd);
  });

  it("takes paths and provider instances only from local configuration", () => {
    const run = approvedRun();
    const localBinding = {
      ...binding,
      projectCwd: "D:\\isolated\\hotpaste",
      providerInstanceId: "codex-founder-a",
    };
    const worktree = compileApprovedWorktree({ ...run, binding: localBinding });
    const compiled = compileApprovedTurn({
      ...run,
      binding: localBinding,
      worktree: preparedWorktree(run),
      createdAt: "2026-08-10T12:02:00.000Z",
    });

    expect(worktree.action).toBe("create");
    if (worktree.action !== "create") {
      throw new Error("Expected a worktree creation plan.");
    }
    expect(worktree.input.cwd).toBe("D:\\isolated\\hotpaste");
    expect(compiled.input.modelSelection?.instanceId).toBe("codex-founder-a");
  });

  it("separates the immutable start commit from pull-request base metadata", () => {
    const run = approvedRun();
    const worktree = compileApprovedWorktree({ ...run, binding });

    expect(worktree.action).toBe("create");
    if (worktree.action !== "create") {
      throw new Error("Expected a worktree creation plan.");
    }
    expect(worktree.input).toEqual({
      cwd: binding.projectCwd,
      refName: body.repository.baseSha,
      newRefName: run.dispatch.branch,
      baseRefName: body.repository.baseBranch,
      path: null,
    });
  });

  it("adopts the exact existing dispatch worktree on replay", () => {
    const run = approvedRun();
    const existingWorktree = preparedWorktree(run);
    const replay = compileApprovedWorktree({
      ...run,
      binding,
      existingWorktree,
    });

    expect(replay).toEqual({
      environmentId: binding.environmentId,
      action: "adopt",
      input: null,
      worktree: existingWorktree,
    });
  });

  it("reattaches an existing dispatch branch that has no worktree", () => {
    const run = approvedRun();
    const replay = compileApprovedWorktree({
      ...run,
      binding,
      existingRef: {
        name: run.dispatch.branch,
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    });

    expect(replay).toEqual({
      environmentId: binding.environmentId,
      action: "create",
      input: {
        cwd: binding.projectCwd,
        refName: run.dispatch.branch,
        path: null,
      },
      worktree: null,
    });
  });

  it("rejects an attached branch unless the caller supplies the observed worktree", () => {
    const run = approvedRun();
    expectCompileError(
      () =>
        compileApprovedWorktree({
          ...run,
          binding,
          existingRef: {
            name: run.dispatch.branch,
            current: false,
            isDefault: false,
            worktreePath: "C:\\dev\\hotpaste-worktrees\\clipboard-history",
          },
        }),
      "worktree-mismatch",
    );
  });

  it("rejects a proposal whose local verification mark was lost", () => {
    const run = approvedRun();
    expectCompileError(
      () =>
        compileApprovedWorktree({
          ...run,
          proposal: { ...run.proposal } as typeof run.proposal,
          binding,
        }),
      "contract-not-approved",
    );
  });

  it("rejects every mutable dispatch identity field", () => {
    const run = approvedRun();
    const dispatches = [
      { ...run.dispatch, id: "dispatch_forged" },
      { ...run.dispatch, idempotencyKey: "0".repeat(64) },
      { ...run.dispatch, branch: "foundry/forged-v1" },
      { ...run.dispatch, baseSha: "different" },
    ];

    for (const dispatch of dispatches) {
      expectCompileError(
        () =>
          compileApprovedTurn({
            ...run,
            dispatch,
            binding,
            worktree: preparedWorktree(run),
            createdAt: "2026-08-10T12:02:00.000Z",
          }),
        "dispatch-mismatch",
      );
    }
  });

  it("enforces local project, repository, provider, model, and branch allow-lists", () => {
    const run = approvedRun();
    const cases: ReadonlyArray<readonly [Partial<LocalRunnerBinding>, CompileTurnErrorCode]> = [
      [{ environmentId: "founder-bob-laptop" }, "environment-not-allowed"],
      [{ foundryProjectId: "midlow-site" }, "project-not-allowed"],
      [{ repositoryRemoteId: "midlow/other" }, "repository-not-allowed"],
      [{ provider: "claude-primary" }, "provider-not-allowed"],
      [{ allowedModels: ["different-model"] }, "model-not-allowed"],
      [{ allowedBaseBranches: ["develop"] }, "base-branch-not-allowed"],
    ];

    for (const [change, code] of cases) {
      expectCompileError(
        () =>
          compileApprovedTurn({
            ...run,
            binding: { ...binding, ...change },
            worktree: preparedWorktree(run),
            createdAt: "2026-08-10T12:02:00.000Z",
          }),
        code,
      );
    }
  });

  it("rejects a prepared worktree for a different branch", () => {
    const run = approvedRun();
    expectCompileError(
      () =>
        compileApprovedTurn({
          ...run,
          binding,
          worktree: {
            worktree: { path: "C:\\dev\\other", refName: "foundry/other-v1" },
          },
          createdAt: "2026-08-10T12:02:00.000Z",
        }),
      "worktree-mismatch",
    );
  });

  it("rejects an existing thread bound to different execution metadata", () => {
    const run = approvedRun();
    const created = compileApprovedTurn({
      ...run,
      binding,
      worktree: preparedWorktree(run),
      createdAt: "2026-08-10T12:02:00.000Z",
    });
    expectCompileError(
      () =>
        compileApprovedTurn({
          ...run,
          binding,
          worktree: preparedWorktree(run),
          existingThread: { ...createdThreadFrom(created), branch: "foundry/other-v1" },
          createdAt: "2026-08-10T12:02:00.000Z",
        }),
      "thread-mismatch",
    );
  });
});
