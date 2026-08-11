import { assert, it } from "@effect/vitest";
import type {
  FoundryApprovedContractPacket,
  FoundryBuzzNostrEvent,
  FoundryFeatureContractBody,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  FoundryApprovedContractStore,
  type FoundryApprovedContractStoreShape,
  type StoreVerifiedFoundryApprovedContractInput,
} from "../persistence/Services/FoundryApprovedContractStore.ts";
import {
  FoundryApprovedContractIngestion,
  FoundryApprovedContractIngestionLive,
} from "./FoundryApprovedContractIngestion.ts";
import { foundryConfigLayer, type FoundryConfigState } from "./FoundryConfig.ts";

const ALICE_PUBLIC_KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const BOB_PUBLIC_KEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const BUZZ_RELAY_URL = "wss://buzz.example/";
const CONTRACT_HASH = "1d5ff27e3ade2a6b249dd396c83af954182a7f6c71852fdf1196d9396bf8fca8";
const FOUNDER_REGISTRY_HASH = "673468a875ce32d4abc10d2a51d6746bcecd90cfda482d428cdb4987d318c0da";
const APPROVAL_SUBJECT = [
  "foundry.contract.approve/v1",
  "hotpaste",
  "clipboard-history",
  "1",
  CONTRACT_HASH,
  FOUNDER_REGISTRY_HASH,
].join("\n");

const founders = [
  { id: "founder-alice", publicKey: ALICE_PUBLIC_KEY },
  { id: "founder-bob", publicKey: BOB_PUBLIC_KEY },
] as const;

const body: FoundryFeatureContractBody = {
  schemaVersion: 1,
  projectId: "hotpaste",
  featureId: "clipboard-history",
  version: 1,
  title: "Clipboard history",
  objective: "Let the user reopen a recently copied item.",
  inScope: ["Store ten recent text items"],
  outOfScope: ["Cloud synchronization"],
  constraints: ["Never persist secret fields"],
  acceptanceCriteria: ["A copied item can be selected again"],
  verificationCommands: ["vp test run clipboard-history.test.ts"],
  repository: {
    remoteId: "midlow/hotpaste",
    baseBranch: "main",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
  },
  execution: {
    environmentId: "founder-alice-laptop",
    provider: "codex",
    model: "gpt-5.6-sol-ultra",
    runtimeMode: "approval-required",
    limits: { maximumTurns: 20, maximumRetries: 2 },
  },
  riskFlags: ["clipboard-data"],
};

const approvalContent = JSON.stringify({
  type: "foundry.contract.approval/v1",
  subject: APPROVAL_SUBJECT,
  relayUrl: BUZZ_RELAY_URL,
});

const aliceEvent: FoundryBuzzNostrEvent = {
  pubkey: ALICE_PUBLIC_KEY,
  created_at: 1_786_377_600,
  kind: 9,
  tags: [
    ["h", "foundry-hotpaste"],
    ["t", "foundry.contract.approval/v1"],
  ],
  content: approvalContent,
  id: "b7efe8986c6e0b9fac0e565584a355490e1ca98a94fdb1c8a3e64b60c2640d8f",
  sig: "60cfaf3d1130d31fe8a7da04155956235423451358b992e7b9168831468cba63a23e2f18a3832b37253571d4ea886d7ad2588109c54ed681b56ee62c1c0de2ba",
};

const bobEvent: FoundryBuzzNostrEvent = {
  pubkey: BOB_PUBLIC_KEY,
  created_at: 1_786_377_601,
  kind: 9,
  tags: [
    ["h", "foundry-hotpaste"],
    ["t", "foundry.contract.approval/v1"],
  ],
  content: approvalContent,
  id: "8cd8833746ec0d6fc6b092d09dc42e2c8720c71c6a8ccbf8dc34ac8ded5b7555",
  sig: "414be8149785c3f4db88aa2aee0a949071323960d63f29ab136a2b2ce7015043c6f78b00fc681f9252c78baf45f60a776532356a90547a985d14cf1125e657bd",
};

function approval(founderId: string, event: FoundryBuzzNostrEvent) {
  return {
    founderId,
    proof: {
      format: "buzz-nostr-event/v1" as const,
      encodedEvent: JSON.stringify(event),
    },
  };
}

function packet(
  options: { readonly reversed?: boolean; readonly invalidAliceSignature?: boolean } = {},
) {
  const aliceApproval = approval(
    "founder-alice",
    options.invalidAliceSignature ? { ...aliceEvent, sig: "0".repeat(128) } : aliceEvent,
  );
  const bobApproval = approval("founder-bob", bobEvent);
  return {
    protocolVersion: 1,
    body,
    approvals: options.reversed
      ? ([bobApproval, aliceApproval] as const)
      : ([aliceApproval, bobApproval] as const),
  } satisfies FoundryApprovedContractPacket;
}

const configured = (
  overrides: Partial<{
    environmentId: string;
    buzzRelayUrl: string;
    buzzGroupId: string;
  }> = {},
) =>
  ({
    configured: true,
    protocolVersion: 1,
    environmentId: overrides.environmentId ?? "founder-alice-laptop",
    buzzRelayUrl: overrides.buzzRelayUrl ?? BUZZ_RELAY_URL,
    buzzGroupId: overrides.buzzGroupId ?? "foundry-hotpaste",
    founders,
  }) as const satisfies FoundryConfigState;

