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

## Durable dispatch runner

Accepting a new contract also creates its dispatch job in the same SQLite transaction. A database
rollback therefore leaves neither object behind. The job permits `maximumRetries + 1` total attempts.
It remains queued until a runner bound to the exact contract environment claims it.

Migration 042 intentionally does not enqueue approvals that predate the dispatch tables. Automatic
backfill could execute old agreements unexpectedly. Issue a new contract version and collect fresh
approvals when an earlier stored contract should enter this runner.

The local runner needs the same `T3CODE_FOUNDRY_CONFIG` value as the server, plus a strict local
binding in `T3CODE_FOUNDRY_RUNNER_CONFIG`:

```json
{
  "protocolVersion": 1,
  "runnerId": "founder-alice-runner",
  "httpBaseUrl": "http://127.0.0.1:3773/",
  "wsBaseUrl": "ws://127.0.0.1:3773/",
  "binding": {
    "environmentId": "founder-alice-laptop",
    "repositoryRemoteId": "midlow/hotpaste",
    "foundryProjectId": "hotpaste",
    "t3ProjectId": "local-hotpaste-project",
    "projectCwd": "C:\\dev\\hotpaste",
    "provider": "codex-primary",
    "providerInstanceId": "codex-work",
    "allowedModels": ["gpt-5.6-sol-ultra"],
    "allowedBaseBranches": ["main"]
  }
}
```

Both base URLs must be canonical, use the same loopback host and port, and point at the co-located T3
server. This is required because the runner independently attests Git state on the local filesystem.
The project ID, workspace path, provider instance, model, repository identity, and base-branch
allow-list are trusted local policy; an approved packet cannot replace them. Set
`T3CODE_FOUNDRY_RUNNER_TOKEN` separately to an environment bearer token with
`orchestration:read` and `orchestration:operate`. Never embed that token in either JSON value or
commit it to the repository.

Start the runner from this workspace with:

```text
pnpm --filter @t3tools/foundry-runner start
```

The process obtains a single-use WebSocket ticket, validates the current T3 environment and
inventory, and then claims jobs continuously. A transport loss closes the scoped session and obtains
a fresh single-use ticket until the local server is available again. A random per-process runner
session is retained across those transport reconnects, allowing the server to return and renew the
same attempt without spending the repair budget. A second process, even with the same `runnerId`,
cannot attach to that lease. A full process restart has a new session and must wait for lease expiry
before reclaiming with a new fence and attempt.

The runner re-verifies the original two-founder packet after every claim. Before each mutating T3
call it records a fenced intent containing deterministic branch, thread, message, and command
identifiers. It creates or safely adopts the matching worktree and starts exactly one
`approval-required` turn. A fresh paused approval remains paused; the runner only keeps the lease
alive and never approves on the founders' behalf. If a runner or T3 reconnect finds an adopted turn
still waiting on an earlier approval callback, callback liveness cannot be proven. The runner does
not duplicate the turn or renew that uncertainty forever: it waits through lease expiry and retries
under a new fence until the signed attempt budget is exhausted or T3 records a terminal outcome.

The authenticated dispatch RPCs are:

- `foundry.claimDispatch` and `foundry.heartbeatDispatch` for runners with operation access.
- `foundry.reportDispatch` for fenced, idempotent evidence and terminal outcomes.
- `foundry.getDispatch` for an operation-safe status projection with read access.

Claims use expiring leases plus runner ID, process-session, and monotonically increasing fence
checks. If a different runner process stops or takes over, it can reclaim the job only after expiry.
Every old heartbeat/report is then rejected as `lease-lost`. Reconciliation reads the locally
attested Git remote/worktree and T3 thread snapshots before mutation, so a crash after worktree
creation or turn dispatch adopts the same deterministic resource instead of creating another turn.
Terminal evidence and attempt/job completion commit in one SQLite transaction. Success requires both
the matching T3 turn to be completed and its matching diff checkpoint to be `ready`.

Dispatch status deliberately excludes prompts, provider output, local paths, logs, credentials, and
raw diagnostics. Operational failures are reduced to stable coarse codes. Use local T3 logs for
detailed diagnosis and use `foundry.getDispatch` for job, attempt, fence, and evidence history.
