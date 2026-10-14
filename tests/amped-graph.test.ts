import { afterEach, describe, expect, it } from "vitest";
import {
  AMPED_HELD_OUT_CASES_V1,
  canonicalize,
  makeId,
  nowIso,
  sha256,
  type AmpedGraphNode,
  type AmpedGraphRunVersion
} from "@amped-studio-os/contracts";
import { EngineStorage, KernelStorageAccessError, SqliteKernelStorage } from "@amped-studio-os/storage";
import {
  AmpedGraphError,
  AmpedGraphService,
  AmpedGraphWorker,
  CompanyCommandService,
  materialAmpedEvidenceHash,
  type AmpedNodeExecutor,
  type AmpedNodeOutput
} from "@amped-studio-os/domain";
import type { CompanyAutonomy } from "../packages/domain/src/autonomous.js";

const workspaceId = "workspace_amped_test";
const opened: EngineStorage[] = [];

class ScriptedExecutor implements AmpedNodeExecutor {
  readonly provider = "fixture-amped";
  readonly calls: string[] = [];
  readonly effects = new Map<string, AmpedNodeOutput>();
  verifierResearchCalls = 0;
  throwAfterEffectOnce = false;
  sharedActor?: string;

  selection(node: AmpedGraphNode, run: AmpedGraphRunVersion) {
    const role = node.role as "planner" | "specialist" | "verifier";
    return {
      choiceId: `choice_fixture_${role}`,
      actorId: this.sharedActor ?? `actor_${node.role}`,
      role,
      provider: this.provider,
      model: "fixture-deterministic",
      modelToolPolicy: run.versions.modelToolPolicy,
      evaluation: {
        id: `evaluation_fixture_amped_${role}`,
        version: 1,
        hash: sha256({ role, provider: "fixture-amped", suite: sha256(AMPED_HELD_OUT_CASES_V1) })
      },
      tools: ["fixture_tool"]
    };
  }

  estimateCostCents(node: AmpedGraphNode): number {
    return node.role === "human" ? 0 : 1;
  }

  async execute({ node, run }: { node: AmpedGraphNode; run: AmpedGraphRunVersion }): Promise<AmpedNodeOutput> {
    this.calls.push(`${run.bindings.companyId}:${node.id}`);
    const completedAt = new Date(Date.parse(run.createdAt) + 1_000).toISOString();
    const status = node.id === "verify_research" && this.verifierResearchCalls++ === 0 ? "disagreed" : "passed";
    const output: AmpedNodeOutput = {
      status,
      actorId: this.sharedActor ?? `actor_${node.role}`,
      summary: `${node.id} produced a bounded fixture result`,
      uncertainty: status === "disagreed" ? "medium" : "low",
      evidence: [{
        type: `proof_${node.id}`,
        statement: `${node.id} evidence for ${run.bindings.companyId}`,
        sourceRefs: [`fixture://${run.bindings.companyId}/${node.id}`]
      }],
      constraint: {
        statement: `${node.id} is the current bounded constraint`,
        evidenceRefs: [],
        status: status === "disagreed" ? "red" : "amber"
      },
      alternatives: node.role === "planner" ? [
        {
          initiative: node.id === "replan"
            ? "Validate the narrower ICP with three buyer interviews"
            : `Advance the bounded ${node.id} branch`,
          rationale: "This option follows current company-scoped evidence.",
          selected: true
        },
        {
          initiative: `Pause the ${node.id} branch`,
          rationale: "This option preserves prior truth if evidence weakens.",
          selected: false
        }
      ] : [],
      ...(node.id === "replan" ? { nextInitiative: "Validate the narrower ICP with three buyer interviews" } : {}),
      proofTier: "fixture-verified",
      costCents: 1,
      startedAt: run.activeNode!.startedAt,
      completedAt
    };
    const key = `amped-node:${run.bindings.companyId}:${run.id}:${run.activeNode!.activationId}`;
    this.effects.set(key, output);
    if (this.throwAfterEffectOnce) {
      this.throwAfterEffectOnce = false;
      throw new Error("fixture timeout after provider accepted request");
    }
    return output;
  }

  async reconcile({ providerIdempotencyKey }: { providerIdempotencyKey: string }): Promise<AmpedNodeOutput | null> {
    return this.effects.get(providerIdempotencyKey) ?? null;
  }
}

function kernel(): SqliteKernelStorage {
  const engine = new EngineStorage(":memory:");
  opened.push(engine);
  return new SqliteKernelStorage(engine);
}

