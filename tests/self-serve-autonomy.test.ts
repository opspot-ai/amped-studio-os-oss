import { describe, expect, it } from "vitest";
import { OperatingEnvelopeSchema, type AmpedApprovalDecisionPacket, type OperatingEnvelope } from "@amped-studio-os/contracts";
import { selfServeApprovalDecision } from "@amped-studio-os/policy";

const AT = "2026-08-03T12:00:00.000Z";
const LATER = "2026-08-03T13:00:00.000Z";
const EARLIER = "2026-08-03T11:00:00.000Z";

const FORBIDDEN = [
  "outreach",
  "public posting",
  "deployment",
  "credential mutation",
  "billing",
  "customer-system mutation",
  "another-company action"
];

function envelope(overrides: Partial<OperatingEnvelope> = {}): OperatingEnvelope {
  return OperatingEnvelopeSchema.parse({
    modelBudgetCents: 500,
    dailyActionCap: 0,
    weeklyActionCap: 0,
    publicationAllowed: false,
    ...overrides
  });
}

function packet(overrides: Record<string, unknown> = {}): AmpedApprovalDecisionPacket {
  return {
    expiresAt: LATER,
    forbiddenActions: FORBIDDEN,
    limits: { maxCostCents: 100, maxOutreach: 0, maxExternalEffects: 0 },
    ...overrides
  } as unknown as AmpedApprovalDecisionPacket;
}

describe("self-serve bounded autonomy", () => {
  it("auto-approves a packet wholly inside the envelope", () => {
    const decision = selfServeApprovalDecision(packet(), envelope(), AT);
    expect(decision.decision).toBe("auto-approve");
    if (decision.decision !== "auto-approve") throw new Error("unreachable");
    expect(decision.boundsChecked).toContain("spend-within-envelope");
    expect(decision.boundsChecked).toContain("never-automatic-actions-forbidden");
  });

  it("asks the customer when spend exceeds the envelope, and names the numbers", () => {
    const decision = selfServeApprovalDecision(
      packet({ limits: { maxCostCents: 501, maxOutreach: 0, maxExternalEffects: 0 } }),
      envelope({ modelBudgetCents: 500 }),
      AT
    );
    expect(decision.decision).toBe("ask-customer");
    if (decision.decision !== "ask-customer") throw new Error("unreachable");
    expect(decision.reasons.join(" ")).toContain("501");
    expect(decision.reasons.join(" ")).toContain("500");
  });

  it("treats spend exactly at the ceiling as inside", () => {
    expect(selfServeApprovalDecision(
      packet({ limits: { maxCostCents: 500, maxOutreach: 0, maxExternalEffects: 0 } }),
      envelope({ modelBudgetCents: 500 }),
      AT
    ).decision).toBe("auto-approve");
  });

  it("never auto-approves outreach beyond the daily cap", () => {
    expect(selfServeApprovalDecision(
      packet({ limits: { maxCostCents: 1, maxOutreach: 1, maxExternalEffects: 0 } }),
      envelope({ dailyActionCap: 0 }),
      AT
    ).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(
      packet({ limits: { maxCostCents: 1, maxOutreach: 1, maxExternalEffects: 0 } }),
      envelope({ dailyActionCap: 1 }),
      AT
    ).decision).toBe("auto-approve");
  });

  it("never auto-approves external effects unless publication is allowed", () => {
    expect(selfServeApprovalDecision(
      packet({ limits: { maxCostCents: 1, maxOutreach: 0, maxExternalEffects: 1 } }),
      envelope({ publicationAllowed: false }),
      AT
    ).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(
      packet({ limits: { maxCostCents: 1, maxOutreach: 0, maxExternalEffects: 1 } }),
      envelope({ publicationAllowed: true }),
      AT
    ).decision).toBe("auto-approve");
  });

  it.each(FORBIDDEN)("refuses to auto-approve a packet that stops forbidding %s", (action) => {
    const decision = selfServeApprovalDecision(
      packet({ forbiddenActions: FORBIDDEN.filter((entry) => entry !== action) }),
      envelope(),
      AT
    );
    expect(decision.decision).toBe("ask-customer");
    if (decision.decision !== "ask-customer") throw new Error("unreachable");
    expect(decision.reasons.join(" ")).toContain(action);
  });

  it("fails closed on an expired envelope or an expired packet", () => {
    expect(selfServeApprovalDecision(packet(), envelope({ expiresAt: EARLIER }), AT).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(packet({ expiresAt: EARLIER }), envelope(), AT).decision).toBe("ask-customer");
  });

  it("fails closed on missing, malformed, or hostile input rather than defaulting to yes", () => {
    expect(selfServeApprovalDecision(undefined, envelope(), AT).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(packet(), undefined, AT).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(packet({ limits: undefined }), envelope(), AT).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(packet({ forbiddenActions: undefined }), envelope(), AT).decision).toBe("ask-customer");
    for (const hostile of [null, "0", Number.NaN, Number.POSITIVE_INFINITY, -1, {}, []]) {
      expect(selfServeApprovalDecision(
        packet({ limits: { maxCostCents: hostile, maxOutreach: 0, maxExternalEffects: 0 } }),
        envelope(),
        AT
      ).decision, `maxCostCents ${String(hostile)} must not auto-approve`).toBe("ask-customer");
    }
  });

  it("does not let a thrown comparison read as approval", () => {
    const hostile = {
      expiresAt: LATER,
      forbiddenActions: FORBIDDEN,
      get limits(): never { throw new Error("boom"); }
    } as unknown as AmpedApprovalDecisionPacket;
    const decision = selfServeApprovalDecision(hostile, envelope(), AT);
    expect(decision.decision).toBe("ask-customer");
    if (decision.decision !== "ask-customer") throw new Error("unreachable");
    expect(decision.reasons.join(" ")).toContain("could not be evaluated");
  });
});

