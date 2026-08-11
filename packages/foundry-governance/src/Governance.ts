import { sha256 as sha256Bytes } from "@noble/hashes/sha2";
import {
  decodeFoundryFeatureContractBody,
  type FoundryApprovalProof,
  type FoundryFeatureContractBody,
  type FoundryRuntimeMode as ContractFoundryRuntimeMode,
} from "@t3tools/contracts";

export type FoundryRuntimeMode = ContractFoundryRuntimeMode;
export type FeatureContractBody = FoundryFeatureContractBody;

export interface FounderIdentity {
  readonly id: string;
  readonly publicKey: string;
}

export type FounderRegistry = readonly [FounderIdentity, FounderIdentity];

export interface FounderApproval {
  readonly founderId: string;
  readonly contentHash: string;
  readonly proof: FoundryApprovalProof;
}

export interface FeatureProposal {
  readonly body: FeatureContractBody;
  readonly canonicalBody: string;
  readonly contentHash: string;
  readonly approvalSubject: string;
  readonly founderRegistry: FounderRegistry;
  readonly founderRegistryHash: string;
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

export interface ApprovalProofVerifier {
  readonly verify: (input: {
    readonly founder: FounderIdentity;
    readonly subject: string;
    readonly proof: FoundryApprovalProof;
  }) => boolean;
}

export type FoundryGovernanceErrorCode =
  | "invalid-contract"
  | "invalid-founder-set"
  | "founder-registry-mismatch"
  | "proposal-integrity"
  | "unknown-founder"
  | "hash-mismatch"
  | "invalid-approval-proof"
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
  readonly founders: ReadonlyArray<FounderIdentity>;
}): string {
  const founderRegistryHash = hashFounderRegistry(validateFounders(input.founders));
  return approvalSubjectForRegistry({
    body: input.body,
    contentHash: input.contentHash,
    founderRegistryHash,
  });
}

function approvalSubjectForRegistry(input: {
  readonly body: FeatureContractBody;
  readonly contentHash: string;
  readonly founderRegistryHash: string;
}): string {
  return [
    "foundry.contract.approve/v1",
    input.body.projectId,
    input.body.featureId,
    String(input.body.version),
    input.contentHash,
    input.founderRegistryHash,
  ].join("\n");
}

function requireNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    fail("invalid-contract", `${field} must not be empty.`);
  }
}

function validatedContractBody(body: FeatureContractBody): FeatureContractBody {
  try {
    return decodeFoundryFeatureContractBody(body);
  } catch {
    return fail("invalid-contract", "The feature contract does not match the strict wire schema.");
  }
}

function validateFounders(founders: ReadonlyArray<FounderIdentity>): FounderRegistry {
  if (!Array.isArray(founders) || founders.length !== 2) {
    fail("invalid-founder-set", "Foundry v0.1 requires exactly two founders.");
  }
  const [first, second] = founders;
  if (
    !first ||
    !second ||
    typeof first.id !== "string" ||
    typeof first.publicKey !== "string" ||
    typeof second.id !== "string" ||
    typeof second.publicKey !== "string" ||
    first.id === second.id ||
    first.publicKey === second.publicKey
  ) {
    fail("invalid-founder-set", "The two founders must have distinct identities and signing keys.");
  }
  requireNonEmpty("founder.id", first.id);
  requireNonEmpty("founder.publicKey", first.publicKey);
  requireNonEmpty("founder.id", second.id);
  requireNonEmpty("founder.publicKey", second.publicKey);
  const registry: [FounderIdentity, FounderIdentity] = [
    Object.freeze({ id: first.id, publicKey: first.publicKey }),
    Object.freeze({ id: second.id, publicKey: second.publicKey }),
  ];
  return Object.freeze(registry);
}

function hashFounderRegistry(founders: FounderRegistry): string {
  return sha256(canonicalizeJson(founders));
}

function founderRegistriesMatch(left: FounderRegistry, right: FounderRegistry): boolean {
  return (
    left[0].id === right[0].id &&
    left[0].publicKey === right[0].publicKey &&
    left[1].id === right[1].id &&
    left[1].publicKey === right[1].publicKey
  );
}

