import { assert, it } from "@effect/vitest";
import { FoundryRunnerSessionId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createFoundryRunnerSessionId } from "./runnerSession.ts";

const isRunnerSessionId = Schema.is(FoundryRunnerSessionId);

it("creates a fresh opaque runner session identity", () => {
  const first = createFoundryRunnerSessionId();
  const second = createFoundryRunnerSessionId();

  assert.isTrue(isRunnerSessionId(first));
  assert.isTrue(isRunnerSessionId(second));
  assert.notEqual(first, second);
});
