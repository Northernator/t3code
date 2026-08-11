import { assert, it } from "@effect/vitest";

import { makeFoundryRunnerRetryGate } from "./retryGate.ts";

it("retains the remaining lease cooldown across worker reconnections", () => {
  let now = 1_000;
  const gate = makeFoundryRunnerRetryGate(() => now);
  gate.setActiveLeaseDurationMilliseconds(60_000);
  gate.deferActiveLeaseFromNow();

  assert.equal(gate.remainingDelayMilliseconds(), 60_000);
  now += 12_000;
  assert.equal(gate.remainingDelayMilliseconds(), 48_000);
  now += 48_000;
  assert.equal(gate.remainingDelayMilliseconds(), 0);
});
