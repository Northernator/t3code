/** Contract-level tests for the transport-independent governance core. */
import { describe, expect, it } from "vite-plus/test";

import {
  approveFeatureContract,
  canonicalizeJson,
  type FeatureContractBody,
  type FeatureProposal,
  type FounderApproval,
  type FounderIdentity,
  FoundryGovernanceError,
  proposeFeatureContract,
  queueFeatureDispatch,
  verifyApprovedFeatureProposal,
  type ApprovalProofVerifier,
  type VerifiedFeatureProposal,
} from "./Governance.ts";

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
  verificationCommands: ["vp test run apps/server/src/foundry/Governance.test.ts"],
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
    limits: {
      maximumTurns: 20,
      maximumRetries: 2,
    },
  },
  riskFlags: ["clipboard-data"],
};

const verifier: ApprovalProofVerifier = {
  verify: ({ founder, subject, proof }) =>
    proof.format === "test/v1" && proof.encodedEvent === `${founder.publicKey}:${subject}`,
};

function approvalFor(proposal: FeatureProposal, founder: FounderIdentity): FounderApproval {
  return {
    founderId: founder.id,
    contentHash: proposal.contentHash,
    proof: {
      format: "test/v1",
      encodedEvent: `${founder.publicKey}:${proposal.approvalSubject}`,
    },
  };
}

function expectGovernanceError(action: () => unknown, code: FoundryGovernanceError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FoundryGovernanceError);
    expect((error as FoundryGovernanceError).code).toBe(code);
    return;
  }
  throw new Error(`Expected FoundryGovernanceError '${code}'.`);
}

function fullyApprovedProposal(): FeatureProposal {
  const proposed = proposeFeatureContract({ body, founders });
  const aliceApproved = approveFeatureContract({
    proposal: proposed,
    approval: approvalFor(proposed, founders[0]),
    founders,
    verifier,
  });
  return approveFeatureContract({
    proposal: aliceApproved,
    approval: approvalFor(proposed, founders[1]),
    founders,
    verifier,
  });
}

