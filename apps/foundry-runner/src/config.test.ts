import { describe, expect, it } from "vite-plus/test";

import {
  decodeFoundryRunnerAuthorityConfig,
  decodeFoundryRunnerConfig,
  validateFoundryRunnerConfiguration,
} from "./config.ts";

const ALICE_PUBLIC_KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const BOB_PUBLIC_KEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

const authorityJson = (environmentId = "founder-alice-laptop") =>
  JSON.stringify({
    protocolVersion: 1,
    environmentId,
    buzzRelayUrl: "wss://buzz.example/",
    buzzGroupId: "foundry-hotpaste",
    founders: [
      { id: "founder-alice", publicKey: ALICE_PUBLIC_KEY },
      { id: "founder-bob", publicKey: BOB_PUBLIC_KEY },
    ],
  });

const runnerJson = (environmentId = "founder-alice-laptop") =>
  JSON.stringify({
    protocolVersion: 1,
    runnerId: "founder-alice-runner",
    httpBaseUrl: "http://127.0.0.1:3773/",
    wsBaseUrl: "ws://127.0.0.1:3773/",
    binding: {
      environmentId,
      repositoryRemoteId: "midlow/hotpaste",
      foundryProjectId: "hotpaste",
      t3ProjectId: "local-hotpaste-project",
      projectCwd: "C:\\dev\\hotpaste",
      provider: "codex",
      providerInstanceId: "codex-primary",
      allowedModels: ["gpt-5.6-sol-ultra"],
      allowedBaseBranches: ["main"],
    },
  });

describe("Foundry runner configuration", () => {
  it("loads strict authority and local runner bindings without a bearer token", () => {
    const authority = decodeFoundryRunnerAuthorityConfig(authorityJson());
    const runner = decodeFoundryRunnerConfig(runnerJson());

    validateFoundryRunnerConfiguration({ authority, runner });
    expect(runner.binding.environmentId).toBe(authority.environmentId);
    expect(JSON.stringify(runner)).not.toContain("token");
  });

  it("rejects extra fields and non-canonical endpoints", () => {
    expect(() =>
      decodeFoundryRunnerConfig(
        runnerJson().replace('"protocolVersion":1', '"protocolVersion":1,"token":"secret"'),
      ),
    ).toThrow();
    expect(() =>
      decodeFoundryRunnerConfig(runnerJson().replace("3773/", "3773/?debug=1")),
    ).toThrow();
  });

  it("rejects authority and runner environment drift", () => {
    expect(() =>
      validateFoundryRunnerConfiguration({
        authority: decodeFoundryRunnerAuthorityConfig(authorityJson()),
        runner: decodeFoundryRunnerConfig(runnerJson("founder-bob-laptop")),
      }),
    ).toThrow(/different environments/);
  });

  it("requires HTTP and WebSocket traffic to use the same loopback T3 endpoint", () => {
    expect(() =>
      decodeFoundryRunnerConfig(runnerJson().replaceAll("127.0.0.1", "t3.example.com")),
    ).toThrow(/same loopback T3 endpoint/);
    expect(() =>
      decodeFoundryRunnerConfig(
        runnerJson().replace(
          '"wsBaseUrl":"ws://127.0.0.1:3773/"',
          '"wsBaseUrl":"ws://127.0.0.1:4773/"',
        ),
      ),
    ).toThrow(/same loopback T3 endpoint/);
  });
});
