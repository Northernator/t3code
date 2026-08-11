import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FoundryApprovedContractPacket } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { FoundryApprovedContractStore } from "../Services/FoundryApprovedContractStore.ts";
import { FoundryApprovedContractStoreLive } from "./FoundryApprovedContractStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const baseBody = {
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
    provider: "codex",
    model: "gpt-5.6-sol-ultra",
    runtimeMode: "approval-required",
    limits: { maximumTurns: 20, maximumRetries: 2 },
  },
  riskFlags: ["clipboard-data"],
} as const;

const decodePacketJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(FoundryApprovedContractPacket),
);

interface FixtureOptions {
  readonly contractHash?: string;
  readonly featureId?: string;
  readonly version?: number;
  readonly objective?: string;
  readonly eventIds?: readonly [string, string];
  readonly encodedEvents?: readonly [string, string];
  readonly founderOrder?: readonly [
    "founder-alice" | "founder-bob",
    "founder-alice" | "founder-bob",
  ];
  readonly packetDigest?: string;
  readonly acceptedAt?: string;
  readonly founderRegistryHash?: string;
  readonly approvalSubject?: string;
  readonly dispatchIdempotencyKey?: string;
}

function makeStoreInput(options: FixtureOptions = {}) {
  const contractHash = options.contractHash ?? "3".repeat(64);
  const dispatchIdempotencyKey = options.dispatchIdempotencyKey ?? contractHash;
  const founderOrder = options.founderOrder ?? ["founder-alice", "founder-bob"];
  const eventIds = options.eventIds ?? ["1".repeat(64), "2".repeat(64)];
  const encodedEvents = options.encodedEvents ?? ['{"event":1}', '{"event":2}'];
  const body = {
    ...baseBody,
    featureId: options.featureId ?? baseBody.featureId,
    version: options.version ?? baseBody.version,
    objective: options.objective ?? baseBody.objective,
  };
  const approvals = founderOrder.map((founderId, index) => ({
    founderId,
    format: "buzz-nostr-event/v1" as const,
    eventId: eventIds[index]!,
    createdAtEpochSeconds: 1_786_377_600 + index,
    encodedEvent: encodedEvents[index]!,
  })) as unknown as readonly [
    {
      readonly founderId: string;
      readonly format: "buzz-nostr-event/v1";
      readonly eventId: string;
      readonly createdAtEpochSeconds: number;
      readonly encodedEvent: string;
    },
    {
      readonly founderId: string;
      readonly format: "buzz-nostr-event/v1";
      readonly eventId: string;
      readonly createdAtEpochSeconds: number;
      readonly encodedEvent: string;
    },
  ];
  const packet = {
    protocolVersion: 1,
    body,
    approvals: approvals.map(({ founderId, format, encodedEvent }) => ({
      founderId,
      proof: { format, encodedEvent },
    })),
  } as unknown as FoundryApprovedContractPacket;

  return {
    record: {
      contractHash,
      projectId: body.projectId,
      featureId: body.featureId,
      version: body.version,
      founderRegistryHash: options.founderRegistryHash ?? "4".repeat(64),
      approvalSubject:
        options.approvalSubject ?? "foundry.contract.approve/v1\nhotpaste\nclipboard-history",
      dispatchIdempotencyKey,
      acceptedAt: options.acceptedAt ?? "2026-08-11T12:00:00.000Z",
      approvals: approvals.map(
        ({ encodedEvent: _encodedEvent, ...evidence }) => evidence,
      ) as unknown as readonly [
        Omit<(typeof approvals)[0], "encodedEvent">,
        Omit<(typeof approvals)[1], "encodedEvent">,
      ],
    },
    canonicalBodyJson: JSON.stringify(body),
    packetJson: JSON.stringify(packet),
    packetDigest: options.packetDigest ?? "6".repeat(64),
    dispatch: {
      dispatchId: `dispatch_${dispatchIdempotencyKey.slice(0, 24)}`,
      dispatchIdempotencyKey,
      environmentId: body.execution.environmentId,
      branch: `foundry/${body.featureId}-v${body.version}-${contractHash.slice(0, 12)}`,
      baseSha: body.repository.baseSha,
      maxAttempts: body.execution.limits.maximumRetries + 1,
    },
    approvals,
  } as const;
}

