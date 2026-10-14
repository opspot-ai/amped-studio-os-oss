import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EvaluationContractInputSchema,
  ExperimentRecordInputSchema,
  GoalChangeInputSchema,
  GoalConfirmChangeInputSchema,
  ReceiptSchema,
  SkillVersionInputSchema,
  TaskDefinitionSchema,
  sha256,
  type CommandResponse,
  type DispatchResult,
  type EvaluationContract,
  type EvaluationInputManifest,
  type GoalRevision,
  type Receipt,
  type SkillVersion,
  type TaskDefinition
} from "@amped-studio-os/contracts";
import { buildSpecialistWorkItem, specialistCitations } from "@amped-studio-os/adapters";
import type { DispatchContext, RoleDispatcher } from "@amped-studio-os/dispatch";
import { createDefaultRuntime, EngineService, EngineWorker } from "@amped-studio-os/domain";
import { tempRuntime } from "./helpers.js";

const VENTURE_ID = "venture_example_a";
const CASE_ID = "case_evaluation_task_001";
const CASE_RECEIPT_ID = "receipt_evaluation_case_001";
const BASELINE_RECEIPT_ID = "receipt_evaluation_baseline";
const PLAIN_RECEIPT_ID = "receipt_evaluation_plain";
const NO_HISTORY_RECEIPT_ID = "receipt_evaluation_no_history";
const execFile = promisify(execFileCallback);

type Runtime = Awaited<ReturnType<typeof tempRuntime>>;

