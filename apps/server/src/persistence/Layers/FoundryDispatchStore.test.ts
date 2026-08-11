import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { FoundryDispatchStore } from "../Services/FoundryDispatchStore.ts";
import { FoundryDispatchStoreLive } from "./FoundryDispatchStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const acceptedAt = "2026-08-11T12:00:00.000Z";
const firstExpiry = "2026-08-11T12:01:00.000Z";
const reclaimedAt = "2026-08-11T12:02:00.000Z";
const secondExpiry = "2026-08-11T12:03:00.000Z";
const dispatchIdempotencyKey = "3".repeat(64);
const dispatchId = `dispatch_${dispatchIdempotencyKey.slice(0, 24)}`;
const contractHash = "1".repeat(64);
const runnerOneSessionId = "a".repeat(64);
const runnerTwoSessionId = "b".repeat(64);
const replacementSessionId = "c".repeat(64);

const seedDispatch = Effect.fn("seedFoundryDispatch")(function* ({
  maxAttempts = 3,
}: {
  readonly maxAttempts?: number;
} = {}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM foundry_dispatch_evidence`;
  yield* sql`DELETE FROM foundry_dispatch_attempts`;
  yield* sql`DELETE FROM foundry_dispatch_jobs`;
  yield* sql`DELETE FROM foundry_approval_events`;
  yield* sql`DELETE FROM foundry_approved_contracts`;
  yield* sql`
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
      ${contractHash},
      ${"hotpaste"},
      ${"clipboard-history"},
      ${1},
      ${"2".repeat(64)},
      ${"foundry.contract.approve/v1\nhotpaste\nclipboard-history"},
      ${dispatchIdempotencyKey},
      ${"{}"},
      ${"{}"},
      ${"4".repeat(64)},
      ${acceptedAt}
    )
  `;
  yield* sql`
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
      ${dispatchId},
      ${dispatchIdempotencyKey},
      ${contractHash},
      ${"founder-alice-laptop"},
      ${"foundry/clipboard-history-v1-111111111111"},
      ${"0".repeat(40)},
      ${"queued"},
      ${0},
      ${0},
      ${maxAttempts},
      ${null},
      ${null},
      ${acceptedAt},
      ${acceptedAt},
      ${acceptedAt},
      ${null},
      ${null}
    )
  `;
});

const runnerSession = (runnerId: string) =>
  runnerId === "runner-one" ? runnerOneSessionId : runnerTwoSessionId;

const claim = (
  runnerId: string,
  claimedAt = acceptedAt,
  leaseExpiresAt = firstExpiry,
  runnerSessionId = runnerSession(runnerId),
) =>
  Effect.flatMap(FoundryDispatchStore, (store) =>
    store.claimNext({
      environmentId: "founder-alice-laptop",
      runnerId,
      runnerSessionId,
      claimedAt,
      leaseExpiresAt,
    }),
  );

const layer = it.layer(FoundryDispatchStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("FoundryDispatchStore", (it) => {
  it.effect("allows only one winner when two runners claim concurrently", () =>
    Effect.gen(function* () {
      yield* seedDispatch();

      const results = yield* Effect.all([claim("runner-one"), claim("runner-two")], {
        concurrency: "unbounded",
      });

      assert.equal(results.filter(Option.isSome).length, 1);
      assert.equal(results.filter(Option.isNone).length, 1);
      const winner = results.find(Option.isSome);
      assert.isDefined(winner);
      if (winner && Option.isSome(winner)) {
        assert.equal(winner.value.job.attemptCount, 1);
        assert.equal(winner.value.job.fenceToken, 1);
        assert.equal(winner.value.attempt.runnerId, winner.value.job.leaseOwner);
        assert.equal(winner.value.attempt.runnerSessionId, winner.value.job.leaseSessionId);
      }
    }),
  );

  it.effect("allows only one winner when duplicated runner config starts two sessions", () =>
    Effect.gen(function* () {
      yield* seedDispatch();

      const results = yield* Effect.all(
        [
          claim("runner-one", acceptedAt, firstExpiry, runnerOneSessionId),
          claim("runner-one", acceptedAt, firstExpiry, replacementSessionId),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter(Option.isSome).length, 1);
      assert.equal(results.filter(Option.isNone).length, 1);
    }),
  );

  it.effect("reattaches the same live runner session without consuming an attempt", () =>
    Effect.gen(function* () {
      yield* seedDispatch();
      const first = yield* claim("runner-one");
      assert.isTrue(Option.isSome(first));

      const reattachedAt = "2026-08-11T12:00:30.000Z";
      const reattachedExpiry = "2026-08-11T12:01:30.000Z";
      const reattached = yield* claim(
        "runner-one",
        reattachedAt,
        reattachedExpiry,
        runnerOneSessionId,
      );
      assert.isTrue(Option.isSome(reattached));
      if (Option.isNone(reattached)) {
        return;
      }

      assert.equal(reattached.value.job.attemptCount, 1);
      assert.equal(reattached.value.job.fenceToken, 1);
      assert.equal(reattached.value.job.leaseSessionId, runnerOneSessionId);
      assert.equal(reattached.value.job.leaseExpiresAt, reattachedExpiry);
      assert.equal(reattached.value.attempt.claimedAt, acceptedAt);
      assert.equal(reattached.value.attempt.lastHeartbeatAt, reattachedAt);
      assert.equal(reattached.value.attempt.leaseExpiresAt, reattachedExpiry);
      assert.equal(reattached.value.attempt.runnerSessionId, runnerOneSessionId);
    }),
  );

  it.effect("makes a new process session wait for expiry and then issues a new fence", () =>
    Effect.gen(function* () {
      yield* seedDispatch();
      const store = yield* FoundryDispatchStore;
      const first = yield* claim("runner-one");
      assert.isTrue(Option.isSome(first));

      const beforeExpiry = yield* claim(
        "runner-one",
        "2026-08-11T12:00:30.000Z",
        "2026-08-11T12:01:30.000Z",
        replacementSessionId,
      );
      assert.isTrue(Option.isNone(beforeExpiry));

      const staleSessionHeartbeat = yield* Effect.flip(
        store.heartbeat({
          dispatchIdempotencyKey,
          runnerId: "runner-one",
          runnerSessionId: replacementSessionId,
          fenceToken: 1,
          heartbeatAt: "2026-08-11T12:00:30.000Z",
          leaseExpiresAt: "2026-08-11T12:01:30.000Z",
        }),
      );
      assert.equal(staleSessionHeartbeat._tag, "FoundryDispatchLeaseError");

      const reclaimed = yield* claim("runner-one", reclaimedAt, secondExpiry, replacementSessionId);
      assert.isTrue(Option.isSome(reclaimed));
      if (Option.isNone(reclaimed)) {
        return;
      }
      assert.equal(reclaimed.value.job.attemptCount, 2);
      assert.equal(reclaimed.value.job.fenceToken, 2);
      assert.equal(reclaimed.value.job.leaseSessionId, replacementSessionId);
      assert.equal(reclaimed.value.attempt.runnerSessionId, replacementSessionId);
    }),
  );

  it.effect("reclaims an expired lease and rejects the stale fencing token", () =>
    Effect.gen(function* () {
      yield* seedDispatch();
      const store = yield* FoundryDispatchStore;
      const first = yield* claim("runner-one");
      assert.isTrue(Option.isSome(first));

      const second = yield* claim("runner-two", reclaimedAt, secondExpiry);
      assert.isTrue(Option.isSome(second));
      if (Option.isNone(second)) {
        return;
      }
      assert.equal(second.value.job.attemptCount, 2);
      assert.equal(second.value.job.fenceToken, 2);
      assert.equal(second.value.attempt.runnerId, "runner-two");

      const stale = yield* Effect.flip(
        store.heartbeat({
          dispatchIdempotencyKey,
          runnerId: "runner-one",
          runnerSessionId: runnerOneSessionId,
          fenceToken: 1,
          heartbeatAt: reclaimedAt,
          leaseExpiresAt: secondExpiry,
        }),
      );
      assert.equal(stale._tag, "FoundryDispatchLeaseError");
      if (stale._tag === "FoundryDispatchLeaseError") {
        assert.equal(stale.reason, "lease-lost");
      }

      const heartbeat = yield* store.heartbeat({
        dispatchIdempotencyKey,
        runnerId: "runner-two",
        runnerSessionId: runnerTwoSessionId,
        fenceToken: 2,
        heartbeatAt: "2026-08-11T12:02:10.000Z",
        leaseExpiresAt: "2026-08-11T12:04:00.000Z",
      });
      assert.equal(heartbeat.job.leaseExpiresAt, "2026-08-11T12:04:00.000Z");
      assert.equal(heartbeat.attempt.leaseExpiresAt, "2026-08-11T12:04:00.000Z");

      const status = yield* store.readStatus(dispatchIdempotencyKey);
      assert.isTrue(Option.isSome(status));
      if (Option.isSome(status)) {
        assert.deepEqual(
          status.value.attempts.map(({ state, fenceToken }) => ({ state, fenceToken })),
          [
            { state: "abandoned", fenceToken: 1 },
            { state: "running", fenceToken: 2 },
          ],
        );
      }
    }),
  );

  it.effect("persists idempotent evidence and a terminal result under the current lease", () =>
    Effect.gen(function* () {
      yield* seedDispatch();
      const store = yield* FoundryDispatchStore;
      const claimed = yield* claim("runner-one");
      assert.isTrue(Option.isSome(claimed));

      const evidenceInput = {
        dispatchIdempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: runnerOneSessionId,
        fenceToken: 1,
        reportId: "5".repeat(64),
        kind: "turn-planned",
        payloadJson:
          '{"kind":"turn-planned","evidenceKey":"7777777777777777777777777777777777777777777777777777777777777777","threadId":"foundry-thread-33333333333333333333333333333333","commandId":"foundry-command-33333333333333333333333333333333","messageId":"foundry-message-33333333333333333333333333333333","createdAt":"2026-08-11T12:00:00.000Z"}',
        recordedAt: "2026-08-11T12:00:10.000Z",
      } as const;
      const recorded = yield* store.recordEvidence(evidenceInput);
      const replayed = yield* store.recordEvidence(evidenceInput);
      assert.equal(recorded.disposition, "recorded");
      assert.equal(replayed.disposition, "replayed");
      assert.deepEqual(replayed.evidence, recorded.evidence);

      const conflict = yield* Effect.flip(
        store.recordEvidence({ ...evidenceInput, payloadJson: "{}" }),
      );
      assert.equal(conflict._tag, "FoundryDispatchEvidenceConflictError");

      const completed = yield* store.complete({
        dispatchIdempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: runnerOneSessionId,
        fenceToken: 1,
        completedAt: "2026-08-11T12:00:20.000Z",
        outcome: "succeeded",
        failureCode: null,
      });
      assert.equal(completed.job.state, "succeeded");
      assert.equal(completed.evidence.length, 1);

      const terminalReplay = yield* store.recordEvidence(evidenceInput);
      assert.equal(terminalReplay.disposition, "replayed");
      assert.deepEqual(terminalReplay.evidence, recorded.evidence);
      const completionReplay = yield* store.complete({
        dispatchIdempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: runnerOneSessionId,
        fenceToken: 1,
        completedAt: "2026-08-11T12:00:30.000Z",
        outcome: "succeeded",
        failureCode: null,
      });
      assert.equal(completionReplay.job.completedAt, "2026-08-11T12:00:20.000Z");
    }),
  );

  it.effect("atomically finalizes terminal evidence and replays the committed result", () =>
    Effect.gen(function* () {
      yield* seedDispatch();
      const store = yield* FoundryDispatchStore;
      const claimed = yield* claim("runner-one");
      assert.isTrue(Option.isSome(claimed));

      const input = {
        dispatchIdempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: runnerOneSessionId,
        fenceToken: 1,
        reportId: "7".repeat(64),
        kind: "succeeded",
        payloadJson: '{"kind":"succeeded"}',
        recordedAt: "2026-08-11T12:00:20.000Z",
        outcome: "succeeded",
        failureCode: null,
      } as const;
      const finalized = yield* store.finalizeWithEvidence(input);
      const replayed = yield* store.finalizeWithEvidence({
        ...input,
        recordedAt: "2026-08-11T12:00:30.000Z",
      });

      assert.equal(finalized.disposition, "recorded");
      assert.equal(finalized.status.job.state, "succeeded");
      assert.equal(finalized.status.attempts[0]?.state, "succeeded");
      assert.equal(finalized.status.evidence.length, 1);
      assert.equal(replayed.disposition, "replayed");
      assert.equal(replayed.status.job.completedAt, input.recordedAt);
      assert.equal(replayed.status.evidence.length, 1);
      assert.deepEqual(replayed.evidence, finalized.evidence);
    }),
  );

  it.effect("rejects stale-session evidence and terminal finalization", () =>
    Effect.gen(function* () {
      yield* seedDispatch();
      const store = yield* FoundryDispatchStore;
      const claimed = yield* claim("runner-one");
      assert.isTrue(Option.isSome(claimed));

      const evidenceInput = {
        dispatchIdempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: runnerOneSessionId,
        fenceToken: 1,
        reportId: "d".repeat(64),
        kind: "turn-started",
        payloadJson: '{"kind":"turn-started"}',
        recordedAt: "2026-08-11T12:00:10.000Z",
      } as const;
      yield* store.recordEvidence(evidenceInput);

      const staleEvidence = yield* store
        .recordEvidence({ ...evidenceInput, runnerSessionId: replacementSessionId })
        .pipe(Effect.flip);
      const staleFinalization = yield* store
        .finalizeWithEvidence({
          ...evidenceInput,
          runnerSessionId: replacementSessionId,
          reportId: "e".repeat(64),
          kind: "succeeded",
          payloadJson: '{"kind":"succeeded"}',
          outcome: "succeeded",
          failureCode: null,
        })
        .pipe(Effect.flip);

      assert.equal(staleEvidence._tag, "FoundryDispatchLeaseError");
      assert.equal(staleFinalization._tag, "FoundryDispatchLeaseError");
      const status = yield* store.readStatus(dispatchIdempotencyKey);
      assert.isTrue(Option.isSome(status));
      if (Option.isSome(status)) {
        assert.equal(status.value.job.state, "running");
        assert.equal(status.value.attempts[0]?.state, "running");
        assert.equal(status.value.evidence.length, 1);
      }
    }),
  );

  it.effect("rolls back terminal evidence and job state when attempt completion crashes", () =>
    Effect.gen(function* () {
      yield* seedDispatch();
      const store = yield* FoundryDispatchStore;
      const sql = yield* SqlClient.SqlClient;
      const claimed = yield* claim("runner-one");
      assert.isTrue(Option.isSome(claimed));

      yield* sql`
        CREATE TEMP TRIGGER foundry_dispatch_fail_attempt_completion
        BEFORE UPDATE OF state ON foundry_dispatch_attempts
        WHEN OLD.state = 'running' AND NEW.state = 'succeeded'
        BEGIN
          SELECT RAISE(ABORT, 'injected terminal attempt failure');
        END
      `;
      const input = {
        dispatchIdempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: runnerOneSessionId,
        fenceToken: 1,
        reportId: "8".repeat(64),
        kind: "succeeded",
        payloadJson: '{"kind":"succeeded"}',
        recordedAt: "2026-08-11T12:00:20.000Z",
        outcome: "succeeded",
        failureCode: null,
      } as const;
      const failure = yield* store.finalizeWithEvidence(input).pipe(Effect.flip);
      assert.equal(failure._tag, "PersistenceSqlError");
      yield* sql`DROP TRIGGER foundry_dispatch_fail_attempt_completion`;

      const rolledBack = yield* store.readStatus(dispatchIdempotencyKey);
      assert.isTrue(Option.isSome(rolledBack));
      if (Option.isSome(rolledBack)) {
        assert.equal(rolledBack.value.job.state, "running");
        assert.equal(rolledBack.value.job.completedAt, null);
        assert.equal(rolledBack.value.attempts[0]?.state, "running");
        assert.equal(rolledBack.value.attempts[0]?.completedAt, null);
        assert.equal(rolledBack.value.evidence.length, 0);
      }

      const recovered = yield* store.finalizeWithEvidence(input);
      assert.equal(recovered.disposition, "recorded");
      assert.equal(recovered.status.job.state, "succeeded");
      assert.equal(recovered.status.evidence.length, 1);
    }),
  );

  it.effect("fails an expired dispatch instead of exceeding its retry budget", () =>
    Effect.gen(function* () {
      yield* seedDispatch({ maxAttempts: 1 });
      const store = yield* FoundryDispatchStore;
      yield* claim("runner-one");

      const reclaimed = yield* claim("runner-two", reclaimedAt, secondExpiry);
      assert.isTrue(Option.isNone(reclaimed));
      const status = yield* store.readStatus(dispatchIdempotencyKey);
      assert.isTrue(Option.isSome(status));
      if (Option.isSome(status)) {
        assert.equal(status.value.job.state, "failed");
        assert.equal(status.value.job.failureCode, "lease-lost");
        assert.equal(status.value.job.attemptCount, 1);
        assert.equal(status.value.attempts[0]?.state, "abandoned");
      }
    }),
  );
});

it.effect("recovers the current lease, evidence, and deterministic timestamp after reopening", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-foundry-dispatch-" });
    const databasePath = path.join(directory, "state.sqlite");
    const makeStoreLayer = () =>
      FoundryDispatchStoreLive.pipe(Layer.provideMerge(makeSqlitePersistenceLive(databasePath)));

    yield* Effect.gen(function* () {
      yield* seedDispatch();
      const claimed = yield* claim("runner-one");
      assert.isTrue(Option.isSome(claimed));
      const store = yield* FoundryDispatchStore;
      yield* store.recordEvidence({
        dispatchIdempotencyKey,
        runnerId: "runner-one",
        runnerSessionId: runnerOneSessionId,
        fenceToken: 1,
        reportId: "6".repeat(64),
        kind: "worktree-planned",
        payloadJson: '{"kind":"worktree-planned"}',
        recordedAt: "2026-08-11T12:00:10.000Z",
      });
    }).pipe(Effect.provide(makeStoreLayer()));

    const reopened = yield* Effect.gen(function* () {
      const store = yield* FoundryDispatchStore;
      return yield* store.readStatus(dispatchIdempotencyKey);
    }).pipe(Effect.provide(makeStoreLayer()));

    assert.isTrue(Option.isSome(reopened));
    if (Option.isSome(reopened)) {
      assert.equal(reopened.value.job.state, "running");
      assert.equal(reopened.value.job.commandCreatedAt, acceptedAt);
      assert.equal(reopened.value.job.fenceToken, 1);
      assert.equal(reopened.value.evidence.length, 1);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
