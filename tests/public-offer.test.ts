import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StripeAdapter } from "@amped-studio-os/adapters";
import { EvidenceItemSchema, TaskDefinitionSchema, nowIso, sha256, type CompanyState } from "@amped-studio-os/contracts";
import { GoldenCompanyWorker, GoldenProviderProofService, PUBLIC_OFFER_DEPLOYMENT_BOUNDARY, PublicAssetGoldenExecutionExecutor, PublicSellableAssetService, preauthorizedEnvelopeBounds, type GoldenExecutionObservation } from "@amped-studio-os/domain";
import { SqliteKernelStorage } from "@amped-studio-os/storage";
import { actionDigest } from "@amped-studio-os/policy";
import { materialEvidenceDigest } from "../packages/domain/src/autonomous.js";
import { handleProviderRequest, type ProviderAuthDependencies, type ProviderRouteDependencies } from "../apps/control/lib/provider-route.js";
import { handlePublicOfferGet } from "../apps/control/lib/public-offer-route.js";
import { tempRuntime } from "./helpers.js";

const appOrigin = "https://offers.example.test";
const slugKey = Buffer.alloc(32, 11);
const access = { key: Buffer.alloc(32, 17), keyId: "access-live-v1" };
const webhookSecret = "whsec_public_offer";
const sellableAsset = {
  offerName: "Operator Launch Guide",
  publicSummary: "A concise digital guide for running the first launch week.",
  amountCents: 12_000,
  currency: "usd" as const,
  digitalPromise: "Immediate access to the digital guide after verified payment.",
  claims: ["A concise first-week operations guide"]
};

