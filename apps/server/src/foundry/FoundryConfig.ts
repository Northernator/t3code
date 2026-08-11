import {
  FoundryBuzzRelayUrl,
  FoundryFounderRegistry,
  type FoundryFounderRegistry as FounderRegistry,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const strictDecodeOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isTrimmed(),
);

const BuzzGroupId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.isTrimmed(),
);

export const FoundryConfiguredRuntime = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  environmentId: Identifier,
  buzzRelayUrl: FoundryBuzzRelayUrl,
  buzzGroupId: BuzzGroupId,
  founders: FoundryFounderRegistry,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryConfiguredRuntime = Omit<typeof FoundryConfiguredRuntime.Type, "founders"> & {
  readonly founders: FounderRegistry;
};

export type FoundryConfigState =
  | { readonly configured: false }
  | ({ readonly configured: true } & FoundryConfiguredRuntime);

const decodeConfiguredRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FoundryConfiguredRuntime),
);

function freezeConfiguredRuntime(config: typeof FoundryConfiguredRuntime.Type): FoundryConfigState {
  const founders = Object.freeze([
    Object.freeze({ ...config.founders[0] }),
    Object.freeze({ ...config.founders[1] }),
  ]) as FounderRegistry;
  return Object.freeze({ configured: true, ...config, founders });
}

export const loadFoundryConfig = Effect.fn("FoundryConfig.load")(function* () {
  const raw = yield* Config.string("T3CODE_FOUNDRY_CONFIG").pipe(Config.option);
  if (Option.isNone(raw)) {
    return Object.freeze({ configured: false }) satisfies FoundryConfigState;
  }
  const config = yield* decodeConfiguredRuntime(raw.value, strictDecodeOptions);
  return freezeConfiguredRuntime(config);
});

export class FoundryConfig extends Context.Service<FoundryConfig, FoundryConfigState>()(
  "t3/foundry/FoundryConfig",
) {}

export const FoundryConfigLive = Layer.effect(FoundryConfig, loadFoundryConfig());

export const foundryConfigLayer = (config: FoundryConfigState) =>
  Layer.succeed(FoundryConfig, FoundryConfig.of(config));
