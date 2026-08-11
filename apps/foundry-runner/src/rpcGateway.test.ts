import { assert, it } from "@effect/vitest";

import { mapFoundryDispatchRpcFailure } from "./rpcGateway.ts";

it("keeps lease loss fenced and retries only transient dispatch RPC failures", () => {
  const leaseLost = mapFoundryDispatchRpcFailure("heartbeat", {
    _tag: "FoundryDispatchRpcError",
    code: "lease-lost",
  });
  const unavailable = mapFoundryDispatchRpcFailure("claim", {
    _tag: "FoundryDispatchRpcError",
    code: "unavailable",
  });
  const conflict = mapFoundryDispatchRpcFailure("report", {
    _tag: "FoundryDispatchRpcError",
    code: "conflict",
  });
  const unauthorized = mapFoundryDispatchRpcFailure("claim", {
    _tag: "EnvironmentAuthorizationError",
  });

  assert.equal(leaseLost.code, "lease-lost");
  assert.equal(leaseLost.retryMode, "none");
  assert.equal(unavailable.retryMode, "reattach");
  assert.equal(conflict.retryMode, "none");
  assert.equal(unauthorized.retryMode, "none");
});