function webhook(event: Record<string, unknown>): Request {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${raw}`).digest("hex");
  return new Request(`${appOrigin}/api/providers/stripe/webhook`, { method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body: raw });
}

async function setup() {
  const runtime = await tempRuntime();
  const workspaceId = runtime.service.context.workspaceId;
  const boot = await runtime.service.execute("company.bootstrap", {
    idea: "A bounded digital operations guide sold through one product-owned public offer route",
    owner: "founder",
    budgetCents: 100,
    permissions: "Free text does not authorize publication",
    operatingEnvelope: {
      modelBudgetCents: 100,
      publicationAllowed: true,
      deploymentBoundaries: [PUBLIC_OFFER_DEPLOYMENT_BOUNDARY],
      approvedClaims: [...sellableAsset.claims],
      prohibitedClaims: ["Guaranteed revenue"],
      publicOfferAuthority: sellableAsset
    },
    requestedAt: nowIso(),
    idempotencyKey: "bootstrap-public-offer-test"
  });
  if (!boot.ok) throw new Error(boot.error?.message);
  const companyId = (boot.data as { ventureId: string }).ventureId;
  const detail = (await runtime.service.execute("company.get", { ventureId: companyId })).data as { state: CompanyState };
  const storage = new SqliteKernelStorage(runtime.storage);
  const evidence = EvidenceItemSchema.parse({
    id: `evidence_${sha256(sellableAsset).slice(0, 20)}`,
    ventureId: companyId,
    type: "initiative-internal-artifact",
    proofTier: "internally-live",
    authority: "engine",
    sourceRef: "receipt_internal_asset",
    observedAt: nowIso(),
    status: "current",
    contentHash: sha256(sellableAsset),
    metadata: { capabilityId: "minimum-sellable-asset", sellableAsset, businessOutcomeVerified: false }
  });
  await storage.appendEvidence(workspaceId, evidence);
  const assets = new PublicSellableAssetService(storage, slugKey, "slug-v1");
  const observation = {
    workspaceId,
    company: detail.state,
    task: { id: "task_publish", ventureId: companyId, actionBounds: { authorityDisposition: "preauthorized", bootstrapDigest: detail.state.bootstrap.digest, authorityEnvelopeDigest: sha256(detail.state.bootstrap.snapshot.operatingEnvelope), preauthorizedBounds: preauthorizedEnvelopeBounds(detail.state.bootstrap.snapshot.operatingEnvelope) } },
    evidence: [evidence],
    suppressedRecipients: [], sentToday: 0, sentThisWeek: 0
  } as unknown as GoldenExecutionObservation;
  const published = await assets.publish(observation);
  const auth: ProviderAuthDependencies = {
    appOrigin,
    createClient: async () => { throw new Error("public offer Checkout must not require an authenticated session"); },
    resolveWorkspace: async () => { throw new Error("public offer Checkout derives workspace from the asset"); },
    consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 })
  };
  return { runtime, storage, workspaceId, companyId, assets, asset: published.asset, auth };
}

describe("public operated-company offer", () => {
  it("rejects model-produced price, promise, copy, or claim mutations outside exact bootstrap authority", async () => {
    const context = await setup();
    try {
      const company = (await context.storage.getCompany(context.workspaceId, context.companyId))!;
      const state = company.state as unknown as CompanyState;
      const mutations = [
        { ...sellableAsset, amountCents: 12_001 },
        { ...sellableAsset, digitalPromise: "A different delivery promise." },
        { ...sellableAsset, publicSummary: "Different public copy." },
        { ...sellableAsset, claims: ["Guaranteed revenue"] }
      ];
      for (const [index, mutated] of mutations.entries()) {
        const source = EvidenceItemSchema.parse({ id: `evidence_mutated_offer_${index}`, ventureId: context.companyId, type: "initiative-internal-artifact", proofTier: "internally-live", authority: "engine", sourceRef: `receipt_mutated_offer_${index}`, observedAt: `2099-01-0${index + 1}T00:00:00.000Z`, status: "current", contentHash: sha256(mutated), metadata: { capabilityId: "minimum-sellable-asset", sellableAsset: mutated } });
        const observation = { workspaceId: context.workspaceId, company: state, task: { id: `task_mutated_${index}`, ventureId: context.companyId, approvalRequired: false, actionBounds: { authorityDisposition: "preauthorized", bootstrapDigest: state.bootstrap.digest, authorityEnvelopeDigest: sha256(state.bootstrap.snapshot.operatingEnvelope), preauthorizedBounds: preauthorizedEnvelopeBounds(state.bootstrap.snapshot.operatingEnvelope) } }, evidence: [source], suppressedRecipients: [], sentToday: 0, sentThisWeek: 0 } as unknown as GoldenExecutionObservation;
        await expect(context.assets.publish(observation)).rejects.toThrow(/exactly match immutable offer authority/);
      }
    } finally {
      await context.runtime.cleanup();
    }
  });

  it("runs publication through the real frozen golden task under exact immutable preauthorization", async () => {
    const runtime = await tempRuntime();
    const workspaceId = runtime.service.context.workspaceId;
    try {
      const goldenAsset = { offerName: "Launch Guide", publicSummary: "A bounded guide.", amountCents: 5_000, currency: "usd" as const, digitalPromise: "Immediate digital access.", claims: ["A bounded launch guide"] };
      const boot = await runtime.service.execute("company.bootstrap", { idea: "A bounded digital guide ready for the product-owned public offer route", owner: "founder", budgetCents: 100, permissions: "Free text is not publication authority", operatingEnvelope: { modelBudgetCents: 100, publicationAllowed: true, deploymentBoundaries: [PUBLIC_OFFER_DEPLOYMENT_BOUNDARY], approvedClaims: [...goldenAsset.claims], prohibitedClaims: ["Guaranteed revenue"], publicOfferAuthority: goldenAsset }, requestedAt: nowIso(), idempotencyKey: "bootstrap-golden-publication" });
      if (!boot.ok) throw new Error(boot.error?.message);
      const companyId = (boot.data as { ventureId: string }).ventureId;
      const source = EvidenceItemSchema.parse({ id: "evidence_public_asset_source", ventureId: companyId, type: "initiative-internal-artifact", proofTier: "internally-live", authority: "engine", sourceRef: "receipt_public_asset_source", observedAt: nowIso(), status: "current", contentHash: sha256("asset-source"), metadata: { capabilityId: "minimum-sellable-asset", materialFacts: { assetReady: true }, sellableAsset: goldenAsset } });
      const prerequisite = EvidenceItemSchema.parse({ id: "evidence_public_asset_prerequisite", ventureId: companyId, type: "initiative-internal-artifact", proofTier: "internally-live", authority: "engine", sourceRef: "receipt_public_asset_prerequisite", observedAt: nowIso(), status: "current", contentHash: sha256("asset-prerequisite"), metadata: { capabilityId: "icp-offer-positioning-pricing", materialFacts: { offerPositioningReady: true } } });
      const run = await runtime.service.execute("company.run", { ventureId: companyId, requestedAt: nowIso(), idempotencyKey: "run-golden-publication" });
      if (!run.ok) throw new Error(run.error?.message);
      runtime.storage.addEvidence(source);
      runtime.storage.addEvidence(prerequisite);
      const storage = new SqliteKernelStorage(runtime.storage);
      const company = (await storage.getCompany(workspaceId, companyId))!;
      const state = company.state as unknown as CompanyState;
      const evidence = await storage.listEvidence(workspaceId, companyId);
      const task = TaskDefinitionSchema.parse({
        id: "task_public_offer_golden",
        ventureId: companyId,
        taskKind: "venture-play",
        purpose: "publish the persisted minimum sellable asset",
        expectedOutcome: "one product-owned public offer route",
        ownerRole: "specialist",
        dependencies: [],
        sourceRefs: [source.sourceRef],
        mode: "external",
        expectedProof: "persisted public asset and worker receipt",
        gateClass: "public-posting",
        actionBounds: {
          executionClass: "golden-execution",
          authorityDisposition: "preauthorized",
          authorityEvaluatedAt: nowIso(),
          authorityEnvelopeDigest: sha256(state.bootstrap.snapshot.operatingEnvelope),
          bootstrapDigest: state.bootstrap.digest,
          preauthorizedBounds: preauthorizedEnvelopeBounds(state.bootstrap.snapshot.operatingEnvelope),
          capabilityId: "minimum-sellable-asset",
          capabilityVersion: "2026-07-20.1",
          senderOrSystem: "ephemeral-specialist",
          exactCommandOrProviderCall: "golden-execution:minimum-sellable-asset:public-offer-test",
          evidencePrerequisites: ["capability:icp-offer-positioning-pricing"],
          evidenceIds: evidence.map((item) => item.id).sort(),
          materialEvidenceDigest: materialEvidenceDigest(evidence)
        },
        budgetCents: 0,
        costCeilingCents: 0,
        approvalRequired: false,
        idempotencyKey: "ceo-initiative:public-offer-test",
        maxAttempts: 1,
        backoffMs: 0,
        timeoutMs: 10_000,
        lifecycleEffect: {},
        metricEffects: []
      });
      const digest = actionDigest(task);
      await storage.putTask(workspaceId, task, digest, "ready");
      await storage.enqueueJob({ workspaceId, companyId, id: "job_public_offer_golden", taskId: task.id, kind: "golden-execution", payload: { ventureId: companyId, taskId: task.id, actionDigest: digest, executionClass: "golden-execution", capabilityId: "minimum-sellable-asset" } });
      await storage.putEntitlement({ workspaceId, companyId, status: "active", plan: "test:paid", periodStart: nowIso(), periodEnd: "2099-01-01T00:00:00.000Z", modelCostCapCents: 1_000, providerEventId: "stripe:test:public-offer", providerOrder: 1, observedAt: nowIso() });
      const worker = new GoldenCompanyWorker(storage, new PublicAssetGoldenExecutionExecutor(storage, slugKey, "slug-v1"), "golden-publication");
      expect(await worker.runOnce(workspaceId)).toMatchObject({ outcome: "success", proofTier: "internally-live" });
      const event = (await storage.listEvents(workspaceId, companyId)).find((item) => item.eventType === "public-sellable-asset-published");
      expect(event).toBeDefined();
      expect((await storage.listEvidence(workspaceId, companyId)).some((item) => item.type === "minimum-sellable-asset-published")).toBe(true);
    } finally {
      await runtime.cleanup();
    }
  });

  it("publishes only persisted structured evidence under an opaque slug and derives Checkout fields server-side", async () => {
    const context = await setup();
    const calls: string[] = [];
    const stripe = new StripeAdapter("sk_live_offer", async (_input, init) => {
      calls.push(String(init?.body ?? ""));
      return Response.json({ id: "cs_live_offer", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/offer", livemode: true });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, auth: context.auth, stripe: { adapter: stripe, mode: "live" }, publicOffer: { assets: context.assets, access } };
    try {
      expect(context.asset.publicSlug).not.toContain(context.workspaceId);
      expect(context.asset.publicSlug).not.toContain(context.companyId);
      expect(await context.assets.getBySlug(`${context.asset.publicSlug}x`)).toBeUndefined();
      const landing = await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}`), context.asset.publicSlug, { storage: context.storage, assets: context.assets });
      expect(landing.status).toBe(200);
      expect(await landing.text()).toContain("Operator Launch Guide");

      const injected = new Request(`${appOrigin}/api/providers/stripe/offer-checkout`, { method: "POST", headers: { origin: appOrigin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slug: context.asset.publicSlug, idempotencyKey: "public-offer-1", amount: "1" }) });
      expect((await handleProviderRequest(injected, "stripe", "offer-checkout", dependencies)).status).toBe(400);
      const request = new Request(`${appOrigin}/api/providers/stripe/offer-checkout`, { method: "POST", headers: { origin: appOrigin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slug: context.asset.publicSlug, idempotencyKey: "public-offer-1" }) });
      const response = await handleProviderRequest(request, "stripe", "offer-checkout", dependencies);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/offer");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("unit_amount%5D=12000");
      expect(calls[0]).toContain(`metadata%5Bopspot_company_id%5D=${context.companyId}`);
      expect(calls[0]).toContain(`metadata%5Bopspot_offer_id%5D=${context.asset.assetId}`);
    } finally {
      await context.runtime.cleanup();
    }
  });

  it("provisions on the canonical live payment, redeems only through a verified paid session, and revokes through the related charge", async () => {
    const context = await setup();
    const metadata = { opspot_workspace_id: context.workspaceId, opspot_company_id: context.companyId, opspot_kind: "operated_company_payment", opspot_offer_id: context.asset.assetId, opspot_amount: "12000", opspot_currency: "usd" };
    const providerObjects: Record<string, Record<string, unknown>> = {
      "payment_intents/pi_offer": { id: "pi_offer", object: "payment_intent", status: "succeeded", amount: 12_000, amount_received: 12_000, currency: "usd", livemode: true, latest_charge: "ch_offer", metadata },
      "charges/ch_offer": { id: "ch_offer", object: "charge", status: "succeeded", paid: true, refunded: false, disputed: false, amount: 12_000, amount_refunded: 0, currency: "usd", livemode: true, payment_intent: "pi_offer", metadata },
      "checkout/sessions/cs_offer_paid": { id: "cs_offer_paid", object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 12_000, currency: "usd", livemode: true, payment_intent: "pi_offer", metadata }
    };
    const stripe = new StripeAdapter("sk_live_offer", async (input) => {
      const key = String(input).replace("https://api.stripe.com/v1/", "");
      return providerObjects[key] ? Response.json(providerObjects[key]) : Response.json({}, { status: 404 });
    });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, stripe: { adapter: stripe, webhookSecret, mode: "live" }, publicOffer: { assets: context.assets, access } };
    try {
      const payment = { id: "evt_offer_pi", type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000), data: { object: { id: "pi_offer", object: "payment_intent", status: "succeeded", amount: 12_000, amount_received: 12_000, currency: "usd", metadata } } };
      expect(await (await handleProviderRequest(webhook(payment), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, proofTier: "revenue-verified", accessProvisioned: true, accessStatus: "pending-redemption" });
      const before = JSON.stringify([await context.storage.listEvents(context.workspaceId, context.companyId), await context.storage.listEvidence(context.workspaceId, context.companyId)]);
      expect(before).not.toMatch(/access_[A-Za-z0-9_-]{43}/);
      expect(before).not.toContain("fulfillment-verified");

      const authoritativeCharge = providerObjects["charges/ch_offer"]!;
      authoritativeCharge.amount = 11_999;
      expect((await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access })).status).toBe(403);
      authoritativeCharge.amount = 12_000;
      authoritativeCharge.currency = "eur";
      expect((await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access })).status).toBe(403);
      authoritativeCharge.currency = "usd";
      authoritativeCharge.metadata = { ...metadata, opspot_company_id: "venture_other" };
      expect((await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access })).status).toBe(403);
      authoritativeCharge.metadata = metadata;
      authoritativeCharge.disputed = true;
      authoritativeCharge.dispute = "dp_offer_open";
      providerObjects["disputes/dp_offer_open"] = { id: "dp_offer_open", object: "dispute", status: "under_review", livemode: true, charge: "ch_offer" };
      expect((await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access })).status).toBe(403);
      authoritativeCharge.disputed = false;
      delete authoritativeCharge.dispute;
      providerObjects["charges/ch_offer"]!.amount_refunded = 1_000;
      providerObjects["charges/ch_offer"]!.refunded = true;
      expect((await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access })).status).toBe(403);
      providerObjects["charges/ch_offer"]!.amount_refunded = 0;
      providerObjects["charges/ch_offer"]!.refunded = false;

      const success = await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access });
      expect(success.status).toBe(200);
      const html = await success.text();
      const secret = html.match(/access_[A-Za-z0-9_-]+/)?.[0];
      expect(secret).toBeTruthy();
      expect(await new GoldenProviderProofService(context.storage).verifyDigitalAccess({ workspaceId: context.workspaceId, companyId: context.companyId }, secret!)).toBe(true);
      const durable = JSON.stringify([await context.storage.listEvents(context.workspaceId, context.companyId), await context.storage.listEvidence(context.workspaceId, context.companyId), await context.storage.listReceipts(context.workspaceId, context.companyId)]);
      expect(durable).not.toContain(secret);
      expect(durable).toContain("authoritative-fulfillment-delivered");
      expect(durable).not.toContain("authoritative-retention-observed");
      const replay = await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access });
      expect(await replay.text()).toContain("already delivered");
      const proof = new GoldenProviderProofService(context.storage);
      expect(await proof.useDigitalAccess({ workspaceId: context.workspaceId, companyId: context.companyId }, secret!, "offer-use-first")).toMatchObject({ active: true, retentionObserved: false });
      expect(await proof.useDigitalAccess({ workspaceId: context.workspaceId, companyId: context.companyId }, secret!, "offer-use-second")).toMatchObject({ active: true, retentionObserved: true });
      expect(JSON.stringify(await context.storage.listEvidence(context.workspaceId, context.companyId))).toContain("authoritative-retention-observed");

      providerObjects["charges/ch_offer"]!.amount_refunded = 12_000;
      providerObjects["charges/ch_offer"]!.refunded = true;
      const refund = { id: "evt_offer_refund", type: "charge.refunded", created: Math.floor(Date.now() / 1000) + 1, data: { object: { id: "ch_offer", object: "charge", status: "succeeded", amount: 12_000, amount_refunded: 12_000, currency: "usd", payment_intent: "pi_offer", metadata } } };
      expect(await (await handleProviderRequest(webhook(refund), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, revokedGrants: 1 });
      expect(await new GoldenProviderProofService(context.storage).verifyDigitalAccess({ workspaceId: context.workspaceId, companyId: context.companyId }, secret!)).toBe(false);
      expect((await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_offer_paid`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "live" }, access })).status).toBe(403);
    } finally {
      await context.runtime.cleanup();
    }
  });

  it("never releases operational access for test-mode payment unless an explicit local fixture path is enabled", async () => {
    const context = await setup();
    const metadata = { opspot_workspace_id: context.workspaceId, opspot_company_id: context.companyId, opspot_kind: "operated_company_payment", opspot_offer_id: context.asset.assetId, opspot_amount: "12000", opspot_currency: "usd" };
    const objects: Record<string, Record<string, unknown>> = {
      "payment_intents/pi_fixture_offer": { id: "pi_fixture_offer", object: "payment_intent", status: "succeeded", amount: 12_000, amount_received: 12_000, currency: "usd", livemode: false, latest_charge: "ch_fixture_offer", metadata },
      "charges/ch_fixture_offer": { id: "ch_fixture_offer", object: "charge", status: "succeeded", paid: true, refunded: false, disputed: false, amount: 12_000, amount_refunded: 0, currency: "usd", livemode: false, payment_intent: "pi_fixture_offer", metadata },
      "checkout/sessions/cs_fixture_offer": { id: "cs_fixture_offer", object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 12_000, currency: "usd", livemode: false, payment_intent: "pi_fixture_offer", metadata }
    };
    const stripe = new StripeAdapter("sk_test_offer", async (input) => {
      const key = String(input).replace("https://api.stripe.com/v1/", "");
      return objects[key] ? Response.json(objects[key]) : Response.json({}, { status: 404 });
    });
    const payment = (id: string) => ({ id, type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000), data: { object: { id: "pi_fixture_offer", object: "payment_intent", status: "succeeded", amount: 12_000, amount_received: 12_000, currency: "usd", metadata } } });
    const dependencies: ProviderRouteDependencies = { storage: context.storage, stripe: { adapter: stripe, webhookSecret, mode: "test" }, publicOffer: { assets: context.assets, access } };
    try {
      expect(await (await handleProviderRequest(webhook(payment("evt_fixture_blocked")), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, proofTier: "fixture-verified", accessProvisioned: false, accessStatus: "fixture-only" });
      expect((await context.storage.listEvents(context.workspaceId, context.companyId)).filter((event) => event.eventType === "digital-access-granted")).toHaveLength(0);

      dependencies.publicOffer!.allowFixtureAccess = true;
      expect(await (await handleProviderRequest(webhook(payment("evt_fixture_allowed")), "stripe", "webhook", dependencies)).json()).toMatchObject({ ok: true, accessProvisioned: true });
      const productionLike = await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_fixture_offer`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "test" }, access });
      expect(productionLike.status).toBe(403);
      const localFixture = await handlePublicOfferGet(new Request(`${appOrigin}/o/${context.asset.publicSlug}?session_id=cs_fixture_offer`), context.asset.publicSlug, { storage: context.storage, assets: context.assets, stripe: { adapter: stripe, mode: "test" }, access, allowFixtureAccess: true });
      expect(localFixture.status).toBe(200);
      expect(await localFixture.text()).toContain("Fixture-only access");
    } finally {
      await context.runtime.cleanup();
    }
  });
});
