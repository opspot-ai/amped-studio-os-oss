import { describe, expect, it } from "vitest";
import {
  nowIso,
  sha256,
  type CeoCycleDecision,
  type InitiativeDraft
} from "@amped-studio-os/contracts";
import { OpenAIResponsesAdapter } from "@amped-studio-os/adapters";
import { SqliteKernelStorage, type KernelStorage } from "@amped-studio-os/storage";
import {
  CompanyInitiativeWorker,
  OpenAIInitiativeExecutor,
  type InitiativeExecutor,
  type InitiativeObservation,
  type InitiativeProviderResult
} from "@amped-studio-os/domain";
import type { CeoExecutor, CeoObservation, CeoProviderResult } from "../packages/domain/src/autonomous.js";
import { tempRuntime } from "./helpers.js";

const safeDraft = (): InitiativeDraft => ({
  capabilityId: "market-problem-research",
  title: "Produce a bounded research artifact",
  hypothesis: "A bounded evidence pass can clarify the stated problem without external action",
  dependencies: [],
  requirements: ["Preserve unknowns"],
  expectedOutcome: "An internal evidence artifact",
  expectedProof: "A task-bound engine receipt",
  successThreshold: "Artifact labels supported claims and unknowns",
  failureThreshold: "Artifact invents market proof",
  stopCondition: "Stop before sends, posts, spend, or deployment",
  estimatedHours: 1,
  estimatedCostCents: 0,
  autonomyMode: "execute-safe",
  gateClasses: ["safe-internal-read-only"],
  uncertainty: 0.7,
  uncertaintyReason: "No market outcome is yet authoritative",
  assumptions: []
});

class SelectingCeo implements CeoExecutor {
  readonly identity = Object.freeze({
    provider: "deterministic-fake",
    model: "fake-ceo",
    tariffVersion: "fake-tariff-v1",
    runtimeConfigHash: sha256({ tariff: "fake-tariff-v1" })
  });

  estimateDecisionReservation(_observation: CeoObservation): number {
    return 0;
  }

  async decide(): Promise<CeoProviderResult<CeoCycleDecision>> {
    return {
      output: {
        alternatives: [safeDraft(), { ...safeDraft(), title: "Preserve the current bounded initiative" }],
        decision: "select",
        selectedAlternativeIndex: 0,
        reason: "Choose the smallest reversible evidence step"
      },
      provider: "deterministic-fake",
      model: "fake-ceo",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      responseId: "fake-ceo-response",
      reservationCents: 0,
      costCents: 0
    };
  }
}

class BoundedInitiativeExecutor implements InitiativeExecutor {
  readonly provider = "deterministic-fake";
  calls = 0;

  constructor(
    readonly reservationCents: number,
    private readonly actualCostCents = reservationCents
  ) {}

  estimateExecutionReservation(): number {
    return this.reservationCents;
  }

  async execute(): Promise<InitiativeProviderResult> {
    this.calls += 1;
    const at = nowIso();
    return {
      artifact: {
        summary: "A bounded internal artifact was produced; no business outcome was verified.",
        findings: [{ statement: "The founder narrative remains a hypothesis", status: "hypothesis", supportingCitationUrls: [] }],
        unknowns: ["Authoritative buyer demand"],
        recommendedNextStep: "Seek authoritative evidence through a separately authorized path",
        businessOutcomeVerified: false
      },
      provider: this.provider,
      model: "fake-initiative-v1",
      responseId: `fake-initiative-${this.calls}`,
      citations: [],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      reservationCents: this.reservationCents,
      costCents: this.actualCostCents,
      startedAt: at,
      completedAt: at
    };
  }
}

async function bootstrapAndPlan(runtime: Awaited<ReturnType<typeof tempRuntime>>, key: string) {
  const boot = await runtime.service.execute("company.bootstrap", {
    idea: "A plain-language company that validates a painful workflow before building a product",
    owner: "founder",
    destination: "cash-flow",
    horizonDays: 30,
    budgetCents: 100,
    constraints: ["No external action without exact authority"],
    killConditions: ["Stop if the bounded evidence step is infeasible"],
    permissions: "Internal artifacts and public research only",
    requestedAt: nowIso(),
    idempotencyKey: `bootstrap-${key}`
  });
  expect(boot.ok, boot.error?.message).toBe(true);
  const ventureId = (boot.data as { ventureId: string }).ventureId;
  const run = await runtime.service.execute("company.run", { ventureId, requestedAt: nowIso(), idempotencyKey: `run-${key}` });
  expect(run.ok, run.error?.message).toBe(true);
  const cycle = await runtime.autonomy.runWorkerOnce(runtime.service.context.workspaceId, `ceo-${key}`);
  expect(cycle?.outcome, JSON.stringify(cycle)).toBe("selected");
  const taskId = (cycle as any).cycle.plannedTaskIds[0] as string;
  return { ventureId, taskId };
}