describe("tool spend is governed at approval, not only at capability selection", () => {
  const base = () => packet();
  it("fails closed on tool spend beyond the envelope, allows it inside, ignores absence", () => {
    const capped = envelope();
    // Absent: today's packets, unchanged behaviour.
    expect(selfServeApprovalDecision(base(), capped, AT).decision).toBe("auto-approve");
    // Declared beyond a zero budget: refused, which is what makes Clay spend impossible to sneak.
    const spending = packet({ limits: { maxCostCents: 1, maxOutreach: 0, maxExternalEffects: 0, maxToolCostCents: 1 } });
    expect(selfServeApprovalDecision(spending, capped, AT).decision).toBe("ask-customer");
    // Declared inside a real budget: allowed and recorded.
    const funded = envelope({ toolBudgetCents: 500 });
    const inside = selfServeApprovalDecision(spending, funded, AT);
    expect(inside.decision).toBe("auto-approve");
    if (inside.decision !== "auto-approve") throw new Error("unreachable");
    expect(inside.boundsChecked).toContain("tool-spend-within-envelope");
    // Exactly at the ceiling is inside; one past is not; malformed fails closed.
    expect(selfServeApprovalDecision(packet({ limits: { maxCostCents: 1, maxOutreach: 0, maxExternalEffects: 0, maxToolCostCents: 500 } }), funded, AT).decision).toBe("auto-approve");
    expect(selfServeApprovalDecision(packet({ limits: { maxCostCents: 1, maxOutreach: 0, maxExternalEffects: 0, maxToolCostCents: 501 } }), funded, AT).decision).toBe("ask-customer");
    expect(selfServeApprovalDecision(packet({ limits: { maxCostCents: 1, maxOutreach: 0, maxExternalEffects: 0, maxToolCostCents: Number.NaN } }), funded, AT).decision).toBe("ask-customer");
  });
});