async function persistentRuntime(): Promise<Runtime & { databasePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cle-evaluation-cli-"));
  await cp(path.join(process.cwd(), "ventures"), path.join(root, "ventures"), { recursive: true });
  const databasePath = path.join(root, "data", "engine.db");
  const runtime = createDefaultRuntime({
    root,
    databasePath,
    dispatcher: "fixture",
    fetchImpl: async (input) => new Response(`<html><title>${String(input)}</title></html>`, { status: 200 })
  });
  return {
    ...runtime,
    root,
    databasePath,
    async loadPacks() {
      for (const relative of ["ventures/example-a/pack.yaml", "ventures/example-c/pack.yaml"]) {
        const result = await runtime.service.execute("venture.create_or_update_pack", { packPath: path.join(root, relative) });
        if (!result.ok) throw new Error(result.error?.message);
      }
    },
    async cleanup() {
      runtime.storage.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function expectOk<T>(response: CommandResponse): T {
  expect(response.ok, response.error?.message).toBe(true);
  return response.data as T;
}

function rawHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeArtifact(runtime: Runtime, relativePath: string, bytes: Uint8Array | string): Promise<{ path: string; hash: string }> {
  const absolutePath = path.join(runtime.root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  return { path: absolutePath, hash: rawHash(await readFile(absolutePath)) };
}

async function attachArtifactReceipt(
  runtime: Runtime,
  id: string,
  receiptType: string,
  metadata: Record<string, unknown> = {}
): Promise<Receipt> {
  const artifact = await writeArtifact(
    runtime,
    `evaluation-fixtures/${id}.json`,
    `${JSON.stringify({ id, receiptType, metadata }, null, 2)}\n`
  );
  const receipt = ReceiptSchema.parse({
    id,
    ventureId: VENTURE_ID,
    proofTier: "internally-live",
    outcome: "success",
    actor: "evaluation-fixture-seeder",
    adapter: "evaluation-fixture-seeder",
    artifactPath: artifact.path,
    contentHash: artifact.hash,
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    metadata: {
      receiptType,
      engineStamped: true,
      baselineTrust: "engine-internal-test",
      promotionEligible: true,
      trustModel: "single-operator-local",
      customerSafe: false,
      ...metadata
    },
    origin: "engine-derived"
  });
  runtime.storage.attachReceipt(receipt);
  return receipt;
}

async function confirmedGoal(runtime: Runtime): Promise<GoalRevision> {
  const requestedAt = new Date(Date.now() - 30_000).toISOString();
  const input = GoalChangeInputSchema.parse({
    ventureId: VENTURE_ID,
    destination: "growth",
    target: "Prove one bounded evaluator path",
    horizon: "7 days",
    constraints: ["No external action"],
    successConditions: ["One engine-bound score and independent review"],
    killConditions: ["Any venture or network scope leak"],
    reason: "Exercise the product through its own frozen evaluation contract",
    requestedBy: "founder",
    requestedAt,
    idempotencyKey: "goal-evaluation-task-v1"
  });
  const preview = expectOk<{ previewId: string; previewHash: string }>(
    await runtime.service.execute("goal.preview_change", input)
  );
  expectOk(
    await runtime.service.execute(
      "goal.confirm_change",
      GoalConfirmChangeInputSchema.parse({
        ...input,
        founderConfirmation: {
          previewId: preview.previewId,
          previewHash: preview.previewHash,
          confirmedBy: "founder",
          authority: "Bounded test confirmation",
          confirmedAt: new Date().toISOString()
        }
      })
    )
  );
  const goal = runtime.storage.getLatestGoalRevision(VENTURE_ID);
  if (!goal) throw new Error("goal was not persisted");
  return goal;
}

interface EvaluationScenario {
  evaluation: EvaluationContract;
  skill: SkillVersion;
  candidatePath: string;
  baselinePath: string;
  casePath: string;
}

async function evaluationScenario(
  runtime: Runtime,
  unknownBaselineCosts = false,
  options: {
    populationKind?: "frozen-cases" | "hidden-held-out";
    candidateRelativePath?: string;
    candidateBytes?: Uint8Array | string;
    allowedGateClasses?: Array<"safe-internal-read-only">;
    manualBaselines?: boolean;
  } = {}
): Promise<EvaluationScenario> {
  await runtime.loadPacks();
  const goal = await confirmedGoal(runtime);
  let baseline: Receipt;
  let plainBaseline: Receipt;
  let noHistoryBaseline: Receipt;
  if (options.manualBaselines) {
    const capture = async (
      id: string,
      receiptType: "baseline" | "plain-agent-baseline" | "no-history-baseline",
      primaryMetricValue?: number
    ): Promise<Receipt> => {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(id)]);
      const artifact = await writeArtifact(runtime, `receipts/manual/${id}.png`, bytes);
      return expectOk<{ record: Receipt }>(
        await runtime.service.execute("evaluation.baseline.capture", {
          ventureId: VENTURE_ID,
          receiptType,
          artifactPath: artifact.path,
          contentHash: artifact.hash,
          ...(primaryMetricValue === undefined ? {} : { primaryMetricValue }),
          ...(unknownBaselineCosts
            ? {}
            : { costCents: 50, founderMinutes: 0, complexityUnits: 100 }),
          capturedBy: "founder",
          requestedAt: new Date().toISOString(),
          idempotencyKey: `capture-${id}-v1`
        })
      ).record;
    };
    baseline = await capture(BASELINE_RECEIPT_ID, "baseline", 0.7);
    plainBaseline = await capture(PLAIN_RECEIPT_ID, "plain-agent-baseline");
    noHistoryBaseline = await capture(NO_HISTORY_RECEIPT_ID, "no-history-baseline");
  } else {
    baseline = await attachArtifactReceipt(runtime, BASELINE_RECEIPT_ID, "baseline", {
      artifactHash: sha256("baseline-output"),
      primaryMetricValue: 0.7,
      ...(unknownBaselineCosts
        ? { costCents: null, founderMinutes: null, complexityUnits: null }
        : { costCents: 50, founderMinutes: 0, complexityUnits: 100 })
    });
    plainBaseline = await attachArtifactReceipt(runtime, PLAIN_RECEIPT_ID, "plain-agent-baseline");
    noHistoryBaseline = await attachArtifactReceipt(runtime, NO_HISTORY_RECEIPT_ID, "no-history-baseline");
  }
  const caseReceipt = await attachArtifactReceipt(runtime, CASE_RECEIPT_ID, "evaluation-case");
  const caseContentHash = sha256("held-out-case-content");
  runtime.storage.addEvidence({
    id: CASE_ID,
    ventureId: VENTURE_ID,
    type: "evaluation-case",
    proofTier: "internally-live",
    authority: "engine",
    sourceRef: CASE_RECEIPT_ID,
    observedAt: new Date().toISOString(),
    status: "current",
    contentHash: caseContentHash,
    metadata: { heldOut: true }
  });

  const binaryCandidate = options.candidateBytes ?? Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x81, 0x42]);
  const candidateRelativePath = options.candidateRelativePath ?? "skills/evaluation-candidate/comparison.png";
  const candidate = await writeArtifact(runtime, candidateRelativePath, binaryCandidate);
  expectOk(
    await runtime.service.execute(
      "skill.version.record",
      SkillVersionInputSchema.parse({
        ventureId: VENTURE_ID,
        skillId: "skill_evaluation_candidate",
        version: "0.1.0",
        name: "Evaluation candidate screenshot",
        state: "candidate",
        artifactPath: candidateRelativePath,
        artifactHash: candidate.hash,
        applicability: ["browser-rendered company GPS candidates"],
        exclusions: [],
        assumptions: [],
        mutableSurface: ["candidate layout"],
        evidenceIds: [],
        evaluationContractIds: [],
        experimentRecordIds: [],
        evaluatedVentureIds: [],
        producerId: "producer",
        recordedBy: "producer",
        reason: "Freeze the exact browser artifact for independent evaluation",
        recordedAt: new Date().toISOString(),
        idempotencyKey: "skill-evaluation-candidate-v1"
      })
    )
  );
  const skill = runtime.storage.listSkillVersions(VENTURE_ID, { skillId: "skill_evaluation_candidate" }).at(-1);
  if (!skill) throw new Error("skill was not persisted");
  expect(skill.artifactHash).toBe(rawHash(binaryCandidate));

  const packRevisionId = runtime.storage.getVenture(VENTURE_ID)?.current_pack_revision_id;
  if (!packRevisionId) throw new Error("pack revision was not loaded");
  const promotionRule = {
    minimumPrimaryMetricImprovement: 0.05,
    maximumCostIncreasePercent: 10,
    maximumFounderTimeIncreasePercent: 0,
    maximumComplexityIncreasePercent: 5,
    minimumSampleSize: 1,
    requireAllHardGates: true,
    requireIndependentReview: true,
    requireHeldOut: false,
    requireCrossVenture: false,
    allowedDispositions: ["keep" as const, "inconclusive" as const]
  };
  const request = EvaluationContractInputSchema.parse({
    ventureId: VENTURE_ID,
    packRevisionId,
    goalRevisionId: goal.id,
    skillVersionId: skill.id,
    candidateVersion: skill.version,
    name: "Frozen evaluator task path",
    hypothesis: "The binary candidate improves founder next-step clarity",
    baseline: {
      description: "Frozen baseline dashboard capture",
      receiptIds: [baseline.id],
      artifactHash: String(baseline.metadata.artifactHash),
      primaryMetricValue: 0.7,
      plainAgentReceiptIds: [plainBaseline.id],
      noHistoryReceiptIds: [noHistoryBaseline.id]
    },
    primaryMetric: {
      id: "metric_founder_clarity",
      name: "Founder next-step clarity",
      unit: "score",
      direction: "higher-is-better",
      formula: "sum(case_clarity_points) / available_case_clarity_points",
      tieRule: "Prefer lower complexity; otherwise abstain",
      missingEvidenceRule: "Return inconclusive and name the missing case",
      abstentionScore: 0,
      minimumImprovement: 0.05,
      minimumSampleSize: 1
    },
    hardGates: [
      {
        id: "gate_no_scope_leak",
        description: "No cross-venture or network scope leak",
        evidenceRequirement: "Engine-bound scorer proof with exact frozen artifacts and no network access",
        failureDisposition: "unsafe"
      }
    ],
    evaluationPopulation: {
      kind: options.populationKind ?? "frozen-cases",
      description: "One frozen browser-evaluation case",
      caseRefs: [CASE_ID],
      populationHash: sha256([{ kind: "evidence", id: CASE_ID, contentHash: caseContentHash }]),
      minimumSampleSize: 1
    },
    mutableSurface: ["candidate layout"],
    bounds: {
      maxAttempts: 1,
      maxElapsedMs: 60_000,
      maxCostCents: 0,
      maxFounderMinutes: 0,
      maxReviewerMinutes: 10,
      autonomyMode: "propose",
      allowedGateClasses: options.allowedGateClasses ?? ["safe-internal-read-only"],
      forbiddenActions: ["network access", "external send", "venture mutation"],
      timeoutMs: 10_000,
      killSwitchPath: "internal://evaluation-kill",
      rollbackRoute: "discard candidate"
    },
    observationWindow: {
      startsAt: new Date(Date.now() - 10_000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60_000).toISOString()
    },
    expectedReceiptTypes: ["scoring", "reviewer"],
    knownConfounders: ["Single frozen case"],
    producerId: "producer",
    evaluatorId: "evaluator",
    reviewerId: "reviewer",
    promotionAuthorityId: "promotion-authority",
    promotionRule,
    promotionRuleHash: sha256(promotionRule),
    requestedAt: new Date().toISOString(),
    idempotencyKey: `evaluation-task-path-${unknownBaselineCosts ? "unknown" : "known"}-${options.manualBaselines ? "manual" : "engine"}-${options.populationKind ?? "frozen"}-${path.extname(candidateRelativePath)}-v1`
  });
  expectOk(await runtime.service.execute("evaluation.create", request));
  const evaluation = runtime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
  if (!evaluation) throw new Error("evaluation was not persisted");
  return {
    evaluation,
    skill,
    candidatePath: await realpath(candidate.path),
    baselinePath: await realpath(baseline.artifactPath),
    casePath: await realpath(caseReceipt.artifactPath)
  };
}

