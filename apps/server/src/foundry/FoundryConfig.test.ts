import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { FoundryConfig, FoundryConfigLive } from "./FoundryConfig.ts";

const ALICE_PUBLIC_KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const BOB_PUBLIC_KEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const BUZZ_RELAY_URL = "wss://buzz.example/";

const withEnvironment = (env: Readonly<Record<string, string>>) =>
  FoundryConfigLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

it.effect("leaves Foundry ingestion disabled when configuration is absent", () =>
  Effect.gen(function* () {
    const config = yield* FoundryConfig;
    assert.deepEqual(config, { configured: false });
  }).pipe(Effect.provide(withEnvironment({}))),
);

it.effect("loads strict startup-local Foundry configuration", () =>
  Effect.gen(function* () {
    const config = yield* FoundryConfig;
    assert.isTrue(config.configured);
    if (config.configured) {
      assert.equal(config.environmentId, "founder-alice-laptop");
      assert.equal(config.buzzRelayUrl, BUZZ_RELAY_URL);
      assert.equal(config.buzzGroupId, "foundry-hotpaste");
      assert.deepEqual(
        config.founders.map(({ id }) => id),
        ["founder-alice", "founder-bob"],
      );
    }
  }).pipe(
    Effect.provide(
      withEnvironment({
        T3CODE_FOUNDRY_CONFIG: JSON.stringify({
          protocolVersion: 1,
          environmentId: "founder-alice-laptop",
          buzzRelayUrl: BUZZ_RELAY_URL,
          buzzGroupId: "foundry-hotpaste",
          founders: [
            { id: "founder-alice", publicKey: ALICE_PUBLIC_KEY },
            { id: "founder-bob", publicKey: BOB_PUBLIC_KEY },
          ],
        }),
      }),
    ),
  ),
);

it.effect("fails layer construction when present configuration is malformed", () =>
  Effect.gen(function* () {
    const result = yield* Layer.build(
      withEnvironment({
        T3CODE_FOUNDRY_CONFIG: JSON.stringify({
          protocolVersion: 1,
          environmentId: "founder-alice-laptop",
          buzzRelayUrl: BUZZ_RELAY_URL,
          buzzGroupId: "foundry-hotpaste",
          founders: [
            { id: "founder-bob", publicKey: BOB_PUBLIC_KEY },
            { id: "founder-alice", publicKey: ALICE_PUBLIC_KEY },
          ],
          trusted: true,
        }),
      }),
    ).pipe(Effect.scoped, Effect.result);

    assert.isTrue(Result.isFailure(result));
  }),
);

it.effect("rejects a non-canonical Buzz relay URL", () =>
  Effect.gen(function* () {
    const result = yield* Layer.build(
      withEnvironment({
        T3CODE_FOUNDRY_CONFIG: JSON.stringify({
          protocolVersion: 1,
          environmentId: "founder-alice-laptop",
          buzzRelayUrl: "wss://Buzz.Example",
          buzzGroupId: "foundry-hotpaste",
          founders: [
            { id: "founder-alice", publicKey: ALICE_PUBLIC_KEY },
            { id: "founder-bob", publicKey: BOB_PUBLIC_KEY },
          ],
        }),
      }),
    ).pipe(Effect.scoped, Effect.result);

    assert.isTrue(Result.isFailure(result));
  }),
);
