import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResendEmailAdapter, StripeAdapter } from "@amped-studio-os/adapters";
import { EngineStorage, SqliteKernelStorage } from "@amped-studio-os/storage";
import { handleProviderRequest, type ProviderAuthDependencies, type ProviderRouteDependencies } from "../apps/control/lib/provider-route.js";

const appOrigin = "https://gtm.example.test";
const workspaceId = "workspace_routes";
const otherWorkspaceId = "workspace_other";
const companyId = "venture_routes";
const otherCompanyId = "venture_other";
const subject = "00000000-0000-4000-8000-000000000002";

async function harness() {
  const engine = new EngineStorage(":memory:");
  const storage = new SqliteKernelStorage(engine);
  await storage.ensureWorkspace(workspaceId);
  await storage.ensureWorkspace(otherWorkspaceId);
  await storage.createCompany({ workspaceId, companyId, slug: "routes", name: "Routes", owner: "founder", owningRepo: "synthetic/routes", lifecycleState: "candidate", state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await storage.createCompany({ workspaceId: otherWorkspaceId, companyId: otherCompanyId, slug: "other", name: "Other", owner: "founder", owningRepo: "synthetic/other", lifecycleState: "candidate", state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const auth: ProviderAuthDependencies = {
    appOrigin,
    createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: subject, role: "authenticated" } }, error: null }) } }) as never,
    resolveWorkspace: async () => ({ authSubject: subject, workspaceId, role: "owner", createdAt: new Date().toISOString() }),
    consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 })
  };
  return { engine, storage, auth };
}

function ownerRequest(body: unknown, origin = appOrigin) {
  return new Request(`${appOrigin}/api/providers/test/action`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

function stripeWebhookRequest(event: Record<string, unknown>, secret: string, valid = true): Request {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return new Request(`${appOrigin}/api/providers/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${valid ? signature : "0".repeat(64)}` }, body: raw });
}

