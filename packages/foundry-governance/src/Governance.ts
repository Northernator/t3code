import { sha256 as sha256Bytes } from "@noble/hashes/sha2";

export type FoundryRuntimeMode = "approval-required";

export interface FounderIdentity {
  readonly id: string;
  readonly publicKey: string;
}

export interface FeatureContractBody {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly featureId: string;
  readonly version: number;
  readonly title: string;
  readonly objective: string;
  readonly inScope: ReadonlyArray<string>;
  readonly outOfScope: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly verificationCommands: ReadonlyArray<string>;
  readonly repository: {
    readonly remoteId: string;
    readonly baseBranch: string;
    readonly baseSha: string;
  };
  readonly execution: {
    readonly environmentId: string;
    readonly provider: string;
    readonly model: string;
    readonly runtimeMode: FoundryRuntimeMode;
    readonly limits: {
      readonly maximumTurns: number;
      readonly maximumRetries: number;
    };
  };
  readonly riskFlags: ReadonlyArray<string>;
}

export interface FounderApproval {
  readonly founderId: string;
  readonly contentHash: string;
  readonly signature: string;
}

export interface FeatureProposal {
  readonly body: FeatureContractBody;
  readonly canonicalBody: string;
  readonly contentHash: string;
  readonly approvalSubject: string;
  readonly founderIds: readonly [string, string];
  readonly approvals: ReadonlyArray<FounderApproval>;
  readonly state: "awaiting-approval" | "approved";
}

const verifiedProposalBrand: unique symbol = Symbol("foundry.verified-proposal");

export interface VerifiedFeatureProposal extends FeatureProposal {
  readonly [verifiedProposalBrand]: true;
}

export function isVerifiedFeatureProposal(
  proposal: FeatureProposal,
): proposal is VerifiedFeatureProposal {
  return (
    (proposal as Partial<VerifiedFeatureProposal>)[verifiedProposalBrand] === true &&
    proposal.state === "approved"
  );
}

export interface FoundryDispatch {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly contractHash: string;
  readonly environmentId: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly state: "queued";
}

export interface ApprovalSignatureVerifier {
  readonly verify: (input: {
    readonly founder: FounderIdentity;
    readonly subject: string;
    readonly signature: string;
  }) => boolean;
}

export type FoundryGovernanceErrorCode =
  | "invalid-contract"
  | "invalid-founder-set"
  | "proposal-integrity"
  | "unknown-founder"
  | "hash-mismatch"
  | "invalid-signature"
  | "duplicate-approval"
  | "already-approved"
  | "contract-not-approved"
  | "environment-mismatch";

export class FoundryGovernanceError extends Error {
  override readonly name = "FoundryGovernanceError";
  readonly code: FoundryGovernanceErrorCode;

  constructor(code: FoundryGovernanceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: FoundryGovernanceErrorCode, message: string): never {
  throw new FoundryGovernanceError(code, message);
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        fail("invalid-contract", "Canonical JSON cannot contain an unpaired high surrogate.");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail("invalid-contract", "Canonical JSON cannot contain an unpaired low surrogate.");
    }
  }
}

