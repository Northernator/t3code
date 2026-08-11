import {
  FoundryApprovedContractRecord,
  FoundryStoredApprovalEvidence,
  type FoundryApprovedContractIngestResult,
  type FoundryApprovedContractPacket,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import { FoundryDispatchCreationInput } from "./FoundryDispatchStore.ts";

export const FoundryApprovalStorageInput = Schema.Struct({
  ...FoundryStoredApprovalEvidence.fields,
  encodedEvent: Schema.String,
});
export type FoundryApprovalStorageInput = typeof FoundryApprovalStorageInput.Type;

export const StoreVerifiedFoundryApprovedContractInput = Schema.Struct({
  record: FoundryApprovedContractRecord,
  canonicalBodyJson: Schema.String,
  packetJson: Schema.String,
  packetDigest: FoundryApprovedContractRecord.fields.contractHash,
  approvals: Schema.Tuple([FoundryApprovalStorageInput, FoundryApprovalStorageInput]),
  dispatch: FoundryDispatchCreationInput,
});
export type StoreVerifiedFoundryApprovedContractInput =
  typeof StoreVerifiedFoundryApprovedContractInput.Type;

export class FoundryApprovedContractConflictError extends Schema.TaggedErrorClass<FoundryApprovedContractConflictError>()(
  "FoundryApprovedContractConflictError",
  {
    contractHash: Schema.String,
    reason: Schema.Literals(["logical-version", "contract-identity", "approval-event"]),
  },
) {
  override get message(): string {
    return `Foundry approved contract conflict: ${this.reason}`;
  }
}

export type FoundryApprovedContractStoreError =
  | FoundryApprovedContractConflictError
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface FoundryApprovedContractStoreShape {
  readonly storeVerified: (
    input: StoreVerifiedFoundryApprovedContractInput,
  ) => Effect.Effect<FoundryApprovedContractIngestResult, FoundryApprovedContractStoreError>;

  readonly readPacketByContractHash: (
    contractHash: string,
  ) => Effect.Effect<
    Option.Option<FoundryApprovedContractPacket>,
    PersistenceSqlError | PersistenceDecodeError
  >;

  readonly readRecordByContractHash: (
    contractHash: string,
  ) => Effect.Effect<
    Option.Option<FoundryApprovedContractRecord>,
    PersistenceSqlError | PersistenceDecodeError
  >;
}

export class FoundryApprovedContractStore extends Context.Service<
  FoundryApprovedContractStore,
  FoundryApprovedContractStoreShape
>()("t3/persistence/Services/FoundryApprovedContractStore") {}
