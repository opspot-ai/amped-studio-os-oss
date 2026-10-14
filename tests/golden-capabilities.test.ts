import { describe, expect, it } from "vitest";
import {
  CompanyBootstrapInputSchema,
  EvidenceItemSchema,
  InitiativeCandidateSchema,
  nowIso,
  sha256,
  type EvidenceItem,
  type InitiativeDraft
} from "@amped-studio-os/contracts";
import { OpenAIResponsesAdapter } from "@amped-studio-os/adapters";
import { CompanyInitiativeWorker, EngineWorker, UnconfiguredInitiativeExecutor } from "@amped-studio-os/domain";
import { SqliteKernelStorage } from "@amped-studio-os/storage";
import {
  OpenAICeoExecutor,
  buildConservativeBootstrapPlan,
  materialEvidenceDigest,
  type CeoExecutor
} from "../packages/domain/src/autonomous.js";
import {
  EXTERNAL_SEND_EVIDENCE_PREREQUISITES,
  GTM_CAPABILITY_CATALOG,
  GTM_CAPABILITY_PROMPT_CATALOG,
  GTM_CAPABILITY_CATALOG_VERSION,
  PUBLIC_OFFER_DEPLOYMENT_BOUNDARY,
  assessGtmCapability,
  capabilityEvidencePrerequisites,
  evidenceSatisfiesCapabilityPrerequisite,
  getGtmCapability
} from "../packages/domain/src/capabilities.js";
import { tempRuntime } from "./helpers.js";

const at = "2026-07-20T12:00:00.000Z";

const researchDraft = (title: string): InitiativeDraft => ({
  capabilityId: "market-problem-research",
  title,
  hypothesis: "A bounded primary-source pass can falsify the founder hypothesis",
  dependencies: [],
  requirements: ["Preserve unknowns"],
  expectedOutcome: "A cited research artifact",
  expectedProof: "Task-bound citations",
  successThreshold: "One supported or falsified statement",
  failureThreshold: "No usable source",
  stopCondition: "Stop before external business action",
  estimatedHours: 1,
  estimatedCostCents: 0,
  autonomyMode: "execute-safe",
  gateClasses: ["public-research-free"],
  uncertainty: 0.7,
  uncertaintyReason: "No authoritative market outcome exists",
  assumptions: []
});

function evidence(type: string, metadata: Record<string, unknown> = {}, ventureId = "venture_capability") {
  return EvidenceItemSchema.parse({
    id: `evidence_${sha256({ type, metadata }).slice(0, 16)}`,
    ventureId,
    type,
    proofTier: "internally-live",
    authority: "engine",
    sourceRef: `source_${sha256(type).slice(0, 16)}`,
    observedAt: at,
    status: "current",
    contentHash: sha256({ type, metadata }),
    metadata
  });
}

const fulfillmentPrerequisite = "authoritative-fulfillment-delivered";
const fulfillmentObservedAt = "2026-08-19T14:00:00.000Z";

function fulfillmentEvidence(label: string, overrides: Partial<EvidenceItem> = {}, ventureId = "venture_example_c"): EvidenceItem {
  const metadata = overrides.metadata ?? { fixture: false, paymentObjectId: "pi_bound" };
  return EvidenceItemSchema.parse({
    id: `evidence_fulfillment_${sha256(label).slice(0, 16)}`,
    ventureId,
    type: fulfillmentPrerequisite,
    proofTier: "fulfillment-verified",
    authority: "fulfillment",
    sourceRef: `source_${sha256({ label, source: true }).slice(0, 16)}`,
    observedAt: fulfillmentObservedAt,
    status: "current",
    contentHash: sha256({ label, overrides }),
    ...overrides,
    metadata
  });
}