class LiveEvaluationDispatcher implements RoleDispatcher {
  readonly name = "live-evaluation-test";
  readonly contexts: DispatchContext[] = [];

  supportsRole(role: string): boolean {
    return role === "evaluator" || role === "reviewer";
  }

  async dispatch(task: TaskDefinition, context: DispatchContext): Promise<DispatchResult> {
    this.contexts.push(context);
    const manifest = task.actionBounds.evaluationInputManifest as EvaluationInputManifest;
    const startedAt = new Date(Date.now() - 1).toISOString();
    const evaluationResult =
      task.taskKind === "evaluation-scoring"
        ? {
            baselineValue: manifest.baseline.primaryMetricValue,
            candidateValue: 0.8,
            sampleSize: 1,
            candidateComplexityUnits: 101,
            otherCostCents: 0,
            leakageDetected: false,
            caseResults: [
              {
                caseRef: CASE_ID,
                baselineScore: 0.7,
                candidateScore: 0.8,
                abstained: false,
                evidenceRefs: [CASE_ID],
                notes: "Exact frozen case scored"
              }
            ],
            hardGateResults: [
              {
                hardGateId: "gate_no_scope_leak",
                passed: true,
                evidenceIds: [CASE_ID],
                reason: "Only manifest artifacts were read"
              }
            ],
            notes: "Free-text formula applied to the exact frozen case"
          }
        : {
            verdict: "keep" as const,
            reproducedCandidateValue: 0.8,
            reproducedSampleSize: 1,
            scoringMatches: true,
            hardGatesPassed: true,
            leakageDetected: false,
            notes: "Independent review reproduced the frozen score"
          };
    return {
      adapter: this.name,
      externalTaskId: `external_${task.id}`,
      externalRunId: `run_${task.id}`,
      ownerRole: task.ownerRole,
      outcome: "success",
      summary: `Completed ${task.taskKind} against the exact frozen evaluator manifest without network access.`,
      citations: manifest.allowedArtifactPaths,
      metadata: {
        evaluationResult,
        providerCostCents: 0,
        modelCostCents: 0,
        founderMinutes: 0,
        reviewerMinutes: 0,
        evaluationBindingHash: "specialist-spoof-must-not-win",
        engineStamped: false
      },
      startedAt,
      completedAt: new Date().toISOString()
    };
  }
}

