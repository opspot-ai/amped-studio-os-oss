import { describe, expect, it } from "vitest";
import {
  OperatingEnvelopeSchema,
  SELF_SERVE_PLANS,
  SELF_SERVE_PLAN_ORDER,
  SelfServePlanIdSchema,
  selfServePlanEnvelope,
  selfServePlanPriceEnv
} from "@amped-studio-os/contracts";
import { selfServeApprovalDecision } from "@amped-studio-os/policy";

const AT = "2026-08-03T12:00:00.000Z";
const LATER = "2026-08-03T13:00:00.000Z";
const FORBIDDEN = [
  "outreach",
  "public posting",
  "deployment",
  "credential mutation",
  "billing or money movement",
  "customer-system mutation",
  "another-company action"
];

function packet(maxCostCents: number) {
  return {
    expiresAt: LATER,
    forbiddenActions: FORBIDDEN,
    limits: { maxCostCents, maxOutreach: 0, maxExternalEffects: 0 }
  } as never;
}

describe("self-serve plan catalog", () => {
  it("prices the three tiers Example Owner set, each with its own model budget", () => {
    expect(SELF_SERVE_PLAN_ORDER).toEqual(["starter", "growth", "scale"]);
    expect(SELF_SERVE_PLANS.starter.priceCents).toBe(2_900);
    expect(SELF_SERVE_PLANS.growth.priceCents).toBe(9_900);
    expect(SELF_SERVE_PLANS.scale.priceCents).toBe(49_900);
    expect(SELF_SERVE_PLANS.starter.modelBudgetCents).toBe(500);
    expect(SELF_SERVE_PLANS.growth.modelBudgetCents).toBe(2_000);
    expect(SELF_SERVE_PLANS.scale.modelBudgetCents).toBe(10_000);
  });

  it("keeps price and budget monotonic, so a more expensive tier never buys less autonomy", () => {
    const prices = SELF_SERVE_PLAN_ORDER.map((plan) => SELF_SERVE_PLANS[plan].priceCents);
    const budgets = SELF_SERVE_PLAN_ORDER.map((plan) => SELF_SERVE_PLANS[plan].modelBudgetCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
  });

  it("emits a valid operating envelope per plan with outreach and publication off at every tier", () => {
    for (const plan of SELF_SERVE_PLAN_ORDER) {
      const envelope = OperatingEnvelopeSchema.parse(selfServePlanEnvelope(plan));
      expect(envelope.modelBudgetCents).toBe(SELF_SERVE_PLANS[plan].modelBudgetCents);
      // Paying more never silently buys the right to contact people or publish claims.
      expect(envelope.dailyActionCap).toBe(0);
      expect(envelope.weeklyActionCap).toBe(0);
      expect(envelope.publicationAllowed).toBe(false);
    }
  });

  it("names a distinct price environment variable per plan", () => {
    const names = SELF_SERVE_PLAN_ORDER.map(selfServePlanPriceEnv);
    expect(names).toEqual(["STRIPE_PRICE_ID_STARTER", "STRIPE_PRICE_ID_GROWTH", "STRIPE_PRICE_ID_SCALE"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("rejects a plan id that is not one of the three", () => {
    expect(SelfServePlanIdSchema.safeParse("enterprise").success).toBe(false);
    expect(SelfServePlanIdSchema.safeParse("starter").success).toBe(true);
  });
});

describe("plan budget governs bounded autonomy", () => {
  it("lets each tier auto-approve up to its own budget and no further", () => {
    for (const plan of SELF_SERVE_PLAN_ORDER) {
      const envelope = OperatingEnvelopeSchema.parse(selfServePlanEnvelope(plan));
      const budget = SELF_SERVE_PLANS[plan].modelBudgetCents;
      expect(selfServeApprovalDecision(packet(budget), envelope, AT).decision).toBe("auto-approve");
      expect(selfServeApprovalDecision(packet(budget + 1), envelope, AT).decision).toBe("ask-customer");
    }
  });

  it("auto-approves work on Scale that Starter must stop and ask about", () => {
    const starter = OperatingEnvelopeSchema.parse(selfServePlanEnvelope("starter"));
    const scale = OperatingEnvelopeSchema.parse(selfServePlanEnvelope("scale"));
    const job = packet(SELF_SERVE_PLANS.growth.modelBudgetCents);
    expect(selfServeApprovalDecision(job, starter, AT).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(job, scale, AT).decision).toBe("auto-approve");
  });
});