function proxyStorage(storage: KernelStorage, overrides: Partial<Record<keyof KernelStorage, (...args: any[]) => any>>): KernelStorage {
  return new Proxy(storage, {
    get(target, property) {
      const override = overrides[property as keyof KernelStorage];
      if (override) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

describe("kernel-native company initiative worker", () => {
  it("executes an exact task-bound initiative without Hermes and preserves truthful proof", async () => {
    const executor = new BoundedInitiativeExecutor(3, 2);
    const runtime = await tempRuntime({
      ceoExecutor: new SelectingCeo(),
      initiativeExecutor: executor,
      legacyDispatcher: "default"
    });
    try {
      const { ventureId, taskId } = await bootstrapAndPlan(runtime, "native-success");
      const task = runtime.storage.getTask(ventureId, taskId)!;
      expect(task).toMatchObject({ mode: "external", budgetCents: 3, costCeilingCents: 3 });
      expect(task.actionBounds).toMatchObject({
        executionClass: "initiative-execution",
        authorityDisposition: "internal-safe",
        capabilityId: "market-problem-research",
        capabilityVersion: "2026-07-20.1",
        evidencePrerequisites: ["company-bootstrap"],
        initiativeProvider: executor.provider,
        initiativeModelCostCeilingCents: 3
      });

      const result = await runtime.initiativeWorker.runOnce(runtime.service.context.workspaceId);
      expect(result).toMatchObject({ taskId, outcome: "success", proofTier: "fixture-verified", businessOutcomeVerified: false });
      expect(executor.calls).toBe(1);
      const receipts = runtime.storage.listReceipts(ventureId).filter((receipt) => receipt.taskId === taskId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ proofTier: "fixture-verified", origin: "fixture", metadata: { capabilityId: "market-problem-research", businessOutcomeVerified: false, externalActions: 0 } });
      const evidence = runtime.storage.listEvidence(ventureId).find((item) => item.sourceRef === receipts[0]!.id);
      expect(evidence).toMatchObject({ authority: "fixture", proofTier: "fixture-verified", metadata: { capabilityId: "market-problem-research", businessOutcomeVerified: false } });
      expect(await new SqliteKernelStorage(runtime.storage).getEntitlement(runtime.service.context.workspaceId, ventureId)).toMatchObject({
        spentCostCents: 2,
        reservedCostCents: 0
      });
      expect(await runtime.autonomy.scheduleDue(runtime.service.context.workspaceId, nowIso())).toBe(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("replays a committed effect after restart without a duplicate provider call", async () => {
    const executor = new BoundedInitiativeExecutor(3, 2);
    const runtime = await tempRuntime({ ceoExecutor: new SelectingCeo(), initiativeExecutor: executor });
    try {
      const { ventureId, taskId } = await bootstrapAndPlan(runtime, "effect-replay");
      const kernel = new SqliteKernelStorage(runtime.storage);
      let failReceiptOnce = true;
      const flaky = proxyStorage(kernel, {
        async appendReceipt(...args: Parameters<KernelStorage["appendReceipt"]>) {
          if (failReceiptOnce) {
            failReceiptOnce = false;
            throw new Error("simulated crash after committed effect");
          }
          return kernel.appendReceipt(...args);
        }
      });
      const first = await new CompanyInitiativeWorker(flaky, executor, "initiative-before-restart").runOnce(runtime.service.context.workspaceId);
      expect(first).toMatchObject({ taskId, outcome: "retry", error: "simulated crash after committed effect" });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const replay = await new CompanyInitiativeWorker(kernel, executor, "initiative-after-restart").runOnce(runtime.service.context.workspaceId);
      expect(replay).toMatchObject({ taskId, outcome: "success" });
      expect(executor.calls).toBe(1);
      expect(runtime.storage.listReceipts(ventureId).filter((receipt) => receipt.taskId === taskId)).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rechecks the kill switch after effect reservation and before the executor call", async () => {
    const executor = new BoundedInitiativeExecutor(3, 2);
    const runtime = await tempRuntime({ ceoExecutor: new SelectingCeo(), initiativeExecutor: executor });
    try {
      const { ventureId, taskId } = await bootstrapAndPlan(runtime, "kill-race");
      const kernel = new SqliteKernelStorage(runtime.storage);
      let killed = false;
      const racing = proxyStorage(kernel, {
        async reserveEffect(...args: Parameters<KernelStorage["reserveEffect"]>) {
          const result = await kernel.reserveEffect(...args);
          if (result.reserved && !killed) {
            killed = true;
            runtime.storage.setKillSwitch(ventureId, true);
          }
          return result;
        }
      });
      const result = await new CompanyInitiativeWorker(racing, executor, "initiative-kill-race").runOnce(runtime.service.context.workspaceId);
      expect(result).toMatchObject({ taskId, outcome: "dead-letter", error: "kill switch active immediately before initiative effect" });
      expect(executor.calls).toBe(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("refuses zero or under-ceiling tasks before any provider call", async () => {
    const zeroRuntime = await tempRuntime({ ceoExecutor: new SelectingCeo() });
    const zeroExecutor = new BoundedInitiativeExecutor(3, 2);
    try {
      const { taskId } = await bootstrapAndPlan(zeroRuntime, "zero-ceiling");
      const result = await new CompanyInitiativeWorker(
        new SqliteKernelStorage(zeroRuntime.storage),
        zeroExecutor,
        "initiative-zero-ceiling"
      ).runOnce(zeroRuntime.service.context.workspaceId);
      expect(result).toMatchObject({ taskId, outcome: "dead-letter", error: "initiative provider reservation is not within the exact runtime-owned task ceiling and budget" });
      expect(zeroExecutor.calls).toBe(0);
    } finally {
      await zeroRuntime.cleanup();
    }

    const planningExecutor = new BoundedInitiativeExecutor(1, 1);
    const underRuntime = await tempRuntime({ ceoExecutor: new SelectingCeo(), initiativeExecutor: planningExecutor });
    const changedExecutor = new BoundedInitiativeExecutor(2, 1);
    try {
      const { taskId } = await bootstrapAndPlan(underRuntime, "under-ceiling");
      const result = await new CompanyInitiativeWorker(
        new SqliteKernelStorage(underRuntime.storage),
        changedExecutor,
        "initiative-under-ceiling"
      ).runOnce(underRuntime.service.context.workspaceId);
      expect(result).toMatchObject({ taskId, outcome: "dead-letter", error: "initiative provider reservation is not within the exact runtime-owned task ceiling and budget" });
      expect(changedExecutor.calls).toBe(0);
    } finally {
      await underRuntime.cleanup();
    }
  });

  it("rechecks all evidence immediately before the provider call, blocking material additions but tolerating wording noise", async () => {
    const materialExecutor = new BoundedInitiativeExecutor(3, 2);
    const materialRuntime = await tempRuntime({ ceoExecutor: new SelectingCeo(), initiativeExecutor: materialExecutor });
    try {
      const { ventureId, taskId } = await bootstrapAndPlan(materialRuntime, "material-evidence-race");
      const task = materialRuntime.storage.getTask(ventureId, taskId)!;
      expect(task.actionBounds.materialEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
      const kernel = new SqliteKernelStorage(materialRuntime.storage);
      let added = false;
      const racing = proxyStorage(kernel, {
        async reserveEffect(...args: Parameters<KernelStorage["reserveEffect"]>) {
          const result = await kernel.reserveEffect(...args);
          if (!added) {
            added = true;
            materialRuntime.storage.addEvidence({
              id: "evidence_material_after_effect_reservation",
              ventureId,
              type: "buyer-demand-observation",
              proofTier: "internally-live",
              authority: "customer",
              sourceRef: "customer://material-after-effect-reservation",
              observedAt: nowIso(),
              status: "current",
              contentHash: sha256("material-after-effect-reservation"),
              metadata: { materialFacts: { qualifiedBuyers: 1, willingnessToPay: true } }
            });
          }
          return result;
        }
      });
      const blocked = await new CompanyInitiativeWorker(racing, materialExecutor, "initiative-material-race").runOnce(
        materialRuntime.service.context.workspaceId
      );
      expect(blocked).toMatchObject({
        taskId,
        outcome: "dead-letter",
        error: "material company evidence changed after initiative planning; refusing the stale provider call"
      });
      expect(materialExecutor.calls).toBe(0);
    } finally {
      await materialRuntime.cleanup();
    }

    const noiseExecutor = new BoundedInitiativeExecutor(3, 2);
    const noiseRuntime = await tempRuntime({ ceoExecutor: new SelectingCeo(), initiativeExecutor: noiseExecutor });
    try {
      const { ventureId, taskId } = await bootstrapAndPlan(noiseRuntime, "wording-evidence-race");
      const kernel = new SqliteKernelStorage(noiseRuntime.storage);
      let added = false;
      const racing = proxyStorage(kernel, {
        async reserveEffect(...args: Parameters<KernelStorage["reserveEffect"]>) {
          const result = await kernel.reserveEffect(...args);
          if (!added) {
            added = true;
            noiseRuntime.storage.addEvidence({
              id: "evidence_wording_after_effect_reservation",
              ventureId,
              type: "wording-only-note",
              proofTier: "internally-live",
              authority: "customer",
              sourceRef: "customer://wording-after-effect-reservation",
              observedAt: nowIso(),
              status: "current",
              contentHash: sha256("same words in a different order"),
              metadata: { notes: "Only prose wording and order changed", display: { order: ["second", "first"] } }
            });
          }
          return result;
        }
      });
      const allowed = await new CompanyInitiativeWorker(racing, noiseExecutor, "initiative-wording-race").runOnce(
        noiseRuntime.service.context.workspaceId
      );
      expect(allowed).toMatchObject({ taskId, outcome: "success" });
      expect(noiseExecutor.calls).toBe(1);
    } finally {
      await noiseRuntime.cleanup();
    }
  });

  it("uses structured OpenAI output with provider-annotated public citations and usage", async () => {
    const citation = "https://example.test/research";
    const artifact = {
      summary: "Primary-source research produced an internal artifact only.",
      findings: [
        { statement: "A public source supports the bounded finding", status: "supported", supportingCitationUrls: [citation] },
        { statement: "An unannotated URL must not remain supported", status: "supported", supportingCitationUrls: ["https://example.test/unannotated"] }
      ],
      unknowns: ["Buyer willingness to pay"],
      recommendedNextStep: "Keep buyer demand unverified until an authoritative event exists",
      businessOutcomeVerified: false
    };
    let requestBody: any;
    const adapter = new OpenAIResponsesAdapter("test-key", {
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          id: "resp_initiative",
          model: "gpt-5.6-terra",
          output_text: JSON.stringify(artifact),
          output: [{ content: [{ type: "output_text", text: JSON.stringify(artifact), annotations: [{ type: "url_citation", url: citation, title: "Research" }] }] }],
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, output_tokens_details: { reasoning_tokens: 5 } }
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_initiative" } });
      }
    });
    const executor = new OpenAIInitiativeExecutor(adapter, {
      version: "test",
      inputUsdPerMillionTokens: 2.5,
      cachedInputUsdPerMillionTokens: 0.25,
      outputUsdPerMillionTokens: 15,
      longContextThresholdTokens: 272_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
      maxOutputTokens: 2_000,
      webSearchCostCents: 1
    });
    const observation = {
      company: { ventureId: "venture_openai" },
      task: {
        id: "task_openai",
        gateClass: "public-research-free",
        purpose: "Research a bounded public question",
        expectedOutcome: "Internal artifact",
        expectedProof: "Citations",
        actionBounds: { question: "What public evidence exists?" }
      },
      evidence: []
    } as unknown as InitiativeObservation;
    const result = await executor.execute(observation);
    expect(result).toMatchObject({ provider: "openai", responseId: "resp_initiative", citations: [{ url: citation }], usage: { reasoningTokens: 5 }, artifact: { businessOutcomeVerified: false } });
    expect(result.artifact.findings[1]).toMatchObject({ status: "unknown", supportingCitationUrls: [] });
    expect(result.costCents).toBeLessThanOrEqual(result.reservationCents);
    expect(requestBody.tools).toEqual([{ type: "web_search" }]);
    const providerSchema = JSON.stringify(requestBody.text.format.schema);
    expect(providerSchema).not.toMatch(/"(?:default|exclusiveMaximum|exclusiveMinimum|format|maxItems|maxLength|maximum|minItems|minLength|minimum|pattern|\$schema)"/);
  });
});
