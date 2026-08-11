import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isTrimmed(),
);
const ShortText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isTrimmed(),
);
const LongText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8_192),
  Schema.isTrimmed(),
);
const ContractList = Schema.Array(LongText).check(Schema.isMaxLength(100));
const FeatureId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
);
const GitObjectId = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i));

export const FoundryRuntimeMode = Schema.Literal("approval-required");
export type FoundryRuntimeMode = typeof FoundryRuntimeMode.Type;

export const FoundryFeatureContractBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectId: Identifier,
  featureId: FeatureId,
  version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  title: ShortText,
  objective: LongText,
  inScope: ContractList,
  outOfScope: ContractList,
  constraints: ContractList,
  acceptanceCriteria: ContractList,
  verificationCommands: ContractList,
  repository: Schema.Struct({
    remoteId: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(512),
      Schema.isTrimmed(),
    ),
    baseBranch: ShortText,
    baseSha: GitObjectId,
  }),
  execution: Schema.Struct({
    environmentId: Identifier,
    provider: ShortText,
    model: ShortText,
    runtimeMode: FoundryRuntimeMode,
    limits: Schema.Struct({
      maximumTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
      maximumRetries: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    }),
  }),
  riskFlags: Schema.Array(ShortText).check(Schema.isMaxLength(50)),
});
export type FoundryFeatureContractBody = typeof FoundryFeatureContractBody.Type;

export const FoundrySignedEventFormat = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9./-]*[a-z0-9])?$/),
);
export type FoundrySignedEventFormat = typeof FoundrySignedEventFormat.Type;

export const FoundryApprovalProof = Schema.Struct({
  format: FoundrySignedEventFormat,
  encodedEvent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
});
export type FoundryApprovalProof = typeof FoundryApprovalProof.Type;

export const FoundryApprovalPacket = Schema.Struct({
  founderId: Identifier,
  proof: FoundryApprovalProof,
});
export type FoundryApprovalPacket = typeof FoundryApprovalPacket.Type;

export const FoundryApprovedContractPacket = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  body: FoundryFeatureContractBody,
  approvals: Schema.Tuple([FoundryApprovalPacket, FoundryApprovalPacket]),
});
export type FoundryApprovedContractPacket = typeof FoundryApprovedContractPacket.Type;

const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Hex128 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/));
const NostrTagValue = Schema.String.check(Schema.isMaxLength(2_048));
const NostrTag = Schema.Array(NostrTagValue).check(Schema.isMinLength(1), Schema.isMaxLength(16));

export const FoundryBuzzNostrEvent = Schema.Struct({
  id: Hex64,
  pubkey: Hex64,
  created_at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })),
  tags: Schema.Array(NostrTag).check(Schema.isMaxLength(128)),
  content: Schema.String.check(Schema.isMaxLength(65_536)),
  sig: Hex128,
});
export type FoundryBuzzNostrEvent = typeof FoundryBuzzNostrEvent.Type;

export const FoundryBuzzApprovalContent = Schema.Struct({
  type: Schema.Literal("foundry.contract.approval/v1"),
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
});
export type FoundryBuzzApprovalContent = typeof FoundryBuzzApprovalContent.Type;

const strictDecodeOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const decodeFeatureContractBody = Schema.decodeUnknownSync(FoundryFeatureContractBody);
const decodeApprovedContractPacket = Schema.decodeUnknownSync(FoundryApprovedContractPacket);
const decodeBuzzNostrEvent = Schema.decodeUnknownSync(FoundryBuzzNostrEvent);
const decodeBuzzApprovalContent = Schema.decodeUnknownSync(FoundryBuzzApprovalContent);

export const decodeFoundryFeatureContractBody = (input: unknown): FoundryFeatureContractBody =>
  decodeFeatureContractBody(input, strictDecodeOptions);

export const decodeFoundryApprovedContractPacket = (
  input: unknown,
): FoundryApprovedContractPacket => decodeApprovedContractPacket(input, strictDecodeOptions);

export const decodeFoundryBuzzNostrEvent = (input: unknown): FoundryBuzzNostrEvent =>
  decodeBuzzNostrEvent(input, strictDecodeOptions);

export const decodeFoundryBuzzApprovalContent = (input: unknown): FoundryBuzzApprovalContent =>
  decodeBuzzApprovalContent(input, strictDecodeOptions);