class InventedGateReferenceDispatcher extends LiveEvaluationDispatcher {
  override async dispatch(task: TaskDefinition, context: DispatchContext): Promise<DispatchResult> {
    const result = await super.dispatch(task, context);
    if (task.taskKind === "evaluation-scoring") {
      const evaluationResult = result.metadata.evaluationResult as {
        hardGateResults: Array<{ evidenceIds: string[] }>;
      };
      evaluationResult.hardGateResults[0]!.evidenceIds = ["evidence_unrelated_or_invented"];
    }
    return result;
  }
}

class MutatingArtifactDispatcher extends LiveEvaluationDispatcher {
  override async dispatch(task: TaskDefinition, context: DispatchContext): Promise<DispatchResult> {
    const result = await super.dispatch(task, context);
    if (task.taskKind === "evaluation-scoring") {
      const manifest = task.actionBounds.evaluationInputManifest as EvaluationInputManifest;
      await writeFile(manifest.population.cases[0]!.artifact.absolutePath, "mutated during dispatch\n");
    }
    return result;
  }
}

function serviceWithDispatcher(runtime: Runtime, dispatcher: RoleDispatcher): EngineService {
  return new EngineService({
    storage: runtime.storage,
    sourceAdapter: runtime.service.sourceAdapter,
    dispatcher,
    receiptWriter: runtime.service.receiptWriter,
    venturesRoot: runtime.service.venturesRoot,
    receiptRoot: runtime.service.receiptRoot,
    dashboardUrl: runtime.service.dashboardUrl,
    forbiddenTermsByVenture: runtime.service.forbiddenTermsByVenture,
    context: runtime.service.context
  });
}