const layer = it.layer(
  FoundryApprovedContractStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("FoundryApprovedContractStore", (it) => {
  it.effect("stores once and replays the original immutable record after reorder and re-sign", () =>
    Effect.gen(function* () {
      const store = yield* FoundryApprovedContractStore;
      const sql = yield* SqlClient.SqlClient;
      const original = makeStoreInput();

      const stored = yield* store.storeVerified(original);
      const exactReplay = yield* store.storeVerified(original);
      const resignedReplay = yield* store.storeVerified(
        makeStoreInput({
          founderOrder: ["founder-bob", "founder-alice"],
          eventIds: ["7".repeat(64), "8".repeat(64)],
          encodedEvents: [' {"event":7}', '{ "event": 8 }'],
          packetDigest: "9".repeat(64),
          acceptedAt: "2026-08-11T13:00:00.000Z",
        }),
      );

      assert.equal(stored.disposition, "stored");
      assert.equal(exactReplay.disposition, "replayed");
      assert.equal(resignedReplay.disposition, "replayed");
      assert.deepEqual(exactReplay.record, stored.record);
      assert.deepEqual(resignedReplay.record, stored.record);

      const counts = yield* sql<{
        readonly contracts: number;
        readonly approvals: number;
        readonly dispatches: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM foundry_approved_contracts) AS contracts,
          (SELECT COUNT(*) FROM foundry_approval_events) AS approvals,
          (SELECT COUNT(*) FROM foundry_dispatch_jobs) AS dispatches
      `;
      assert.deepEqual(counts, [{ contracts: 1, approvals: 2, dispatches: 1 }]);
    }),
  );

  it.effect("rejects a different body for the same logical version without changing storage", () =>
    Effect.gen(function* () {
      const store = yield* FoundryApprovedContractStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.storeVerified(makeStoreInput());

      const error = yield* Effect.flip(
        store.storeVerified(
          makeStoreInput({
            contractHash: "a".repeat(64),
            objective: "A conflicting objective.",
            packetDigest: "b".repeat(64),
          }),
        ),
      );
      assert.equal(error._tag, "FoundryApprovedContractConflictError");
      if (error._tag === "FoundryApprovedContractConflictError") {
        assert.equal(error.reason, "logical-version");
      }

      const rows = yield* sql<{ readonly contractHash: string }>`
        SELECT contract_hash AS "contractHash"
        FROM foundry_approved_contracts
      `;
      assert.deepEqual(rows, [{ contractHash: "3".repeat(64) }]);
    }),
  );

  it.effect("rejects changed locally-derived identity fields for an existing contract hash", () =>
    Effect.gen(function* () {
      const store = yield* FoundryApprovedContractStore;
      yield* store.storeVerified(makeStoreInput());

      const error = yield* Effect.flip(
        store.storeVerified(
          makeStoreInput({
            founderRegistryHash: "a".repeat(64),
            approvalSubject: "foundry.contract.approve/v1\nchanged",
            dispatchIdempotencyKey: "b".repeat(64),
          }),
        ),
      );
      assert.equal(error._tag, "FoundryApprovedContractConflictError");
      if (error._tag === "FoundryApprovedContractConflictError") {
        assert.equal(error.reason, "contract-identity");
      }
    }),
  );

  it.effect(
    "rolls back the header and first approval when the second event was already stored",
    () =>
      Effect.gen(function* () {
        const store = yield* FoundryApprovedContractStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.storeVerified(makeStoreInput());

        const conflicting = makeStoreInput({
          contractHash: "c".repeat(64),
          version: 2,
          eventIds: ["8".repeat(64), "1".repeat(64)],
          encodedEvents: ['{"event":8}', '{"event":1,"replayed":true}'],
          packetDigest: "d".repeat(64),
        });
        const error = yield* Effect.flip(store.storeVerified(conflicting));
        assert.equal(error._tag, "FoundryApprovedContractConflictError");
        if (error._tag === "FoundryApprovedContractConflictError") {
          assert.equal(error.reason, "approval-event");
        }

        const contractRows = yield* sql<{ readonly contractHash: string }>`
        SELECT contract_hash AS "contractHash"
        FROM foundry_approved_contracts
        ORDER BY contract_hash
      `;
        const approvalRows = yield* sql<{ readonly eventId: string }>`
        SELECT event_id AS "eventId"
        FROM foundry_approval_events
        ORDER BY event_id
      `;
        const dispatchRows = yield* sql<{ readonly dispatchId: string }>`
        SELECT dispatch_id AS "dispatchId"
        FROM foundry_dispatch_jobs
        ORDER BY dispatch_id
      `;
        assert.deepEqual(contractRows, [{ contractHash: "3".repeat(64) }]);
        assert.deepEqual(approvalRows, [{ eventId: "1".repeat(64) }, { eventId: "2".repeat(64) }]);
        assert.deepEqual(dispatchRows, [{ dispatchId: `dispatch_${"3".repeat(24)}` }]);
      }),
  );

  it.effect("rolls back contract acceptance when the dispatch identity collides", () =>
    Effect.gen(function* () {
      const store = yield* FoundryApprovedContractStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.storeVerified(
        makeStoreInput({
          contractHash: "e".repeat(64),
          featureId: "dispatch-collision-one",
          eventIds: ["a".repeat(64), "b".repeat(64)],
          encodedEvents: ['{"event":"a"}', '{"event":"b"}'],
          packetDigest: "e".repeat(64),
          dispatchIdempotencyKey: `a${"1".repeat(63)}`,
        }),
      );

      const error = yield* Effect.flip(
        store.storeVerified(
          makeStoreInput({
            contractHash: "f".repeat(64),
            featureId: "dispatch-collision-two",
            eventIds: ["c".repeat(64), "d".repeat(64)],
            encodedEvents: ['{"event":"c"}', '{"event":"d"}'],
            packetDigest: "f".repeat(64),
            dispatchIdempotencyKey: `a${"1".repeat(23)}${"2".repeat(40)}`,
          }),
        ),
      );
      assert.equal(error._tag, "PersistenceSqlError");

      const counts = yield* sql<{
        readonly contracts: number;
        readonly approvals: number;
        readonly dispatches: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM foundry_approved_contracts) AS contracts,
          (SELECT COUNT(*) FROM foundry_approval_events) AS approvals,
          (SELECT COUNT(*) FROM foundry_dispatch_jobs) AS dispatches
      `;
      assert.deepEqual(counts, [{ contracts: 2, approvals: 4, dispatches: 2 }]);
    }),
  );

  it.effect("reads a strict packet without manufacturing a verified proposal", () =>
    Effect.gen(function* () {
      const store = yield* FoundryApprovedContractStore;
      const input = makeStoreInput();
      yield* store.storeVerified(input);

      const packet = yield* store.readPacketByContractHash(input.record.contractHash);
      const record = yield* store.readRecordByContractHash(input.record.contractHash);
      assert.isTrue(Option.isSome(packet));
      assert.isTrue(Option.isSome(record));
      if (Option.isSome(packet)) {
        assert.deepEqual(packet.value, decodePacketJson(input.packetJson));
      }
      if (Option.isSome(record)) {
        assert.deepEqual(record.value, input.record);
      }
      const missing = yield* store.readPacketByContractHash("f".repeat(64));
      assert.isTrue(Option.isNone(missing));
    }),
  );
});

it.effect("decodes the strict packet after reopening the SQLite database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-foundry-contract-store-",
    });
    const databasePath = path.join(tempDirectory, "state.sqlite");
    const input = makeStoreInput();
    const makeStoreLayer = () =>
      FoundryApprovedContractStoreLive.pipe(
        Layer.provideMerge(makeSqlitePersistenceLive(databasePath)),
      );

    yield* Effect.gen(function* () {
      const store = yield* FoundryApprovedContractStore;
      yield* store.storeVerified(input);
    }).pipe(Effect.provide(makeStoreLayer()));

    const packet = yield* Effect.gen(function* () {
      const store = yield* FoundryApprovedContractStore;
      return yield* store.readPacketByContractHash(input.record.contractHash);
    }).pipe(Effect.provide(makeStoreLayer()));

    assert.isTrue(Option.isSome(packet));
    if (Option.isSome(packet)) {
      assert.deepEqual(packet.value, decodePacketJson(input.packetJson));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
