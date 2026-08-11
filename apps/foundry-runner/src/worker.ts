import type {
  FoundryDispatchClaim,
  FoundryDispatchFailureCode,
  FoundryRunnerSessionId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { FoundryRunnerAuthorityConfig, FoundryRunnerConfig } from "./config.ts";
import type { FoundryRunnerRetryGate } from "./retryGate.ts";
import { FoundryRunnerError, runClaimedDispatch, type FoundryT3Driver } from "./runClaim.ts";
import type { FoundryDispatchRpcGateway } from "./rpcGateway.ts";

const MINIMUM_HEARTBEAT_INTERVAL_MS = 1_000;
const MAXIMUM_HEARTBEAT_INTERVAL_MS = 10_000;
const EMPTY_QUEUE_DELAY = "2 seconds";
const FAILED_ATTEMPT_DELAY_MS = 1_000;

export function leaseDurationMilliseconds(claim: FoundryDispatchClaim): number {
  const leaseDuration =
    Date.parse(claim.attempt.leaseExpiresAt) - Date.parse(claim.attempt.lastHeartbeatAt);
  if (!Number.isFinite(leaseDuration) || leaseDuration <= 0) {
    throw new FoundryRunnerError("lease-lost", "The claimed dispatch lease is already invalid.");
  }
  return leaseDuration;
}

export function attachClaimRetryDelay(
  cause: FoundryRunnerError,
  claim: FoundryDispatchClaim,
): FoundryRunnerError {
  return cause.retryMode === "after-lease-expiry"
    ? cause.withRetryDelayMilliseconds(leaseDurationMilliseconds(claim))
    : cause;
}

export function heartbeatIntervalMilliseconds(claim: FoundryDispatchClaim): number {
  const leaseDuration = leaseDurationMilliseconds(claim);
  return Math.max(
    MINIMUM_HEARTBEAT_INTERVAL_MS,
    Math.min(MAXIMUM_HEARTBEAT_INTERVAL_MS, Math.floor(leaseDuration / 3)),
  );
}

export function raceWithClaimHeartbeat<A, E, R>(input: {
  readonly execute: Effect.Effect<A, E, R>;
  readonly heartbeat: Effect.Effect<never, FoundryRunnerError>;
}): Effect.Effect<A, E | FoundryRunnerError, R> {
  return Effect.raceFirst(input.execute, input.heartbeat);
}

export function reconnectForever<E, R, RRecovery>(input: {
  readonly connectAndRun: Effect.Effect<never, E, R>;
  readonly recover: (cause: E) => Effect.Effect<void, never, RRecovery>;
}): Effect.Effect<never, never, R | RRecovery> {
  const loop: Effect.Effect<never, never, R | RRecovery> = Effect.suspend(() =>
    input.connectAndRun.pipe(
      Effect.catch((cause) => input.recover(cause).pipe(Effect.andThen(loop))),
    ),
  );
  return loop;
}

export function withClaimHeartbeat<A, E, R>(input: {
  readonly claim: FoundryDispatchClaim;
  readonly runnerId: string;
  readonly runnerSessionId: FoundryRunnerSessionId;
  readonly gateway: FoundryDispatchRpcGateway;
  readonly execute: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | FoundryRunnerError, R> {
  const interval = heartbeatIntervalMilliseconds(input.claim);
  const heartbeat = Effect.sleep(Duration.millis(interval)).pipe(
    Effect.andThen(
      input.gateway.heartbeat({
        dispatchIdempotencyKey: input.claim.job.dispatchIdempotencyKey,
        runnerId: input.runnerId,
        runnerSessionId: input.runnerSessionId,
        fenceToken: input.claim.attempt.fenceToken,
      }),
    ),
    Effect.forever,
  );
  return raceWithClaimHeartbeat({ execute: input.execute, heartbeat });
}

export const runNextFoundryDispatch = Effect.fn("FoundryRunner.runNext")(function* (input: {
  readonly authority: FoundryRunnerAuthorityConfig;
  readonly config: FoundryRunnerConfig;
  readonly runnerSessionId: FoundryRunnerSessionId;
  readonly retryGate: FoundryRunnerRetryGate;
  readonly gateway: FoundryDispatchRpcGateway;
  readonly t3: FoundryT3Driver;
}) {
  const claimed = yield* input.gateway.claim({
    environmentId: input.config.binding.environmentId,
    runnerId: input.config.runnerId,
    runnerSessionId: input.runnerSessionId,
  });
  const claim = claimed.claim;
  if (claim === null) {
    return false;
  }
  input.retryGate.setActiveLeaseDurationMilliseconds(leaseDurationMilliseconds(claim));

  yield* withClaimHeartbeat({
    claim,
    runnerId: input.config.runnerId,
    runnerSessionId: input.runnerSessionId,
    gateway: input.gateway,
    execute: runClaimedDispatch({
      claim,
      runnerId: input.config.runnerId,
      runnerSessionId: input.runnerSessionId,
      authority: input.authority,
      binding: input.config.binding,
      gateway: input.gateway,
      t3: input.t3,
    }),
  }).pipe(
    Effect.mapError((cause) => {
      const failure = attachClaimRetryDelay(cause, claim);
      if (
        failure.retryMode === "after-lease-expiry" &&
        input.retryGate.remainingDelayMilliseconds() === 0
      ) {
        input.retryGate.deferActiveLeaseFromNow();
      }
      return failure;
    }),
  );
  return true;
});

function safeFailureCode(cause: unknown): FoundryDispatchFailureCode {
  return cause instanceof FoundryRunnerError ? cause.code : "internal";
}

function retryDisposition(cause: unknown): string {
  if (!(cause instanceof FoundryRunnerError)) {
    return "";
  }
  if (cause.retryMode === "after-lease-expiry") {
    return " Heartbeats stopped; retrying after the full lease duration.";
  }
  return cause.retryMode === "reattach"
    ? " Reattaching this runner session without consuming an attempt."
    : "";
}

export function isFatalRunnerFailure(cause: unknown): boolean {
  return (
    cause instanceof FoundryRunnerError &&
    cause.retryMode === "none" &&
    cause.code !== "lease-lost" &&
    !cause.terminalReported
  );
}

export function failedAttemptDelayMilliseconds(cause: unknown): number {
  if (
    cause instanceof FoundryRunnerError &&
    cause.retryMode === "after-lease-expiry" &&
    cause.retryDelayMilliseconds !== null
  ) {
    return cause.retryDelayMilliseconds;
  }
  return FAILED_ATTEMPT_DELAY_MS;
}

export function waitForRetryGate(retryGate: FoundryRunnerRetryGate): Effect.Effect<void, never> {
  return Effect.suspend(() => {
    const remainingDelay = retryGate.remainingDelayMilliseconds();
    return remainingDelay > 0 ? Effect.sleep(Duration.millis(remainingDelay)) : Effect.void;
  });
}

export function runFoundryWorker(input: {
  readonly authority: FoundryRunnerAuthorityConfig;
  readonly config: FoundryRunnerConfig;
  readonly runnerSessionId: FoundryRunnerSessionId;
  readonly retryGate: FoundryRunnerRetryGate;
  readonly gateway: FoundryDispatchRpcGateway;
  readonly t3: FoundryT3Driver;
}): Effect.Effect<never, never> {
  const loop: Effect.Effect<never, never> = Effect.suspend(() =>
    waitForRetryGate(input.retryGate).pipe(
      Effect.andThen(runNextFoundryDispatch(input)),
      Effect.catch((cause) => {
        const logged = Console.error(
          `Foundry dispatch attempt stopped (${safeFailureCode(cause)}).${retryDisposition(cause)}`,
        );
        if (isFatalRunnerFailure(cause)) {
          return logged.pipe(Effect.andThen(Effect.die(cause)));
        }
        return logged.pipe(
          Effect.andThen(Effect.sleep(Duration.millis(failedAttemptDelayMilliseconds(cause)))),
          Effect.as(false),
        );
      }),
      Effect.flatMap((didWork) =>
        (didWork ? Effect.void : Effect.sleep(EMPTY_QUEUE_DELAY)).pipe(Effect.andThen(loop)),
      ),
    ),
  );
  return loop;
}
