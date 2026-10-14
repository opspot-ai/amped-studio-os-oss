import type { AmpedApprovalDecisionPacket, OperatingEnvelope } from "@amped-studio-os/contracts";

/**
 * Bounded autonomy for the self-serve paid tier.
 *
 * A paid workspace cannot wait on an operator to hand-approve every packet, so a packet that falls
 * wholly inside the tier's operating envelope resolves automatically. Anything else stops and asks
 * the customer.
 *
 * The entire contract of this module is that it fails closed. Every path that cannot positively
 * prove a packet is inside the envelope returns `ask-customer`, including malformed input, a
 * missing envelope, an expired envelope, and any thrown error. An automatic approval is a real
 * approval with real spending authority, so "I could not tell" must never read as "yes".
 */

export type SelfServeApprovalDecision =
  | { decision: "auto-approve"; boundsChecked: readonly string[] }
  | { decision: "ask-customer"; reasons: readonly string[] };

/** Actions that never auto-approve, whatever the envelope says. */
const NEVER_AUTOMATIC = [
  "outreach",
  "public posting",
  "deployment",
  "credential mutation",
  "billing",
  "customer-system mutation",
  "another-company action"
] as const;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Decide whether a packet may resolve without a human.
 *
 * `at` is required rather than defaulted to now so the caller owns the clock and the decision stays
 * reproducible in replay.
 */
export function selfServeApprovalDecision(
  packet: AmpedApprovalDecisionPacket | undefined,
  envelope: OperatingEnvelope | undefined,
  at: string
): SelfServeApprovalDecision {
  const reasons: string[] = [];
  const checked: string[] = [];
  try {
    if (!packet) return { decision: "ask-customer", reasons: ["no decision packet to evaluate"] };
    if (!envelope) return { decision: "ask-customer", reasons: ["no operating envelope bound to this workspace"] };

    // An envelope that has lapsed grants nothing. Absent expiry means non-expiring, which is the
    // existing contract elsewhere in the kernel.
    if (envelope.expiresAt && envelope.expiresAt <= at) reasons.push("operating envelope has expired");
    else checked.push("envelope-not-expired");

    if (packet.expiresAt && packet.expiresAt <= at) reasons.push("decision packet has expired");
    else checked.push("packet-not-expired");

    const limits = packet.limits as Record<string, unknown> | undefined;
    if (!limits) reasons.push("packet declares no limits");

    // Spend. The packet must declare a cost ceiling and it must fit the envelope's model budget.
    const maxCostCents = limits?.maxCostCents;
    if (!isFiniteNonNegative(maxCostCents)) reasons.push("packet does not declare a usable maxCostCents");
    else if (!isFiniteNonNegative(envelope.modelBudgetCents)) reasons.push("envelope does not declare a usable modelBudgetCents");
    else if (maxCostCents > envelope.modelBudgetCents) {
      reasons.push(`packet maxCostCents ${maxCostCents} exceeds envelope modelBudgetCents ${envelope.modelBudgetCents}`);
    } else checked.push("spend-within-envelope");

    // Anything that leaves the system. A zero cap is the safe default and the schema's default.
    const maxOutreach = limits?.maxOutreach;
    if (!isFiniteNonNegative(maxOutreach)) reasons.push("packet does not declare a usable maxOutreach");
    else if (maxOutreach > envelope.dailyActionCap) {
      reasons.push(`packet maxOutreach ${maxOutreach} exceeds envelope dailyActionCap ${envelope.dailyActionCap}`);
    } else checked.push("outreach-within-cap");

    // Tool spend, e.g. Clay enrichment credits. The frozen packet schema does not yet declare a
    // tool-cost limit, so absence means zero and is fine; but the moment a packet carries
    // maxToolCostCents (the Clay change will add it), it is governed here, in the same gate as
    // model spend. Wiring this before Clay exists is the point: enforced-at-capability-selection is
    // not the same as governed-at-approval, and an integration that bypasses capability selection
    // must still hit this wall. Malformed values fail closed like every other limit.
    const maxToolCostCents = limits?.maxToolCostCents;
    if (maxToolCostCents !== undefined) {
      if (!isFiniteNonNegative(maxToolCostCents)) reasons.push("packet declares an unusable maxToolCostCents");
      else if (maxToolCostCents > envelope.toolBudgetCents) {
        reasons.push(`packet maxToolCostCents ${maxToolCostCents} exceeds envelope toolBudgetCents ${envelope.toolBudgetCents}`);
      } else checked.push("tool-spend-within-envelope");
    }

    const maxExternalEffects = limits?.maxExternalEffects;
    if (!isFiniteNonNegative(maxExternalEffects)) reasons.push("packet does not declare a usable maxExternalEffects");
    else if (maxExternalEffects > 0 && !envelope.publicationAllowed) {
      reasons.push("packet permits external effects but the envelope does not allow publication");
    } else checked.push("external-effects-within-envelope");

    // The packet must still forbid everything that is categorically outside bounded autonomy. This
    // is belt-and-braces against a packet that simply omits its forbidden list.
    //
    // Matched by containment, not equality: packets phrase these as concepts, not tokens, so the
    // real founder-gate packet says "billing or money movement" where the concept is "billing". An
    // equality check silently refused every real packet. Containment still fails closed, since a
    // packet that names the concept nowhere is refused.
    const forbidden = (packet.forbiddenActions ?? []).map((action) => String(action).trim().toLocaleLowerCase());
    const missing = NEVER_AUTOMATIC.filter((action) => !forbidden.some((entry) => entry.includes(action)));
    if (missing.length > 0) reasons.push(`packet does not forbid: ${missing.join(", ")}`);
    else checked.push("never-automatic-actions-forbidden");

    if (reasons.length > 0) return { decision: "ask-customer", reasons };
    return { decision: "auto-approve", boundsChecked: checked };
  } catch (error) {
    // A thrown comparison must never read as approval.
    return {
      decision: "ask-customer",
      reasons: [`bounds could not be evaluated: ${error instanceof Error ? error.message : "unknown error"}`]
    };
  }
}