function serializeCanonicalJson(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        fail("invalid-contract", "Canonical JSON only accepts finite numbers.");
      }
      return JSON.stringify(value);
    case "string":
      assertValidUnicode(value);
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        fail("invalid-contract", "Canonical JSON cannot contain a cycle.");
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(value);

      if (Array.isArray(value)) {
        const entries: Array<string> = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index)) {
            fail("invalid-contract", "Canonical JSON cannot contain a sparse array.");
          }
          entries.push(serializeCanonicalJson(value[index], nextAncestors));
        }
        return `[${entries.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("invalid-contract", "Canonical JSON only accepts plain objects.");
      }

      const entries = Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      return `{${entries
        .map(([key, entry]) => {
          if (entry === undefined) {
            fail("invalid-contract", `Canonical JSON field '${key}' cannot be undefined.`);
          }
          assertValidUnicode(key);
          return `${JSON.stringify(key)}:${serializeCanonicalJson(entry, nextAncestors)}`;
        })
        .join(",")}}`;
    }
    default:
      return fail("invalid-contract", `Canonical JSON does not accept ${typeof value} values.`);
  }
}

/** RFC 8785-style JSON canonicalization for JSON-compatible Foundry contracts. */
export function canonicalizeJson(value: unknown): string {
  return serializeCanonicalJson(value, new Set());
}

export function sha256(value: string): string {
  return Array.from(sha256Bytes(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function approvalSubjectFor(input: {
  readonly body: FeatureContractBody;
  readonly contentHash: string;
}): string {
  return [
    "foundry.contract.approve/v1",
    input.body.projectId,
    input.body.featureId,
    String(input.body.version),
    input.contentHash,
  ].join("\n");
}

function requireNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    fail("invalid-contract", `${field} must not be empty.`);
  }
}

function validateContract(body: FeatureContractBody): void {
  if (body.schemaVersion !== 1) {
    fail("invalid-contract", "schemaVersion must be 1.");
  }
  requireNonEmpty("projectId", body.projectId);
  requireNonEmpty("title", body.title);
  requireNonEmpty("objective", body.objective);
  requireNonEmpty("repository.remoteId", body.repository.remoteId);
  requireNonEmpty("repository.baseBranch", body.repository.baseBranch);
  requireNonEmpty("repository.baseSha", body.repository.baseSha);
  requireNonEmpty("execution.environmentId", body.execution.environmentId);
  requireNonEmpty("execution.provider", body.execution.provider);
  requireNonEmpty("execution.model", body.execution.model);

  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(body.featureId)) {
    fail(
      "invalid-contract",
      "featureId must be a lowercase, dash-separated identifier of at most 64 characters.",
    );
  }
  if (!Number.isInteger(body.version) || body.version < 1) {
    fail("invalid-contract", "version must be a positive integer.");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(body.repository.baseSha)) {
    fail("invalid-contract", "repository.baseSha must be a complete Git object ID.");
  }
  if (body.execution.runtimeMode !== "approval-required") {
    fail("invalid-contract", "Foundry v0.1 only permits approval-required execution.");
  }
  if (
    !Number.isInteger(body.execution.limits.maximumTurns) ||
    body.execution.limits.maximumTurns < 1
  ) {
    fail("invalid-contract", "execution.limits.maximumTurns must be a positive integer.");
  }
  if (
    !Number.isInteger(body.execution.limits.maximumRetries) ||
    body.execution.limits.maximumRetries < 0
  ) {
    fail("invalid-contract", "execution.limits.maximumRetries must be a non-negative integer.");
  }
}

function validateFounders(founders: ReadonlyArray<FounderIdentity>): readonly [string, string] {
  if (founders.length !== 2) {
    fail("invalid-founder-set", "Foundry v0.1 requires exactly two founders.");
  }
  const [first, second] = founders;
  if (!first || !second || first.id === second.id || first.publicKey === second.publicKey) {
    fail("invalid-founder-set", "The two founders must have distinct identities and signing keys.");
  }
  requireNonEmpty("founder.id", first.id);
  requireNonEmpty("founder.publicKey", first.publicKey);
  requireNonEmpty("founder.id", second.id);
  requireNonEmpty("founder.publicKey", second.publicKey);
  return [first.id, second.id];
}

function frozenContractBody(canonicalBody: string): FeatureContractBody {
  return deepFreeze(JSON.parse(canonicalBody) as FeatureContractBody);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function proposeFeatureContract(input: {
  readonly body: FeatureContractBody;
  readonly founders: ReadonlyArray<FounderIdentity>;
}): FeatureProposal {
  validateContract(input.body);
  const founderIds = validateFounders(input.founders);
  const canonicalBody = canonicalizeJson(input.body);
  const contentHash = sha256(canonicalBody);

  return Object.freeze({
    body: frozenContractBody(canonicalBody),
    canonicalBody,
    contentHash,
    approvalSubject: approvalSubjectFor({ body: input.body, contentHash }),
    founderIds,
    approvals: Object.freeze([]),
    state: "awaiting-approval",
  });
}

export function approveFeatureContract(input: {
  readonly proposal: FeatureProposal;
  readonly approval: FounderApproval;
  readonly founders: ReadonlyArray<FounderIdentity>;
  readonly verifier: ApprovalSignatureVerifier;
}): FeatureProposal {
  if (input.proposal.state === "approved") {
    fail("already-approved", "This exact contract is already fully approved.");
  }
  if (input.approval.contentHash !== input.proposal.contentHash) {
    fail("hash-mismatch", "The approval does not reference this contract hash.");
  }
  if (!input.proposal.founderIds.includes(input.approval.founderId)) {
    fail("unknown-founder", "Only a founder registered on this proposal may approve it.");
  }
  if (input.proposal.approvals.some(({ founderId }) => founderId === input.approval.founderId)) {
    fail("duplicate-approval", "A founder may approve a contract hash only once.");
  }

  const founder = input.founders.find(({ id }) => id === input.approval.founderId);
  if (!founder || !input.proposal.founderIds.includes(founder.id)) {
    fail("unknown-founder", "The approval founder is not in the active founder registry.");
  }
  if (
    !input.verifier.verify({
      founder,
      subject: input.proposal.approvalSubject,
      signature: input.approval.signature,
    })
  ) {
    fail("invalid-signature", "The approval signature is invalid for this contract.");
  }

  const approvals = Object.freeze([...input.proposal.approvals, Object.freeze(input.approval)]);
  return Object.freeze({
    ...input.proposal,
    approvals,
    state: approvals.length === input.proposal.founderIds.length ? "approved" : "awaiting-approval",
  });
}

export function verifyApprovedFeatureProposal(input: {
  readonly proposal: FeatureProposal;
  readonly founders: ReadonlyArray<FounderIdentity>;
  readonly verifier: ApprovalSignatureVerifier;
}): VerifiedFeatureProposal {
  if (input.proposal.state !== "approved" || input.proposal.approvals.length !== 2) {
    fail("contract-not-approved", "A dispatchable proposal must contain exactly two approvals.");
  }

  const reconstructed = proposeFeatureContract({
    body: input.proposal.body,
    founders: input.founders,
  });
  if (
    reconstructed.canonicalBody !== input.proposal.canonicalBody ||
    reconstructed.contentHash !== input.proposal.contentHash ||
    reconstructed.approvalSubject !== input.proposal.approvalSubject ||
    reconstructed.founderIds.some(
      (founderId, index) => founderId !== input.proposal.founderIds[index],
    )
  ) {
    fail("proposal-integrity", "The proposal envelope does not match its canonical contract body.");
  }

  const verified = input.proposal.approvals.reduce(
    (proposal, approval) =>
      approveFeatureContract({
        proposal,
        approval,
        founders: input.founders,
        verifier: input.verifier,
      }),
    reconstructed,
  );
  const branded = { ...verified };
  Object.defineProperty(branded, verifiedProposalBrand, { value: true });
  return Object.freeze(branded) as VerifiedFeatureProposal;
}

export function queueFeatureDispatch(input: {
  readonly proposal: VerifiedFeatureProposal;
  readonly environmentId: string;
}): FoundryDispatch {
  if (!isVerifiedFeatureProposal(input.proposal)) {
    fail(
      "contract-not-approved",
      "Both founder signatures must be reverified locally before dispatch.",
    );
  }
  if (input.environmentId !== input.proposal.body.execution.environmentId) {
    fail("environment-mismatch", "The dispatch environment differs from the approved contract.");
  }

  const idempotencyKey = sha256(
    [
      "foundry.dispatch/v1",
      input.proposal.body.projectId,
      input.proposal.body.featureId,
      String(input.proposal.body.version),
      input.proposal.contentHash,
      input.environmentId,
    ].join("\n"),
  );

  return Object.freeze({
    id: `dispatch_${idempotencyKey.slice(0, 24)}`,
    idempotencyKey,
    contractHash: input.proposal.contentHash,
    environmentId: input.environmentId,
    branch: `foundry/${input.proposal.body.featureId}-v${input.proposal.body.version}-${input.proposal.contentHash.slice(0, 12)}`,
    baseSha: input.proposal.body.repository.baseSha,
    state: "queued",
  });
}