function fulfillmentFailureControls(ventureId = "venture_example_c") {
  return [
    { label: "wrong type", item: fulfillmentEvidence(`${ventureId}-wrong-type`, { type: "authoritative-retention-observed" }, ventureId) },
    { label: "stale status", item: fulfillmentEvidence(`${ventureId}-stale`, { status: "stale" }, ventureId) },
    { label: "wrong authority", item: fulfillmentEvidence(`${ventureId}-wrong-authority`, { authority: "engine" }, ventureId) },
    { label: "wrong proof tier", item: fulfillmentEvidence(`${ventureId}-wrong-proof-tier`, { proofTier: "internally-live" }, ventureId) },
    { label: "fixture marker", item: fulfillmentEvidence(`${ventureId}-fixture-marker`, { metadata: { fixture: true, paymentObjectId: "pi_bound" } }, ventureId) },
    { label: "missing payment binding", item: fulfillmentEvidence(`${ventureId}-missing-payment-binding`, { metadata: { fixture: false } }, ventureId) },
    { label: "non-string payment binding", item: fulfillmentEvidence(`${ventureId}-non-string-payment-binding`, { metadata: { fixture: false, paymentObjectId: 42 } }, ventureId) },
    { label: "blank payment binding", item: fulfillmentEvidence(`${ventureId}-blank-payment-binding`, { metadata: { fixture: false, paymentObjectId: "   " } }, ventureId) }
  ];
}

function acquisitionCandidate() {
  return InitiativeCandidateSchema.parse({
    id: "initiative_permissioned_acquisition",
    ventureId: "venture_capability",
    goalRevisionId: "goal_capability",
    capabilityId: "permissioned-acquisition",
    title: "Run one owned-endpoint acquisition self-test",
    hypothesis: "A bounded owned-endpoint send can verify the acquisition route without contacting a prospect",
    dependencyIds: [],
    requirementIds: [],
    expectedOutcome: "One provider-observed owned-endpoint delivery",
    expectedProof: "Provider send, delivery, and suppression receipts",
    successThreshold: "One idempotent owned-endpoint delivery",
    failureThreshold: "Sender, suppression, or endpoint verification fails",
    stopCondition: "Stop after one action or any safety failure",
    estimatedHours: 1,
    estimatedCostCents: 0,
    autonomyMode: "execute-gated",
    gateClasses: ["external-send-within-license"],
    uncertainty: 0.4,
    uncertaintyReason: "No provider result exists yet",
    assumptions: [],
    evidenceIds: []
  });
}

function publicationCandidate() {
  return InitiativeCandidateSchema.parse({
    ...acquisitionCandidate(),
    id: "initiative_public_offer",
    capabilityId: "minimum-sellable-asset",
    title: "Publish the persisted minimum sellable asset",
    hypothesis: "The product-owned offer route can expose the bounded persisted asset",
    expectedOutcome: "One public offer route",
    expectedProof: "Persisted asset and route receipt",
    gateClasses: ["public-posting"]
  });
}

