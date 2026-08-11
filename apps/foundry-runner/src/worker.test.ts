import { assert, it } from "@effect/vitest";
import {
  FoundryRunnerSessionId,
  type FoundryClaimDispatchInput,
  type FoundryDispatchClaim,
  type FoundryHeartbeatDispatchInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { FoundryRunnerAuthorityConfig, FoundryRunnerConfig } from "./config.ts";
import { makeFoundryRunnerRetryGate } from "./retryGate.ts";
import { FoundryRunnerError, type FoundryT3Driver } from "./runClaim.ts";
import type { FoundryDispatchRpcGateway } from "./rpcGateway.ts";
import {
  attachClaimRetryDelay,
  failedAttemptDelayMilliseconds,
  heartbeatIntervalMilliseconds,
  isFatalRunnerFailure,
  raceWithClaimHeartbeat,
  reconnectForever,
  runNextFoundryDispatch,
  waitForRetryGate,
  withClaimHeartbeat,
} from "./worker.ts";

const runnerSessionId = FoundryRunnerSessionId.make("a".repeat(64));

function claimWithLease(lastHeartbeatAt: string, leaseExpiresAt: string): FoundryDispatchClaim {
  return {
    attempt: { lastHeartbeatAt, leaseExpiresAt },
  } as FoundryDispatchClaim;
}

function runnableClaim(lastHeartbeatAt: string, leaseExpiresAt: string): FoundryDispatchClaim {
  return {
    job: { dispatchIdempotencyKey: "3".repeat(64) },
    attempt: { fenceToken: 7, lastHeartbeatAt, leaseExpiresAt },
  } as FoundryDispatchClaim;
}

it("derives a bounded heartbeat interval from the server lease", () => {
  assert.equal(
    heartbeatIntervalMilliseconds(
      claimWithLease("2026-08-11T10:00:00.000Z", "2026-08-11T10:00:30.000Z"),
    ),
    10_000,
  );
  assert.equal(
    heartbeatIntervalMilliseconds(
      claimWithLease("2026-08-11T10:00:00.000Z", "2026-08-11T10:00:01.500Z"),
    ),
    1_000,
  );
  assert.throws(
    () =>
      heartbeatIntervalMilliseconds(
        claimWithLease("2026-08-11T10:00:30.000Z", "2026-08-11T10:00:00.000Z"),
      ),
    FoundryRunnerError,
  );
});

it("waits one full lease duration for an adopted pending turn but fast-retries transport loss", () => {
  const claim = claimWithLease("2026-08-11T10:00:00.000Z", "2026-08-11T10:01:00.000Z");
  const pending = attachClaimRetryDelay(
    new FoundryRunnerError(
      "turn-failed",
      "approval callback is stale",
      undefined,
      "after-lease-expiry",
    ),
    claim,
  );
  const transport = attachClaimRetryDelay(
    new FoundryRunnerError("internal", "socket closed"),
    claim,
  );

  assert.equal(pending.retryDelayMilliseconds, 60_000);
  assert.equal(failedAttemptDelayMilliseconds(pending), 60_000);
  assert.equal(transport.retryMode, "reattach");
  assert.equal(failedAttemptDelayMilliseconds(transport), 1_000);
});

it("stops on unreported permanent failures but continues after a terminal report", () => {
  const permanent = new FoundryRunnerError("internal", "dispatch conflict", undefined, "none");

  assert.isTrue(isFatalRunnerFailure(permanent));
  assert.isFalse(isFatalRunnerFailure(permanent.withTerminalReported()));
  assert.isFalse(
    isFatalRunnerFailure(new FoundryRunnerError("lease-lost", "another worker owns the fence")),
  );
});

it.effect("keeps the remaining lease cooldown when a connection interrupts the wait", () =>
  Effect.gen(function* () {
    let now = 1_000;
    const retryGate = makeFoundryRunnerRetryGate(() => now);
    retryGate.setActiveLeaseDurationMilliseconds(60_000);
    retryGate.deferActiveLeaseFromNow();

    const firstWait = yield* waitForRetryGate(retryGate).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("12 seconds");
    yield* Fiber.interrupt(firstWait);
    now += 12_000;

    const completed = yield* Deferred.make<void>();
    yield* waitForRetryGate(retryGate).pipe(
      Effect.andThen(Deferred.succeed(completed, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("47999 millis");
    assert.isFalse(yield* Deferred.isDone(completed));
    yield* TestClock.adjust("1 millis");
    assert.isTrue(yield* Deferred.isDone(completed));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("uses the process session for every heartbeat", () =>
  Effect.gen(function* () {
    const claim = runnableClaim("2026-08-11T10:00:00.000Z", "2026-08-11T10:00:03.000Z");
    const observed = yield* Ref.make<FoundryHeartbeatDispatchInput | null>(null);
    const gateway = {
      heartbeat: (input: FoundryHeartbeatDispatchInput) =>
        Ref.set(observed, input).pipe(
          Effect.andThen(Effect.fail(new FoundryRunnerError("lease-lost", "stop heartbeat loop"))),
        ),
    } as unknown as FoundryDispatchRpcGateway;
    const fiber = yield* withClaimHeartbeat({
      claim,
      runnerId: "runner-one",
      runnerSessionId,
      gateway,
      execute: Effect.never,
    }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);

    assert.deepEqual(yield* Ref.get(observed), {
      dispatchIdempotencyKey: "3".repeat(64),
      runnerId: "runner-one",
      runnerSessionId,
      fenceToken: 7,
    });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("uses the same process session when claiming after reconnect", () =>
  Effect.gen(function* () {
    let observed: FoundryClaimDispatchInput | null = null;
    const gateway = {
      claim: (input: FoundryClaimDispatchInput) =>
        Effect.sync(() => {
          observed = input;
          return { claim: null };
        }),
    } as unknown as FoundryDispatchRpcGateway;
    const didWork = yield* runNextFoundryDispatch({
      authority: {} as FoundryRunnerAuthorityConfig,
      config: {
        runnerId: "runner-one",
        binding: { environmentId: "founder-alice-laptop" },
      } as FoundryRunnerConfig,
      runnerSessionId,
      retryGate: makeFoundryRunnerRetryGate(),
      gateway,
      t3: {} as FoundryT3Driver,
    });

    assert.isFalse(didWork);
    assert.deepEqual(observed, {
      environmentId: "founder-alice-laptop",
      runnerId: "runner-one",
      runnerSessionId,
    });
  }),
);

it.effect("interrupts local execution when a heartbeat loses the fence", () =>
  Effect.gen(function* () {
    const interrupted = yield* Ref.make(false);
    const execute = Effect.never.pipe(Effect.ensuring(Ref.set(interrupted, true)));
    const heartbeat = Effect.fail(
      new FoundryRunnerError("lease-lost", "The competing runner owns the new fence."),
    );

    const fiber = yield* raceWithClaimHeartbeat({ execute, heartbeat }).pipe(
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );
    const failure = yield* Fiber.join(fiber);

    assert.equal(failure.code, "lease-lost");
    assert.isTrue(yield* Ref.get(interrupted));
  }),
);

it.effect("opens a fresh connection after the current server session closes", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const reconnected = yield* Deferred.make<void>();
    const connectionFailure = new FoundryRunnerError("internal", "server restarted");
    const connectAndRun = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
      Effect.flatMap((attempt) =>
        attempt === 1
          ? Effect.fail(connectionFailure)
          : Deferred.succeed(reconnected, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    );
    const fiber = yield* reconnectForever({
      connectAndRun,
      recover: () => Effect.void,
    }).pipe(Effect.forkChild({ startImmediately: true }));

    yield* Deferred.await(reconnected);
    yield* Fiber.interrupt(fiber);
    assert.equal(yield* Ref.get(attempts), 2);
  }),
);
