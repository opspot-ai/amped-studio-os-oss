import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StripeAdapter, stripeCheckoutRequest } from "@amped-studio-os/adapters";
import { SELF_SERVE_PLANS, sha256 } from "@amped-studio-os/contracts";
import { EngineStorage, SqliteKernelStorage } from "@amped-studio-os/storage";
import { handleProviderRequest, type ProviderRouteDependencies } from "../apps/control/lib/provider-route.js";

/**
 * The tier a customer buys must reach the operating envelope, because bounded autonomy authorises
 * work against the envelope and nothing else. Before this, a paid subscription raised the
 * entitlement while the envelope kept the trial's $10, so a Scale customer paid $499 and received
 * one tenth of the budget advertised, silently.
 */
describe("the purchased tier reaches the money path", () => {
  it("writes the plan into both the session and the subscription metadata", () => {
    const body = stripeCheckoutRequest({
      priceId: "price_scale",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      workspaceId: "workspace_1",
      companyId: "venture_1",
      plan: "scale"
    }).body;
    const form = new URLSearchParams(body);
    expect(form.get("metadata[opspot_plan]")).toBe("scale");
    // The subscription copy is what renewals carry. Without it every renewal after the first would
    // look like an unknown plan and fall back to the trial cap.
    expect(form.get("subscription_data[metadata][opspot_plan]")).toBe("scale");
  });

  it("omits the plan entirely when none was chosen, rather than inventing one", () => {
    const form = new URLSearchParams(stripeCheckoutRequest({
      priceId: "price_default",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      workspaceId: "workspace_1",
      companyId: "venture_1"
    }).body);
    expect(form.get("metadata[opspot_plan]")).toBeNull();
    expect(form.get("subscription_data[metadata][opspot_plan]")).toBeNull();
  });

  it("refuses a plan value that is not a safe identifier", () => {
    expect(() => stripeCheckoutRequest({
      priceId: "price_1",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      workspaceId: "workspace_1",
      companyId: "venture_1",
      plan: "scale&metadata[opspot_workspace_id]=attacker"
    })).toThrow();
  });

  it("never leaks a key into the checkout request", () => {
    const request = stripeCheckoutRequest({
      priceId: "price_scale",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      workspaceId: "workspace_1",
      companyId: "venture_1",
      plan: "growth"
    });
    expect(JSON.stringify(request)).not.toMatch(/sk_(test|live)|authorization|bearer/i);
  });

  it("keeps every tier's advertised budget expressible, which the old $10 ceiling did not", () => {
    // The regression this whole change exists to prevent: a hardcoded cap silently truncating the
    // tiers. If any advertised budget stops being representable, selling that tier is mis-selling.
    for (const plan of Object.values(SELF_SERVE_PLANS)) {
      expect(plan.modelBudgetCents).toBeGreaterThan(0);
      expect(Number.isSafeInteger(plan.modelBudgetCents)).toBe(true);
    }
    expect(SELF_SERVE_PLANS.scale.modelBudgetCents).toBe(10_000);
    expect(SELF_SERVE_PLANS.growth.modelBudgetCents).toBe(2_000);
  });
});

