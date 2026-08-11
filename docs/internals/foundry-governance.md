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
- Strict JSON content containing `type=foundry.contract.approval/v1` and the exact domain-separated
  approval subject.

Using an ordinary signed stream message avoids allocating a private Buzz event kind before the Buzz
project has standardized one. The configured founder public-key registry remains the identity
authority; a key or founder ID carried by an untrusted packet cannot modify that registry. The signed
Nostr `created_at` value is retained as evidence, not treated as an expiry or authorization decision.
See Buzz's [Nostr interoperability guide](https://github.com/block/buzz/blob/main/NOSTR.md) and
[protocol architecture](https://github.com/block/buzz/blob/main/ARCHITECTURE.md).

## Safety defaults

Foundry v0.1 accepts only T3's `approval-required` runtime mode. A Git worktree isolates branch files,
not credentials, processes, databases, or the network. Unattended full-access execution will remain
disabled until the local runner can prove it is operating inside a disposable container or VM.

Chat text is untrusted context. Only fields in the approved canonical contract may be transformed into
an execution prompt. A prompt change therefore creates a new contract version and requires two new
approvals.

## Planned boundaries

The next slices should preserve these interfaces:

- `BuzzIdentityAdapter`: verifies founder identity and signed approval events. The Nostr v1 adapter
  now establishes this interface; relay transport and key provisioning remain future work.
- `FoundryStore`: appends governance events and rebuilds projections.
- `T3Driver`: creates or resumes one project worktree, thread, and turn.
- `FoundryRunner`: claims approved dispatches and returns hash-bound evidence.
- `ForgeAdapter`: observes pull-request checks, reviews, and the final merge commit.

## Current limitations

This is still a policy, wire-ingestion, and T3 input-compiler layer rather than a network service. It
does not yet connect to a Buzz relay, provision founder keys, persist accepted packets, or expose a
Foundry RPC. The next server slice should store only strictly decoded and cryptographically verified
packets, enforce replay uniqueness transactionally, and make the resulting projection available to a
server-backed Council UI.

The local runner binding is trusted configuration for now. The executable runner must build it from
T3's current provider inventory and verify that the approved provider driver and model still exist
before claiming a job. Likewise, execution limits are hashed policy values and prompt context in this
slice; a durable runner must persist attempt, repair, time, and cost counters before it can enforce
multi-turn or repair loops. There is no external RPC transport, background runner process, or Buzz UI
wiring yet. That runner must also reconcile T3's local worktree inventory before every create attempt
and persist the adopted or created worktree, thread, and original command timestamp against the
dispatch idempotency key.

The MVP will dispatch to one local T3 environment. Cross-machine fan-out, agent-team DAGs, autonomous
merge, production deployment access, and Graphiti ingestion are later milestones.
