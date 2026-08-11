import {
  FoundryApprovedContractPacket,
  FoundryApprovedContractRecord,
  FoundryStoredApprovalEvidence,
  type FoundryApprovedContractIngestResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceSqlError,
} from "../Errors.ts";
import {
  FoundryApprovedContractConflictError,
  FoundryApprovedContractStore,
  FoundryApprovalStorageInput,
  StoreVerifiedFoundryApprovedContractInput,
  type FoundryApprovedContractStoreShape,
} from "../Services/FoundryApprovedContractStore.ts";

const ContractHeaderRow = Schema.Struct({
  contractHash: FoundryApprovedContractRecord.fields.contractHash,
  projectId: FoundryApprovedContractRecord.fields.projectId,
  featureId: FoundryApprovedContractRecord.fields.featureId,
  version: FoundryApprovedContractRecord.fields.version,
  founderRegistryHash: FoundryApprovedContractRecord.fields.founderRegistryHash,
  approvalSubject: FoundryApprovedContractRecord.fields.approvalSubject,
  dispatchIdempotencyKey: FoundryApprovedContractRecord.fields.dispatchIdempotencyKey,
  acceptedAt: FoundryApprovedContractRecord.fields.acceptedAt,
  canonicalBodyJson: Schema.String,
  packetJson: Schema.String,
  packetDigest: FoundryApprovedContractRecord.fields.contractHash,
});
type ContractHeaderRow = typeof ContractHeaderRow.Type;

const ApprovalRow = Schema.Struct({
  approvalIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ...FoundryStoredApprovalEvidence.fields,
  encodedEvent: Schema.String,
});

const ContractHashRequest = Schema.Struct({
  contractHash: FoundryApprovedContractRecord.fields.contractHash,
});

const InsertApprovalRequest = Schema.Struct({
  contractHash: FoundryApprovedContractRecord.fields.contractHash,
  approvalIndex: ApprovalRow.fields.approvalIndex,
  ...FoundryApprovalStorageInput.fields,
});

const InsertedContractRow = Schema.Struct({
  contractHash: FoundryApprovedContractRecord.fields.contractHash,
});
const decodeApprovedContractRecord = Schema.decodeUnknownEffect(FoundryApprovedContractRecord);
const decodeStoredApprovedContractPacket = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FoundryApprovedContractPacket),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function approvalStorageMatchesRecord(
  input: typeof FoundryApprovalStorageInput.Type,
  evidence: typeof FoundryStoredApprovalEvidence.Type,
): boolean {
  return (
    input.founderId === evidence.founderId &&
    input.format === evidence.format &&
    input.eventId === evidence.eventId &&
    input.createdAtEpochSeconds === evidence.createdAtEpochSeconds
  );
}

function isSemanticReplay(
  stored: ContractHeaderRow,
  input: typeof StoreVerifiedFoundryApprovedContractInput.Type,
): boolean {
  return (
    stored.contractHash === input.record.contractHash &&
    stored.projectId === input.record.projectId &&
    stored.featureId === input.record.featureId &&
    stored.version === input.record.version &&
    stored.canonicalBodyJson === input.canonicalBodyJson &&
    stored.founderRegistryHash === input.record.founderRegistryHash &&
    stored.approvalSubject === input.record.approvalSubject &&
    stored.dispatchIdempotencyKey === input.record.dispatchIdempotencyKey
  );
}

const makeFoundryApprovedContractStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertContractRow = SqlSchema.findAll({
    Request: StoreVerifiedFoundryApprovedContractInput,
    Result: InsertedContractRow,
    execute: (input) => sql`
      INSERT INTO foundry_approved_contracts (
        contract_hash,
        project_id,
        feature_id,
        contract_version,
        founder_registry_hash,
        approval_subject,
        dispatch_idempotency_key,
        canonical_body_json,
        packet_json,
        packet_digest,
        accepted_at
      ) VALUES (
        ${input.record.contractHash},
        ${input.record.projectId},
        ${input.record.featureId},
        ${input.record.version},
        ${input.record.founderRegistryHash},
        ${input.record.approvalSubject},
        ${input.record.dispatchIdempotencyKey},
        ${input.canonicalBodyJson},
        ${input.packetJson},
        ${input.packetDigest},
        ${input.record.acceptedAt}
      )
      ON CONFLICT (project_id, feature_id, contract_version) DO NOTHING
      RETURNING contract_hash AS "contractHash"
    `,
  });

  const insertApprovalRow = SqlSchema.findAll({
    Request: InsertApprovalRequest,
    Result: InsertedContractRow,
    execute: (input) => sql`
      INSERT INTO foundry_approval_events (
        contract_hash,
        approval_index,
        founder_id,
        proof_format,
        event_id,
        created_at_epoch_seconds,
        encoded_event
      ) VALUES (
        ${input.contractHash},
        ${input.approvalIndex},
        ${input.founderId},
        ${input.format},
        ${input.eventId},
        ${input.createdAtEpochSeconds},
        ${input.encodedEvent}
      )
      ON CONFLICT (proof_format, event_id) DO NOTHING
      RETURNING contract_hash AS "contractHash"
    `,
  });

  const insertDispatchJob = SqlSchema.void({
    Request: StoreVerifiedFoundryApprovedContractInput,
    execute: (input) => sql`
      INSERT INTO foundry_dispatch_jobs (
        dispatch_id,
        dispatch_idempotency_key,
        contract_hash,
        environment_id,
        branch,
        base_sha,
        state,
        fence_token,
        attempt_count,
        max_attempts,
        lease_owner,
        lease_expires_at,
        command_created_at,
        created_at,
        updated_at,
        completed_at,
        failure_code
      ) VALUES (
        ${input.dispatch.dispatchId},
        ${input.dispatch.dispatchIdempotencyKey},
        ${input.record.contractHash},
        ${input.dispatch.environmentId},
        ${input.dispatch.branch},
        ${input.dispatch.baseSha},
        ${"queued"},
        ${0},
        ${0},
        ${input.dispatch.maxAttempts},
        ${null},
        ${null},
        ${input.record.acceptedAt},
        ${input.record.acceptedAt},
        ${input.record.acceptedAt},
        ${null},
        ${null}
      )
    `,
  });

  const findContractHeader = SqlSchema.findOneOption({
    Request: ContractHashRequest,
    Result: ContractHeaderRow,
    execute: ({ contractHash }) => sql`
      SELECT
        contract_hash AS "contractHash",
        project_id AS "projectId",
        feature_id AS "featureId",
        contract_version AS "version",
        founder_registry_hash AS "founderRegistryHash",
        approval_subject AS "approvalSubject",
        dispatch_idempotency_key AS "dispatchIdempotencyKey",
        canonical_body_json AS "canonicalBodyJson",
        packet_json AS "packetJson",
        packet_digest AS "packetDigest",
        accepted_at AS "acceptedAt"
      FROM foundry_approved_contracts
      WHERE contract_hash = ${contractHash}
    `,
  });

  const listApprovalRows = SqlSchema.findAll({
    Request: ContractHashRequest,
    Result: ApprovalRow,
    execute: ({ contractHash }) => sql`
      SELECT
        approval_index AS "approvalIndex",
        founder_id AS "founderId",
        proof_format AS "format",
        event_id AS "eventId",
        created_at_epoch_seconds AS "createdAtEpochSeconds",
        encoded_event AS "encodedEvent"
      FROM foundry_approval_events
      WHERE contract_hash = ${contractHash}
      ORDER BY approval_index ASC
    `,
  });

  const loadRecord = Effect.fn("FoundryApprovedContractStore.loadRecord")(function* (
    header: ContractHeaderRow,
  ) {
    const approvalRows = yield* listApprovalRows({ contractHash: header.contractHash }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FoundryApprovedContractStore.loadRecord:approvalQuery",
          "FoundryApprovedContractStore.loadRecord:decodeApprovals",
        ),
      ),
    );
    return yield* decodeApprovedContractRecord({
      contractHash: header.contractHash,
      projectId: header.projectId,
      featureId: header.featureId,
      version: header.version,
      founderRegistryHash: header.founderRegistryHash,
      approvalSubject: header.approvalSubject,
      dispatchIdempotencyKey: header.dispatchIdempotencyKey,
      acceptedAt: header.acceptedAt,
      approvals: approvalRows.map(
        ({ encodedEvent: _encodedEvent, approvalIndex: _index, ...row }) => row,
      ),
    }).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError(
          "FoundryApprovedContractStore.loadRecord:decodeRecord",
          cause,
        ),
      ),
    );
  });

  const findHeader = Effect.fn("FoundryApprovedContractStore.findHeader")(function* (
    contractHash: string,
  ) {
    return yield* findContractHeader({ contractHash }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FoundryApprovedContractStore.findHeader:query",
          "FoundryApprovedContractStore.findHeader:decodeRow",
        ),
      ),
    );
  });

  const conflict = (
    contractHash: string,
    reason: "logical-version" | "contract-identity" | "approval-event",
  ) => new FoundryApprovedContractConflictError({ contractHash, reason });

  const storeVerified: FoundryApprovedContractStoreShape["storeVerified"] = Effect.fn(
    "FoundryApprovedContractStore.storeVerified",
  )(function* (input) {
    if (
      !approvalStorageMatchesRecord(input.approvals[0], input.record.approvals[0]) ||
      !approvalStorageMatchesRecord(input.approvals[1], input.record.approvals[1]) ||
      input.dispatch.dispatchIdempotencyKey !== input.record.dispatchIdempotencyKey ||
      input.dispatch.dispatchId !== `dispatch_${input.record.dispatchIdempotencyKey.slice(0, 24)}`
    ) {
      return yield* conflict(input.record.contractHash, "contract-identity");
    }

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* insertContractRow(input).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "FoundryApprovedContractStore.storeVerified:insertContract",
                "FoundryApprovedContractStore.storeVerified:encodeContract",
              ),
            ),
          );

          if (inserted.length === 0) {
            const existing = yield* findHeader(input.record.contractHash);
            if (Option.isNone(existing)) {
              return yield* conflict(input.record.contractHash, "logical-version");
            }
            if (!isSemanticReplay(existing.value, input)) {
              return yield* conflict(input.record.contractHash, "contract-identity");
            }
            const record = yield* loadRecord(existing.value);
            return {
              disposition: "replayed",
              record,
            } satisfies FoundryApprovedContractIngestResult;
          }

          for (const [approvalIndex, approval] of input.approvals.entries()) {
            const approvalInserted = yield* insertApprovalRow({
              contractHash: input.record.contractHash,
              approvalIndex,
              ...approval,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "FoundryApprovedContractStore.storeVerified:insertApproval",
                  "FoundryApprovedContractStore.storeVerified:encodeApproval",
                ),
              ),
            );
            if (approvalInserted.length === 0) {
              return yield* conflict(input.record.contractHash, "approval-event");
            }
          }

          yield* insertDispatchJob(input).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "FoundryApprovedContractStore.storeVerified:insertDispatchJob",
                "FoundryApprovedContractStore.storeVerified:encodeDispatchJob",
              ),
            ),
          );

          const storedHeader = yield* findHeader(input.record.contractHash);
          if (Option.isNone(storedHeader)) {
            return yield* new PersistenceDecodeError({
              operation: "FoundryApprovedContractStore.storeVerified:readStoredHeader",
              issue: "MissingStoredHeader",
            });
          }
          const record = yield* loadRecord(storedHeader.value);
          return {
            disposition: "stored",
            record,
          } satisfies FoundryApprovedContractIngestResult;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("FoundryApprovedContractStore.storeVerified:transaction")(cause),
          ),
        ),
      );
  });

  const readPacketByContractHash: FoundryApprovedContractStoreShape["readPacketByContractHash"] =
    Effect.fn("FoundryApprovedContractStore.readPacketByContractHash")(function* (contractHash) {
      const header = yield* findHeader(contractHash);
      if (Option.isNone(header)) {
        return Option.none<FoundryApprovedContractPacket>();
      }
      const packet = yield* decodeStoredApprovedContractPacket(header.value.packetJson).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError(
            "FoundryApprovedContractStore.readPacketByContractHash:decodePacket",
            cause,
          ),
        ),
      );
      return Option.some(packet);
    });

  const readRecordByContractHash: FoundryApprovedContractStoreShape["readRecordByContractHash"] =
    Effect.fn("FoundryApprovedContractStore.readRecordByContractHash")(function* (contractHash) {
      const header = yield* findHeader(contractHash);
      return Option.isNone(header) ? Option.none() : Option.some(yield* loadRecord(header.value));
    });

  return {
    storeVerified,
    readPacketByContractHash,
    readRecordByContractHash,
  } satisfies FoundryApprovedContractStoreShape;
});

export const FoundryApprovedContractStoreLive = Layer.effect(
  FoundryApprovedContractStore,
  makeFoundryApprovedContractStore,
);