describe("a real signed webhook moves the envelope", () => {
  const workspaceId = "workspace_paid_envelope";
  const companyId = "venture_paid_envelope";
  const appOrigin = "https://app.example";
  const secret = "whsec_paid_envelope";

  function trialCompanyState() {
    // The digest is computed over the snapshot exactly as production validation does. The original
    // fixture faked it (sha256 of the company id), which is how the corruption shipped: the sync
    // wrote the paid budget INTO the digest-pinned snapshot, production reads then refused the
    // whole company, and no test could see it because no fixture carried the real invariant.
    const snapshot = {
      operatingEnvelope: {
        modelBudgetCents: 1_000,
        toolBudgetCents: 0,
        operatingBudgetCents: 0,
        dailyActionCap: 0,
        weeklyActionCap: 0,
        publicationAllowed: false,
        // Created with a short window, as company bootstrap does.
        expiresAt: "2025-07-25T00:00:00.000Z",
        senderIdentities: [],
        allowedChannels: [],
        recipientRules: [],
        suppressions: [],
        quietHours: [],
        approvedClaims: [],
        prohibitedClaims: [],
        credentialScopes: [],
        deploymentBoundaries: []
      }
    };
    return {
      bootstrap: { digest: sha256(snapshot), snapshot },
      runState: "idle",
      lifecycleState: "candidate"
    };
  }

  async function harness() {
    const engine = new EngineStorage(":memory:");
    const storage = new SqliteKernelStorage(engine);
    await storage.ensureWorkspace(workspaceId);
    const at = new Date().toISOString();
    await storage.createCompany({
      workspaceId,
      companyId,
      slug: "paid-envelope",
      name: "Paid Envelope",
      owner: "founder",
      owningRepo: "synthetic/paid-envelope",
      lifecycleState: "candidate",
      state: trialCompanyState(),
      createdAt: at,
      updatedAt: at
    });
    return { engine, storage };
  }

  function signed(event: Record<string, unknown>): Request {
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    return new Request(`${appOrigin}/api/providers/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: raw
    });
  }

  function paidInvoiceEvent(id: string, metadata: Record<string, string>, objectId = "in_paid_envelope", createdOffset = 0) {
    return {
      id,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000) + createdOffset,
      data: { object: { id: objectId, object: "invoice", amount_paid: 49_900, currency: "usd", metadata } }
    };
  }

  function dependencies(storage: SqliteKernelStorage, metadata: Record<string, string>, objectId = "in_paid_envelope", periodEnd = 1_755_216_000): ProviderRouteDependencies {
    const object = {
      id: objectId,
      object: "invoice",
      status: "paid",
      amount_paid: 49_900,
      currency: "usd",
      livemode: false,
      customer: "cus_paid_envelope",
      subscription: "sub_paid_envelope",
      metadata,
      lines: { data: [{ type: "subscription", period: { start: 1_752_537_600, end: periodEnd } }] }
    };
    const adapter = new StripeAdapter("sk_test_paid_envelope", async () => Response.json(object));
    return { storage, stripe: { adapter, webhookSecret: secret, mode: "test" } };
  }

  async function envelope(storage: SqliteKernelStorage) {
    // Read the way autonomy reads: the mutable paid overlay first, the founder snapshot as the
    // fallback. The snapshot itself must never change; that is asserted separately below.
    const company = await storage.getCompany(workspaceId, companyId);
    const state = company!.state as {
      operatingEnvelope?: { modelBudgetCents: number; expiresAt?: string };
      bootstrap: { digest: string; snapshot: { operatingEnvelope: { modelBudgetCents: number; expiresAt?: string } } };
    };
    return state.operatingEnvelope ?? state.bootstrap.snapshot.operatingEnvelope;
  }

  async function bootstrapIntegrity(storage: SqliteKernelStorage) {
    const company = await storage.getCompany(workspaceId, companyId);
    const state = company!.state as { bootstrap: { digest: string; snapshot: { operatingEnvelope: { modelBudgetCents: number } } } };
    return {
      digestStillMatches: state.bootstrap.digest === sha256(state.bootstrap.snapshot),
      snapshotBudget: state.bootstrap.snapshot.operatingEnvelope.modelBudgetCents
    };
  }

  async function envelopeBudget(storage: SqliteKernelStorage): Promise<unknown> {
    return (await envelope(storage)).modelBudgetCents;
  }

  it("raises a Scale customer from the trial budget to the budget they paid for", async () => {
    const context = await harness();
    try {
      expect(await envelopeBudget(context.storage)).toBe(1_000);
      const metadata = {
        opspot_kind: "saas_entitlement",
        opspot_workspace_id: workspaceId,
        opspot_company_id: companyId,
        opspot_plan: "scale"
      };
      const response = await handleProviderRequest(
        signed(paidInvoiceEvent("evt_paid_scale", metadata)),
        "stripe",
        "webhook",
        dependencies(context.storage, metadata)
      );
      expect(response.status).toBe(200);

      // The entitlement records what was bought.
      const entitlement = await context.storage.getEntitlement(workspaceId, companyId);
      expect(entitlement?.modelCostCapCents).toBe(SELF_SERVE_PLANS.scale.modelBudgetCents);
      // And the envelope, which is the only thing bounded autonomy actually reads, now matches.
      expect(await envelopeBudget(context.storage)).toBe(SELF_SERVE_PLANS.scale.modelBudgetCents);
      // Paying must move the expiry too. Raising the budget while leaving a lapsing window means
      // bounded autonomy fails closed a few days in and the subscriber is billed for nothing.
      expect((await envelope(context.storage)).expiresAt).toBe("2025-08-15T00:00:00.000Z");

      // And never shortened: a period ending sooner than the current window must not claw autonomy
      // back early, so the later of the two always wins.
      const shorter = { ...metadata };
      await handleProviderRequest(
        signed(paidInvoiceEvent("evt_paid_scale_shorter", shorter)),
        "stripe",
        "webhook",
        dependencies(context.storage, shorter)
      );
      expect((await envelope(context.storage)).expiresAt).toBe("2025-08-15T00:00:00.000Z");

      // The seam the original proof missed: after payment the company must still VALIDATE. The
      // first shipped sync wrote the paid budget into the digest-pinned bootstrap snapshot, so the
      // digest broke and every validating read (company.list, the whole dashboard) refused the
      // company the moment it paid. The paid value lives in the mutable overlay; the
      // founder-approved snapshot stays byte-identical and its digest still matches.
      const integrity = await bootstrapIntegrity(context.storage);
      expect(integrity.digestStillMatches).toBe(true);
      expect(integrity.snapshotBudget).toBe(1_000);
    } finally {
      await context.storage.close();
    }
  });

  it("falls back to the trial budget when the plan metadata is missing or unrecognised", async () => {
    for (const plan of [undefined, "enterprise"]) {
      const context = await harness();
      try {
        const metadata = {
          opspot_kind: "saas_entitlement",
          opspot_workspace_id: workspaceId,
          opspot_company_id: companyId,
          ...(plan ? { opspot_plan: plan } : {})
        };
        const response = await handleProviderRequest(
          signed(paidInvoiceEvent(`evt_paid_${plan ?? "absent"}`, metadata)),
          "stripe",
          "webhook",
          dependencies(context.storage, metadata)
        );
        expect(response.status).toBe(200);
        // Under-granting is the safe direction. The alternative is handing out the largest budget
        // because metadata went missing.
        expect(await envelopeBudget(context.storage), `plan ${String(plan)} must not escalate`).toBe(1_000);
      } finally {
        await context.storage.close();
      }
    }
  });

  it("moves the budget in both directions when a subscriber changes tier mid-cycle", async () => {
    const context = await harness();
    try {
      const at = (plan: string) => ({
        opspot_kind: "saas_entitlement",
        opspot_workspace_id: workspaceId,
        opspot_company_id: companyId,
        opspot_plan: plan
      });

      // Upgrade: Starter to Scale. Autonomy must widen as soon as the payment is confirmed,
      // otherwise the customer pays the higher price and keeps the smaller budget.
      await handleProviderRequest(signed(paidInvoiceEvent("evt_tier_starter", at("starter"), "in_tier_1", 0)), "stripe", "webhook", dependencies(context.storage, at("starter"), "in_tier_1", 1_755_216_000));
      expect(await envelopeBudget(context.storage)).toBe(SELF_SERVE_PLANS.starter.modelBudgetCents);

      await handleProviderRequest(signed(paidInvoiceEvent("evt_tier_scale", at("scale"), "in_tier_2", 10)), "stripe", "webhook", dependencies(context.storage, at("scale"), "in_tier_2", 1_757_894_400));
      expect(await envelopeBudget(context.storage)).toBe(SELF_SERVE_PLANS.scale.modelBudgetCents);

      // Downgrade: Scale to Growth. The budget must actually come down, unlike the expiry which is
      // only ever extended. A budget that ratchets upward would let one month on Scale buy Scale
      // autonomy forever on a Growth subscription.
      await handleProviderRequest(signed(paidInvoiceEvent("evt_tier_growth", at("growth"), "in_tier_3", 20)), "stripe", "webhook", dependencies(context.storage, at("growth"), "in_tier_3", 1_760_572_800));
      expect(await envelopeBudget(context.storage)).toBe(SELF_SERVE_PLANS.growth.modelBudgetCents);
    } finally {
      await context.storage.close();
    }
  });

  it("is idempotent under webhook redelivery", async () => {
    const context = await harness();
    try {
      const metadata = {
        opspot_kind: "saas_entitlement",
        opspot_workspace_id: workspaceId,
        opspot_company_id: companyId,
        opspot_plan: "growth"
      };
      const event = paidInvoiceEvent("evt_paid_redelivered", metadata);
      const first = await handleProviderRequest(signed(event), "stripe", "webhook", dependencies(context.storage, metadata));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ created: true });
      expect(await envelopeBudget(context.storage)).toBe(SELF_SERVE_PLANS.growth.modelBudgetCents);

      // Stripe retries settled events. A redelivery must not stack, drift, or fail.
      const second = await handleProviderRequest(signed(event), "stripe", "webhook", dependencies(context.storage, metadata));
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ created: false });
      expect(await envelopeBudget(context.storage)).toBe(SELF_SERVE_PLANS.growth.modelBudgetCents);
    } finally {
      await context.storage.close();
    }
  });
});

describe("the no-plan checkout path cannot sell", () => {
  it("refuses a subscription that names no tier, because its envelope would silently be the trial", async () => {
    process.env.GTM_SELF_SERVE_CHECKOUT_ENABLED = "1";
    const engine = new EngineStorage(":memory:");
    const storage = new SqliteKernelStorage(engine);
    const workspaceId = "workspace_noplan";
    const companyId = "venture_noplan";
    const subject = "00000000-0000-4000-8000-000000000006";
    const origin = "https://app.example";
    await storage.ensureWorkspace(workspaceId);
    const at = new Date().toISOString();
    await storage.createCompany({
      workspaceId, companyId, slug: "noplan", name: "No Plan", owner: "founder",
      owningRepo: "synthetic/noplan", lifecycleState: "candidate", state: {}, createdAt: at, updatedAt: at
    });
    const calls: string[] = [];
    const adapter = new StripeAdapter("sk_test_noplan", async (input) => {
      calls.push(String(input));
      return Response.json({ id: "cs_test_noplan", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/x", livemode: false, created: 1_753_052_400 });
    });
    const dependencies: ProviderRouteDependencies = {
      storage,
      auth: {
        appOrigin: origin,
        createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: subject, role: "authenticated" } }, error: null }) } }) as never,
        resolveWorkspace: async () => ({ authSubject: subject, workspaceId, role: "owner", createdAt: at }),
        consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 })
      },
      stripe: { adapter, priceId: "price_legacy", planPriceIds: { starter: "price_starter" }, mode: "test" }
    };
    const request = (body: unknown) => new Request(`${origin}/api/providers/stripe/checkout`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body)
    });
    try {
      const response = await handleProviderRequest(request({ companyId, idempotencyKey: "noplan-1" }), "stripe", "checkout", dependencies);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "plan-required" } });
      // Stripe was never called, so the legacy price could not have charged anyone.
      expect(calls).toEqual([]);
    } finally {
      delete process.env.GTM_SELF_SERVE_CHECKOUT_ENABLED;
      await storage.close();
    }
  });
});