describe("engine-bound evaluation task execution", () => {
  it("freezes and runs manual-local captured baselines while marking them non-promotable", async () => {
    const runtime = await tempRuntime();
    try {
      const scenario = await evaluationScenario(runtime, false, { manualBaselines: true });
      const service = serviceWithDispatcher(runtime, new LiveEvaluationDispatcher());
      const worker = new EngineWorker(service, "manual-baseline-worker");
      const planned = expectOk<{ scoringTask: TaskDefinition; reviewTask: TaskDefinition }>(
        await service.execute("evaluation.tasks.plan", {
          ventureId: VENTURE_ID,
          evaluationContractId: scenario.evaluation.id,
          evaluationContractHash: scenario.evaluation.canonicalHash
        })
      );
      const manifest = planned.scoringTask.actionBounds.evaluationInputManifest as EvaluationInputManifest;
      expect(manifest.baseline.receipts).toHaveLength(3);
      expect(manifest.baseline.receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            binding: "baseline",
            baselineTrust: "manual-local",
            promotionEligible: false,
            trustModel: "single-operator-local",
            customerSafe: false
          })
        ])
      );
      expectOk(await service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.reviewTask.id }));
      expectOk(await service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.scoringTask.id }));
      expect(await worker.runOnce()).toMatchObject({ outcome: "success", taskId: planned.scoringTask.id });
      expect(await worker.runOnce()).toMatchObject({ outcome: "success", taskId: planned.reviewTask.id });
    } finally {
      await runtime.cleanup();
    }
  });

  it("freezes complete local inputs, supports binary candidates, and excludes unrelated URLs", async () => {
    const runtime = await tempRuntime();
    try {
      const scenario = await evaluationScenario(runtime);
      const dispatcher = new LiveEvaluationDispatcher();
      const service = serviceWithDispatcher(runtime, dispatcher);
      const first = expectOk<{
        created: boolean;
        scoringTask: TaskDefinition;
        reviewTask: TaskDefinition;
        evaluationBindingHash: string;
      }>(
        await service.execute("evaluation.tasks.plan", {
          ventureId: VENTURE_ID,
          evaluationContractId: scenario.evaluation.id,
          evaluationContractHash: scenario.evaluation.canonicalHash
        })
      );
      expect(first.created).toBe(true);
      expect(first.scoringTask.dependencies).toEqual([]);
      expect(first.reviewTask.dependencies).toEqual([first.scoringTask.id]);
      expect(first.scoringTask.sourceRefs).toEqual([]);
      expect(first.reviewTask.evaluationBindingHash).toBe(first.evaluationBindingHash);
      const manifest = first.scoringTask.actionBounds.evaluationInputManifest as EvaluationInputManifest;
      expect(manifest.candidate.artifact.absolutePath).toBe(scenario.candidatePath);
      expect(manifest.baseline.receipts.find((item) => item.id === BASELINE_RECEIPT_ID)?.artifact.absolutePath).toBe(
        scenario.baselinePath
      );
      expect(manifest.population.cases[0]?.artifact.absolutePath).toBe(scenario.casePath);
      expect(manifest.networkAccessPolicy).toBe("forbidden");
      expect(manifest.networkIsolation).toBe("not-mechanically-verified");
      expect(manifest.promotionEligibility).toBe("blocked-pending-network-isolation-proof");
      expect(first.scoringTask.evaluationBinding?.inputManifestHash).toBe(sha256(manifest));

      const pack = runtime.storage.getVenture(VENTURE_ID)?.pack;
      if (!pack) throw new Error("pack missing");
      const body = buildSpecialistWorkItem(first.scoringTask, {
        pack,
        receiptDestination: path.join(runtime.root, "receipts"),
        forbiddenTerms: [],
        dependencyReceipts: []
      });
      expect(body).toContain(scenario.candidatePath);
      expect(body).toContain(scenario.baselinePath);
      expect(body).toContain(scenario.casePath);
      expect(body).toContain("sum(case_clarity_points) / available_case_clarity_points");
      expect(body).toContain("Engine-bound scorer proof with exact frozen artifacts and no network access");
      expect(body).toContain("Network access is forbidden by policy");
      expect(body).toContain("runtime isolation is not mechanically verified");
      expect(body).not.toContain("https://betslipdoctor.ai/");

      const evaluationCitations = specialistCitations(first.scoringTask, pack.sources, {
        evaluationResult: {
          caseResults: [{ caseRef: CASE_ID }],
          hardGateResults: [{ hardGateId: "gate_no_scope_leak" }]
        }
      });
      expect(evaluationCitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`case:${CASE_ID}:`),
          expect.stringContaining("gate:gate_no_scope_leak:")
        ])
      );
      expect(() => specialistCitations(first.scoringTask, pack.sources, { evaluationResult: { caseResults: [] } })).toThrow(
        /omits exact caseRef/
      );
      expect(() =>
        specialistCitations(first.scoringTask, pack.sources, {
          evaluationResult: {
            caseResults: [{ caseRef: CASE_ID }],
            hardGateResults: [{ hardGateId: "gate_no_scope_leak" }]
          },
          citation: "https://example.test/not-allowed"
        })
      ).toThrow(/forbidden network policy/);
      const scoringDependency = ReceiptSchema.parse({
        id: "receipt_single_case_scoring_dependency",
        ventureId: VENTURE_ID,
        proofTier: "internally-live",
        outcome: "success",
        actor: "evaluator",
        adapter: "live-evaluation-test",
        artifactPath: scenario.casePath,
        contentHash: sha256("single-case-scoring-dependency"),
        occurredAt: new Date().toISOString(),
        metadata: {
          evaluationResult: {
            caseResults: [{ caseRef: CASE_ID }],
            hardGateResults: [{ hardGateId: "gate_no_scope_leak" }]
          }
        },
        origin: "dispatch"
      });
      expect(
        specialistCitations(first.reviewTask, pack.sources, {
          evaluationResult: { verdict: "keep" },
          dependencyReceipts: [scoringDependency]
        })
      ).toEqual(expect.arrayContaining([expect.stringContaining(`case:${CASE_ID}:`)]));

      const beforeReplay = runtime.storage.listTasks(VENTURE_ID).length;
      const replay = expectOk<{ created: boolean }>(
        await service.execute("evaluation.tasks.plan", {
          ventureId: VENTURE_ID,
          evaluationContractId: scenario.evaluation.id,
          evaluationContractHash: scenario.evaluation.canonicalHash
        })
      );
      expect(replay.created).toBe(false);
      expect(runtime.storage.listTasks(VENTURE_ID)).toHaveLength(beforeReplay);
      const wrongHash = await service.execute("evaluation.tasks.plan", {
        ventureId: VENTURE_ID,
        evaluationContractId: scenario.evaluation.id,
        evaluationContractHash: sha256("wrong")
      });
      expect(wrongHash.ok).toBe(false);
      expect(wrongHash.error?.code).toBe("evaluation-hash-mismatch");
      expect(runtime.storage.listTasks(VENTURE_ID)).toHaveLength(beforeReplay);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects missing, modified, and drifted input manifests before dispatch", async () => {
    const runtime = await tempRuntime();
    try {
      const scenario = await evaluationScenario(runtime);
      const service = serviceWithDispatcher(runtime, new LiveEvaluationDispatcher());
      const planned = expectOk<{ scoringTask: TaskDefinition }>(
        await service.execute("evaluation.tasks.plan", {
          ventureId: VENTURE_ID,
          evaluationContractId: scenario.evaluation.id,
          evaluationContractHash: scenario.evaluation.canonicalHash
        })
      ).scoringTask;
      const withoutManifest = {
        ...planned,
        actionBounds: Object.fromEntries(
          Object.entries(planned.actionBounds).filter(([key]) => key !== "evaluationInputManifest")
        )
      };
      expect(TaskDefinitionSchema.safeParse(withoutManifest).success).toBe(false);
      const modifiedManifest = {
        ...(planned.actionBounds.evaluationInputManifest as EvaluationInputManifest),
        hypothesis: "attacker changed the frozen hypothesis"
      };
      expect(
        TaskDefinitionSchema.safeParse({
          ...planned,
          actionBounds: { ...planned.actionBounds, evaluationInputManifest: modifiedManifest }
        }).success
      ).toBe(false);

      await writeFile(scenario.candidatePath, Uint8Array.from([1, 2, 3, 4]));
      const run = await service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.id });
      expect(run.ok).toBe(false);
      expect(run.error?.code).toBe("candidate-artifact-drift");
    } finally {
      await runtime.cleanup();
    }
  });

  it("dead-letters evaluation output when a frozen artifact changes during dispatch", async () => {
    const runtime = await tempRuntime();
    try {
      const scenario = await evaluationScenario(runtime);
      const service = serviceWithDispatcher(runtime, new MutatingArtifactDispatcher());
      const worker = new EngineWorker(service, "artifact-drift-worker");
      const planned = expectOk<{ scoringTask: TaskDefinition }>(
        await service.execute("evaluation.tasks.plan", {
          ventureId: VENTURE_ID,
          evaluationContractId: scenario.evaluation.id,
          evaluationContractHash: scenario.evaluation.canonicalHash
        })
      );
      expectOk(await service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.scoringTask.id }));
      expect(await worker.runOnce()).toMatchObject({
        outcome: "dead-letter",
        error: expect.stringContaining("changed during dispatch")
      });
      expect(runtime.storage.listReceipts(VENTURE_ID).some((receipt) => receipt.taskId === planned.scoringTask.id)).toBe(false);
      expect(runtime.storage.listEvidence(VENTURE_ID).some((item) => item.type === "evaluation-hard-gate-proof")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("refuses to engine-stamp invented hard-gate supporting references", async () => {
    const runtime = await tempRuntime();
    try {
      const scenario = await evaluationScenario(runtime);
      const service = serviceWithDispatcher(runtime, new InventedGateReferenceDispatcher());
      const worker = new EngineWorker(service, "invented-reference-worker");
      const planned = expectOk<{ scoringTask: TaskDefinition }>(
        await service.execute("evaluation.tasks.plan", {
          ventureId: VENTURE_ID,
          evaluationContractId: scenario.evaluation.id,
          evaluationContractHash: scenario.evaluation.canonicalHash
        })
      );
      expectOk(await service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.scoringTask.id }));
      expect(await worker.runOnce()).toMatchObject({
        outcome: "dead-letter",
        error: expect.stringContaining("outside the frozen evaluator inputs")
      });
      expect(runtime.storage.listReceipts(VENTURE_ID).some((receipt) => receipt.taskId === planned.scoringTask.id)).toBe(false);
      expect(runtime.storage.listEvidence(VENTURE_ID).some((item) => item.type === "evaluation-hard-gate-proof")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("runs scorer then reviewer, stamps receipts, creates gate proof, and records an experiment without caller terminal authority", async () => {
    const runtime = await tempRuntime();
    try {
      const scenario = await evaluationScenario(runtime);
      const dispatcher = new LiveEvaluationDispatcher();
      const service = serviceWithDispatcher(runtime, dispatcher);
      const worker = new EngineWorker(service, "evaluation-test-worker");
      const planned = expectOk<{ scoringTask: TaskDefinition; reviewTask: TaskDefinition }>(
        await service.execute("evaluation.tasks.plan", {
          ventureId: VENTURE_ID,
          evaluationContractId: scenario.evaluation.id,
          evaluationContractHash: scenario.evaluation.canonicalHash
        })
      );

      expectOk(await service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.reviewTask.id }));
      expect(await worker.runOnce()).toBeNull();
      expectOk(await service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.scoringTask.id }));
      expect(await worker.runOnce()).toMatchObject({ outcome: "success", taskId: planned.scoringTask.id });
      expect(await worker.runOnce()).toMatchObject({ outcome: "success", taskId: planned.reviewTask.id });

      const scoring = runtime.storage
        .listReceipts(VENTURE_ID)
        .find((receipt) => receipt.taskId === planned.scoringTask.id);
      const review = runtime.storage
        .listReceipts(VENTURE_ID)
        .find((receipt) => receipt.taskId === planned.reviewTask.id);
      if (!scoring || !review) throw new Error("evaluation receipts missing");
      expect(scoring.origin).toBe("dispatch");
      expect(scoring.metadata.engineStamped).toBe(true);
      expect(scoring.metadata.evaluationBindingHash).toBe(planned.scoringTask.evaluationBindingHash);
      expect((scoring.metadata.specialistOutput as Record<string, unknown>).engineStamped).toBe(false);
      expect(review.metadata.reviewedScoringReceiptId).toBe(scoring.id);
      expect(review.metadata.reviewedScoringContentHash).toBe(scoring.contentHash);
      expect(dispatcher.contexts[1]?.dependencyReceipts.map((receipt) => receipt.id)).toEqual([scoring.id]);

      const hardGateResults = scoring.metadata.experimentHardGateResults as Array<{
        hardGateId: string;
        passed: boolean;
        evidenceIds: string[];
        reason: string;
      }>;
      expect(hardGateResults).toHaveLength(1);
      const gateEvidence = runtime.storage
        .listEvidence(VENTURE_ID)
        .find((item) => item.id === hardGateResults[0]?.evidenceIds[0]);
      expect(gateEvidence).toMatchObject({
        type: "evaluation-hard-gate-proof",
        authority: "engine",
        sourceRef: scoring.id,
        metadata: {
          hardGateId: "gate_no_scope_leak",
          evaluationContractId: scenario.evaluation.id,
          candidateArtifactHash: scenario.skill.artifactHash,
          passed: true,
          engineStamped: true
        }
      });

      const startedAt = String(scoring.metadata.dispatchStartedAt);
      const completedAt = String(scoring.metadata.dispatchCompletedAt);
      const experimentInput = ExperimentRecordInputSchema.parse({
        ventureId: VENTURE_ID,
        evaluationContractId: scenario.evaluation.id,
        evaluationContractHash: scenario.evaluation.canonicalHash,
        goalRevisionId: scenario.evaluation.goalRevisionId,
        skillVersionId: scenario.skill.id,
        hypothesis: scenario.evaluation.hypothesis,
        baselineReceiptId: BASELINE_RECEIPT_ID,
        producerId: "producer",
        candidateVersion: scenario.skill.version,
        candidateArtifactHash: scenario.skill.artifactHash,
        attempts: [
          {
            attempt: 1,
            startedAt,
            completedAt,
            candidateHash: scenario.skill.artifactHash,
            outcome: "succeeded",
            receiptIds: [scoring.id],
            providerCostCents: 0,
            modelCostCents: 0,
            elapsedMs: Date.parse(completedAt) - Date.parse(startedAt),
            founderMinutes: 0,
            reviewerMinutes: 0,
            sideEffects: [],
            confounders: []
          }
        ],
        costs: {
          providerCostCents: 0,
          modelCostCents: 0,
          otherCostCents: 0,
          founderMinutes: 0,
          reviewerMinutes: 0,
          elapsedMs: Date.parse(completedAt) - Date.parse(startedAt)
        },
        receiptIds: [BASELINE_RECEIPT_ID, scoring.id, review.id],
        outcomeReceiptId: scoring.id,
        outcomeSummary: "Canonical scorer and reviewer receipts passed the frozen evaluator",
        confounders: [],
        primaryMetricResult: {
          metricId: scenario.evaluation.primaryMetric.id,
          baselineValue: 0.7,
          candidateValue: 0.8,
          improvement: 0.1,
          sampleSize: 1,
          thresholdPassed: true,
          scoringReceiptId: scoring.id
        },
        hardGateResults,
        reviewer: {
          reviewerId: "reviewer",
          reviewedAt: review.occurredAt,
          independentFromProducer: true,
          receiptId: review.id,
          verdict: "keep",
          notes: "Independent review reproduced the scoring receipt"
        },
        missingOutputs: [],
        disposition: "keep",
        complexityDeltaPercent: 1,
        implementationState: "not-applied",
        refinements: [],
        recordedAt: new Date().toISOString(),
        idempotencyKey: "experiment-evaluation-task-canonical-v1"
      });
      expect(
        ExperimentRecordInputSchema.safeParse({
          ...experimentInput,
          terminalReceiptId: "receipt_spoofed_terminal"
        }).success
      ).toBe(false);
      const recorded = expectOk<{ record: { terminalReceiptId: string }; terminalReceiptId: string }>(
        await service.execute("experiment.record", experimentInput)
      );
      expect(recorded.record.terminalReceiptId).toBe(recorded.terminalReceiptId);
      const terminal = runtime.storage
        .listReceipts(VENTURE_ID)
        .find((receipt) => receipt.id === recorded.terminalReceiptId);
      expect(terminal).toMatchObject({
        origin: "engine-derived",
        actor: "company-launch-engine",
        adapter: "engine-terminalizer",
        metadata: { receiptType: "terminal", engineStamped: true, disposition: "keep", missingOutputs: [] }
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("records an inconclusive unknown-cost experiment through the real CLI and generates its terminal receipt", async () => {
    const runtime = await persistentRuntime();
    try {
      const scenario = await evaluationScenario(runtime, true);
      const attemptArtifact = await writeArtifact(
        runtime,
        "receipts/manual/evaluation-inconclusive-attempt.json",
        `${JSON.stringify({ outcome: "bounded-attempt", externalActions: 0 }, null, 2)}\n`
      );
      const attemptId = "receipt_evaluation_inconclusive_attempt";
      const attemptAt = new Date(Math.max(Date.now(), Date.parse(scenario.evaluation.frozenAt)) + 5).toISOString();
      expectOk(
        await runtime.service.execute("receipt.attach", {
          id: attemptId,
          ventureId: VENTURE_ID,
          proofTier: "scaffolded",
          outcome: "success",
          actor: "producer",
          adapter: "manual-bounded-attempt",
          artifactPath: attemptArtifact.path,
          contentHash: attemptArtifact.hash,
          occurredAt: attemptAt,
          metadata: {
            receiptType: "provider",
            evaluationContractId: scenario.evaluation.id,
            evaluationContractHash: scenario.evaluation.canonicalHash,
            candidateVersion: scenario.skill.version,
            candidateArtifactHash: scenario.skill.artifactHash
          }
        })
      );
      const completedAt = new Date(Date.parse(attemptAt) + 1).toISOString();
      const input = ExperimentRecordInputSchema.parse({
        ventureId: VENTURE_ID,
        evaluationContractId: scenario.evaluation.id,
        evaluationContractHash: scenario.evaluation.canonicalHash,
        goalRevisionId: scenario.evaluation.goalRevisionId,
        skillVersionId: scenario.skill.id,
        hypothesis: scenario.evaluation.hypothesis,
        baselineReceiptId: BASELINE_RECEIPT_ID,
        producerId: "producer",
        candidateVersion: scenario.skill.version,
        candidateArtifactHash: scenario.skill.artifactHash,
        attempts: [
          {
            attempt: 1,
            startedAt: attemptAt,
            completedAt,
            candidateHash: scenario.skill.artifactHash,
            outcome: "succeeded",
            receiptIds: [attemptId],
            providerCostCents: 0,
            modelCostCents: 0,
            elapsedMs: 1,
            founderMinutes: 0,
            reviewerMinutes: 0,
            sideEffects: [],
            confounders: ["Historical baseline costs remain unknown"]
          }
        ],
        costs: {
          providerCostCents: 0,
          modelCostCents: 0,
          otherCostCents: 0,
          founderMinutes: 0,
          reviewerMinutes: 0,
          elapsedMs: 1
        },
        receiptIds: [BASELINE_RECEIPT_ID, attemptId],
        outcomeReceiptId: attemptId,
        outcomeSummary: "The bounded attempt completed but unknown historical baseline costs prevent promotion",
        confounders: ["Unknown historical baseline costs"],
        primaryMetricResult: null,
        hardGateResults: [],
        reviewer: null,
        missingOutputs: [
          "primaryMetricResult",
          "hardGateResults",
          "reviewer",
          "baseline.costCents",
          "baseline.founderMinutes",
          "baseline.complexityUnits"
        ],
        disposition: "inconclusive",
        complexityDeltaPercent: null,
        implementationState: "not-applied",
        refinements: [],
        recordedAt: new Date(Date.parse(completedAt) + 1).toISOString(),
        idempotencyKey: "experiment-evaluation-cli-inconclusive-v1"
      });
      expect(
        runtime.storage
          .listReceipts(VENTURE_ID)
          .some((receipt) => receipt.adapter === "engine-terminalizer")
      ).toBe(false);

      const cli = await execFile(
        path.join(process.cwd(), "node_modules/.bin/tsx"),
        ["apps/cli/src/index.ts", "experiment.record", "--input", JSON.stringify(input), "--json"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ENGINE_ROOT: runtime.root,
            ENGINE_DB_PATH: runtime.databasePath,
            ENGINE_DISPATCH_ADAPTER: "fixture"
          },
          maxBuffer: 4 * 1024 * 1024
        }
      );
      const response = JSON.parse(cli.stdout) as CommandResponse<{
        record: { disposition: string; terminalReceiptId: string; missingOutputs: string[] };
        terminalReceiptId: string;
      }>;
      expect(response.ok, response.error?.message).toBe(true);
      expect(response.data?.record).toMatchObject({
        disposition: "inconclusive",
        missingOutputs: expect.arrayContaining([
          "baseline.costCents",
          "baseline.founderMinutes",
          "baseline.complexityUnits"
        ])
      });
      expect(response.data?.record.terminalReceiptId).toBe(response.data?.terminalReceiptId);
      const terminal = runtime.storage
        .listReceipts(VENTURE_ID)
        .find((receipt) => receipt.id === response.data?.terminalReceiptId);
      expect(terminal).toMatchObject({
        origin: "engine-derived",
        adapter: "engine-terminalizer",
        metadata: { disposition: "inconclusive", engineStamped: true }
      });
    } finally {
      await runtime.cleanup();
    }
  });
});