describe("Foundry governance", () => {
  it("canonicalizes equivalent JSON identically", () => {
    const left = canonicalizeJson({ z: 1, nested: { b: true, a: "same" } });
    const right = canonicalizeJson({ nested: { a: "same", b: true }, z: 1 });

    expect(left).toBe('{"nested":{"a":"same","b":true},"z":1}');
    expect(right).toBe(left);
  });

  it("rejects values that are not canonical JSON", () => {
    const sparse: Array<unknown> = [];
    sparse.length = 1;

    expectGovernanceError(() => canonicalizeJson({ invalid: Number.NaN }), "invalid-contract");
    expectGovernanceError(() => canonicalizeJson({ invalid: undefined }), "invalid-contract");
    expectGovernanceError(() => canonicalizeJson("\ud800"), "invalid-contract");
    expectGovernanceError(() => canonicalizeJson(sparse), "invalid-contract");
  });

  it("requires the current schema and an immutable Git object ID", () => {
    expectGovernanceError(
      () =>
        proposeFeatureContract({
          body: { ...body, schemaVersion: 2 as 1 },
          founders,
        }),
      "invalid-contract",
    );
    expectGovernanceError(
      () =>
        proposeFeatureContract({
          body: { ...body, repository: { ...body.repository, baseSha: "main" } },
          founders,
        }),
      "invalid-contract",
    );
  });

  it("requires exactly two distinct founders", () => {
    expectGovernanceError(
      () => proposeFeatureContract({ body, founders: [founders[0]] }),
      "invalid-founder-set",
    );
    expectGovernanceError(
      () => proposeFeatureContract({ body, founders: [founders[0], founders[0]] }),
      "invalid-founder-set",
    );
    expectGovernanceError(
      () =>
        proposeFeatureContract({
          body,
          founders: [founders[0], { id: "founder-mallory", publicKey: founders[0].publicKey }],
        }),
      "invalid-founder-set",
    );
  });

  it("binds approvals to the immutable contract hash", () => {
    const proposed = proposeFeatureContract({ body, founders });
    const revised = proposeFeatureContract({
      founders,
      body: {
        ...body,
        version: 2,
        objective: `${body.objective} Keep the list local to the device.`,
      },
    });

    expect(revised.contentHash).not.toBe(proposed.contentHash);
    expect(revised.approvals).toEqual([]);
    expectGovernanceError(
      () =>
        approveFeatureContract({
          proposal: revised,
          approval: approvalFor(proposed, founders[0]),
          founders,
          verifier,
        }),
      "hash-mismatch",
    );
  });

  it("binds approvals to an immutable founder registry", () => {
    const proposed = proposeFeatureContract({ body, founders });
    const aliceApproved = approveFeatureContract({
      proposal: proposed,
      approval: approvalFor(proposed, founders[0]),
      founders,
      verifier,
    });
    const eve = { id: "founder-eve", publicKey: "eve-public-key" };
    const rotatedFounders = [founders[0], eve] as const;
    const rotated = proposeFeatureContract({ body, founders: rotatedFounders });

    expect(Object.isFrozen(proposed.founderIds)).toBe(true);
    expect(Object.isFrozen(proposed.founderRegistry)).toBe(true);
    expect(Object.isFrozen(proposed.founderRegistry[0])).toBe(true);
    expect(rotated.approvalSubject).not.toBe(proposed.approvalSubject);
    expectGovernanceError(
      () =>
        approveFeatureContract({
          proposal: aliceApproved,
          approval: approvalFor(aliceApproved, founders[1]),
          founders: [founders[0], { ...founders[1], publicKey: "rotated-bob-key" }],
          verifier,
        }),
      "founder-registry-mismatch",
    );

    const substitutedProposal: FeatureProposal = {
      ...aliceApproved,
      approvalSubject: rotated.approvalSubject,
      founderRegistry: rotated.founderRegistry,
      founderRegistryHash: rotated.founderRegistryHash,
      founderIds: rotated.founderIds,
    };
    expectGovernanceError(
      () =>
        approveFeatureContract({
          proposal: substitutedProposal,
          approval: approvalFor(substitutedProposal, eve),
          founders: rotatedFounders,
          verifier,
        }),
      "invalid-approval-proof",
    );
  });

  it("needs one valid approval from each founder", () => {
    const proposed = proposeFeatureContract({ body, founders });
    const aliceApproved = approveFeatureContract({
      proposal: proposed,
      approval: approvalFor(proposed, founders[0]),
      founders,
      verifier,
    });

    expect(aliceApproved.state).toBe("awaiting-approval");
    expect(aliceApproved.approvals).toHaveLength(1);
    expectGovernanceError(
      () =>
        approveFeatureContract({
          proposal: aliceApproved,
          approval: approvalFor(proposed, founders[0]),
          founders,
          verifier,
        }),
      "duplicate-approval",
    );

    const approved = approveFeatureContract({
      proposal: aliceApproved,
      approval: approvalFor(proposed, founders[1]),
      founders,
      verifier,
    });
    expect(approved.state).toBe("approved");
    expect(approved.approvals.map(({ founderId }) => founderId)).toEqual([
      "founder-alice",
      "founder-bob",
    ]);
  });

  it("rejects unknown founders and invalid signatures", () => {
    const proposed = proposeFeatureContract({ body, founders });
    const outsider = { id: "founder-eve", publicKey: "eve-public-key" };

    expectGovernanceError(
      () =>
        approveFeatureContract({
          proposal: proposed,
          approval: approvalFor(proposed, outsider),
          founders: [...founders, outsider],
          verifier,
        }),
      "unknown-founder",
    );
    expectGovernanceError(
      () =>
        approveFeatureContract({
          proposal: proposed,
          approval: {
            ...approvalFor(proposed, founders[0]),
            proof: { format: "test/v1", encodedEvent: "forged" },
          },
          founders,
          verifier,
        }),
      "invalid-approval-proof",
    );
  });

  it("revalidates a serialized approved proposal before runner use", () => {
    const approved = fullyApprovedProposal();

    expect(verifyApprovedFeatureProposal({ proposal: approved, founders, verifier })).toEqual(
      approved,
    );
    expectGovernanceError(
      () =>
        verifyApprovedFeatureProposal({
          proposal: {
            ...approved,
            body: {
              ...approved.body,
              objective: "Tampered after approval",
            },
          },
          founders,
          verifier,
        }),
      "proposal-integrity",
    );
    expectGovernanceError(
      () =>
        verifyApprovedFeatureProposal({
          proposal: {
            ...approved,
            approvals: [
              approved.approvals[0]!,
              {
                ...approved.approvals[1]!,
                proof: { format: "test/v1", encodedEvent: "forged" },
              },
            ],
          },
          founders,
          verifier,
        }),
      "invalid-approval-proof",
    );
  });

  it("queues one deterministic dispatch only after both approvals", () => {
    const proposed = proposeFeatureContract({ body, founders });
    expectGovernanceError(
      () =>
        queueFeatureDispatch({
          proposal: proposed as VerifiedFeatureProposal,
          environmentId: "founder-alice-laptop",
        }),
      "contract-not-approved",
    );

    const approved = verifyApprovedFeatureProposal({
      proposal: fullyApprovedProposal(),
      founders,
      verifier,
    });
    const first = queueFeatureDispatch({
      proposal: approved,
      environmentId: "founder-alice-laptop",
    });
    const retry = queueFeatureDispatch({
      proposal: approved,
      environmentId: "founder-alice-laptop",
    });

    expect(retry).toEqual(first);
    expect(first.branch).toBe(`foundry/clipboard-history-v1-${approved.contentHash.slice(0, 12)}`);
    expect(first.baseSha).toBe(body.repository.baseSha);
    expectGovernanceError(
      () =>
        queueFeatureDispatch({
          proposal: { ...approved } as VerifiedFeatureProposal,
          environmentId: "founder-alice-laptop",
        }),
      "contract-not-approved",
    );
    expectGovernanceError(
      () => queueFeatureDispatch({ proposal: approved, environmentId: "founder-bob-laptop" }),
      "environment-mismatch",
    );
  });
});
