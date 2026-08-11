# Foundry governance

Foundry extends T3 Code with a two-founder control plane. T3 remains the execution environment: it
owns provider credentials, projects, worktrees, threads, terminals, checkpoints, and Git operations.
Foundry decides whether an agreed feature contract may enter that environment.

## Truth boundaries

| Concern                          | Authority                                            |
| -------------------------------- | ---------------------------------------------------- |
| Founder discussion and approvals | Signed Foundry/Buzz governance events                |
| Contract identity                | Canonical contract body and SHA-256 content hash     |
| Agent execution and checkpoints  | The founder's local T3 environment                   |
| Code, review, checks, and merge  | Protected Git repository and pull request            |
| Search and long-term memory      | Derived indexes such as Graphiti, never an authority |

The coordinator never receives provider credentials. A local runner makes an outbound connection,
claims a fully approved job, and invokes its local T3 server through a narrow adapter.

## First vertical slice

`packages/foundry-governance/src/Governance.ts` establishes the invariants before persistence or UI
work:

1. A contract is serialized as canonical JSON and identified by its SHA-256 hash.
2. Version 0.1 has exactly two distinct founders.
3. Each founder signs a domain-separated approval subject containing the project, feature, version,
   contract hash, and the hash of the ordered founder IDs and public keys. A cofounder or key change
   therefore invalidates every earlier approval.
4. Editing any contract field produces a new hash and no approval carries forward.
5. Dispatch is unavailable until both founder signatures have been verified.
6. Dispatch identity is deterministic, so a later persistence boundary can enforce exactly-once
   creation with a unique idempotency key.
7. The approved environment, base commit, branch name, provider, model, safety mode, and execution
   limits are part of the hashed contract.
8. A local runner reconstructs a received proposal from its canonical body and re-verifies both
   signatures instead of trusting serialized projection state.

Signed-event verification is deliberately behind `ApprovalProofVerifier`. The governance state
machine does not depend directly on a chat transport or signing library. Approval time belongs to the
signed event envelope rather than the core approval object, so an unsigned timestamp cannot be
mistaken for trusted evidence.

`apps/foundry-runner/src/compileTurn.ts` is the first T3 adapter boundary. It translates a locally
verified proposal into deterministic VCS and `thread.turn.start` inputs. Local configuration supplies
the Foundry-to-T3 project mapping, project path, and provider instance; the shared packet cannot
choose them. Worktree creation uses
the immutable approved commit as `refName` and preserves the approved branch separately as
`baseRefName` for pull-request metadata. Its branch contains a contract-hash suffix, and the compiler
can adopt an already observed matching worktree after a runner restart instead of creating it again.
It does the same for the deterministic T3 thread: a verified matching thread is adopted and thread
bootstrap is omitted on replay. The turn compiler forces `approval-required`, disables setup scripts,
and uses the recomputed dispatch idempotency key for stable command, thread, and message identifiers.

## Signed Buzz ingestion slice

`packages/contracts/src/foundry.ts` is the strict external boundary. An approved packet contains only
protocol version 1, the feature contract body, and exactly two founder IDs with opaque signed-event
proofs. It never accepts serialized proposal state, a claimed contract hash, an approval subject, a
dispatch identity, or a verified marker. All of those values are derived again on the receiving
machine. Missing, oversized, malformed, and unknown nested fields fail decoding before cryptographic
work begins.

`ingestApprovedContractPacket` reconstructs the proposal, resolves each proof through a registered
identity adapter, verifies both founders, applies the approvals, and then performs the governance
core's local re-verification pass. Its result carries a non-serializable verified marker; serializing
the result removes that marker and requires ingestion again.

The founder registry comes only from trusted local configuration. Its ordered identity/key snapshot
is frozen into the reconstructed proposal and bound to the signed approval subject. Every approval
checks that the active registry still matches that snapshot and re-verifies existing proofs, so an
approval cannot be combined with a substituted cofounder or rotated key.