describe("golden company capability contract", () => {
  it("freezes one compact runtime catalog for all twelve required capabilities", () => {
    expect(GTM_CAPABILITY_CATALOG_VERSION).toBe("2026-07-20.1");
    expect(GTM_CAPABILITY_CATALOG).toHaveLength(12);
    expect(new Set(GTM_CAPABILITY_CATALOG.map((capability) => capability.id))).toHaveProperty("size", 12);
    for (const capability of GTM_CAPABILITY_CATALOG) {
      expect(capability.trigger).not.toBe("");
      expect(capability.inputs.length).toBeGreaterThan(0);
      expect(capability.authority).not.toBe("");
      expect(capability.procedure.length).toBeGreaterThan(0);
      expect(capability.outputs.length).toBeGreaterThan(0);
      expect(capability.expectedProof.length).toBeGreaterThan(0);
      expect(capability.budgets.length).toBeGreaterThan(0);
      expect(capability.stopConditions.length).toBeGreaterThan(0);
      expect(capability.failureHandling).not.toBe("");
      expect(capability.learningHooks).not.toBe("");
      expect(capability.gateClasses.length).toBeGreaterThan(0);
    }
  });

  it("accepts authority only from a structured bootstrap envelope and caps its budgets", () => {
    const freeText = CompanyBootstrapInputSchema.parse({
      idea: "A digital service whose first test is restricted to an Amped Studio OS-owned endpoint",
      owner: "founder",
      budgetCents: 2_000,
      permissions: "I authorize email from synthetic-contact-024@example.test to anyone we choose",
      requestedAt: at,
      idempotencyKey: "bootstrap-free-text-authority"
    });
    const failClosed = buildConservativeBootstrapPlan(freeText).operatingEnvelope;
    expect(failClosed).toMatchObject({ senderIdentities: [], allowedChannels: [], recipientRules: [], suppressions: [], dailyActionCap: 0, weeklyActionCap: 0 });

    const structured = CompanyBootstrapInputSchema.parse({
      ...freeText,
      idempotencyKey: "bootstrap-structured-authority",
      operatingEnvelope: {
        senderIdentities: ["sender_ref_verified_later"],
        allowedChannels: ["email"],
        recipientRules: ["Amped Studio OS-owned endpoint only"],
        suppressions: ["provider_suppression_ref"],
        dailyActionCap: 1,
        weeklyActionCap: 1,
        quietHours: ["21:00-08:00 America/New_York"],
        approvedClaims: ["Owned-endpoint route test only"],
        prohibitedClaims: ["Any customer or revenue claim"],
        modelBudgetCents: 5_000,
        toolBudgetCents: 3_000,
        operatingBudgetCents: 4_000,
        credentialScopes: ["email.send.owned-test"],
        deploymentBoundaries: [],
        publicationAllowed: false,
        expiresAt: "2026-07-21T12:00:00.000Z"
      }
    });
    const envelope = buildConservativeBootstrapPlan(structured).operatingEnvelope;
    expect(envelope).toMatchObject({
      senderIdentities: ["sender_ref_verified_later"],
      allowedChannels: ["email"],
      recipientRules: ["Amped Studio OS-owned endpoint only"],
      suppressions: ["provider_suppression_ref"],
      dailyActionCap: 1,
      weeklyActionCap: 1,
      modelBudgetCents: 1_000,
      toolBudgetCents: 2_000,
      operatingBudgetCents: 2_000
    });
  });

  it("distinguishes provider-verified preauthorization from approval and missing evidence", () => {
    const envelope = buildConservativeBootstrapPlan(CompanyBootstrapInputSchema.parse({
      idea: "A digital service whose first test is restricted to an Amped Studio OS-owned endpoint",
      owner: "founder",
      budgetCents: 2_000,
      permissions: "Free text is not authority",
      operatingEnvelope: {
        senderIdentities: ["sender_ref"],
        allowedChannels: ["email"],
        recipientRules: ["Amped Studio OS-owned endpoint only"],
        suppressions: ["suppression_ref"],
        dailyActionCap: 1,
        weeklyActionCap: 1,
        quietHours: [],
        approvedClaims: [],
        prohibitedClaims: ["customer claim"],
        modelBudgetCents: 100,
        toolBudgetCents: 0,
        operatingBudgetCents: 0,
        credentialScopes: ["email.send.owned-test"],
        deploymentBoundaries: [],
        publicationAllowed: false,
        expiresAt: "2026-07-21T12:00:00.000Z"
      },
      requestedAt: at,
      idempotencyKey: "bootstrap-capability-authority"
    })).operatingEnvelope;
    const asset = evidence("initiative-internal-artifact", { capabilityId: "minimum-sellable-asset" });
    const missingControls = assessGtmCapability(acquisitionCandidate(), envelope, [asset], at);
    expect(missingControls).toMatchObject({ executionClass: "golden-execution", authorityDisposition: "approval-required", evidenceReady: false });
    expect(missingControls.missingEvidencePrerequisites).toEqual(expect.arrayContaining([...EXTERNAL_SEND_EVIDENCE_PREREQUISITES]));

    const providerControls = EXTERNAL_SEND_EVIDENCE_PREREQUISITES.map((type) => evidence(type));
    const preauthorized = assessGtmCapability(acquisitionCandidate(), envelope, [asset, ...providerControls], at);
    expect(preauthorized).toMatchObject({ executionClass: "golden-execution", authorityDisposition: "preauthorized", evidenceReady: true, gateConsistent: true });

    const unverifiedRecipient = providerControls.filter((item) => item.type !== "provider-verified-owned-recipient-endpoint");
    const approvalCannotBypass = assessGtmCapability(acquisitionCandidate(), envelope, [asset, ...unverifiedRecipient], at);
    expect(approvalCannotBypass).toMatchObject({ authorityDisposition: "approval-required", evidenceReady: false });
  });

  it("preauthorizes the product-owned public offer route only from the immutable publication flag and exact boundary", () => {
    const publicOfferAuthority = { offerName: "Launch Guide", publicSummary: "A bounded launch guide.", amountCents: 5_000, currency: "usd" as const, digitalPromise: "Immediate access after verified payment.", claims: ["Bounded launch guidance"] };
    const base = buildConservativeBootstrapPlan(CompanyBootstrapInputSchema.parse({
      idea: "A digital service with an evidence-backed offer ready for one bounded payment page",
      owner: "founder",
      permissions: `Publish anything through ${PUBLIC_OFFER_DEPLOYMENT_BOUNDARY}`,
      operatingEnvelope: {
        modelBudgetCents: 100,
        deploymentBoundaries: [PUBLIC_OFFER_DEPLOYMENT_BOUNDARY],
        publicationAllowed: true,
        approvedClaims: [...publicOfferAuthority.claims],
        prohibitedClaims: ["Guaranteed revenue"],
        publicOfferAuthority
      },
      requestedAt: at,
      idempotencyKey: "bootstrap-publication-authority"
    })).operatingEnvelope;
    const prerequisite = evidence("initiative-internal-artifact", { capabilityId: "icp-offer-positioning-pricing" });
    expect(assessGtmCapability(publicationCandidate(), base, [prerequisite], at)).toMatchObject({ authorityDisposition: "preauthorized", evidenceReady: true });
    expect(assessGtmCapability(publicationCandidate(), { ...base, publicationAllowed: false }, [prerequisite], at)).toMatchObject({ authorityDisposition: "approval-required" });
    expect(assessGtmCapability(publicationCandidate(), { ...base, deploymentBoundaries: ["some-other-route"] }, [prerequisite], at)).toMatchObject({ authorityDisposition: "approval-required" });
    expect(assessGtmCapability(publicationCandidate(), { ...base, publicOfferAuthority: undefined }, [prerequisite], at)).toMatchObject({ authorityDisposition: "approval-required" });
    expect(assessGtmCapability(publicationCandidate(), { ...base, approvedClaims: [] }, [prerequisite], at)).toMatchObject({ authorityDisposition: "approval-required" });
    expect(assessGtmCapability(publicationCandidate(), { ...base, prohibitedClaims: ["bounded launch"] }, [prerequisite], at)).toMatchObject({ authorityDisposition: "approval-required" });
    expect(assessGtmCapability(publicationCandidate(), base, [], at)).toMatchObject({ authorityDisposition: "approval-required", evidenceReady: false });
  });

  it("includes capability and evidence contracts in the real CEO provider prompt", async () => {
    const runtime = await tempRuntime();
    try {
      const boot = await runtime.service.execute("company.bootstrap", {
        idea: "A plain-language digital company that must validate one painful workflow before building",
        owner: "founder",
        destination: "cash-flow",
        horizonDays: 30,
        budgetCents: 100,
        constraints: [],
        killConditions: ["Stop when the bounded test is infeasible"],
        permissions: "Internal research only",
        requestedAt: at,
        idempotencyKey: "bootstrap-capability-prompt"
      });
      expect(boot.ok).toBe(true);
      const ventureId = (boot.data as { ventureId: string }).ventureId;
      const current = (await runtime.service.execute("company.get", { ventureId })).data as any;
      let requestBody: Record<string, unknown> | undefined;
      const adapter = new OpenAIResponsesAdapter("test-key", {
        fetchImpl: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            id: "resp_capabilities",
            model: "fake-capability-model",
            output_text: JSON.stringify({
              alternatives: [researchDraft("Research the problem"), researchDraft("Falsify the problem")],
              decision: "abstain",
              reason: "No authoritative market evidence exists yet"
            }),
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
      });
      const evidenceItems = current.evidence;
      await new OpenAICeoExecutor(adapter).decide({
        company: current.state,
        evidence: evidenceItems,
        cycleSequence: 1,
        materialEvidenceDigest: materialEvidenceDigest(evidenceItems)
      });
      const prompt = JSON.parse(String(requestBody?.input)) as Record<string, any>;
      expect(prompt.capabilityCatalogVersion).toBe(GTM_CAPABILITY_CATALOG_VERSION);
      expect(prompt.capabilityCatalog).toHaveLength(12);
      expect(JSON.stringify(prompt.capabilityCatalog).length).toBeLessThan(JSON.stringify(GTM_CAPABILITY_CATALOG).length / 2);
      expect(prompt.capabilityCatalog).toEqual(GTM_CAPABILITY_PROMPT_CATALOG);
      expect(prompt.externalSendEvidencePrerequisites).toEqual(EXTERNAL_SEND_EVIDENCE_PREREQUISITES);
      expect(prompt.capabilityCatalog.find((item: any) => item.id === "fulfillment-verification").evidencePrerequisites)
        .toContain("authoritative-payment-collected");
    } finally {
      await runtime.cleanup();
    }
  });

  it("persists a provider-verified preauthorized action as golden execution that internal workers cannot claim after restart", async () => {
    const acquisition: InitiativeDraft = {
      capabilityId: "permissioned-acquisition",
      title: "Send one owned-endpoint acquisition self-test",
      hypothesis: "The verified provider route can deliver once to the owned endpoint",
      dependencies: [],
      requirements: ["Owned endpoint only"],
      expectedOutcome: "One provider-observed owned-endpoint delivery",
      expectedProof: "Provider send, delivery, and suppression receipts",
      successThreshold: "One idempotent delivery",
      failureThreshold: "Any provider or safety-control rejection",
      stopCondition: "Stop after one action or any control failure",
      estimatedHours: 1,
      estimatedCostCents: 0,
      autonomyMode: "execute-gated",
      gateClasses: ["external-send-within-license"],
      uncertainty: 0.4,
      uncertaintyReason: "No provider action receipt exists yet",
      assumptions: []
    };
    const ceo: CeoExecutor = {
      identity: Object.freeze({
        provider: "deterministic-fake",
        model: "golden-routing-case",
        tariffVersion: "frozen-v1",
        runtimeConfigHash: sha256("golden-routing-case")
      }),
      estimateDecisionReservation: () => 0,
      async decide() {
        return {
          output: {
            alternatives: [acquisition, researchDraft("Keep researching internally")],
            decision: "select" as const,
            selectedAlternativeIndex: 0,
            reason: "The exact provider-owned self-test is inside the structured envelope"
          },
          provider: "deterministic-fake",
          model: "golden-routing-case",
          responseId: "golden-routing-response",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          reservationCents: 0,
          costCents: 0
        };
      }
    };
    const runtime = await tempRuntime({ ceoExecutor: ceo, legacyDispatcher: "default" });
    try {
      const boot = await runtime.service.execute("company.bootstrap", {
        idea: "A digital company proving one controlled acquisition route to an Amped Studio OS-owned endpoint",
        owner: "founder",
        destination: "cash-flow",
        horizonDays: 30,
        budgetCents: 100,
        constraints: [],
        killConditions: ["Stop on any safety-control failure"],
        permissions: "Free text does not grant send authority",
        operatingEnvelope: {
          senderIdentities: ["sender_ref"],
          allowedChannels: ["email"],
          recipientRules: ["Amped Studio OS-owned endpoint only"],
          suppressions: ["suppression_ref"],
          dailyActionCap: 1,
          weeklyActionCap: 1,
          quietHours: [],
          approvedClaims: [],
          prohibitedClaims: ["customer or revenue claim"],
          modelBudgetCents: 100,
          toolBudgetCents: 0,
          operatingBudgetCents: 0,
          credentialScopes: ["email.send.owned-test"],
          deploymentBoundaries: [],
          publicationAllowed: false,
          expiresAt: "2099-07-21T12:00:00.000Z"
        },
        requestedAt: nowIso(),
        idempotencyKey: "bootstrap-golden-routing"
      });
      expect(boot.ok, boot.error?.message).toBe(true);
      const ventureId = (boot.data as { ventureId: string }).ventureId;
      const requiredEvidence = [
        evidence("initiative-internal-artifact", { capabilityId: "minimum-sellable-asset", materialFacts: { assetReady: true } }, ventureId),
        ...EXTERNAL_SEND_EVIDENCE_PREREQUISITES.map((type) => evidence(type, { materialFacts: { verified: true, type } }, ventureId))
      ];
      for (const item of requiredEvidence) runtime.storage.addEvidence(item);
      const run = await runtime.service.execute("company.run", { ventureId, requestedAt: nowIso(), idempotencyKey: "run-golden-routing" });
      expect(run.ok, run.error?.message).toBe(true);
      const cycle = await runtime.autonomy.runWorkerOnce(runtime.service.context.workspaceId, "ceo-golden-routing");
      expect(cycle?.outcome, JSON.stringify(cycle)).toBe("selected");
      const taskId = (cycle as any).cycle.plannedTaskIds[0] as string;
      const task = runtime.storage.getTask(ventureId, taskId)!;
      expect(task).toMatchObject({ mode: "external", approvalRequired: false });
      expect(task.actionBounds).toMatchObject({
        executionClass: "golden-execution",
        authorityDisposition: "preauthorized",
        capabilityId: "permissioned-acquisition",
        capabilityVersion: GTM_CAPABILITY_CATALOG_VERSION,
        evidencePrerequisites: ["capability:minimum-sellable-asset", ...EXTERNAL_SEND_EVIDENCE_PREREQUISITES]
      });

      const restartedStorage = new SqliteKernelStorage(runtime.storage);
      expect(await restartedStorage.listJobs(runtime.service.context.workspaceId, ventureId)).toContainEqual(
        expect.objectContaining({ taskId, kind: "golden-execution", status: "queued" })
      );
      expect(await new CompanyInitiativeWorker(restartedStorage, new UnconfiguredInitiativeExecutor(), "initiative-after-restart")
        .runOnce(runtime.service.context.workspaceId)).toBeNull();
      expect(await new EngineWorker(runtime.service, "legacy-after-restart").runOnce()).toBeNull();
      expect(runtime.storage.listReceipts(ventureId).some((receipt) => receipt.taskId === taskId)).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });
});

describe("payment-bound authoritative fulfillment contract", () => {
  it("keeps the retention external-send controls additive to its fulfillment prerequisite", () => {
    const capability = getGtmCapability("retention-renewal-observation");
    expect(capabilityEvidencePrerequisites(capability, "external-send-within-license")).toEqual([
      fulfillmentPrerequisite,
      ...EXTERNAL_SEND_EVIDENCE_PREREQUISITES
    ]);
  });

  it("requires every fulfillment conjunct on one capability-prerequisite candidate", () => {
    const singleFailureControls = fulfillmentFailureControls();
    for (const { label, item } of singleFailureControls) {
      expect(
        evidenceSatisfiesCapabilityPrerequisite(fulfillmentPrerequisite, [item]),
        label
      ).toBe(false);
    }
    const invalidItems = singleFailureControls.map(({ item }) => item);
    expect(evidenceSatisfiesCapabilityPrerequisite(fulfillmentPrerequisite, invalidItems)).toBe(false);

    const valid = fulfillmentEvidence("valid");
    expect(evidenceSatisfiesCapabilityPrerequisite(fulfillmentPrerequisite, [...invalidItems, valid])).toBe(true);
    expect(evidenceSatisfiesCapabilityPrerequisite(fulfillmentPrerequisite, [valid, ...invalidItems])).toBe(true);
  });

  it("reports the same single-candidate contract through the scorecard", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const readVerifiedFulfillment = async (ventureId: string) => {
        const response = await runtime.service.execute("portfolio.scorecard", {});
        expect(response.ok, response.error?.message).toBe(true);
        const venture = (response.data as { ventures: Array<{ ventureId: string; verifiedFulfillment: boolean }> }).ventures
          .find((item) => item.ventureId === ventureId);
        expect(venture).toBeDefined();
        return venture!.verifiedFulfillment;
      };

      const exampleCFailures = fulfillmentFailureControls("venture_example_c");
      expect(await readVerifiedFulfillment("venture_example_c")).toBe(false);
      for (const { item } of exampleCFailures) runtime.storage.addEvidence(item);
      expect(await readVerifiedFulfillment("venture_example_c")).toBe(false);

      runtime.storage.addEvidence(fulfillmentEvidence("scorecard-valid-last", { observedAt: "2026-08-19T15:00:00.000Z" }));
      expect(await readVerifiedFulfillment("venture_example_c")).toBe(true);

      runtime.storage.addEvidence(fulfillmentEvidence("scorecard-valid-first", { observedAt: "2026-08-19T13:00:00.000Z" }, "venture_example_a"));
      for (const { item } of fulfillmentFailureControls("venture_example_a")) runtime.storage.addEvidence(item);
      expect(await readVerifiedFulfillment("venture_example_a")).toBe(true);
    } finally {
      await runtime.cleanup();
    }
  });
});
