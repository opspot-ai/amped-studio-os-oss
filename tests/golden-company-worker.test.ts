import { describe, expect, it } from "vitest";
import { EvidenceItemSchema, nowIso, sha256, type InitiativeDraft } from "@amped-studio-os/contracts";
import { ResendEmailAdapter } from "@amped-studio-os/adapters";
import { GoldenCompanyWorker, ResendGoldenExecutionExecutor } from "@amped-studio-os/domain";
import { SqliteKernelStorage, type KernelStorage } from "@amped-studio-os/storage";
import type { CeoExecutor } from "../packages/domain/src/autonomous.js";
import { tempRuntime } from "./helpers.js";

const sender = "synthetic-contact-025@example.test";
const recipient = "synthetic-contact-019@example.test";
const replyRecipient = "synthetic-contact-023@example.test";

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
  identity: Object.freeze({ provider: "deterministic-fake", model: "golden-worker", tariffVersion: "frozen-v1", runtimeConfigHash: sha256("golden-worker") }),
  estimateDecisionReservation: () => 0,
  async decide() {
    return {
      output: { alternatives: [acquisition, { ...acquisition, capabilityId: "market-problem-research", title: "Research instead", autonomyMode: "execute-safe", gateClasses: ["public-research-free"] }], decision: "select" as const, selectedAlternativeIndex: 0, reason: "The exact owned endpoint is bounded" },
      provider: "deterministic-fake",
      model: "golden-worker",
      responseId: "golden-worker-response",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      reservationCents: 0,
      costCents: 0
    };
  }
};