function testLayer(input: {
  readonly config: FoundryConfigState;
  readonly storeVerified: FoundryApprovedContractStoreShape["storeVerified"];
}) {
  const store = FoundryApprovedContractStore.of({
    storeVerified: input.storeVerified,
    readPacketByContractHash: () => Effect.succeed(Option.none()),
  });
  return FoundryApprovedContractIngestionLive.pipe(
    Layer.provide(
      Layer.merge(
        foundryConfigLayer(input.config),
        Layer.succeed(FoundryApprovedContractStore, store),
      ),
    ),
  );
}

function fakeStore(disposition: "stored" | "replayed" = "stored") {
  const inputs: Array<StoreVerifiedFoundryApprovedContractInput> = [];
  const storeVerified: FoundryApprovedContractStoreShape["storeVerified"] = (input) =>
    Effect.sync(() => {
      inputs.push(input);
      return { disposition, record: input.record };
    });
  return { inputs, storeVerified };
}

it.effect("rejects an invalid signature before a would-be replay can reach storage", () => {
  const store = fakeStore("replayed");
  return Effect.gen(function* () {
    const ingestion = yield* FoundryApprovedContractIngestion;
    const error = yield* ingestion
      .ingest(packet({ invalidAliceSignature: true }))
      .pipe(Effect.flip);

    assert.equal(error.code, "policy-rejected");
    assert.equal(store.inputs.length, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        config: configured(),
        storeVerified: store.storeVerified,
      }),
    ),
  );
});

it.effect("rejects a valid packet from another configured Buzz group before storage", () => {
  const store = fakeStore("replayed");
  return Effect.gen(function* () {
    const ingestion = yield* FoundryApprovedContractIngestion;
    const error = yield* ingestion.ingest(packet()).pipe(Effect.flip);

    assert.equal(error.code, "policy-rejected");
    assert.equal(store.inputs.length, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        config: configured({ buzzGroupId: "foundry-another-group" }),
        storeVerified: store.storeVerified,
      }),
    ),
  );
});

it.effect("rejects a valid packet from another configured Buzz relay before storage", () => {
  const store = fakeStore("replayed");
  return Effect.gen(function* () {
    const ingestion = yield* FoundryApprovedContractIngestion;
    const error = yield* ingestion.ingest(packet()).pipe(Effect.flip);

    assert.equal(error.code, "policy-rejected");
    assert.equal(store.inputs.length, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        config: configured({ buzzRelayUrl: "wss://another.example/" }),
        storeVerified: store.storeVerified,
      }),
    ),
  );
});

it.effect("rejects a valid packet targeting another environment before storage", () => {
  const store = fakeStore("replayed");
  return Effect.gen(function* () {
    const ingestion = yield* FoundryApprovedContractIngestion;
    const error = yield* ingestion.ingest(packet()).pipe(Effect.flip);

    assert.equal(error.code, "policy-rejected");
    assert.equal(store.inputs.length, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        config: configured({ environmentId: "founder-bob-laptop" }),
        storeVerified: store.storeVerified,
      }),
    ),
  );
});

it.effect("returns not-configured without decoding or storing a packet", () => {
  const store = fakeStore("replayed");
  return Effect.gen(function* () {
    const ingestion = yield* FoundryApprovedContractIngestion;
    const error = yield* ingestion.ingest({ trusted: true }).pipe(Effect.flip);

    assert.equal(error.code, "not-configured");
    assert.equal(store.inputs.length, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        config: { configured: false },
        storeVerified: store.storeVerified,
      }),
    ),
  );
});

it.effect("normalizes approvals and sends only locally derived values to storage", () => {
  const store = fakeStore();
  return Effect.gen(function* () {
    const ingestion = yield* FoundryApprovedContractIngestion;
    yield* TestClock.setTime(1_800_000_000_000);
    const result = yield* ingestion.ingest(packet({ reversed: true }));
    const storedInput = store.inputs[0];

    assert.isDefined(storedInput);
    assert.equal(result.disposition, "stored");
    assert.equal(result.record.contractHash, CONTRACT_HASH);
    assert.equal(result.record.acceptedAt, "2027-01-15T08:00:00.000Z");
    assert.deepEqual(
      storedInput.approvals.map(({ founderId }) => founderId),
      ["founder-alice", "founder-bob"],
    );
    assert.deepEqual(
      storedInput.record.approvals.map(({ founderId }) => founderId),
      ["founder-alice", "founder-bob"],
    );
    const normalizedPacket = JSON.parse(storedInput.packetJson) as FoundryApprovedContractPacket;
    assert.deepEqual(
      normalizedPacket.approvals.map(({ founderId }) => founderId),
      ["founder-alice", "founder-bob"],
    );
    assert.equal(normalizedPacket.approvals[0].proof.encodedEvent, JSON.stringify(aliceEvent));
    assert.equal(storedInput.canonicalBodyJson.length > 0, true);
    assert.match(storedInput.packetDigest, /^[0-9a-f]{64}$/);
    assert.match(storedInput.record.dispatchIdempotencyKey, /^[0-9a-f]{64}$/);
  }).pipe(
    Effect.provide(
      testLayer({
        config: configured(),
        storeVerified: store.storeVerified,
      }),
    ),
  );
});
