export interface FoundryRunnerRetryGate {
  readonly setActiveLeaseDurationMilliseconds: (durationMilliseconds: number) => void;
  readonly deferActiveLeaseFromNow: () => void;
  readonly remainingDelayMilliseconds: () => number;
}

export function makeFoundryRunnerRetryGate(now: () => number = Date.now): FoundryRunnerRetryGate {
  let activeLeaseDurationMilliseconds = 0;
  let retryNotBefore = 0;

  return {
    setActiveLeaseDurationMilliseconds: (durationMilliseconds) => {
      if (!Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) {
        throw new Error("The active Foundry lease duration must be positive.");
      }
      activeLeaseDurationMilliseconds = durationMilliseconds;
    },
    deferActiveLeaseFromNow: () => {
      if (activeLeaseDurationMilliseconds <= 0) {
        throw new Error("The Foundry retry gate has no active lease duration.");
      }
      retryNotBefore = Math.max(retryNotBefore, now() + activeLeaseDurationMilliseconds);
    },
    remainingDelayMilliseconds: () => Math.max(0, retryNotBefore - now()),
  };
}
