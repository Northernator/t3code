import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  WS_METHODS,
  type FoundryClaimDispatchInput,
  type FoundryClaimDispatchResult,
  type FoundryGetDispatchInput,
  type FoundryGetDispatchResult,
  type FoundryHeartbeatDispatchInput,
  type FoundryHeartbeatDispatchResult,
  type FoundryReportDispatchInput,
  type FoundryReportDispatchResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { FoundryRunnerError, type FoundryDispatchGateway } from "./runClaim.ts";

export function mapFoundryDispatchRpcFailure(
  operation: string,
  cause: unknown,
): FoundryRunnerError {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "FoundryDispatchRpcError" &&
    "code" in cause
  ) {
    if (cause.code === "lease-lost") {
      return new FoundryRunnerError("lease-lost", `Foundry ${operation} lost its lease.`, cause);
    }
    return new FoundryRunnerError(
      "internal",
      `Foundry ${operation} was rejected (${String(cause.code)}).`,
      cause,
      cause.code === "unavailable" ? "reattach" : "none",
    );
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "EnvironmentAuthorizationError"
  ) {
    return new FoundryRunnerError(
      "internal",
      `Foundry ${operation} was not authorized.`,
      cause,
      "none",
    );
  }
  return new FoundryRunnerError("internal", `Foundry ${operation} failed.`, cause);
}

export interface FoundryDispatchRpcGateway extends FoundryDispatchGateway {
  readonly claim: (
    input: FoundryClaimDispatchInput,
  ) => Effect.Effect<FoundryClaimDispatchResult, FoundryRunnerError>;
  readonly heartbeatResult: (
    input: FoundryHeartbeatDispatchInput,
  ) => Effect.Effect<FoundryHeartbeatDispatchResult, FoundryRunnerError>;
  readonly reportResult: (
    input: FoundryReportDispatchInput,
  ) => Effect.Effect<FoundryReportDispatchResult, FoundryRunnerError>;
  readonly get: (
    input: FoundryGetDispatchInput,
  ) => Effect.Effect<FoundryGetDispatchResult, FoundryRunnerError>;
}

export function makeFoundryDispatchRpcGateway(
  client: WsRpcProtocolClient,
): FoundryDispatchRpcGateway {
  const claim = (input: FoundryClaimDispatchInput) =>
    client[WS_METHODS.foundryClaimDispatch](input).pipe(
      Effect.mapError((cause) => mapFoundryDispatchRpcFailure("claim", cause)),
    );
  const heartbeatResult = (input: FoundryHeartbeatDispatchInput) =>
    client[WS_METHODS.foundryHeartbeatDispatch](input).pipe(
      Effect.mapError((cause) => mapFoundryDispatchRpcFailure("heartbeat", cause)),
    );
  const reportResult = (input: FoundryReportDispatchInput) =>
    client[WS_METHODS.foundryReportDispatch](input).pipe(
      Effect.mapError((cause) => mapFoundryDispatchRpcFailure("report", cause)),
    );
  const get = (input: FoundryGetDispatchInput) =>
    client[WS_METHODS.foundryGetDispatch](input).pipe(
      Effect.mapError((cause) => mapFoundryDispatchRpcFailure("status read", cause)),
    );

  return {
    claim,
    heartbeatResult,
    reportResult,
    get,
    heartbeat: (input) => heartbeatResult(input).pipe(Effect.asVoid),
    report: (input) => reportResult(input).pipe(Effect.asVoid),
  };
}
