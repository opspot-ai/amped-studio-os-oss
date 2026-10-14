import { z } from "zod";

/**
 * The self-serve plan catalog.
 *
 * `modelBudgetCents` is not a billing detail, it is the product. It becomes the company's operating
 * envelope, and bounded autonomy auto-approves only the work that fits inside it, so the tier a
 * customer buys is literally how much their agents may do without being asked. That is also the
 * upgrade incentive: a bigger envelope means fewer interruptions, not a longer feature list.
 *
 * Prices are duplicated from Stripe deliberately. Stripe holds the money truth via the price id;
 * these cents are for display and for keeping the envelope honest against the tier. A mismatch
 * between the two is a bug, which `selfServePlanPriceEnv` failing loudly is meant to surface.
 */
export const SelfServePlanIdSchema = z.enum(["starter", "growth", "scale"]);
export type SelfServePlanId = z.infer<typeof SelfServePlanIdSchema>;

export interface SelfServePlan {
  id: SelfServePlanId;
  name: string;
  /** Monthly price in cents, for display. Stripe is the billing authority. */
  priceCents: number;
  /** Model spend a company on this plan may consume without asking its owner. */
  modelBudgetCents: number;
  summary: string;
}

export const SELF_SERVE_PLANS: Readonly<Record<SelfServePlanId, SelfServePlan>> = Object.freeze({
  starter: {
    id: "starter",
    name: "Starter",
    priceCents: 2_900,
    modelBudgetCents: 500,
    summary: "One company, bounded autonomy inside a $5 monthly model budget."
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceCents: 9_900,
    modelBudgetCents: 2_000,
    summary: "One company, bounded autonomy inside a $20 monthly model budget."
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceCents: 49_900,
    modelBudgetCents: 10_000,
    summary: "One company, bounded autonomy inside a $100 monthly model budget."
  }
});

export const SELF_SERVE_PLAN_ORDER: readonly SelfServePlanId[] = ["starter", "growth", "scale"];

/** Environment variable holding the Stripe price id for a plan. */
export function selfServePlanPriceEnv(plan: SelfServePlanId): string {
  return `STRIPE_PRICE_ID_${plan.toUpperCase()}`;
}

/**
 * The operating envelope a company gets on this plan.
 *
 * Outreach and publication are off regardless of tier. Someone who just handed over a card has not
 * told us who they are allowed to contact or what they are allowed to claim, and paying more does
 * not change that. Those stay customer decisions, surfaced as approval requests rather than
 * silently pre-authorized.
 */
export function selfServePlanEnvelope(plan: SelfServePlanId): Record<string, unknown> {
  return {
    modelBudgetCents: SELF_SERVE_PLANS[plan].modelBudgetCents,
    toolBudgetCents: 0,
    operatingBudgetCents: 0,
    dailyActionCap: 0,
    weeklyActionCap: 0,
    publicationAllowed: false,
    senderIdentities: [],
    allowedChannels: [],
    recipientRules: [],
    suppressions: [],
    quietHours: [],
    approvedClaims: [],
    prohibitedClaims: [],
    credentialScopes: [],
    deploymentBoundaries: []
  };
}
