import * as NodeCrypto from "node:crypto";

import {
  FoundryRunnerSessionId,
  type FoundryRunnerSessionId as RunnerSessionId,
} from "@t3tools/contracts";

/** Creates one process identity. Call once, then reuse it across connection retries. */
export function createFoundryRunnerSessionId(): RunnerSessionId {
  return FoundryRunnerSessionId.make(NodeCrypto.randomBytes(32).toString("hex"));
}