async function company(storage: SqliteKernelStorage, companyId: string): Promise<void> {
  const at = nowIso();
  await storage.ensureWorkspace(workspaceId);
  await storage.createCompany({
    workspaceId,
    companyId,
    slug: companyId,
    name: companyId,
    owner: "fixture-founder",
    owningRepo: `fixture/${companyId}`,
    lifecycleState: "candidate",
    state: { bootstrap: { digest: sha256(companyId) }, runState: "idle", lifecycleState: "candidate" },
    createdAt: at,
    updatedAt: at
  });
  await storage.putEntitlement({
    workspaceId,
    companyId,
    status: "active",
    plan: "test:amped",
    periodStart: at,
    periodEnd: "2099-01-01T00:00:00.000Z",
    modelCostCapCents: 10_000,
    providerEventId: `entitlement_${companyId}`,
    providerOrder: 1,
    observedAt: at
  });
}

/** Same fixture company, but bootstrapped with a self-serve operating envelope. */
async function selfServeCompany(
  storage: SqliteKernelStorage,
  companyId: string,
  envelope: Record<string, unknown>
): Promise<void> {
  const at = nowIso();
  await storage.ensureWorkspace(workspaceId);
  await storage.createCompany({
    workspaceId,
    companyId,
    slug: companyId,
    name: companyId,
    owner: "fixture-founder",
    owningRepo: `fixture/${companyId}`,
    lifecycleState: "candidate",
    state: {
      bootstrap: { digest: sha256(companyId), snapshot: { operatingEnvelope: envelope } },
      runState: "idle",
      lifecycleState: "candidate"
    },
    createdAt: at,
    updatedAt: at
  });
  await storage.putEntitlement({
    workspaceId,
    companyId,
    status: "active",
    plan: "selfserve:monthly",
    periodStart: at,
    periodEnd: "2099-01-01T00:00:00.000Z",
    modelCostCapCents: 10_000,
    providerEventId: `entitlement_${companyId}`,
    providerOrder: 1,
    observedAt: at
  });
}

async function runToHuman(storage: SqliteKernelStorage, worker: AmpedGraphWorker, runId: string, companyId: string) {
  for (let count = 0; count < 20; count += 1) {
    const current = (await new AmpedGraphService(storage).get(workspaceId, companyId, runId)).run;
    if (current.state === "waiting-human") return current;
    await worker.runOnce(workspaceId);
  }
  const detail = await new AmpedGraphService(storage).get(workspaceId, companyId, runId);
  throw new Error(`graph did not reach the founder gate: ${canonicalize({
    run: detail.run,
    jobs: await storage.listJobs(workspaceId, companyId, { limit: 50 })
  })}`);
}