function assertProposalEnvelopeIntegrity(proposal: FeatureProposal): FounderRegistry {
  const body = validatedContractBody(proposal.body);
  const canonicalBody = canonicalizeJson(body);
  const contentHash = sha256(canonicalBody);
  let founderRegistry: FounderRegistry;
  try {
    founderRegistry = validateFounders(proposal.founderRegistry);
  } catch {
    return fail("proposal-integrity", "The proposal founder registry is invalid.");
  }
  const founderRegistryHash = hashFounderRegistry(founderRegistry);
  const founderIds = founderRegistry.map(({ id }) => id);
  const approvalSubject = approvalSubjectForRegistry({ body, contentHash, founderRegistryHash });
  const expectedState = proposal.approvals.length === 2 ? "approved" : "awaiting-approval";

  if (
    canonicalBody !== proposal.canonicalBody ||
    contentHash !== proposal.contentHash ||
    founderRegistryHash !== proposal.founderRegistryHash ||
    proposal.founderIds.length !== 2 ||
    founderIds.some((founderId, index) => founderId !== proposal.founderIds[index]) ||
    approvalSubject !== proposal.approvalSubject ||
    proposal.approvals.length > 2 ||
    proposal.state !== expectedState
  ) {
    fail("proposal-integrity", "The proposal envelope does not match its trusted inputs.");
  }

  return founderRegistry;
}

function assertActiveFounderRegistry(
  proposalRegistry: FounderRegistry,
  founders: ReadonlyArray<FounderIdentity>,
): FounderRegistry {
  const activeRegistry = validateFounders(founders);
  if (!founderRegistriesMatch(proposalRegistry, activeRegistry)) {
    fail(
      "founder-registry-mismatch",
      "The active founder identities or signing keys differ from the proposal registry.",
    );
  }
  return activeRegistry;
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
  const body = validatedContractBody(input.body);
  const founderRegistry = validateFounders(input.founders);
  const founderRegistryHash = hashFounderRegistry(founderRegistry);
  const founderIds: [string, string] = [founderRegistry[0].id, founderRegistry[1].id];
  Object.freeze(founderIds);
  const canonicalBody = canonicalizeJson(body);
  const contentHash = sha256(canonicalBody);

  return Object.freeze({
    body: frozenContractBody(canonicalBody),
    canonicalBody,
    contentHash,
    approvalSubject: approvalSubjectForRegistry({ body, contentHash, founderRegistryHash }),
    founderRegistry,
    founderRegistryHash,
    founderIds,
    approvals: Object.freeze([]),
    state: "awaiting-approval",
  });
}

export function approveFeatureContract(input: {
  readonly proposal: FeatureProposal;
  readonly approval: FounderApproval;
  readonly founders: ReadonlyArray<FounderIdentity>;
  readonly verifier: ApprovalProofVerifier;
}): FeatureProposal {
  const proposalRegistry = assertProposalEnvelopeIntegrity(input.proposal);
  if (input.proposal.state === "approved") {
    fail("already-approved", "This exact contract is already fully approved.");
  }
  if (input.approval.contentHash !== input.proposal.contentHash) {
    fail("hash-mismatch", "The approval does not reference this contract hash.");
  }
  if (!input.proposal.founderIds.includes(input.approval.founderId)) {
    fail("unknown-founder", "Only a founder registered on this proposal may approve it.");
  }
  const activeRegistry = assertActiveFounderRegistry(proposalRegistry, input.founders);
  if (input.proposal.approvals.some(({ founderId }) => founderId === input.approval.founderId)) {
    fail("duplicate-approval", "A founder may approve a contract hash only once.");
  }

  for (const existingApproval of input.proposal.approvals) {
    const existingFounder = activeRegistry.find(({ id }) => id === existingApproval.founderId);
    if (
      !existingFounder ||
      existingApproval.contentHash !== input.proposal.contentHash ||
      !input.verifier.verify({
        founder: existingFounder,
        subject: input.proposal.approvalSubject,
        proof: existingApproval.proof,
      })
    ) {
      fail("invalid-approval-proof", "An existing approval proof is no longer valid.");
    }
  }

  const founder = activeRegistry.find(({ id }) => id === input.approval.founderId);
  if (!founder || !input.proposal.founderIds.includes(founder.id)) {
    fail("unknown-founder", "The approval founder is not in the active founder registry.");
  }
  if (
    !input.verifier.verify({
      founder,
      subject: input.proposal.approvalSubject,
      proof: input.approval.proof,
    })
  ) {
    fail("invalid-approval-proof", "The approval proof is invalid for this contract.");
  }

  const approval = Object.freeze({
    ...input.approval,
    proof: Object.freeze({ ...input.approval.proof }),
  });
  const approvals = Object.freeze([...input.proposal.approvals, approval]);
  return Object.freeze({
    ...input.proposal,
    approvals,
    state: approvals.length === input.proposal.founderIds.length ? "approved" : "awaiting-approval",
  });
}

export function verifyApprovedFeatureProposal(input: {
  readonly proposal: FeatureProposal;
  readonly founders: ReadonlyArray<FounderIdentity>;
  readonly verifier: ApprovalProofVerifier;
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
    reconstructed.founderRegistryHash !== input.proposal.founderRegistryHash ||
    !founderRegistriesMatch(reconstructed.founderRegistry, input.proposal.founderRegistry) ||
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
