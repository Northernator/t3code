import {
  FoundryBuzzRelayUrl,
  FoundryFounderRegistry,
  FoundryRunnerId,
  type FoundryFounderRegistry as FounderRegistry,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { LocalRunnerBinding } from "./compileTurn.ts";

const strictDecodeOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isTrimmed(),
);
const NonEmptyText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.isTrimmed(),
);
const NonEmptyList = Schema.Array(NonEmptyText).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

const canonicalUrl = (protocols: ReadonlyArray<string>) =>
  Schema.String.check(
    Schema.isMaxLength(2_048),
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);
        return (
          (protocols.includes(url.protocol) &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            url.search.length === 0 &&
            url.hash.length === 0 &&
            url.toString() === value) ||
          `URL must be canonical ${protocols.join(" or ")} without credentials, query, or fragment.`
        );
      } catch {
        return "URL must be canonical.";
      }
    }),
  );

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function effectivePort(url: URL): string {
  if (url.port.length > 0) {
    return url.port;
  }
  return url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
}

function isCoLocatedEndpointPair(httpBaseUrl: string, wsBaseUrl: string): boolean {
  const http = new URL(httpBaseUrl);
  const webSocket = new URL(wsBaseUrl);
  const protocolsMatch =
    (http.protocol === "http:" && webSocket.protocol === "ws:") ||
    (http.protocol === "https:" && webSocket.protocol === "wss:");
  return (
    protocolsMatch &&
    isLoopbackHostname(http.hostname) &&
    http.hostname === webSocket.hostname &&
    effectivePort(http) === effectivePort(webSocket)
  );
}

export const FoundryRunnerAuthorityConfig = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  environmentId: Identifier,
  buzzRelayUrl: FoundryBuzzRelayUrl,
  buzzGroupId: NonEmptyText,
  founders: FoundryFounderRegistry,
}).annotate({ parseOptions: strictDecodeOptions });
export type FoundryRunnerAuthorityConfig = Omit<
  typeof FoundryRunnerAuthorityConfig.Type,
  "founders"
> & {
  readonly founders: FounderRegistry;
};

const RunnerBinding = Schema.Struct({
  environmentId: Identifier,
  repositoryRemoteId: NonEmptyText,
  foundryProjectId: Identifier,
  t3ProjectId: Identifier,
  projectCwd: NonEmptyText,
  provider: NonEmptyText,
  providerInstanceId: NonEmptyText,
  allowedModels: NonEmptyList,
  allowedBaseBranches: NonEmptyList,
});

export const FoundryRunnerConfig = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  runnerId: FoundryRunnerId,
  httpBaseUrl: canonicalUrl(["http:", "https:"]),
  wsBaseUrl: canonicalUrl(["ws:", "wss:"]),
  binding: RunnerBinding,
})
  .check(
    Schema.makeFilter(
      (config) =>
        isCoLocatedEndpointPair(config.httpBaseUrl, config.wsBaseUrl) ||
        "Foundry runner HTTP and WebSocket URLs must use the same loopback T3 endpoint.",
    ),
  )
  .annotate({ parseOptions: strictDecodeOptions });
export type FoundryRunnerConfig = Omit<typeof FoundryRunnerConfig.Type, "binding"> & {
  readonly binding: LocalRunnerBinding;
};

const decodeAuthority = Schema.decodeUnknownSync(
  Schema.fromJsonString(FoundryRunnerAuthorityConfig),
);
const decodeRunner = Schema.decodeUnknownSync(Schema.fromJsonString(FoundryRunnerConfig));

export function decodeFoundryRunnerAuthorityConfig(raw: string): FoundryRunnerAuthorityConfig {
  return decodeAuthority(raw, strictDecodeOptions) as FoundryRunnerAuthorityConfig;
}

export function decodeFoundryRunnerConfig(raw: string): FoundryRunnerConfig {
  return decodeRunner(raw, strictDecodeOptions) as FoundryRunnerConfig;
}

export function validateFoundryRunnerConfiguration(input: {
  readonly authority: FoundryRunnerAuthorityConfig;
  readonly runner: FoundryRunnerConfig;
}): void {
  if (input.authority.environmentId !== input.runner.binding.environmentId) {
    throw new Error("Foundry authority and runner binding target different environments.");
  }
}