async function approveAndFinish(storage: SqliteKernelStorage, worker: AmpedGraphWorker, runId: string, companyId: string) {
  const approval = (await storage.listPendingApprovals(workspaceId, companyId))[0]!;
  await storage.resolveApproval({
    workspaceId,
    companyId,
    approvalId: approval.id,
    expectedActionDigest: approval.actionDigest,
    resolution: "approved",
    resolutionId: makeId("resolution", { approvalId: approval.id }),
    actor: "fixture-founder",
    resolvedAt: nowIso()
  });
  for (let count = 0; count < 10; count += 1) {
    const current = (await new AmpedGraphService(storage).get(workspaceId, companyId, runId)).run;
    if (current.state === "completed") return current;
    await worker.runOnce(workspaceId);
  }
  throw new Error("graph did not complete after founder approval");
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

describe("Amped graph production harness", () => {
  it("treats ordering, duplicate records, ids, and observation timestamps as non-material", () => {
    const fact = {
      ventureId: "venture_amped_material",
      type: "buyer_signal",
      proofTier: "internally-live" as const,
      authority: "customer" as const,
      sourceRef: "provider://buyer/interview",
      status: "current" as const,
      contentHash: sha256({ buyer: "ICP-A", outcome: "rejected" }),
      metadata: {}
    };
    const first = { ...fact, id: "evidence_material_a", observedAt: "2026-07-27T12:00:00.000Z" };
    const duplicate = { ...fact, id: "evidence_material_b", observedAt: "2026-07-27T13:00:00.000Z" };
    expect(materialAmpedEvidenceHash([first, duplicate])).toBe(materialAmpedEvidenceHash([duplicate]));
    expect(materialAmpedEvidenceHash([first])).not.toBe(materialAmpedEvidenceHash([{
      ...duplicate,
      contentHash: sha256({ buyer: "ICP-B", outcome: "accepted" })
    }]));
  });

  it("runs the hierarchy through disagreement, restart, exact human approval, material replan, replay, and shadow without repeat effects", async () => {
    const storage = kernel();
    const companyId = "venture_amped_alpha";
    await company(storage, companyId);
    const executor = new ScriptedExecutor();
    const service = new AmpedGraphService(storage);
    const api = new CompanyCommandService(storage, {} as CompanyAutonomy, service);
    const response = await api.execute(workspaceId, "amped.start", {
      ventureId: companyId,
      requestedAt: nowIso(),
      idempotencyKey: "amped-alpha-first-run"
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const started = response.data as Awaited<ReturnType<AmpedGraphService["start"]>>;

    await new AmpedGraphWorker(storage, executor, "worker-before-restart").runOnce(workspaceId);
    const waiting = await runToHuman(storage, new AmpedGraphWorker(storage, executor, "worker-after-restart"), started.run.id, companyId);
    expect(waiting.activeNode?.node.id).toBe("founder_gate");
    expect(executor.calls.filter((call) => call.endsWith(":verify_research"))).toHaveLength(2);

    const completed = await approveAndFinish(storage, new AmpedGraphWorker(storage, executor, "worker-after-approval"), started.run.id, companyId);
    const detail = await service.get(workspaceId, companyId, started.run.id);
    expect(completed.bindings.initiativeId).not.toBe("initiative_current");
    expect(detail.run.state).toBe("completed");
    expect(new Set(detail.graph.nodes.map((node) => node.hierarchy))).toEqual(new Set([
      "portfolio",
      "company",
      "initiative",
      "node-harness",
      "studio-learning"
    ]));
    expect(detail.graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "observe",
      "research",
      "choose",
      "offer",
      "verify_offer",
      "learn",
      "replan"
    ]));
    expect(detail.teaching).toHaveLength(detail.traces.length);
    expect(detail.traces.filter((trace) => trace.versions.activeNode.id.startsWith("verify_"))
      .every((trace) => Boolean(trace.identity.parentTraceId))).toBe(true);
    expect(detail.teaching.every((record) => [
      record.why_now,
      record.founder_lesson,
      record.agent_work,
      record.founder_action,
      record.evidence_required,
      record.success_signal,
      record.failure_signal,
      record.reflection,
      record.what_changed,
      record.next_gate
    ].every(Boolean))).toBe(true);
    const durableReceiptIds = new Set((await storage.listReceipts(workspaceId, companyId)).map((receipt) => receipt.id));
    const durableEvidenceIds = new Set((await storage.listEvidence(workspaceId, companyId)).map((evidence) => evidence.id));
    expect(detail.traces.flatMap((trace) => trace.bindings.receiptIds).filter((id) => !durableReceiptIds.has(id))).toEqual([]);
    expect(detail.traces.flatMap((trace) => trace.bindings.evidenceIds).filter((id) => !durableEvidenceIds.has(id))).toEqual([]);
    const effectsBeforeReplay = ((await storage.exportCompany(workspaceId, companyId)).tables.effect_reservations ?? []).length;
    const replay = await service.replay(workspaceId, companyId, started.run.id, "replay", nowIso());
    const shadow = await service.replay(workspaceId, companyId, started.run.id, "shadow", nowIso(), {
      id: "harness_candidate",
      version: 2,
      hash: sha256("candidate")
    });
    const replayAgain = await service.replay(workspaceId, companyId, started.run.id, "replay", nowIso());
    expect(replayAgain.hash).toBe(replay.hash);
    expect(replay.replay).toMatchObject({ mode: "replay", noExternalEffects: true, sourceRunId: started.run.id });
    expect(shadow.replay).toMatchObject({ mode: "shadow", noExternalEffects: true, sourceRunId: started.run.id });
    expect((await service.get(workspaceId, companyId, replay.id)).traces).toHaveLength(detail.traces.length);
    expect((await service.get(workspaceId, companyId, shadow.id)).traces.every((trace) => (
      trace.replay.noExternalEffects && trace.effectKeys.length === 0 && trace.costCents === 0
    ))).toBe(true);
    const harness = await storage.getAmpedRecord(workspaceId, companyId, "harness", "harness_amped", 1);
    expect(harness?.record).toMatchObject({
      retention: { traceDays: 90, teachingDays: 365, rawPromptStored: false },
      runtime: { partitionKey: "company_id", fullPortfolioScanAllowed: false },
      scaleInvariants: { capacityClaimAllowed: false }
    });
    const telemetry = await storage.listAmpedRecords(workspaceId, companyId, "telemetry", started.run.id);
    expect(telemetry.some((record) => (
      typeof (record.record as Record<string, unknown>).queueLagMs === "number"
      && typeof (record.record as Record<string, unknown>).transitionLatencyMs === "number"
      && typeof (record.record as Record<string, unknown>).evidenceConversion === "number"
    ))).toBe(true);
    expect((await storage.exportCompany(workspaceId, companyId)).tables.effect_reservations).toHaveLength(effectsBeforeReplay);
  });

  it("reconciles an uncertain provider result without executing the effect twice", async () => {
    const storage = kernel();
    const companyId = "venture_amped_reconcile";
    await company(storage, companyId);
    const executor = new ScriptedExecutor();
    executor.throwAfterEffectOnce = true;
    const started = await new AmpedGraphService(storage).start({
      workspaceId,
      companyId,
      requestedAt: nowIso(),
      idempotencyKey: "amped-reconcile-run"
    });
    const worker = new AmpedGraphWorker(storage, executor, "worker-reconcile");
    await expect(worker.runOnce(workspaceId)).rejects.toMatchObject({ code: "effect-reconciliation-required" });
    expect((await new AmpedGraphService(storage).get(workspaceId, companyId, started.run.id)).run.state).toBe("waiting-reconciliation");
    expect(executor.calls).toHaveLength(1);
    await worker.runOnce(workspaceId);
    expect(executor.calls).toHaveLength(1);
    expect((await storage.exportCompany(workspaceId, companyId)).tables.effect_reservations).toEqual([
      expect.objectContaining({ status: "committed" })
    ]);
  });

  it("repairs a crash after committing the next run version before scheduling its task", async () => {
    const storage = kernel();
    const companyId = "venture_amped_restart_seam";
    await company(storage, companyId);
    const service = new AmpedGraphService(storage);
    await service.start({ workspaceId, companyId, requestedAt: nowIso(), idempotencyKey: "amped-restart-seam" });
    const append = storage.appendAmpedRecord.bind(storage);
    let crashed = false;
    storage.appendAmpedRecord = async (record) => {
      const result = await append(record);
      if (!crashed && record.kind === "run" && record.version === 2) {
        crashed = true;
        throw new Error("fixture crash after next run commit");
      }
      return result;
    };
    const executor = new ScriptedExecutor();
    const worker = new AmpedGraphWorker(storage, executor, "worker-restart-seam");
    await expect(worker.runOnce(workspaceId)).rejects.toThrow("fixture crash");
    expect(executor.calls).toHaveLength(1);
    expect(await worker.runOnce(workspaceId)).toMatchObject({ outcome: "stale-idempotent", runVersion: 2 });
    await worker.runOnce(workspaceId);
    expect(executor.calls).toHaveLength(2);
    expect((await storage.listJobs(workspaceId, companyId, { limit: 20 })).filter((job) => job.status === "dead-letter")).toEqual([]);
  });

  it("keeps two companies isolated under concurrent scheduling and company kill", async () => {
    const storage = kernel();
    const alpha = "venture_amped_concurrent_alpha";
    const beta = "venture_amped_concurrent_beta";
    await Promise.all([company(storage, alpha), company(storage, beta)]);
    const service = new AmpedGraphService(storage);
    const [runA, runB] = await Promise.all([
      service.start({ workspaceId, companyId: alpha, requestedAt: nowIso(), idempotencyKey: "concurrent-alpha" }),
      service.start({ workspaceId, companyId: beta, requestedAt: nowIso(), idempotencyKey: "concurrent-beta" })
    ]);
    await storage.setKillSwitch(workspaceId, beta, true);
    const executor = new ScriptedExecutor();
    executor.throwAfterEffectOnce = true;
    const workers = [
      new AmpedGraphWorker(storage, executor, "worker-concurrent-a"),
      new AmpedGraphWorker(storage, executor, "worker-concurrent-b")
    ];
    const firstPass = await Promise.allSettled(workers.map((worker) => worker.runOnce(workspaceId)));
    expect(firstPass.filter((result) => result.status === "rejected")).toHaveLength(1);
    await new AmpedGraphWorker(storage, executor, "worker-concurrent-recovery").runOnce(workspaceId);
    expect((await service.get(workspaceId, beta, runB.run.id)).run.state).toBe("killed");
    expect((await service.get(workspaceId, alpha, runA.run.id)).run.state).toBe("running");
    expect(executor.calls.some((call) => call.startsWith(`${beta}:`))).toBe(false);
    expect(executor.calls.filter((call) => call.startsWith(`${alpha}:`))).toHaveLength(1);
    await expect(service.get("workspace_other", alpha, runA.run.id)).rejects.toBeInstanceOf(KernelStorageAccessError);
    const alphaExport = canonicalize(await storage.exportCompany(workspaceId, alpha));
    const betaExport = canonicalize(await storage.exportCompany(workspaceId, beta));
    expect(alphaExport).not.toContain(beta);
    expect(betaExport).not.toContain(alpha);
    expect(((await storage.exportCompany(workspaceId, alpha)).tables.effect_reservations ?? [])).toEqual([
      expect.objectContaining({ status: "committed" })
    ]);
    expect(((await storage.exportCompany(workspaceId, beta)).tables.effect_reservations ?? [])).toEqual([]);
    expect(await storage.getEntitlement(workspaceId, alpha)).toMatchObject({ spentCostCents: 1, reservedCostCents: 0 });
    expect(await storage.getEntitlement(workspaceId, beta)).toMatchObject({ spentCostCents: 0, reservedCostCents: 0 });
  });

  it("rejects producer self-verification and over-budget execution", async () => {
    const storage = kernel();
    const companyId = "venture_amped_adversarial";
    await company(storage, companyId);
    const executor = new ScriptedExecutor();
    executor.sharedActor = "actor_shared";
    const started = await new AmpedGraphService(storage).start({
      workspaceId,
      companyId,
      requestedAt: nowIso(),
      idempotencyKey: "amped-self-review"
    });
    const worker = new AmpedGraphWorker(storage, executor, "worker-adversarial");
    await worker.runOnce(workspaceId);
    await worker.runOnce(workspaceId);
    await worker.runOnce(workspaceId);
    await expect(worker.runOnce(workspaceId)).rejects.toMatchObject({ code: "verifier-disagreement" });
    expect((await new AmpedGraphService(storage).get(workspaceId, companyId, started.run.id)).run.state).toBe("failed");

    const storageBudget = kernel();
    const budgetCompany = "venture_amped_budget";
    await company(storageBudget, budgetCompany);
    const overBudget = new ScriptedExecutor();
    overBudget.estimateCostCents = () => 501;
    await new AmpedGraphService(storageBudget).start({
      workspaceId,
      companyId: budgetCompany,
      requestedAt: nowIso(),
      idempotencyKey: "amped-over-budget"
    });
    await expect(new AmpedGraphWorker(storageBudget, overBudget, "worker-budget").runOnce(workspaceId))
      .rejects.toMatchObject({ code: "budget-exhausted" });
    expect(overBudget.calls).toHaveLength(0);
    const budgetRun = (await storageBudget.listAmpedRecords(workspaceId, budgetCompany, "run"))[0]!;
    expect((await new AmpedGraphService(storageBudget).get(workspaceId, budgetCompany, budgetRun.id)).run.state).toBe("failed");
  });

  it("fails closed at per-company backpressure and circuit-breaker limits", async () => {
    const storage = kernel();
    const companyId = "venture_amped_limits";
    await company(storage, companyId);
    const service = new AmpedGraphService(storage);
    const job = (index: number, status: "queued" | "dead-letter") => ({
      id: `job_limit_${index}`,
      taskId: `task_limit_${index}`,
      kind: "amped-node",
      status,
      attemptCount: 1,
      availableAt: "2026-07-27T12:00:00.000Z",
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
      ...(status === "dead-letter" ? { error: { redacted: true as const, at: "2026-07-27T12:00:00.000Z" } } : {})
    });
    storage.listJobs = async () => Array.from({ length: 100 }, (_, index) => job(index, "queued"));
    await expect(service.start({
      workspaceId,
      companyId,
      requestedAt: nowIso(),
      idempotencyKey: "amped-backpressure"
    })).rejects.toMatchObject({ code: "backpressure" });
    storage.listJobs = async () => Array.from({ length: 5 }, (_, index) => job(index, "dead-letter"));
    await expect(service.start({
      workspaceId,
      companyId,
      requestedAt: nowIso(),
      idempotencyKey: "amped-circuit"
    })).rejects.toMatchObject({ code: "circuit-open" });
    expect(await storage.listAmpedRecords(workspaceId, companyId, "run")).toEqual([]);
  });

  it("independently scores five frozen teaching cases and proves candidate promotion plus rollback", async () => {
    const storage = kernel();
    const companyId = "venture_amped_learning";
    const secondCompanyId = "venture_amped_learning_beta";
    await Promise.all([company(storage, companyId), company(storage, secondCompanyId)]);
    const service = new AmpedGraphService(storage);
    const at = nowIso();
    const evaluationCore = {
      schemaVersion: "amped-teaching-evaluation-v1" as const,
      version: { id: "evaluation_amped_teaching", version: 1 },
      suiteHash: sha256(AMPED_HELD_OUT_CASES_V1),
      baseline: { id: "harness_baseline", version: 1, hash: sha256("baseline") },
      candidate: { id: "harness_candidate", version: 2, hash: sha256("candidate") },
      evaluatorId: "evaluator_independent",
      reviewerId: "reviewer_independent",
      evaluatorReceiptId: "receipt_teaching_evaluator",
      reviewerReceiptId: "receipt_teaching_reviewer",
      companyIds: [companyId, secondCompanyId],
      blindComparisonRequired: true as const,
      scores: AMPED_HELD_OUT_CASES_V1.slice(0, 5).map((testCase) => ({
        caseId: testCase.id,
        rubric: {
          correctConstraintEvidenceGate: 2,
          companyGrounding: 2,
          founderAgentSplit: 2,
          calibratedUncertainty: 1,
          actionableProofReflection: 2
        },
        total: 9,
        passed: true,
        rationale: "Independent fixture evaluation found correct grounding, gates, role split, uncertainty, and next proof."
      })),
      passed: true,
      createdAt: at
    };
    const evaluation = {
      ...evaluationCore,
      version: { ...evaluationCore.version, hash: sha256(evaluationCore) }
    };
    for (const [id, actor, role] of [
      [evaluation.evaluatorReceiptId, evaluation.evaluatorId, "evaluator"],
      [evaluation.reviewerReceiptId, evaluation.reviewerId, "reviewer"]
    ] as const) {
      await storage.appendReceipt(workspaceId, {
        id,
        ventureId: companyId,
        proofTier: "fixture-verified",
        outcome: "success",
        actor,
        adapter: "amped-teaching-evaluation",
        artifactPath: `engine://amped/evaluation/${id}`,
        contentHash: sha256({ id, scores: evaluation.scores }),
        occurredAt: at,
        metadata: {
          role,
          suiteHash: evaluation.suiteHash,
          candidateHash: evaluation.candidate.hash
        },
        origin: "fixture"
      });
    }
    expect((await service.recordTeachingEvaluation(workspaceId, companyId, evaluation)).created).toBe(true);

    for (const [id, outcome] of [
      ["receipt_playbook_canary", "success"],
      ["receipt_playbook_promote", "success"],
      ["receipt_playbook_rollback", "success"]
    ] as const) {
      await storage.appendReceipt(workspaceId, {
        id,
        ventureId: companyId,
        proofTier: "fixture-verified",
        outcome,
        actor: "reviewer-independent",
        adapter: "amped-playbook-evaluation",
        artifactPath: `engine://amped/playbook/${id}`,
        contentHash: sha256(id),
        occurredAt: at,
        metadata: { deidentified: true, rightsSafe: true },
        origin: "fixture"
      });
    }
    const shared = {
      schemaVersion: "amped-playbook-v1" as const,
      owner: "Amped Ventures",
      scope: "studio-general" as const,
      sourceRefs: ["engine://amped/evaluation/evaluation_amped_teaching"],
      rightsSafe: true,
      deidentified: true,
      lifecycleStages: ["candidate"],
      preconditions: ["Current company evidence is present"],
      instructions: ["Name the highest constraint before proposing work"],
      antiPatterns: ["Do not treat agent output as buyer proof"],
      expectedEvidence: ["buyer_signal"],
      teachingNotes: ["Separate founder judgment from bounded agent work"],
      createdAt: at
    };
    const candidateCore = {
      ...shared,
      version: { id: "playbook_amped_constraint", version: 1 },
      evaluations: [],
      state: "candidate" as const
    };
    const candidate = {
      ...candidateCore,
      version: { ...candidateCore.version, hash: sha256(candidateCore) }
    };
    await service.recordPlaybook(workspaceId, companyId, candidate);

    const promotedCore = {
      ...shared,
      version: { id: candidate.version.id, version: 2 },
      evaluations: [evaluation.version],
      state: "promoted" as const,
      canaryReceiptId: "receipt_playbook_canary",
      dispositionReceiptId: "receipt_playbook_promote"
    };
    const promoted = {
      ...promotedCore,
      version: { ...promotedCore.version, hash: sha256(promotedCore) }
    };
    expect((await service.recordPlaybook(workspaceId, companyId, promoted)).pack.state).toBe("promoted");

    const rolledBackCore = {
      ...shared,
      version: { id: candidate.version.id, version: 3 },
      evaluations: [evaluation.version],
      state: "rolled-back" as const,
      dispositionReceiptId: "receipt_playbook_rollback",
      rollbackTo: candidate.version
    };
    const rolledBack = {
      ...rolledBackCore,
      version: { ...rolledBackCore.version, hash: sha256(rolledBackCore) }
    };
    expect((await service.recordPlaybook(workspaceId, companyId, rolledBack)).pack.state).toBe("rolled-back");
    await expect(service.recordPlaybook(workspaceId, companyId, {
      ...promoted,
      version: { ...promoted.version, id: "playbook_missing_proof", hash: sha256("invalid") },
      canaryReceiptId: "receipt_absent"
    })).rejects.toBeInstanceOf(AmpedGraphError);
  });
});

describe("self-serve bounded autonomy through a real graph run", () => {
  it("clears the founder gate with no human when the packet is inside the envelope, and stops when it is not", async () => {
    const inside = kernel();
    const companyId = "venture_selfserve_inside";
    await selfServeCompany(inside, companyId, {
      modelBudgetCents: 10_000,
      dailyActionCap: 0,
      weeklyActionCap: 0,
      publicationAllowed: false
    });
    const service = new AmpedGraphService(inside);
    const api = new CompanyCommandService(inside, {} as CompanyAutonomy, service);
    const started = await api.execute(workspaceId, "amped.start", {
      ventureId: companyId,
      requestedAt: nowIso(),
      idempotencyKey: "selfserve-inside"
    });
    if (!started.ok) throw new Error(started.error.message);
    const run = (started.data as Awaited<ReturnType<AmpedGraphService["start"]>>).run;

    // No human ever resolves anything here. If bounded autonomy did not fire, the run parks at
    // `waiting-human` forever and this loop ends without completing.
    const worker = new AmpedGraphWorker(inside, new ScriptedExecutor(), "worker-selfserve-inside");
    let state = "";
    for (let count = 0; count < 40; count += 1) {
      state = (await service.get(workspaceId, companyId, run.id)).run.state;
      if (state === "completed") break;
      await worker.runOnce(workspaceId);
    }
    expect(state).toBe("completed");
    expect(await inside.listPendingApprovals(workspaceId, companyId)).toHaveLength(0);

    // Same graph, same packet, an envelope that has lapsed: the gate must hold.
    const outside = kernel();
    const strictId = "venture_selfserve_outside";
    await selfServeCompany(outside, strictId, {
      modelBudgetCents: 10_000,
      dailyActionCap: 0,
      weeklyActionCap: 0,
      publicationAllowed: false,
      expiresAt: "2020-01-01T00:00:00.000Z"
    });
    const strictService = new AmpedGraphService(outside);
    const strictApi = new CompanyCommandService(outside, {} as CompanyAutonomy, strictService);
    const strictStarted = await strictApi.execute(workspaceId, "amped.start", {
      ventureId: strictId,
      requestedAt: nowIso(),
      idempotencyKey: "selfserve-outside"
    });
    if (!strictStarted.ok) throw new Error(strictStarted.error.message);
    const strictRun = (strictStarted.data as Awaited<ReturnType<AmpedGraphService["start"]>>).run;
    const strictWorker = new AmpedGraphWorker(outside, new ScriptedExecutor(), "worker-selfserve-outside");
    const waiting = await runToHuman(outside, strictWorker, strictRun.id, strictId);
    expect(waiting.activeNode?.node.id).toBe("founder_gate");
    expect(await outside.listPendingApprovals(workspaceId, strictId)).toHaveLength(1);
  }, 30_000);
});
