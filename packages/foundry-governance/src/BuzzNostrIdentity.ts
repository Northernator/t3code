import { schnorr } from "@noble/curves/secp256k1";
import {
  decodeFoundryBuzzApprovalContent,
  decodeFoundryBuzzNostrEvent,
  type FoundryBuzzRelayUrl,
  type FoundryBuzzNostrEvent,
} from "@t3tools/contracts";

import { canonicalizeJson, sha256 } from "./Governance.ts";
import type { SignedEventIdentityAdapter } from "./SignedEventIdentity.ts";

export const FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT = "buzz-nostr-event/v1" as const;
export const FOUNDRY_BUZZ_APPROVAL_EVENT_KIND = 9;
export const FOUNDRY_BUZZ_APPROVAL_TAG = "foundry.contract.approval/v1";

export function computeBuzzNostrEventId(
  event: Pick<FoundryBuzzNostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">,
): string {
  return sha256(
    canonicalizeJson([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
  );
}

function hasTag(
  tags: FoundryBuzzNostrEvent["tags"],
  name: string,
  expectedValue?: string,
): boolean {
  return tags.some(
    (tag) =>
      tag[0] === name &&
      typeof tag[1] === "string" &&
      tag[1].trim().length > 0 &&
      (expectedValue === undefined || tag[1] === expectedValue),
  );
}

function hasExactGroupTag(tags: FoundryBuzzNostrEvent["tags"], groupId: string): boolean {
  const groupTags = tags.filter((tag) => tag[0] === "h");
  return groupTags.length === 1 && groupTags[0]?.[1] === groupId;
}

export function makeBuzzNostrIdentityAdapter(input: {
  readonly groupId: string;
  readonly relayUrl: FoundryBuzzRelayUrl;
}): SignedEventIdentityAdapter {
  return {
    format: FOUNDRY_BUZZ_NOSTR_EVENT_FORMAT,
    verify: ({ founder, subject, encodedEvent }) => {
      let event: FoundryBuzzNostrEvent;
      try {
        event = decodeFoundryBuzzNostrEvent(JSON.parse(encodedEvent));
      } catch {
        return { ok: false, reason: "malformed-event" };
      }

      if (
        event.kind !== FOUNDRY_BUZZ_APPROVAL_EVENT_KIND ||
        !hasExactGroupTag(event.tags, input.groupId) ||
        !hasTag(event.tags, "t", FOUNDRY_BUZZ_APPROVAL_TAG)
      ) {
        return { ok: false, reason: "malformed-event" };
      }
      if (event.pubkey !== founder.publicKey) {
        return { ok: false, reason: "signer-mismatch" };
      }

      let expectedEventId: string;
      try {
        expectedEventId = computeBuzzNostrEventId(event);
      } catch {
        return { ok: false, reason: "malformed-event" };
      }
      if (event.id !== expectedEventId) {
        return { ok: false, reason: "event-id-mismatch" };
      }
      try {
        if (!schnorr.verify(event.sig, event.id, event.pubkey)) {
          return { ok: false, reason: "invalid-signature" };
        }
      } catch {
        return { ok: false, reason: "invalid-signature" };
      }

      try {
        const content = decodeFoundryBuzzApprovalContent(JSON.parse(event.content));
        if (content.subject !== subject || content.relayUrl !== input.relayUrl) {
          return { ok: false, reason: "subject-mismatch" };
        }
      } catch {
        return { ok: false, reason: "malformed-event" };
      }

      return {
        ok: true,
        eventId: event.id,
        createdAtEpochSeconds: event.created_at,
      };
    },
  };
}
