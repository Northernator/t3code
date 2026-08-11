import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { rpcSessionFactoryLayer } from "@t3tools/client-runtime/rpc";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { connectFoundryRunner } from "./connection.ts";
import {
  decodeFoundryRunnerAuthorityConfig,
  decodeFoundryRunnerConfig,
  validateFoundryRunnerConfiguration,
} from "./config.ts";
import { makeFoundryDispatchRpcGateway } from "./rpcGateway.ts";
import { makeFoundryRunnerRetryGate } from "./retryGate.ts";
import { FoundryRunnerError } from "./runClaim.ts";
import { createFoundryRunnerSessionId } from "./runnerSession.ts";
import { makeFoundryT3Driver, makeNodeFoundryGitInspector } from "./t3Driver.ts";
import { reconnectForever, runFoundryWorker } from "./worker.ts";

const decodeConfiguration = Effect.fn("FoundryRunner.decodeConfiguration")(function* (input: {
  readonly authorityJson: string;
  readonly runnerJson: string;
}) {
  return yield* Effect.try({
    try: () => {
      const authority = decodeFoundryRunnerAuthorityConfig(input.authorityJson);
      const runner = decodeFoundryRunnerConfig(input.runnerJson);
      validateFoundryRunnerConfiguration({ authority, runner });
      return { authority, runner };
    },
    catch: (cause) =>
      new FoundryRunnerError("internal", "The Foundry runner configuration is invalid.", cause),
  });
});

export const program = Effect.gen(function* () {
  const authorityJson = yield* Config.string("T3CODE_FOUNDRY_CONFIG");
  const runnerJson = yield* Config.string("T3CODE_FOUNDRY_RUNNER_CONFIG");
  const bearerToken = yield* Config.string("T3CODE_FOUNDRY_RUNNER_TOKEN");
  const { authority, runner } = yield* decodeConfiguration({ authorityJson, runnerJson });
  const runnerSessionId = createFoundryRunnerSessionId();
  const retryGate = makeFoundryRunnerRetryGate();
  const git = yield* makeNodeFoundryGitInspector();

  const connectAndRun = Effect.scoped(
    Effect.gen(function* () {
      const session = yield* connectFoundryRunner({ config: runner, bearerToken });
      const gateway = makeFoundryDispatchRpcGateway(session.client);
      const t3 = makeFoundryT3Driver({ client: session.client, git, retryGate });

      yield* Console.log(
        `Foundry runner ${runner.runnerId} connected to ${runner.binding.environmentId}.`,
      );
      return yield* Effect.raceFirst(
        runFoundryWorker({ authority, config: runner, runnerSessionId, retryGate, gateway, t3 }),
        session.closed.pipe(
          Effect.mapError(
            (cause) =>
              new FoundryRunnerError(
                "internal",
                "The Foundry runner T3 session disconnected.",
                cause,
              ),
          ),
        ),
      );
    }),
  );
  return yield* reconnectForever({
    connectAndRun,
    recover: (cause) =>
      Console.error(
        `Foundry runner connection stopped (${cause instanceof FoundryRunnerError ? cause.code : "internal"}); retrying.`,
      ).pipe(Effect.andThen(Effect.sleep("2 seconds"))),
  });
});

const httpClientLayer = NodeHttpClient.layerUndici;
const webSocketLayer = NodeSocket.layerWebSocketConstructor;
const rpcLayer = rpcSessionFactoryLayer.pipe(Layer.provide(webSocketLayer));
const runtimeLayer = Layer.mergeAll(NodeServices.layer, httpClientLayer, webSocketLayer, rpcLayer);

if (import.meta.main) {
  program.pipe(Effect.scoped, Effect.provide(runtimeLayer), NodeRuntime.runMain);
}