function resendWebhookRequest(payload: Record<string, unknown>, secret: string, valid = true): Request {
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = "msg_route_bounce";
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return new Request(`${appOrigin}/api/providers/resend/webhook`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${valid ? signature : Buffer.alloc(32).toString("base64")}` }, body: raw });
}

function genericWebhookRequest(payload: Record<string, unknown>, signer: string, secret: string, valid = true): Request {
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return new Request(`${appOrigin}/api/providers/generic/webhook`, { method: "POST", headers: { "x-opspot-signer": signer, "x-opspot-timestamp": String(timestamp), "x-opspot-signature": valid ? signature : "0".repeat(64) }, body: raw });
}

function clayWebhookRequest(payload: unknown, secret: string | null, headers: Record<string, string> = {}): Request {
  const raw = JSON.stringify(payload);
  const requestHeaders: Record<string, string> = { "content-type": "application/json", ...headers };
  if (secret !== null && requestHeaders["x-opspot-clay-authorization"] === undefined) {
    requestHeaders["x-opspot-clay-authorization"] = secret;
  }
  return new Request(`${appOrigin}/api/providers/clay/webhook`, { method: "POST", headers: requestHeaders, body: raw });
}

describe("production provider routes", () => {
  // Subscription checkout is opt-in while the paid operating envelope is unimplemented. These tests
  // exercise the checkout mechanics, so they turn it on explicitly; the guard itself is asserted
  // separately below.
  beforeEach(() => { process.env.GTM_SELF_SERVE_CHECKOUT_ENABLED = "1"; });
  afterEach(() => { delete process.env.GTM_SELF_SERVE_CHECKOUT_ENABLED; });

  it("refuses to create any Stripe session while self-serve checkout is not enabled", async () => {
    // The paid operating envelope is not implemented: a subscription raises the entitlement but
    // nothing raises the company's envelope, and bounded autonomy reads the envelope. So a payer
    // would be charged and silently receive the trial budget. With live Stripe armed that is a real
    // charge for something undelivered, so the default must be to sell nothing.
    delete process.env.GTM_SELF_SERVE_CHECKOUT_ENABLED;
    const context = await harness();
    const calls: string[] = [];
    const stripe = new StripeAdapter("sk_test_route", async (input) => {
      calls.push(String(input));
      return Response.json({ id: "cs_test_should_not_happen", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/x", livemode: false, created: 1_753_052_400 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, priceId: "price_routes", planPriceIds: { starter: "price_starter" }, trialBypassSecret: "SYNTHETIC_TEST_ONLY", mode: "test" } };
    try {
      for (const body of [
        { companyId, idempotencyKey: "guarded-default" },
        { companyId, idempotencyKey: "guarded-plan", plan: "starter" as const }
      ]) {
        const response = await handleProviderRequest(ownerRequest(body), "stripe", "checkout", dependencies);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "checkout-not-enabled" } });
      }
      // The decisive assertion: Stripe was never contacted, so no session exists to be paid.
      expect(calls).toEqual([]);
    } finally {
      context.engine.db.close();
    }
  });

  it("derives the checkout tenant from owner claims, fixes price/mode server-side, and rejects cross-tenant company IDs", async () => {
    const context = await harness();
    const calls: Array<{ url: string; body: string; idempotency: string | null }> = [];
    const stripe = new StripeAdapter("sk_test_route", async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? ""), idempotency: new Headers(init?.headers).get("idempotency-key") });
      return Response.json({ id: "cs_test_routes", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/routes", livemode: false, created: 1_753_052_400 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, priceId: "price_routes", planPriceIds: { starter: "price_routes" }, trialBypassSecret: "SYNTHETIC_TEST_ONLY", mode: "test" } };
    try {
      const response = await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-1", plan: "starter" }), "stripe", "checkout", dependencies);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, providerMode: "test", paymentVerified: false });
      expect(calls[0]?.body).toContain("line_items%5B0%5D%5Bprice%5D=price_routes");
      expect(calls[0]?.body).toContain(`metadata%5Bopspot_workspace_id%5D=${workspaceId}`);
      expect(new URLSearchParams(calls[0]?.body).get("success_url")).toBe(`${appOrigin}/app?company=${companyId}&checkout=success`);
      expect(new URLSearchParams(calls[0]?.body).get("cancel_url")).toBe(`${appOrigin}/app?company=${companyId}&checkout=cancelled`);
      expect(new URLSearchParams(calls[0]?.body).get("subscription_data[trial_period_days]")).toBe("7");
      expect(calls[0]?.idempotency).toMatch(/^opspot:/);

      expect((await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-2", priceId: "price_attacker" }), "stripe", "checkout", dependencies)).status).toBe(400);
      expect((await handleProviderRequest(ownerRequest({ companyId: otherCompanyId, idempotencyKey: "checkout-route-3" }), "stripe", "checkout", dependencies)).status).toBe(404);
      expect((await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-4" }, "https://evil.example"), "stripe", "checkout", dependencies)).status).toBe(403);
      expect((await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-bypass-missing" }), "stripe", "checkout-trial-bypass", dependencies)).status).toBe(403);
      const bypassRequest = () => new Request(`${appOrigin}/api/providers/stripe/checkout-trial-bypass`, { method: "POST", headers: { origin: appOrigin, "content-type": "application/json", "x-opspot-trial-bypass-authorization": "SYNTHETIC_TEST_ONLY" }, body: JSON.stringify({ companyId, idempotencyKey: "checkout-route-bypass-authorized" }) });
      expect((await handleProviderRequest(bypassRequest(), "stripe", "checkout-trial-bypass", dependencies)).status).toBe(200);
      expect((await handleProviderRequest(bypassRequest(), "stripe", "checkout-trial-bypass", dependencies)).status).toBe(200);
      expect(new URLSearchParams(calls[1]?.body).has("subscription_data[trial_period_days]")).toBe(false);
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "saas-trial-bypass-checkout-created")).toHaveLength(1);
      expect((await context.storage.listReceipts(workspaceId, companyId)).filter((receipt) => receipt.metadata.trialBypass === true && receipt.metadata.authorization === "dedicated-server-secret")).toHaveLength(1);
      expect(JSON.stringify(await context.storage.listReceipts(workspaceId, companyId))).not.toContain("SYNTHETIC_TEST_ONLY");
      expect(calls).toHaveLength(3);

      // A proof coupon makes the session $0 and card-optional, so the customer path must refuse it
      // loudly rather than strip it, and only the operator path may pass it through to Stripe.
      const couponOnCustomerPath = await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "checkout-route-coupon-1", plan: "starter", proofCouponId: "proof_coupon_1" }), "stripe", "checkout", dependencies);
      expect(couponOnCustomerPath.status).toBe(403);
      expect(await couponOnCustomerPath.json()).toMatchObject({ ok: false, error: { code: "proof-coupon-not-allowed" } });
      expect(calls).toHaveLength(3);
      const bypassCouponRequest = new Request(`${appOrigin}/api/providers/stripe/checkout-trial-bypass`, { method: "POST", headers: { origin: appOrigin, "content-type": "application/json", "x-opspot-trial-bypass-authorization": "SYNTHETIC_TEST_ONLY" }, body: JSON.stringify({ companyId, idempotencyKey: "checkout-route-coupon-2", proofCouponId: "proof_coupon_1" }) });
      expect((await handleProviderRequest(bypassCouponRequest, "stripe", "checkout-trial-bypass", dependencies)).status).toBe(200);
      const couponCall = new URLSearchParams(calls[3]?.body);
      expect(couponCall.get("discounts[0][coupon]")).toBe("proof_coupon_1");
      expect(couponCall.get("payment_method_collection")).toBe("if_required");
      // The plain customer session carries neither.
      expect(new URLSearchParams(calls[0]?.body).has("discounts[0][coupon]")).toBe(false);
      expect(new URLSearchParams(calls[0]?.body).has("payment_method_collection")).toBe(false);
    } finally {
      await context.storage.close();
    }
  });

  it("uses raw signed Stripe events, reconciles provider binding, persists replay once, and derives Portal customer server-side", async () => {
    const context = await harness();
    const secret = "whsec_stripe_routes";
    const providerObjects: Record<string, Record<string, unknown>> = {
      in_routes: { id: "in_routes", object: "invoice", status: "paid", amount_paid: 49_900, currency: "usd", livemode: false, customer: "cus_routes", subscription: "sub_routes", metadata: { opspot_workspace_id: workspaceId, opspot_company_id: companyId, opspot_kind: "saas_entitlement" }, lines: { data: [{ type: "subscription", period: { start: 1_752_537_600, end: 1_755_216_000 } }] } },
      in_forged: { id: "in_forged", object: "invoice", status: "paid", amount_paid: 49_900, currency: "usd", livemode: false, customer: "cus_other", metadata: { opspot_workspace_id: otherWorkspaceId, opspot_company_id: otherCompanyId, opspot_kind: "saas_entitlement" }, lines: { data: [{ type: "subscription", period: { start: 1_752_537_600, end: 1_755_216_000 } }] } }
    };
    const stripe = new StripeAdapter("sk_test_route", async (input) => {
      const url = String(input);
      if (url.includes("billing_portal/sessions")) return Response.json({ id: "bps_routes", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/routes" });
      const id = url.split("/").at(-1)!;
      return Response.json(providerObjects[id] ?? {}, { status: providerObjects[id] ? 200 : 404 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, webhookSecret: secret, mode: "test" } };
    const event = { id: "evt_routes", type: "invoice.paid", created: Math.floor(Date.now() / 1000), data: { object: { id: "in_routes", object: "invoice", amount_paid: 49_900, currency: "usd", metadata: { opspot_workspace_id: workspaceId, opspot_company_id: companyId, opspot_kind: "saas_entitlement" } } } };
    try {
      expect((await handleProviderRequest(stripeWebhookRequest(event, secret, false), "stripe", "webhook", dependencies)).status).toBe(401);
      const first = await handleProviderRequest(stripeWebhookRequest(event, secret), "stripe", "webhook", dependencies);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, created: true, proofTier: "fixture-verified" });
      expect(await (await handleProviderRequest(stripeWebhookRequest(event, secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ created: false });
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((item) => item.eventType === "stripe-saas-entitlement-reconciled")).toHaveLength(1);

      const forged = { ...event, id: "evt_forged", data: { object: { ...(event.data.object as Record<string, unknown>), id: "in_forged" } } };
      expect((await handleProviderRequest(stripeWebhookRequest(forged, secret), "stripe", "webhook", dependencies)).status).toBe(202);
      expect(await context.storage.listEvents(otherWorkspaceId, otherCompanyId)).toEqual([]);

      dependencies.stripe!.priceId = "price_unused";
      const portal = await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "portal-route-1" }), "stripe", "portal", dependencies);
      expect(portal.status).toBe(200);
      expect(await portal.json()).toMatchObject({ ok: true, providerMode: "test", url: "https://billing.stripe.com/p/session/routes" });
    } finally {
      await context.storage.close();
    }
  });

  it("records Checkout as non-entitlement proof, preserves the trial until authoritative subscription state, and handles same-second cancellation", async () => {
    const context = await harness();
    const secret = "whsec_stripe_normal_trial";
    const created = Math.floor(Date.now() / 1000);
    const metadata = { opspot_workspace_id: workspaceId, opspot_company_id: companyId, opspot_kind: "saas_entitlement" };
    const objects: Record<string, Record<string, unknown>> = {
      cs_normal: { id: "cs_normal", object: "checkout.session", status: "complete", livemode: false, customer: "cus_normal", metadata },
      sub_normal: { id: "sub_normal", object: "subscription", status: "trialing", livemode: false, customer: "cus_normal", metadata, current_period_start: created, current_period_end: created + 7 * 86_400 },
      sub_cancel: { id: "sub_cancel", object: "subscription", status: "canceled", livemode: false, customer: "cus_normal", metadata }
    };
    let portalReturnUrl: string | null = null;
    const stripe = new StripeAdapter("sk_test_normal", async (input, init) => {
      const url = String(input);
      if (url.endsWith("billing_portal/sessions")) {
        portalReturnUrl = new URLSearchParams(String(init?.body)).get("return_url");
        return Response.json({ id: "bps_normal", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/normal" });
      }
      const id = url.split("/").at(-1)!;
      return objects[id] ? Response.json(objects[id]) : Response.json({}, { status: 404 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, webhookSecret: secret, mode: "test" } };
    await context.storage.putEntitlement({ workspaceId, companyId, status: "active", plan: "test:bootstrap-trial", periodStart: new Date(created * 1000).toISOString(), periodEnd: new Date((created + 7 * 86_400) * 1000).toISOString(), modelCostCapCents: 1_000, providerEventId: "stripe:test:bootstrap-trial", providerOrder: 1, observedAt: new Date(created * 1000).toISOString() });
    const event = (id: string, type: string, objectId: string, object: string, status?: string) => ({ id, type, created, data: { object: { id: objectId, object, ...(status ? { status } : {}), metadata } } });
    try {
      expect(await (await handleProviderRequest(stripeWebhookRequest(event("evt_checkout_normal", "checkout.session.completed", "cs_normal", "checkout.session"), secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true });
      expect(await context.storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "active", providerEventId: "stripe:test:bootstrap-trial" });

      expect(await (await handleProviderRequest(stripeWebhookRequest(event("evt_trial_normal", "customer.subscription.created", "sub_normal", "subscription", "trialing"), secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true });
      expect(await context.storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "active", plan: "test:trial", providerEventId: "stripe:test:evt_trial_normal" });
      const portal = await handleProviderRequest(ownerRequest({ companyId, idempotencyKey: "portal-normal-trial" }), "stripe", "portal", dependencies);
      expect(portal.status).toBe(200);
      expect(portalReturnUrl).toBe(`${appOrigin}/app?company=${companyId}`);

      expect(await (await handleProviderRequest(stripeWebhookRequest(event("evt_cancel_normal", "customer.subscription.deleted", "sub_cancel", "subscription", "canceled"), secret), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true });
      expect(await context.storage.getEntitlement(workspaceId, companyId)).toMatchObject({ status: "canceled", providerEventId: "stripe:test:evt_cancel_normal" });
    } finally {
      await context.storage.close();
    }
  });

  it("requires signed provider-tagged Resend events and persists suppression replay-safely", async () => {
    const context = await harness();
    const secret = `whsec_${Buffer.from("resend-route-secret").toString("base64")}`;
    const resend = new ResendEmailAdapter("re_test", async () => Response.json({ object: "email", id: "email_routes", to: ["synthetic-contact-019@example.test"], created_at: new Date().toISOString(), last_event: "bounced", tags: [{ name: "opspot_workspace", value: workspaceId }, { name: "opspot_company", value: companyId }] }));
    const dependencies: ProviderRouteDependencies = { storage: context.storage, resend: { adapter: resend, webhookSecret: secret, connectorScope: { workspaceId, companyId }, ownedInboundRecipient: "synthetic-contact-019@example.test" } };
    const payload = { type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "email_routes", to: ["synthetic-contact-019@example.test"], tags: [{ name: "opspot_workspace", value: workspaceId }, { name: "opspot_company", value: companyId }] } };
    try {
      expect((await handleProviderRequest(resendWebhookRequest(payload, secret, false), "resend", "webhook", dependencies)).status).toBe(401);
      expect(await (await handleProviderRequest(resendWebhookRequest(payload, secret), "resend", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true, suppressed: 1 });
      expect(await (await handleProviderRequest(resendWebhookRequest(payload, secret), "resend", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: false, suppressed: 1 });
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((item) => item.eventType === "email-recipient-suppressed")).toHaveLength(1);
    } finally {
      await context.storage.close();
    }
  });

  it("retrieves Resend inbound mail and binds an owned plus-address to the persisted exact thread reference", async () => {
    const context = await harness();
    const secret = `whsec_${Buffer.from("resend-inbound-route-secret").toString("base64")}`;
    const threadRef = `<opspot.${"a".repeat(48)}@thread.opspot.invalid>`;
    const inboundRecipient = `inbox+${"a".repeat(48)}@example.test`;
    const urls: string[] = [];
    const resend = new ResendEmailAdapter("re_test", async (url) => {
      urls.push(String(url));
      return Response.json({
        object: "email",
        id: "email_reply_routes",
        from: "synthetic-contact-025@example.test",
        to: [inboundRecipient],
        headers: {}
      });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, resend: { adapter: resend, webhookSecret: secret, connectorScope: { workspaceId, companyId }, ownedInboundRecipient: "synthetic-contact-011@example.test" } };
    const payload = { type: "email.received", created_at: new Date().toISOString(), data: { email_id: "email_reply_routes", from: "synthetic-contact-025@example.test", to: [inboundRecipient], message_id: "<synthetic-contact-021@example.test>" } };
    try {
      await context.storage.appendEvent({ workspaceId, companyId, id: "audit_outbound_thread_routes", eventType: "golden-execution-completed", actor: "golden-company-worker", entityType: "task", entityId: "task_outbound", payload: { provider: "resend", providerObjectId: "email_outbound_routes", threadRef }, occurredAt: new Date().toISOString() });
      expect((await context.storage.listEvents(workspaceId, companyId)).find((event) => event.id === "audit_outbound_thread_routes")?.payload).toMatchObject({ threadRef });
      expect((await handleProviderRequest(resendWebhookRequest(payload, secret), "resend", "webhook", dependencies)).status).toBe(200);
      expect(urls).toEqual(["https://api.resend.com/emails/receiving/email_reply_routes"]);

      const unbound = { ...payload, data: { ...payload.data, email_id: "email_reply_unbound" } };
      expect((await handleProviderRequest(resendWebhookRequest(unbound, secret), "resend", "webhook", {
        ...dependencies,
        resend: { ...dependencies.resend!, adapter: new ResendEmailAdapter("re_test", async () => Response.json({ object: "email", id: "email_reply_unbound", from: "synthetic-contact-025@example.test", to: ["synthetic-contact-011@example.test"], headers: { References: "<synthetic-contact-017@example.test>" } })) }
      })).status).toBe(502);
    } finally {
      await context.storage.close();
    }
  });

  it("rate-limits authenticated acquisition/verification routes and never accepts another workspace company", async () => {
    const context = await harness();
    let invoked = 0;
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, runAcquisitionOnce: async (claimedWorkspace) => { invoked += 1; return { outcome: "processed", workspaceId: claimedWorkspace }; } };
    try {
      expect(await (await handleProviderRequest(ownerRequest({}), "resend", "send", dependencies)).json()).toMatchObject({ ok: true, outcome: { workspaceId } });
      expect(invoked).toBe(1);
      expect((await handleProviderRequest(ownerRequest({ companyId: otherCompanyId, accessSecret: "x".repeat(32), idempotencyKey: "access-use-other-company" }), "fulfillment", "verify", dependencies)).status).toBe(404);
      dependencies.auth = { ...context.auth, consumeRateLimit: async () => ({ allowed: false, retryAfterSeconds: 30 }) };
      const limited = await handleProviderRequest(ownerRequest({}), "resend", "send", dependencies);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("30");
      expect(invoked).toBe(1);
    } finally {
      await context.storage.close();
    }
  });

  it("binds signed generic and bounded analytics events to the configured company without upgrading business proof", async () => {
    const context = await harness();
    const signer = "owned-system";
    const secret = "generic-webhook-secret-at-least-32-bytes";
    const dependencies: ProviderRouteDependencies = { storage: context.storage, generic: { signer, signingSecret: secret, scope: { workspaceId, companyId } } };
    const payload = { id: "hook_routes_1", type: "customer.signal", occurredAt: new Date().toISOString(), companyId: otherCompanyId };
    try {
      expect((await handleProviderRequest(genericWebhookRequest(payload, signer, secret, false), "generic", "webhook", dependencies)).status).toBe(401);
      expect(await (await handleProviderRequest(genericWebhookRequest(payload, signer, secret), "generic", "webhook", dependencies)).json()).toMatchObject({ ok: true, created: true, businessOutcomeVerified: false });
      expect(await (await handleProviderRequest(genericWebhookRequest(payload, signer, secret), "generic", "webhook", dependencies)).json()).toMatchObject({ created: false });
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "generic-webhook-received")).toHaveLength(1);
      expect(await context.storage.listEvents(otherWorkspaceId, otherCompanyId)).toEqual([]);

      const analytics = { id: "analytics_routes_1", type: "landing-view", occurredAt: new Date().toISOString() };
      expect(await (await handleProviderRequest(genericWebhookRequest(analytics, signer, secret), "generic", "analytics", dependencies)).json()).toMatchObject({ ok: true, created: true, businessOutcomeVerified: false });
      expect((await handleProviderRequest(genericWebhookRequest({ ...analytics, id: "analytics_bad", type: "payment" }, signer, secret), "generic", "analytics", dependencies)).status).toBe(400);
    } finally {
      await context.storage.close();
    }
  });

  it("accepts Clay intake batches under a static secret, dedupes by table/row, and never claims spend or outcomes", async () => {
    const context = await harness();
    const secret = "SYNTHETIC_TEST_ONLY";
    const dependencies: ProviderRouteDependencies = { storage: context.storage, clay: { intakeSecret: secret, scope: { workspaceId, companyId } } };
    const batch = {
      tableId: "tbl_routes",
      rows: [
        { rowId: "row_1", email: "synthetic-contact-013@example.test", companyName: "One Co" },
        { rowId: "row_2", domain: "two.example.test", fields: { title: "VP" } }
      ]
    };
    try {
      // 1. No config -> 503.
      expect((await handleProviderRequest(clayWebhookRequest(batch, secret), "clay", "webhook", { storage: context.storage })).status).toBe(503);
      expect(await (await handleProviderRequest(clayWebhookRequest(batch, secret), "clay", "webhook", { storage: context.storage })).json()).toMatchObject({
        ok: false,
        error: { code: "clay-unavailable" }
      });

      // 2. Wrong secret -> 401, nothing written.
      expect((await handleProviderRequest(clayWebhookRequest(batch, "wrong-secret-that-is-also-at-least-32b"), "clay", "webhook", dependencies)).status).toBe(401);
      expect(await context.storage.listEvents(workspaceId, companyId)).toEqual([]);

      // 3. Missing secret header -> 401.
      expect((await handleProviderRequest(clayWebhookRequest(batch, null), "clay", "webhook", dependencies)).status).toBe(401);

      // 4. Valid batch of 2 rows -> 200 with created counts and two stored events.
      const first = await handleProviderRequest(clayWebhookRequest(batch, secret), "clay", "webhook", dependencies);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, received: 2, created: 2, duplicates: 0, businessOutcomeVerified: false });
      const clayEvents = (await context.storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "clay-prospect-received");
      expect(clayEvents).toHaveLength(2);

      // 5. Replay of the identical batch -> created:0, duplicates:2, still exactly 2 events. The
      // handler stamps server time per request and storage only recognises a clean replay when
      // occurredAt matches, so a replay in the same millisecond exercises a different path than one
      // across a tick. Cross the tick deliberately; without it this asserts whichever path the
      // clock happens to take, which is how the conflict path shipped untested and flaky.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const replay = await handleProviderRequest(clayWebhookRequest(batch, secret), "clay", "webhook", dependencies);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ ok: true, received: 2, created: 0, duplicates: 2, businessOutcomeVerified: false });
      expect((await context.storage.listEvents(workspaceId, companyId)).filter((event) => event.eventType === "clay-prospect-received")).toHaveLength(2);

      // 5b. A known row re-exported with changed data is still a duplicate, and the stored event
      // does not mutate. Re-enrichment is routine in Clay; intake is append-only, so the update is
      // dropped rather than conflicting the whole batch.
      const reEnriched = await handleProviderRequest(clayWebhookRequest({
        tableId: "tbl_routes",
        rows: [{ rowId: "row_1", email: "synthetic-contact-013@example.test", companyName: "One Co, renamed" }]
      }, secret), "clay", "webhook", dependencies);
      expect(reEnriched.status).toBe(200);
      expect(await reEnriched.json()).toMatchObject({ ok: true, received: 1, created: 0, duplicates: 1 });
      const storedRowOne = (await context.storage.listEvents(workspaceId, companyId)).find((event) => event.eventType === "clay-prospect-received" && event.entityId === "row_1");
      expect(storedRowOne?.payload).toMatchObject({ companyName: "One Co" });

      // 6. Payload workspaceId / companyId that disagree with configured scope -> 400, nothing extra written.
      const beforeBinding = (await context.storage.listEvents(workspaceId, companyId)).length;
      expect((await handleProviderRequest(clayWebhookRequest({ ...batch, workspaceId: otherWorkspaceId }, secret), "clay", "webhook", dependencies)).status).toBe(400);
      expect(await (await handleProviderRequest(clayWebhookRequest({ ...batch, workspaceId: otherWorkspaceId }, secret), "clay", "webhook", dependencies)).json()).toMatchObject({
        ok: false,
        error: { code: "provider-binding-invalid" }
      });
      expect((await handleProviderRequest(clayWebhookRequest({ ...batch, companyId: otherCompanyId }, secret), "clay", "webhook", dependencies)).status).toBe(400);
      expect(await (await handleProviderRequest(clayWebhookRequest({ ...batch, companyId: otherCompanyId }, secret), "clay", "webhook", dependencies)).json()).toMatchObject({
        ok: false,
        error: { code: "provider-binding-invalid" }
      });
      expect((await context.storage.listEvents(workspaceId, companyId)).length).toBe(beforeBinding);
      expect(await context.storage.listEvents(otherWorkspaceId, otherCompanyId)).toEqual([]);

      // 7. A row with neither email nor domain rejects the whole batch (no partial accept).
      const beforeIdentity = (await context.storage.listEvents(workspaceId, companyId)).length;
      const noIdentity = await handleProviderRequest(clayWebhookRequest({
        tableId: "tbl_noise",
        rows: [{ rowId: "row_noise", companyName: "Nobody" }]
      }, secret), "clay", "webhook", dependencies);
      expect(noIdentity.status).toBe(400);
      expect(await noIdentity.json()).toMatchObject({ ok: false, error: { code: "invalid-clay-payload" } });
      expect((await context.storage.listEvents(workspaceId, companyId)).length).toBe(beforeIdentity);

      // 8. Empty rows and oversize batches are rejected.
      expect((await handleProviderRequest(clayWebhookRequest({ tableId: "tbl_empty", rows: [] }, secret), "clay", "webhook", dependencies)).status).toBe(400);
      expect((await handleProviderRequest(clayWebhookRequest({
        tableId: "tbl_over",
        rows: Array.from({ length: 101 }, (_, index) => ({ rowId: `row_${index}`, email: `u${index}@example.test` }))
      }, secret), "clay", "webhook", dependencies)).status).toBe(400);

      // 9. fields with 51 keys is rejected.
      const tooManyFields: Record<string, string> = {};
      for (let index = 0; index < 51; index += 1) tooManyFields[`k${index}`] = "v";
      expect((await handleProviderRequest(clayWebhookRequest({
        tableId: "tbl_fields",
        rows: [{ rowId: "row_fields", email: "synthetic-contact-005@example.test", fields: tooManyFields }]
      }, secret), "clay", "webhook", dependencies)).status).toBe(400);

      // 10. Wrong content-type -> 415.
      expect((await handleProviderRequest(clayWebhookRequest(batch, secret, { "content-type": "text/plain" }), "clay", "webhook", dependencies)).status).toBe(415);

      // 11. Stored events assert zero spend and no verified business outcome.
      for (const event of clayEvents) {
        expect(event.payload).toMatchObject({ enrichmentSpendCents: 0, businessOutcomeVerified: false });
      }
    } finally {
      await context.storage.close();
    }
  });
});
