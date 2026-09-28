import type { CustodyOutcome, CustodyParty, CustodyPartyKind } from "../../db/tables/custody";

/**
 * The vocabulary of custody: why items change hands, what the receiving party
 * can find, and whose signature a transfer needs. Pure, so it is safe to
 * import anywhere and to test without a database.
 */

export type PurposeInfo = {
  name: string;
  label: string;
  /** Whose signatures complete a transfer of this purpose. */
  requires: CustodyParty[];
  help: string;
};

const PURPOSES = new Map<string, PurposeInfo>([
  [
    "pickup",
    {
      name: "pickup",
      label: "Pickup",
      requires: ["from", "to"],
      help: "The owner or site releases items to a carrier or crew.",
    },
  ],
  [
    "handoff",
    {
      name: "handoff",
      label: "Handoff",
      requires: ["from", "to"],
      help: "Custody passes between crews, drivers or custodians.",
    },
  ],
  [
    "delivery",
    {
      name: "delivery",
      label: "Delivery",
      // The receiving party's signature is the proof of delivery; the driver
      // may sign as well, but a delivery is not held up waiting for them.
      requires: ["to"],
      help: "The receiving party accepts items at the destination. Needed before a controlled item is marked delivered.",
    },
  ],
  [
    "checkout",
    {
      name: "checkout",
      label: "Check-out",
      requires: ["from", "to"],
      help: "Items go out to a person or team. When the receiver is a holder, the items are checked out to them.",
    },
  ],
  [
    "return",
    {
      name: "return",
      label: "Return",
      requires: ["from", "to"],
      help: "Items come back from a person or team. Items checked out are checked back in.",
    },
  ],
  [
    "storage",
    {
      name: "storage",
      label: "Into storage",
      requires: ["from", "to"],
      help: "Items go into a vault or store. With a place set, they are moved there.",
    },
  ],
]);

export const isPurpose = (name: string): boolean => PURPOSES.has(name);
export const purposeList = (): PurposeInfo[] => [...PURPOSES.values()];
export const purposeInfo = (name: string): PurposeInfo =>
  PURPOSES.get(name) ?? { name, label: name, requires: ["from", "to"], help: "" };

export const OUTCOMES = ["accepted", "missing", "damaged", "refused"] as const satisfies readonly CustodyOutcome[];

export const OUTCOME_LABEL: Record<CustodyOutcome, string> = {
  accepted: "Accepted",
  missing: "Missing",
  damaged: "Damaged",
  refused: "Refused",
};

/**
 * Whether custody of a line passed to the receiving party. A damaged item was
 * still handed over; a missing one was not, and a refused one stays with
 * whoever brought it.
 */
export const outcomePasses = (outcome: string): boolean => outcome === "accepted" || outcome === "damaged";

/** The job stage a delivery outcome puts its manifest line in. */
export function stageForOutcome(outcome: CustodyOutcome): string {
  return outcome === "accepted" ? "delivered" : outcome;
}

/** Job stages a controlled item cannot reach without a delivery transfer. */
export const GUARDED_STAGES: ReadonlySet<string> = new Set(["delivered", "placed"]);

export const PARTY_KINDS = ["entity", "user", "external"] as const satisfies readonly CustodyPartyKind[];

export type PartyInput = {
  kind: CustodyPartyKind;
  entityId?: string | null;
  userOid?: string | null;
  name?: string | null;
  org?: string | null;
};

export type PartySnapshot = {
  kind: CustodyPartyKind;
  entityId: string | null;
  userOid: string | null;
  name: string;
  org: string | null;
};

const tidy = (s: string | null | undefined, max: number): string | null => {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/**
 * A party as stored: the reference that fits its kind, and the name to show
 * and sign under. `resolvedName` is the holder's or account's name when the
 * party is one; an external party must bring its own. Returns an error
 * message instead of throwing, so the caller picks the status.
 */
export function normalizeParty(
  input: PartyInput,
  resolvedName: string | null,
  which: "releasing" | "receiving",
): PartySnapshot | string {
  const org = tidy(input.org, 200);
  switch (input.kind) {
    case "entity":
      if (!input.entityId) return `Pick the ${which} holder.`;
      if (!resolvedName) return `The ${which} holder does not exist. Pick another.`;
      return { kind: "entity", entityId: input.entityId, userOid: null, name: tidy(input.name, 200) ?? resolvedName, org };
    case "user":
      if (!input.userOid) return `Pick the ${which} account.`;
      if (!resolvedName) return `The ${which} account does not exist.`;
      return { kind: "user", entityId: null, userOid: input.userOid, name: tidy(input.name, 200) ?? resolvedName, org };
    case "external": {
      const name = tidy(input.name, 200);
      if (!name) return `Enter the ${which} party's name.`;
      return { kind: "external", entityId: null, userOid: null, name, org };
    }
    default:
      return `Unknown kind of ${which} party.`;
  }
}

/** Seal numbers as entered: trimmed, de-duplicated, order kept. */
export const cleanSeals = (seals: readonly string[]): string[] => [
  ...new Set(seals.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)),
];

/** The words each party agrees to. Stored verbatim with the signature. */
export function statementFor(
  purpose: string,
  party: CustodyParty,
  t: { code: string; fromName: string; toName: string; count: number },
): string {
  const n = `${t.count} item${t.count === 1 ? "" : "s"}`;
  if (party === "from") {
    return `I released the ${n} listed on custody transfer ${t.code} to ${t.toName}, sealed as recorded.`;
  }
  if (purpose === "delivery") {
    return (
      `I received the items listed on custody transfer ${t.code} from ${t.fromName}. ` +
      "Lines marked missing, damaged or refused are recorded as I noted them; every other line arrived in good order."
    );
  }
  return `I received the ${n} listed on custody transfer ${t.code} from ${t.fromName}, in the condition noted.`;
}

/** Which required signatures are still missing. Empty means the transfer can complete. */
export function missingSignatures(
  purpose: string,
  signed: { from: string | null; to: string | null },
): CustodyParty[] {
  return purposeInfo(purpose).requires.filter((p) => !signed[p]);
}

// Crockford base32, as asset and job codes use: no I, L, O or U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A printed reference such as CUS-7F3K2A. */
export function genTransferCode(random: (n: number) => Uint8Array, length = 6): string {
  const bytes = random(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `CUS-${out}`;
}