The first identity adapter is pinned to [Block Buzz](https://github.com/block/buzz)'s Nostr model:

- Standard NIP-01 event ID serialization and BIP-340 Schnorr signatures.
- NIP-29 stream message kind `9`, including a non-empty `h` channel tag.
- A `t=foundry.contract.approval/v1` tag for efficient filtering.
- Strict JSON content containing `type=foundry.contract.approval/v1`, the exact domain-separated
  approval subject, and the canonical Buzz relay URL that names the community authority.

Using an ordinary signed stream message avoids allocating a private Buzz event kind before the Buzz
project has standardized one. The configured founder public-key registry remains the identity
authority; a key or founder ID carried by an untrusted packet cannot modify that registry. The signed
Nostr `created_at` value is retained as evidence, not treated as an expiry or authorization decision.
See Buzz's [Nostr interoperability guide](https://github.com/block/buzz/blob/main/NOSTR.md) and
[protocol architecture](https://github.com/block/buzz/blob/main/ARCHITECTURE.md).

## Authenticated persistence slice

The T3 server exposes `foundry.ingestApprovedContract` over the existing authenticated WebSocket RPC
transport. The method requires `orchestration:operate`; founder signatures do not replace the local
T3 session authorization check. The RPC schema rejects excess fields and packets larger than 256
KiB before the handler runs.

Every call performs the complete cryptographic verification path before reading or writing Foundry
storage, including a replay of a previously accepted packet. The two public keys, canonical Buzz
relay URL, exact Buzz `h` group, and target T3 environment come only from startup-local configuration.
A packet cannot select or amend any of them. Requiring the relay URL in the founder-signed content
prevents a same-named NIP-29 group on another relay community from becoming an approval source.

Migration 041 stores an immutable contract header and its two exact signed events in one SQLite
transaction. The full contract hash is the content identity, while the unique
`(project_id, feature_id, contract_version)` tuple prevents two different bodies from claiming the
same logical revision. Re-signed or reordered proofs for the same verified contract are a semantic
replay and return the original server acceptance time and evidence. Reusing an approval event for a
different contract, or presenting a different contract for an occupied logical revision, is a
conflict and rolls the entire write back.

The stored packet is an audit/replay input, not verification authority. Any later dispatcher must
read the packet and run governance verification again; it must never recreate the in-memory verified
brand from a database row.

## Safety defaults

Foundry v0.1 accepts only T3's `approval-required` runtime mode. A Git worktree isolates branch files,
not credentials, processes, databases, or the network. Unattended full-access execution will remain
disabled until the local runner can prove it is operating inside a disposable container or VM.

Chat text is untrusted context. Only fields in the approved canonical contract may be transformed into
an execution prompt. A prompt change therefore creates a new contract version and requires two new
approvals.

## Durable dispatch slice

Migration 042 adds `foundry_dispatch_jobs`, `foundry_dispatch_attempts`, and
`foundry_dispatch_evidence`. The approval-store transaction inserts the initial queued job alongside
the immutable packet. SQLite compare-and-set updates select only one claimant, increment a monotonic
fence, abandon an expired attempt, and enforce the approved retry budget. Heartbeats, evidence, and
completion all require the current runner ID and fence. A report ID may be replayed only with the
same canonical payload.

Migration 043 adds a random per-process runner session to the lease. The same process can reattach
and renew its current attempt after a WebSocket/server reconnect without increasing the attempt or
fence, while another process using the same logical runner ID remains fenced out until expiry.
Pre-session leases retain their original expiry during upgrade, preventing an old worker and a new
session from overlapping. Terminal evidence and job/attempt completion use one transaction, and even
an otherwise identical evidence replay must first pass the live runner/session/fence check.

The four authenticated RPC operations expose a deliberately narrower projection than persistence:
claim returns the raw packet for local reverification; heartbeat renews the current lease; report
records typed resource correlations or a coarse outcome; status returns attempts and evidence. No
wire record contains a prompt, local path, provider output, log, credential, or arbitrary diagnostic
text.

`apps/foundry-runner` is now executable. It resolves a single-use bearer WebSocket connection, checks
the exact T3 environment, project root and repository identity, provider instance, authentication
state, model inventory, local primary Git remote, base, branch, and worktree, and then compiles the
signed contract into deterministic T3 inputs. The T3 endpoint is restricted to the same loopback
machine because Git attestation is local. It persists `worktree-planned` before worktree creation and
`turn-planned` before `thread.turn.start`. On restart it adopts a matching
branch/worktree/thread/message/turn. A differing resource is a hard failure, not an adoption
candidate.

The terminal reducer merges T3 shell and thread snapshots/events. An approval pause is non-terminal
for a freshly started turn and keeps receiving heartbeats. A reclaimed turn that is still pending an
approval is not redispatched: the runner stops renewing, waits through lease expiry, and reconciles
again under a new fence because provider callback state cannot be proven across a T3 restart. A
successful dispatch needs both a completed matching turn and a `ready` checkpoint for that same turn;
interrupted/error turns and missing/error checkpoints fail. The isolated integration proof executes
one signed fixture through real temporary Git, file SQLite, and production T3 orchestration/checkpoint
reactors with a scripted local provider, without calling a paid model. This proves the execution
engine before Buzz transport can enqueue live work.

## Preserved boundaries

The next slices should preserve these interfaces:

- `BuzzIdentityAdapter`: verifies founder identity and signed approval events. The Nostr v1 adapter
  now establishes this interface; relay transport and key provisioning remain future work.
- `FoundryApprovedContractStore`: atomically records verified packets and immutable approval evidence.
- `T3Driver`: creates or resumes one project worktree, thread, and turn. The local implementation now
  enforces the boundary through authenticated T3 RPCs and local Git inspection.
- `FoundryRunner`: claims approved dispatches and returns hash-bound evidence. The executable local
  worker now implements this boundary with leases and fencing.
- `ForgeAdapter`: observes pull-request checks, reviews, and the final merge commit.

## Current limitations

This now includes authenticated wire ingestion, atomic durable dispatch, an external RPC runner, and
one recoverable approval-required T3 turn. It does not yet connect to a Buzz relay, provision founder
keys, expose a server-backed Council UI, execute repair turns, or enforce time/token/cost budgets.
Maximum retries bounds dispatch attempts, while maximum turns and the other execution limits remain
hashed prompt/policy inputs until the gauntlet-loop slice adds durable counters and additional turns.

The local runner binding remains trusted configuration. Project/provider discovery validates that
binding against current T3 inventory; it does not let the approved packet create mappings. Automatic
runner service installation, token provisioning/rotation, rich local diagnostics, and Buzz delivery
acknowledgements are operational follow-ups.

The MVP will dispatch to one local T3 environment. Cross-machine fan-out, agent-team DAGs, autonomous
merge, production deployment access, and Graphiti ingestion are later milestones.
