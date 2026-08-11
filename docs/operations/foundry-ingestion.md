# Foundry approval ingestion

Foundry approval ingestion is disabled unless the T3 server starts with
`T3CODE_FOUNDRY_CONFIG`. The value is strict JSON containing only the local environment, the Buzz
relay community and group, and the two trusted founder identities:

```json
{
  "protocolVersion": 1,
  "environmentId": "founder-alice-laptop",
  "buzzRelayUrl": "wss://buzz.example/",
  "buzzGroupId": "foundry-hotpaste",
  "founders": [
    {
      "id": "founder-alice",
      "publicKey": "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    },
    {
      "id": "founder-bob",
      "publicKey": "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
    }
  ]
}
```

The example keys are public test keys whose private counterparts are known; replace both before use.
Keep real private keys in the founder's signing tool. T3 only needs lowercase 64-character x-only
public keys. Founder IDs must be distinct and listed in lexicographic order, and the public keys must
be distinct.

`buzzRelayUrl` is the canonical `ws://` or `wss://` URL of the Buzz community authority. Use the
exact URL serialized by the URL standard (including a trailing `/` for a host-only URL), with no
credentials, query, or fragment. The relay URL and group ID are both included in the signed approval
event because NIP-29 group IDs can be reused by different relay communities.

Configuration behavior is fail-closed:

- If the variable is absent, the RPC returns `not-configured` and does not parse or store packets.
- If the variable is present but malformed, server layer construction fails.
- The contract environment must exactly equal `environmentId`.
- Each Buzz approval must name the configured `buzzRelayUrl` in signed content and contain exactly one
  `h` tag equal to `buzzGroupId`.

An authenticated client calls `foundry.ingestApprovedContract` with the strict protocol-v1 packet
and needs the `orchestration:operate` scope. A successful first write returns `stored`; a verified
semantic replay returns `replayed` with the original record. The other stable error codes are
`invalid-packet`, `policy-rejected`, `conflict`, and `unavailable`. Detailed signature, public-key,
proof, and SQL diagnostics are intentionally not returned over the wire.

Acceptance time is assigned by the receiving server. Signed Nostr `created_at` values are retained
only as approval evidence. Database presence alone never authorizes execution: dispatch code must
load the original packet and re-run local governance verification.

Treat a founder-key, relay-URL, or group-ID change as a policy rotation. Existing packets will no
longer verify under the new local policy; issue a new contract version and collect fresh approvals.
