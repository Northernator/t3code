import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { RpcSessionFactory } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { FoundryRunnerConfig } from "./config.ts";
import { FoundryRunnerError } from "./runClaim.ts";

export const connectFoundryRunner = Effect.fn("FoundryRunner.connect")(function* (input: {
  readonly config: FoundryRunnerConfig;
  readonly bearerToken: string;
}) {
  if (input.bearerToken.trim().length === 0) {
    return yield* Effect.fail(
      new FoundryRunnerError("internal", "The Foundry runner bearer token is empty."),
    );
  }

  const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
    httpBaseUrl: input.config.httpBaseUrl,
    wsBaseUrl: input.config.wsBaseUrl,
    bearerToken: input.bearerToken,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new FoundryRunnerError(
          "internal",
          "The Foundry runner could not obtain a WebSocket ticket.",
          cause,
        ),
    ),
  );
  const environmentId = EnvironmentId.make(input.config.binding.environmentId);
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: `Foundry runner ${input.config.runnerId}`,
    httpBaseUrl: input.config.httpBaseUrl,
    wsBaseUrl: input.config.wsBaseUrl,
  });
  const prepared: PreparedConnection = {
    environmentId,
    label: target.label,
    httpBaseUrl: input.config.httpBaseUrl,
    socketUrl,
    httpAuthorization: { _tag: "Bearer", token: input.bearerToken },
    target,
  };
  const sessions = yield* RpcSessionFactory;
  const session = yield* sessions
    .connect(prepared)
    .pipe(
      Effect.mapError(
        (cause) =>
          new FoundryRunnerError(
            "internal",
            "The Foundry runner could not open its T3 session.",
            cause,
          ),
      ),
    );
  yield* session.ready.pipe(
    Effect.mapError(
      (cause) =>
        new FoundryRunnerError(
          "internal",
          "The Foundry runner T3 session did not become ready.",
          cause,
        ),
    ),
  );
  return session;
});