async function harness(fetchImpl: typeof fetch) {
  const runtime = await tempRuntime({ ceoExecutor: ceo, legacyDispatcher: "default" });
  const workspaceId = runtime.service.context.workspaceId;
  const boot = await runtime.service.execute("company.bootstrap", {
    idea: "A digital company proving one controlled acquisition route",
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
      recipientRules: ["owned_endpoint_only"],
      suppressions: ["resend_suppression"],
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
    idempotencyKey: "bootstrap-golden-worker"
  });
  if (!boot.ok) throw new Error(boot.error?.message);
  const companyId = (boot.data as { ventureId: string }).ventureId;
  const controls = [
    ["initiative-internal-artifact", { capabilityId: "minimum-sellable-asset", materialFacts: { assetReady: true } }],
    ["provider-verified-sender-domain", { provider: "resend", workspaceId, companyId, verified: true, sender, senderRef: "sender_ref" }],
    ["provider-verified-owned-recipient-endpoint", { provider: "resend", workspaceId, companyId, verified: true, recipient, replyRecipient, recipientRule: "owned_endpoint_only" }],
    ["provider-verified-suppression-control", { provider: "resend", workspaceId, companyId, verified: true, suppressionRef: "resend_suppression" }]
  ] as const;
  for (const [type, metadata] of controls) {
    runtime.storage.addEvidence(EvidenceItemSchema.parse({
      id: `evidence_${sha256({ type, metadata }).slice(0, 20)}`,
      ventureId: companyId,
      type,
      proofTier: "internally-live",
      authority: "engine",
      sourceRef: `source_${sha256(type).slice(0, 20)}`,
      observedAt: nowIso(),
      status: "current",
      contentHash: sha256({ type, metadata }),
      metadata
    }));
  }
  const run = await runtime.service.execute("company.run", { ventureId: companyId, requestedAt: nowIso(), idempotencyKey: "run-golden-worker" });
  if (!run.ok) throw new Error(run.error?.message);
  await runtime.autonomy.runWorkerOnce(workspaceId, "ceo-golden-worker");
  const storage = new SqliteKernelStorage(runtime.storage);
  await storage.putEntitlement({ workspaceId, companyId, status: "active", plan: "test:paid", periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2099-08-01T00:00:00.000Z", modelCostCapCents: 10_000, providerEventId: "stripe:test:golden-worker", providerOrder: 1, observedAt: nowIso() });
  const worker = new GoldenCompanyWorker(storage, new ResendGoldenExecutionExecutor(new ResendEmailAdapter("re_test", fetchImpl), { sender, ownedRecipient: recipient, ownedReplyRecipient: replyRecipient }), "golden-test");
  return { runtime, storage, worker, workspaceId, companyId };
}

describe("golden company worker", () => {
  it("claims only golden execution, reserves before send, and records authoritative proof before success", async () => {
    const calls: Array<{ url: string; idempotencyKey: string | null; body: string }> = [];
    const context = await harness(async (input, init) => {
      const url = String(input);
      calls.push({ url, idempotencyKey: new Headers(init?.headers).get("idempotency-key"), body: String(init?.body ?? "") });
      if (url.endsWith("/emails") && init?.method === "POST") return Response.json({ id: "email_golden" });
      return Response.json({ object: "email", id: "email_golden", to: [recipient], created_at: nowIso(), last_event: "sent", tags: [{ name: "opspot_workspace", value: context.workspaceId }, { name: "opspot_company", value: context.companyId }] });
    });
    try {
      const result = await context.worker.runOnce(context.workspaceId);
      expect(result).toMatchObject({ outcome: "success", ventureId: context.companyId, proofTier: "externally-live" });
      expect(calls.filter((call) => call.url.endsWith("/emails"))).toHaveLength(1);
      expect(calls[0]?.idempotencyKey).toMatch(/^opspot-email:/);
      expect(JSON.parse(calls[0]!.body).reply_to).toMatch(/^replies\+[a-f0-9]{48}@inbound\.example\.test$/);
      expect((await context.storage.listReceipts(context.workspaceId, context.companyId)).some((receipt) => receipt.actor === "golden-company-worker")).toBe(true);
      expect((await context.storage.listEvidence(context.workspaceId, context.companyId)).some((item) => item.type === "permissioned-acquisition-provider-action")).toBe(true);
      expect(await context.worker.runOnce(context.workspaceId)).toBeNull();
    } finally {
      await context.runtime.cleanup();
    }
  });

  it("reconciles an ambiguous timeout with the same provider idempotency key", async () => {
    const calls: Array<{ url: string; idempotencyKey: string | null }> = [];
    const binding = { workspaceId: "", companyId: "" };
    const context = await harness(async (input, init) => {
      const url = String(input);
      const idempotencyKey = new Headers(init?.headers).get("idempotency-key");
      calls.push({ url, idempotencyKey });
      const posts = calls.filter((call) => call.url.endsWith("/emails")).length;
      if (url.endsWith("/emails") && init?.method === "POST") {
        if (posts === 1) throw new TypeError("network timeout after write");
        return Response.json({ id: "email_golden" });
      }
      return Response.json({ object: "email", id: "email_golden", to: [recipient], created_at: nowIso(), last_event: "sent", tags: [{ name: "opspot_workspace", value: binding.workspaceId }, { name: "opspot_company", value: binding.companyId }] });
    });
    binding.workspaceId = context.workspaceId;
    binding.companyId = context.companyId;
    try {
      expect(await context.worker.runOnce(context.workspaceId)).toMatchObject({ outcome: "retry" });
      context.runtime.storage.db.prepare("UPDATE jobs SET available_at=? WHERE venture_id=? AND kind='golden-execution'").run("2000-01-01T00:00:00.000Z", context.companyId);
      expect(await context.worker.runOnce(context.workspaceId)).toMatchObject({ outcome: "success" });
      const keys = calls.filter((call) => call.url.endsWith("/emails")).map((call) => call.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      const receipts = await context.storage.listReceipts(context.workspaceId, context.companyId);
      expect(receipts.find((receipt) => receipt.actor === "golden-company-worker")?.metadata).toMatchObject({ providerMetadata: { reconciled: true } });
    } finally {
      await context.runtime.cleanup();
    }
  });

  it("does not commit or claim success after lease loss, then reconciles on recovery", async () => {
    const calls: Array<{ url: string; idempotencyKey: string | null }> = [];
    const binding = { workspaceId: "", companyId: "" };
    const providerFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, idempotencyKey: new Headers(init?.headers).get("idempotency-key") });
      if (url.endsWith("/emails") && init?.method === "POST") return Response.json({ id: "email_golden" });
      return Response.json({ object: "email", id: "email_golden", to: [recipient], created_at: nowIso(), last_event: "sent", tags: [{ name: "opspot_workspace", value: binding.workspaceId }, { name: "opspot_company", value: binding.companyId }] });
    };
    const context = await harness(providerFetch);
    binding.workspaceId = context.workspaceId;
    binding.companyId = context.companyId;
    try {
      let renewals = 0;
      const leaseLosingStorage = new Proxy(context.storage, {
        get(target, property) {
          if (property === "renewJobLease") return async (...args: Parameters<KernelStorage["renewJobLease"]>) => {
            renewals += 1;
            if (renewals === 3) {
              context.runtime.storage.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE venture_id=? AND kind='golden-execution'").run("2000-01-01T00:00:00.000Z", context.companyId);
              return false;
            }
            return target.renewJobLease(...args);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const losingWorker = new GoldenCompanyWorker(leaseLosingStorage, new ResendGoldenExecutionExecutor(new ResendEmailAdapter("re_test", providerFetch), { sender, ownedRecipient: recipient, ownedReplyRecipient: replyRecipient }), "lease-loser");
      expect(await losingWorker.runOnce(context.workspaceId)).toMatchObject({ outcome: "lease-lost" });
      expect((await context.storage.listReceipts(context.workspaceId, context.companyId)).some((receipt) => receipt.actor === "golden-company-worker")).toBe(false);
      expect(await context.worker.runOnce(context.workspaceId)).toMatchObject({ outcome: "success" });
      expect(calls.filter((call) => call.url.endsWith("/emails"))).toHaveLength(2);
    } finally {
      await context.runtime.cleanup();
    }
  });
});
