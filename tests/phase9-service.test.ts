import { describe, expect, it } from "vitest";
import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  EvaluationContractInputSchema,
  ExperimentRecordInputSchema,
  GoalChangeInputSchema,
  GoalConfirmChangeInputSchema,
  InitiativeDecisionInputSchema,
  PlayPromotionInputSchema,
  ReceiptSchema,
  SkillVersionInputSchema,
  TaskDefinitionSchema,
  sha256,
  type CommandResponse,
  type EvaluationContract,
  type ExperimentRecord,
  type ExperimentRecordInput,
  type GoalChangeInput,
  type GoalRevision,
  type SkillVersion
} from "@amped-studio-os/contracts";
import { tempRuntime } from "./helpers.js";

const VENTURE_ID = "venture_example_a";
const FIXTURE_NOW = Date.now();
const BASELINE_AT = new Date(FIXTURE_NOW - 60_000).toISOString();
const START = new Date(FIXTURE_NOW + 60_000).toISOString();
const ATTEMPT_END = new Date(FIXTURE_NOW + 61_000).toISOString();
const END = new Date(FIXTURE_NOW + 60 * 60_000).toISOString();
const HASH = sha256("phase-9-service-fixture");
const BASELINE_ARTIFACT_HASH = sha256("phase-9-baseline");
const CASE_CONTENT_HASH = sha256("phase-9-held-out-case");
const POPULATION_HASH = sha256([{ kind: "evidence", id: "case_phase9_001", contentHash: CASE_CONTENT_HASH }]);
const CANDIDATE_VERSION = "0.1.0";
const GATE_REQUIREMENT = "Provider and reviewer receipts";
const RECEIPTS = {
  baseline: "receipt_phase9_baseline",
  plainAgent: "receipt_phase9_plain_agent",
  noHistory: "receipt_phase9_no_history",
  attempt: "receipt_phase9_attempt",
  scoring: "receipt_phase9_scoring",
  review: "receipt_phase9_review",
  gate: "receipt_phase9_gate",
  terminal: "receipt_phase9_terminal"
} as const;

type TestRuntime = Awaited<ReturnType<typeof tempRuntime>>;
type ReceiptProvenance = {
  origin?: "dispatch" | "engine-derived" | "attached-artifact" | "fixture" | "legacy";
  adapter?: string;
  taskId?: string;
  dispatchId?: string;
};
type BoundReceiptKey = "attempt" | "scoring" | "review" | "gate" | "terminal";

interface GoalPreview {
  previewId: string;
  previewHash: string;
  confirmationRequired: true;
}

interface PlannedTaskView {
  idempotencyKey: string;
  actionBounds: Record<string, unknown>;
}

function expectOk<T>(response: CommandResponse): T {
  expect(response.ok, response.error?.message).toBe(true);
  expect(response.data).toBeDefined();
  return response.data as T;
}

function unwrap<T>(data: unknown, key: string): T {
  const object = data as Record<string, unknown> | undefined;
  return (object?.[key] ?? object?.record ?? data) as T;
}

function unwrapList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  const object = data as Record<string, unknown> | undefined;
  const value = object?.[key] ?? object?.records ?? object?.items;
  return Array.isArray(value) ? (value as T[]) : [];
}

function currentPackRevisionId(runtime: TestRuntime, ventureId = VENTURE_ID): string {
  const revisionId = runtime.storage.getVenture(ventureId)?.current_pack_revision_id;
  if (!revisionId) throw new Error(`venture pack revision was not loaded: ${ventureId}`);
  return revisionId;
}

function goalInput(overrides: Partial<GoalChangeInput> = {}): GoalChangeInput {
  return GoalChangeInputSchema.parse({
    ventureId: VENTURE_ID,
    destination: "cash-flow",
    target: "First authoritative paid pilot",
    horizon: "30 days",
    constraints: ["No external action without approval"],
    successConditions: ["One non-fixture authoritative payment event"],
    killConditions: ["No paid demand after the bounded test"],
    reason: "Prove the narrow wedge before scaling",
    requestedBy: "founder",
    requestedAt: BASELINE_AT,
    idempotencyKey: "goal-phase9-service-v1",
    ...overrides
  });
}

async function previewGoal(runtime: TestRuntime, input: GoalChangeInput): Promise<GoalPreview> {
  const response = await runtime.service.execute("goal.preview_change", input);
  return unwrap<GoalPreview>(expectOk(response), "preview");
}

async function confirmGoal(runtime: TestRuntime, input: GoalChangeInput, preview: GoalPreview): Promise<GoalRevision> {
  const response = await runtime.service.execute(
    "goal.confirm_change",
    GoalConfirmChangeInputSchema.parse({
      ...input,
      founderConfirmation: {
        previewId: preview.previewId,
        previewHash: preview.previewHash,
        confirmedBy: "founder",
        authority: "Founder confirmation in a bounded service fixture",
        confirmedAt: START
      }
    })
  );
  expectOk(response);
  const record = runtime.storage.getLatestGoalRevision(input.ventureId);
  if (!record) throw new Error("goal.confirm_change did not persist a goal revision");
  return record;
}

function attachReceipt(
  runtime: TestRuntime,
  id: string,
  receiptType: string,
  metadata: Record<string, unknown> = {},
  actor = "phase9-service-test",
  ventureId = VENTURE_ID,
  provenance: ReceiptProvenance = {}
): void {
  runtime.storage.attachReceipt(
    ReceiptSchema.parse({
      id,
      ventureId,
      ...(provenance.taskId ? { taskId: provenance.taskId } : {}),
      ...(provenance.dispatchId ? { dispatchId: provenance.dispatchId } : {}),
      proofTier: "internally-live",
      outcome: "success",
      actor,
      adapter: provenance.adapter ?? "phase9-test-engine",
      artifactPath: `receipts/${id}.json`,
      contentHash: sha256(id),
      occurredAt: receiptType.includes("baseline") ? BASELINE_AT : START,
      metadata: {
        receiptType,
        engineStamped: true,
        baselineTrust: "engine-internal-test",
        promotionEligible: true,
        trustModel: "single-operator-local",
        customerSafe: false,
        ...metadata
      },
      origin: provenance.origin ?? "engine-derived"
    })
  );
}

function seedEvaluationEvidence(runtime: TestRuntime, baselineOverrides: Record<string, unknown> = {}): void {
  attachReceipt(runtime, RECEIPTS.baseline, "baseline", {
    artifactHash: BASELINE_ARTIFACT_HASH,
    primaryMetricValue: 0.7,
    costCents: 50,
    founderMinutes: 0,
    complexityUnits: 100,
    ...baselineOverrides
  });
  attachReceipt(runtime, RECEIPTS.plainAgent, "plain-agent-baseline");
  attachReceipt(runtime, RECEIPTS.noHistory, "no-history-baseline");
  runtime.storage.addEvidence({
    id: "evidence_phase9_quality",
    ventureId: VENTURE_ID,
    type: "evaluation-quality",
    proofTier: "internally-live",
    authority: "engine",
    sourceRef: RECEIPTS.scoring,
    observedAt: END,
    status: "current",
    contentHash: sha256("phase-9-quality-evidence"),
    metadata: {}
  });
  runtime.storage.addEvidence({
    id: "case_phase9_001",
    ventureId: VENTURE_ID,
    type: "evaluation-case",
    proofTier: "internally-live",
    authority: "engine",
    sourceRef: RECEIPTS.scoring,
    observedAt: END,
    status: "current",
    contentHash: CASE_CONTENT_HASH,
    metadata: { heldOut: true }
  });
}

function evaluationInput(packRevisionId: string, goalRevisionId: string, skill: SkillVersion) {
  const promotionRule = {
    minimumPrimaryMetricImprovement: 0.05,
    maximumCostIncreasePercent: 10,
    maximumFounderTimeIncreasePercent: 0,
    maximumComplexityIncreasePercent: 5,
    minimumSampleSize: 1,
    requireAllHardGates: true,
    requireIndependentReview: true,
    requireHeldOut: true,
    requireCrossVenture: false,
    allowedDispositions: ["keep" as const]
  };
  return EvaluationContractInputSchema.parse({
    ventureId: VENTURE_ID,
    packRevisionId,
    goalRevisionId,
    skillVersionId: skill.id,
    candidateVersion: skill.version,
    name: "Phase 9 planner evaluation",
    hypothesis: "The candidate improves decision quality without weakening gates",
    baseline: {
      description: "Frozen no-history and plain-agent baselines",
      receiptIds: [RECEIPTS.baseline],
      artifactHash: BASELINE_ARTIFACT_HASH,
      primaryMetricValue: 0.7,
      plainAgentReceiptIds: [RECEIPTS.plainAgent],
      noHistoryReceiptIds: [RECEIPTS.noHistory]
    },
    primaryMetric: {
      id: "metric_phase9_quality",
      name: "Decision quality",
      unit: "score",
      direction: "higher-is-better",
      formula: "correct_points / available_points",
      tieRule: "Prefer lower fully loaded cost, otherwise abstain",
      missingEvidenceRule: "Return inconclusive",
      abstentionScore: 0,
      minimumImprovement: 0.05,
      minimumSampleSize: 1
    },
    hardGates: [
      {
        id: "gate_phase9_safety",
        description: "No unauthorized action",
        evidenceRequirement: GATE_REQUIREMENT,
        failureDisposition: "unsafe"
      }
    ],
    evaluationPopulation: {
      kind: "hidden-held-out",
      description: "One frozen held-out fixture",
      caseRefs: ["case_phase9_001"],
      populationHash: POPULATION_HASH,
      minimumSampleSize: 1
    },
    mutableSurface: ["planner prompt"],
    bounds: {
      maxAttempts: 1,
      maxElapsedMs: 60_000,
      maxCostCents: 500,
      maxFounderMinutes: 5,
      maxReviewerMinutes: 10,
      autonomyMode: "propose",
      allowedGateClasses: [],
      forbiddenActions: ["external send", "venture state mutation"],
      timeoutMs: 10_000,
      killSwitchPath: "internal://phase9-kill",
      rollbackRoute: "discard candidate"
    },
    observationWindow: { startsAt: START, endsAt: END },
    expectedReceiptTypes: ["provider", "scoring", "reviewer"],
    knownConfounders: [],
    producerId: "producer",
    evaluatorId: "evaluator",
    reviewerId: "reviewer",
    promotionAuthorityId: "promotion-authority",
    promotionRule,
    promotionRuleHash: sha256(promotionRule),
    requestedAt: BASELINE_AT,
    idempotencyKey: "evaluation-phase9-service-v1"
  });
}

async function createEvaluationFixture(
  runtime: TestRuntime,
  receiptOverrides: Partial<Record<BoundReceiptKey, Record<string, unknown>>> = {},
  provenanceOverrides: Partial<Record<BoundReceiptKey, ReceiptProvenance>> = {}
): Promise<{ goal: GoalRevision; evaluation: EvaluationContract; candidate: SkillVersion }> {
  const input = goalInput();
  const goal = await confirmGoal(runtime, input, await previewGoal(runtime, input));
  const candidate = await createCandidateSkill(runtime);
  const response = await runtime.service.execute(
    "evaluation.create",
    evaluationInput(currentPackRevisionId(runtime), goal.id, candidate)
  );
  expectOk(response);
  const evaluation = runtime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
  if (!evaluation) throw new Error("evaluation.create did not persist an evaluation contract");
  seedBoundExperimentReceipts(runtime, evaluation, candidate, receiptOverrides, provenanceOverrides);
  return { goal, evaluation, candidate };
}

function seedBoundExperimentReceipts(
  runtime: TestRuntime,
  evaluation: EvaluationContract,
  candidate: SkillVersion,
  overrides: Partial<Record<BoundReceiptKey, Record<string, unknown>>> = {},
  provenanceOverrides: Partial<Record<BoundReceiptKey, ReceiptProvenance>> = {}
): void {
  const binding = {
    evaluationContractId: evaluation.id,
    evaluationContractHash: evaluation.canonicalHash,
    candidateVersion: candidate.version,
    candidateArtifactHash: candidate.artifactHash
  };
  attachReceipt(runtime, RECEIPTS.attempt, "provider", { ...binding, ...overrides.attempt }, "provider", VENTURE_ID, provenanceOverrides.attempt);
  attachReceipt(
    runtime,
    RECEIPTS.scoring,
    "scoring",
    {
      ...binding,
      metricId: evaluation.primaryMetric.id,
      formulaHash: sha256(evaluation.primaryMetric.formula),
      baselineValue: 0.7,
      candidateValue: 0.8,
      sampleSize: 1,
      populationHash: POPULATION_HASH,
      otherCostCents: 0,
      candidateComplexityUnits: 101,
      leakageDetected: false,
      heldOutChannel: "opaque-authenticated",
      ...overrides.scoring
    },
    "evaluator",
    VENTURE_ID,
    provenanceOverrides.scoring
  );
  attachReceipt(
    runtime,
    RECEIPTS.review,
    "reviewer",
    { ...binding, reviewerId: "reviewer", verdict: "keep", ...overrides.review },
    "reviewer",
    VENTURE_ID,
    provenanceOverrides.review
  );
  attachReceipt(
    runtime,
    RECEIPTS.terminal,
    "terminal",
    { ...binding, disposition: "keep", missingOutputs: [], ...overrides.terminal },
    "engine",
    VENTURE_ID,
    provenanceOverrides.terminal
  );
  attachReceipt(
    runtime,
    RECEIPTS.gate,
    "gate-proof",
    {
      ...binding,
      hardGateId: "gate_phase9_safety",
      evidenceRequirementHash: sha256(GATE_REQUIREMENT),
      ...overrides.gate
    },
    "reviewer",
    VENTURE_ID,
    provenanceOverrides.gate
  );
  addBoundPromotionEvidence(runtime, evaluation, candidate, RECEIPTS.scoring);
}

function attachTerminalReceipt(
  runtime: TestRuntime,
  evaluation: EvaluationContract,
  candidate: SkillVersion,
  id: string,
  disposition: "keep" | "discard" | "inconclusive" | "crash" | "gated" | "unsafe",
  missingOutputs: readonly string[],
  ventureId = VENTURE_ID,
  provenance: ReceiptProvenance = {}
): void {
  attachReceipt(
    runtime,
    id,
    "terminal",
    {
      evaluationContractId: evaluation.id,
      evaluationContractHash: evaluation.canonicalHash,
      candidateVersion: candidate.version,
      candidateArtifactHash: candidate.artifactHash,
      disposition,
      missingOutputs: [...missingOutputs]
    },
    "engine",
    ventureId,
    provenance
  );
}

function experimentInput(goal: GoalRevision, evaluation: EvaluationContract, candidate: SkillVersion) {
  return ExperimentRecordInputSchema.parse({
    ventureId: VENTURE_ID,
    evaluationContractId: evaluation.id,
    evaluationContractHash: evaluation.canonicalHash,
    goalRevisionId: goal.id,
    skillVersionId: candidate.id,
    hypothesis: "One bounded prompt change improves the frozen metric",
    baselineReceiptId: RECEIPTS.baseline,
    producerId: "producer",
    candidateVersion: candidate.version,
    candidateArtifactHash: candidate.artifactHash,
    attempts: [
      {
        attempt: 1,
        startedAt: START,
        completedAt: ATTEMPT_END,
        candidateHash: candidate.artifactHash,
        outcome: "succeeded",
        receiptIds: [RECEIPTS.attempt],
        providerCostCents: 25,
        modelCostCents: 30,
        elapsedMs: 1_000,
        founderMinutes: 0,
        reviewerMinutes: 5,
        sideEffects: [],
        confounders: []
      }
    ],
    costs: {
      providerCostCents: 25,
      modelCostCents: 30,
      otherCostCents: 0,
      founderMinutes: 0,
      reviewerMinutes: 5,
      elapsedMs: 1_000
    },
    receiptIds: [RECEIPTS.baseline, RECEIPTS.attempt, RECEIPTS.scoring, RECEIPTS.review, RECEIPTS.gate],
    outcomeReceiptId: RECEIPTS.attempt,
    outcomeSummary: "The candidate passed the frozen threshold",
    confounders: [],
    primaryMetricResult: {
      metricId: "metric_phase9_quality",
      baselineValue: 0.7,
      candidateValue: 0.8,
      improvement: 0.1,
      sampleSize: 1,
      thresholdPassed: true,
      scoringReceiptId: RECEIPTS.scoring
    },
    hardGateResults: [
      {
        hardGateId: "gate_phase9_safety",
        passed: true,
        evidenceIds: [RECEIPTS.gate, promotionEvidenceId(evaluation)],
        reason: "No venture or external action occurred"
      }
    ],
    reviewer: {
      reviewerId: "reviewer",
      reviewedAt: END,
      independentFromProducer: true,
      receiptId: RECEIPTS.review,
      verdict: "keep",
      notes: "Frozen score and gates reproduced"
    },
    missingOutputs: [],
    disposition: "keep",
    complexityDeltaPercent: 1,
    implementationState: "retained",
    refinements: [
      {
        sequence: 1,
        description: "Clarified one planner instruction",
        rationale: "Reduce ambiguity without changing the evaluator",
        diffHash: HASH,
        mutableSurface: ["planner prompt"],
        recordedAt: START
      }
    ],
    recordedAt: END,
    idempotencyKey: "experiment-phase9-service-v1"
  });
}

function incompleteExperimentInput(
  goal: GoalRevision,
  evaluation: EvaluationContract,
  candidate: SkillVersion,
  terminalReceiptId: string,
  overrides: Record<string, unknown> = {}
): ExperimentRecordInput {
  return ExperimentRecordInputSchema.parse({
    ventureId: VENTURE_ID,
    evaluationContractId: evaluation.id,
    evaluationContractHash: evaluation.canonicalHash,
    goalRevisionId: goal.id,
    skillVersionId: candidate.id,
    hypothesis: "A bounded attempt terminated without a complete kept result",
    baselineReceiptId: RECEIPTS.baseline,
    producerId: "producer",
    candidateVersion: candidate.version,
    candidateArtifactHash: candidate.artifactHash,
    attempts: [],
    costs: {
      providerCostCents: 0,
      modelCostCents: 0,
      otherCostCents: 0,
      founderMinutes: 0,
      reviewerMinutes: 0,
      elapsedMs: 0
    },
    receiptIds: [RECEIPTS.baseline],
    outcomeSummary: "The exact terminal state and missing outputs were preserved",
    confounders: [],
    primaryMetricResult: null,
    hardGateResults: [],
    reviewer: null,
    missingOutputs: ["attempts", "outcomeReceiptId", "primaryMetricResult", "hardGateResults", "reviewer"],
    disposition: "gated",
    complexityDeltaPercent: 0,
    implementationState: "not-applied",
    refinements: [],
    recordedAt: END,
    idempotencyKey: `experiment-phase9-incomplete-${terminalReceiptId}`,
    ...overrides
  });
}

async function createExperimentFixture(
  runtime: TestRuntime,
  receiptOverrides: Partial<Record<BoundReceiptKey, Record<string, unknown>>> = {},
  provenanceOverrides: Partial<Record<BoundReceiptKey, ReceiptProvenance>> = {}
): Promise<{ goal: GoalRevision; evaluation: EvaluationContract; experiment: ExperimentRecord; candidate: SkillVersion }> {
  const { goal, evaluation, candidate } = await createEvaluationFixture(runtime, receiptOverrides, provenanceOverrides);
  const response = await runtime.service.execute("experiment.record", experimentInput(goal, evaluation, candidate));
  expectOk(response);
  const experiment = runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id).at(-1);
  if (!experiment) throw new Error("experiment.record did not persist an experiment record");
  return { goal, evaluation, experiment, candidate };
}

async function seedSkillArtifact(runtime: TestRuntime): Promise<string> {
  const relativePath = "skills/phase9-planner/SKILL.md";
  const target = path.join(runtime.root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(process.cwd(), "skills/run-bounded-gtme-experiment/SKILL.md"), target);
  return sha256(await readFile(target, "utf8"));
}

async function seedDifferentSkillArtifact(runtime: TestRuntime): Promise<{ path: string; hash: string }> {
  const relativePath = "skills/phase9-planner-mutated/SKILL.md";
  const target = path.join(runtime.root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(process.cwd(), "skills/promote-proven-play/SKILL.md"), target);
  return { path: relativePath, hash: sha256(await readFile(target, "utf8")) };
}

function candidateSkillInput(artifactHash: string, overrides: Record<string, unknown> = {}) {
  return SkillVersionInputSchema.parse({
    ventureId: VENTURE_ID,
    skillId: "skill_phase9_planner",
    version: CANDIDATE_VERSION,
    name: "Phase 9 planner",
    state: "candidate",
    artifactPath: "skills/phase9-planner/SKILL.md",
    artifactHash,
    applicability: ["founder-led software"],
    exclusions: [],
    assumptions: [],
    mutableSurface: ["planner prompt"],
    evidenceIds: [],
    evaluationContractIds: [],
    experimentRecordIds: [],
    evaluatedVentureIds: [],
    producerId: "producer",
    recordedBy: "producer",
    reason: "Candidate retained for independent promotion review",
    recordedAt: END,
    idempotencyKey: "skill-phase9-candidate-v1",
    ...overrides
  });
}

async function createCandidateSkill(
  runtime: TestRuntime,
  overrides: Record<string, unknown> = {}
): Promise<SkillVersion> {
  const artifactHash = await seedSkillArtifact(runtime);
  const response = await runtime.service.execute(
    "skill.version.record",
    candidateSkillInput(artifactHash, overrides)
  );
  expectOk(response);
  const ventureId = String(overrides.ventureId ?? VENTURE_ID);
  const skillId = String(overrides.skillId ?? "skill_phase9_planner");
  const skill = runtime.storage.listSkillVersions(ventureId, { skillId }).at(-1);
  if (!skill) throw new Error("skill.version.record did not persist a candidate skill");
  return skill;
}

function outcomeDefinitionHash(evaluation: EvaluationContract): string {
  const primaryMetric: Record<string, unknown> = { ...evaluation.primaryMetric };
  delete primaryMetric.authoritativeSourceRef;
  return sha256({
    primaryMetric,
    hardGates: [...evaluation.hardGates].sort((left, right) => left.id.localeCompare(right.id)),
    populationProtocol: {
      kind: evaluation.evaluationPopulation.kind,
      minimumSampleSize: evaluation.evaluationPopulation.minimumSampleSize
    },
    expectedReceiptTypes: [...evaluation.expectedReceiptTypes].sort(),
    promotionRule: evaluation.promotionRule
  });
}

function promotionEvidenceId(evaluation: EvaluationContract): string {
  return `evidence_phase9_gate_${sha256(evaluation.id).slice(0, 16)}`;
}

function addBoundPromotionEvidence(
  runtime: TestRuntime,
  evaluation: EvaluationContract,
  candidate: SkillVersion,
  scoringReceiptId: string,
  ventureId = evaluation.ventureId
): string {
  const id = promotionEvidenceId(evaluation);
  runtime.storage.addEvidence({
    id,
    ventureId,
    type: "evaluation-promotion-hard-gate-proof",
    proofTier: "internally-live",
    authority: "engine",
    sourceRef: scoringReceiptId,
    observedAt: END,
    status: "current",
    contentHash: sha256({ id, scoringReceiptId, evaluationContractId: evaluation.id }),
    metadata: {
      hardGateId: "gate_phase9_safety",
      evaluationContractId: evaluation.id,
      evaluationContractHash: evaluation.canonicalHash,
      candidateVersion: candidate.version,
      candidateArtifactHash: candidate.artifactHash,
      evidenceRequirementHash: sha256(GATE_REQUIREMENT),
      trustModel: "single-operator-local",
      customerSafe: false
    }
  });
  return id;
}

function promotionInput(
  evaluation: EvaluationContract,
  experiment: ExperimentRecord,
  candidate: SkillVersion,
  overrides: Record<string, unknown> = {}
) {
  return PlayPromotionInputSchema.parse({
    ventureId: VENTURE_ID,
    playId: "play_example_a_channel_evidence_v1",
    skillVersionId: candidate.id,
    fromState: "candidate",
    toState: "held-out-verified",
    decision: "promote",
    evaluationContractIds: [evaluation.id],
    experimentRecordIds: [experiment.id],
    evidenceIds: [promotionEvidenceId(evaluation)],
    transferVentureIds: [],
    outcomeDefinitionHash: outcomeDefinitionHash(evaluation),
    supportedArchetypes: ["founder-led software"],
    unsupportedArchetypes: [],
    noHistoryBaselineReceiptIds: [RECEIPTS.noHistory],
    plainAgentBaselineReceiptIds: [RECEIPTS.plainAgent],
    hardGatesPassed: true,
    leakageDetected: false,
    costWithinTolerance: true,
    founderTimeWithinTolerance: true,
    complexityWithinTolerance: true,
    producerId: "producer",
    evaluatorId: "evaluator",
    reviewerId: "reviewer",
    promotionAuthorityId: "promotion-authority",
    reason: "The exact sealed candidate passed the frozen evaluator and all gates",
    requestedAt: END,
    idempotencyKey: "promotion-phase9-held-out-v1",
    ...overrides
  });
}

async function createExampleCTransferFixture(runtime: TestRuntime, mismatchedOutcome = false) {
  const ventureId = "venture_example_c";
  const ids = {
    baseline: "receipt_example_c_phase9_baseline",
    plainAgent: "receipt_example_c_phase9_plain_agent",
    noHistory: "receipt_example_c_phase9_no_history",
    attempt: "receipt_example_c_phase9_attempt",
    scoring: "receipt_example_c_phase9_scoring",
    review: "receipt_example_c_phase9_review",
    gate: "receipt_example_c_phase9_gate",
    terminal: "receipt_example_c_phase9_terminal",
    case: "case_example_c_phase9_001"
  } as const;
  const caseContentHash = sha256("hwp-phase-9-held-out-case");
  const populationHash = sha256([{ kind: "evidence", id: ids.case, contentHash: caseContentHash }]);
  attachReceipt(
    runtime,
    ids.baseline,
    "baseline",
    {
      artifactHash: BASELINE_ARTIFACT_HASH,
      primaryMetricValue: 0.7,
      costCents: 50,
      founderMinutes: 0,
      complexityUnits: 100
    },
    "phase9-service-test",
    ventureId
  );
  attachReceipt(runtime, ids.plainAgent, "plain-agent-baseline", {}, "phase9-service-test", ventureId);
  attachReceipt(runtime, ids.noHistory, "no-history-baseline", {}, "phase9-service-test", ventureId);
  runtime.storage.addEvidence({
    id: ids.case,
    ventureId,
    type: "evaluation-case",
    proofTier: "internally-live",
    authority: "engine",
    sourceRef: ids.baseline,
    observedAt: END,
    status: "current",
    contentHash: caseContentHash,
    metadata: { heldOut: true }
  });
  const hwpGoalInput = goalInput({
    ventureId,
    idempotencyKey: "goal-hwp-phase9-transfer-v1"
  });
  const goal = await confirmGoal(runtime, hwpGoalInput, await previewGoal(runtime, hwpGoalInput));
  const candidate = await createCandidateSkill(runtime, {
    ventureId,
    skillId: "skill_hwp_phase9_planner",
    name: "HWP transfer candidate",
    idempotencyKey: "skill-hwp-phase9-candidate-v1"
  });
  const baseEvaluation = evaluationInput(currentPackRevisionId(runtime, ventureId), goal.id, candidate);
  const evaluationRequest = EvaluationContractInputSchema.parse({
    ...baseEvaluation,
    ventureId,
    name: "HWP transfer evaluation",
    baseline: {
      ...baseEvaluation.baseline,
      receiptIds: [ids.baseline],
      plainAgentReceiptIds: [ids.plainAgent],
      noHistoryReceiptIds: [ids.noHistory]
    },
    primaryMetric: mismatchedOutcome
      ? { ...baseEvaluation.primaryMetric, name: "Incomparable transfer outcome" }
      : baseEvaluation.primaryMetric,
    evaluationPopulation: {
      ...baseEvaluation.evaluationPopulation,
      caseRefs: [ids.case],
      populationHash
    },
    idempotencyKey: mismatchedOutcome ? "evaluation-hwp-phase9-mismatch-v1" : "evaluation-hwp-phase9-transfer-v1"
  });
  expectOk(await runtime.service.execute("evaluation.create", evaluationRequest));
  const evaluation = runtime.storage.listEvaluationContracts(ventureId).at(-1);
  if (!evaluation) throw new Error("HWP transfer evaluation missing");
  const binding = {
    evaluationContractId: evaluation.id,
    evaluationContractHash: evaluation.canonicalHash,
    candidateVersion: candidate.version,
    candidateArtifactHash: candidate.artifactHash
  };
  attachReceipt(runtime, ids.attempt, "provider", binding, "provider", ventureId);
  attachReceipt(
    runtime,
    ids.scoring,
    "scoring",
    {
      ...binding,
      metricId: evaluation.primaryMetric.id,
      formulaHash: sha256(evaluation.primaryMetric.formula),
      baselineValue: 0.7,
      candidateValue: 0.8,
      sampleSize: 1,
      populationHash,
      otherCostCents: 0,
      candidateComplexityUnits: 101,
      leakageDetected: false,
      heldOutChannel: "opaque-authenticated"
    },
    "evaluator",
    ventureId
  );
  attachReceipt(runtime, ids.terminal, "terminal", { ...binding, disposition: "keep", missingOutputs: [] }, "engine", ventureId);
  attachReceipt(
    runtime,
    ids.review,
    "reviewer",
    { ...binding, reviewerId: "reviewer", verdict: "keep" },
    "reviewer",
    ventureId
  );
  const boundPromotionEvidenceId = addBoundPromotionEvidence(runtime, evaluation, candidate, ids.scoring, ventureId);
  attachReceipt(
    runtime,
    ids.gate,
    "gate-proof",
    { ...binding, hardGateId: "gate_phase9_safety", evidenceRequirementHash: sha256(GATE_REQUIREMENT) },
    "reviewer",
    ventureId
  );
  const baseExperiment = experimentInput(goal, evaluation, candidate);
  const experimentRequest = ExperimentRecordInputSchema.parse({
    ...baseExperiment,
    ventureId,
    baselineReceiptId: ids.baseline,
    attempts: baseExperiment.attempts.map((attempt) => ({ ...attempt, receiptIds: [ids.attempt] })),
    receiptIds: [ids.baseline, ids.attempt, ids.scoring, ids.review, ids.gate],
    outcomeReceiptId: ids.attempt,
    primaryMetricResult: { ...baseExperiment.primaryMetricResult, scoringReceiptId: ids.scoring },
    hardGateResults: baseExperiment.hardGateResults.map((gate) => ({
      ...gate,
      evidenceIds: [ids.gate, boundPromotionEvidenceId]
    })),
    reviewer: { ...baseExperiment.reviewer, receiptId: ids.review },
    idempotencyKey: mismatchedOutcome ? "experiment-hwp-phase9-mismatch-v1" : "experiment-hwp-phase9-transfer-v1"
  });
  expectOk(await runtime.service.execute("experiment.record", experimentRequest));
  const experiment = runtime.storage.listExperimentRecords(ventureId, evaluation.id).at(-1);
  if (!experiment) throw new Error("HWP transfer experiment missing");
  return { ventureId, ids, evaluation, experiment, candidate };
}

async function createHeldOutOriginFixture(runtime: TestRuntime) {
  const initial = await createExperimentFixture(runtime);
  expectOk(await runtime.service.execute("play.promotion.record", promotionInput(initial.evaluation, initial.experiment, initial.candidate)));
  expectOk(
    await runtime.service.execute(
      "skill.version.record",
      candidateSkillInput(initial.candidate.artifactHash, {
        version: initial.candidate.version,
        state: "held-out-verified",
        evidenceIds: [promotionEvidenceId(initial.evaluation)],
        evaluationContractIds: [initial.evaluation.id],
        experimentRecordIds: [initial.experiment.id],
        supersedesSkillVersionId: initial.candidate.id,
        recordedBy: "promotion-authority",
        reason: "Advance the exact sealed candidate to held-out verification",
        idempotencyKey: "skill-phase9-held-out-origin-v1"
      })
    )
  );
  const candidate = runtime.storage
    .listSkillVersions(VENTURE_ID, { skillId: initial.candidate.skillId })
    .find((skill) => skill.state === "held-out-verified");
  if (!candidate || candidate.state !== "held-out-verified") throw new Error("held-out origin skill missing");
  const evaluationRequest = evaluationInput(currentPackRevisionId(runtime), initial.goal.id, candidate);
  expectOk(
    await runtime.service.execute("evaluation.create", {
      ...evaluationRequest,
      name: "Phase 9 held-out transfer evaluation",
      idempotencyKey: "evaluation-phase9-held-out-transfer-v1"
    })
  );
  const evaluation = runtime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
  if (!evaluation) throw new Error("held-out transfer evaluation missing");
  const ids = {
    attempt: "receipt_phase9_transfer_attempt",
    scoring: "receipt_phase9_transfer_scoring",
    review: "receipt_phase9_transfer_review",
    gate: "receipt_phase9_transfer_gate",
    terminal: "receipt_phase9_transfer_terminal"
  } as const;
  const binding = {
    evaluationContractId: evaluation.id,
    evaluationContractHash: evaluation.canonicalHash,
    candidateVersion: candidate.version,
    candidateArtifactHash: candidate.artifactHash
  };
  attachReceipt(runtime, ids.attempt, "provider", binding, "provider");
  attachReceipt(
    runtime,
    ids.scoring,
    "scoring",
    {
      ...binding,
      metricId: evaluation.primaryMetric.id,
      formulaHash: sha256(evaluation.primaryMetric.formula),
      baselineValue: 0.7,
      candidateValue: 0.8,
      sampleSize: 1,
      populationHash: POPULATION_HASH,
      otherCostCents: 0,
      candidateComplexityUnits: 101,
      leakageDetected: false,
      heldOutChannel: "opaque-authenticated"
    },
    "evaluator"
  );
  attachReceipt(runtime, ids.review, "reviewer", { ...binding, reviewerId: "reviewer", verdict: "keep" }, "reviewer");
  attachReceipt(
    runtime,
    ids.gate,
    "gate-proof",
    { ...binding, hardGateId: "gate_phase9_safety", evidenceRequirementHash: sha256(GATE_REQUIREMENT) },
    "reviewer"
  );
  attachReceipt(runtime, ids.terminal, "terminal", { ...binding, disposition: "keep", missingOutputs: [] }, "engine");
  const boundPromotionEvidenceId = addBoundPromotionEvidence(runtime, evaluation, candidate, ids.scoring);
  const baseExperiment = experimentInput(initial.goal, evaluation, candidate);
  const experimentRequest = ExperimentRecordInputSchema.parse({
    ...baseExperiment,
    attempts: baseExperiment.attempts.map((attempt) => ({ ...attempt, receiptIds: [ids.attempt] })),
    receiptIds: [RECEIPTS.baseline, ids.attempt, ids.scoring, ids.review, ids.gate],
    outcomeReceiptId: ids.attempt,
    primaryMetricResult: { ...baseExperiment.primaryMetricResult, scoringReceiptId: ids.scoring },
    hardGateResults: baseExperiment.hardGateResults.map((gate) => ({
      ...gate,
      evidenceIds: [ids.gate, boundPromotionEvidenceId]
    })),
    reviewer: { ...baseExperiment.reviewer, receiptId: ids.review },
    idempotencyKey: "experiment-phase9-held-out-transfer-v1"
  });
  expectOk(await runtime.service.execute("experiment.record", experimentRequest));
  const experiment = runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id).at(-1);
  if (!experiment) throw new Error("held-out transfer experiment missing");
  return { ...initial, candidate, evaluation, experiment };
}

function businessStateHash(runtime: TestRuntime): string {
  const venture = runtime.storage.getVenture(VENTURE_ID);
  return sha256({
    venture: venture
      ? {
          lifecycleState: venture.lifecycle_state,
          killSwitch: venture.kill_switch,
          packHash: venture.current_pack_hash,
          packRevisionId: venture.current_pack_revision_id
        }
      : null,
    goalHash: runtime.storage.getLatestGoalRevision(VENTURE_ID)?.canonicalHash ?? null,
    evidence: runtime.storage.listEvidence(VENTURE_ID),
    tasks: runtime.storage.listTasks(VENTURE_ID),
    receipts: runtime.storage.listReceipts(VENTURE_ID).filter((receipt) => receipt.metadata.receiptType !== "terminal"),
    metrics: runtime.storage.listMetrics(VENTURE_ID)
  });
}

describe("Phase 9 service boundaries", () => {
  it("plans gate-derived evidence modes under a v2 idempotency boundary", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      expectOk(
        await runtime.service.execute("venture.create_or_update_pack", {
          packPath: path.join(runtime.root, "ventures/example-b/pack.yaml")
        })
      );
      const bsd = unwrap<PlannedTaskView>(
        expectOk(await runtime.service.execute("task.plan", { ventureId: "venture_example_a", playId: "play_example_a_channel_evidence_v1" })),
        "task"
      );
      const hwp = unwrap<PlannedTaskView>(
        expectOk(await runtime.service.execute("task.plan", { ventureId: "venture_example_c", playId: "play_example_c_channel_evidence_v1" })),
        "task"
      );
      const gtme = unwrap<PlannedTaskView>(
        expectOk(
          await runtime.service.execute("task.plan", {
            ventureId: "venture_example_b",
            playId: "play_example_b_front_door_comprehension_v1"
          })
        ),
        "task"
      );
      for (const task of [bsd, hwp]) {
        expect(task.idempotencyKey).toContain(":v2");
        expect(task.actionBounds).toMatchObject({ publicResearchOnly: true, evidenceMode: "public-research" });
      }
      expect(gtme.idempotencyKey).toContain(":v2");
      expect(gtme.actionBounds).toMatchObject({ publicResearchOnly: false, evidenceMode: "pack-sources-only" });
    } finally {
      await runtime.cleanup();
    }
  });

  it("previews deterministically, replays confirmation, and rejects an idempotency conflict", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const input = goalInput();
      const firstPreview = await previewGoal(runtime, input);
      const replayedPreview = await previewGoal(runtime, input);
      expect(replayedPreview).toEqual(firstPreview);

      const firstGoal = await confirmGoal(runtime, input, firstPreview);
      const replay = await runtime.service.execute("goal.confirm_change", {
        ...input,
        founderConfirmation: {
          previewId: firstPreview.previewId,
          previewHash: firstPreview.previewHash,
          confirmedBy: "founder",
          authority: "Founder confirmation in a bounded service fixture",
          confirmedAt: START
        }
      });
      expectOk(replay);
      expect(runtime.storage.listGoalRevisions(VENTURE_ID)).toHaveLength(1);

      const changed = goalInput({
        target: "A materially different target",
        expectedGoalRevisionId: firstGoal.id
      });
      const changedPreview = await previewGoal(runtime, changed);
      const conflict = await runtime.service.execute("goal.confirm_change", {
        ...changed,
        founderConfirmation: {
          previewId: changedPreview.previewId,
          previewHash: changedPreview.previewHash,
          confirmedBy: "founder",
          authority: "Founder confirmation in a bounded service fixture",
          confirmedAt: END
        }
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.error?.message).toMatch(/conflict|idempot/i);
      expect(runtime.storage.listGoalRevisions(VENTURE_ID).map((goal) => goal.id)).toEqual([firstGoal.id]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("replays an identical evaluation contract and rejects mutation under the same key", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const goal = await confirmGoal(runtime, goalInput(), await previewGoal(runtime, goalInput()));
      const candidate = await createCandidateSkill(runtime);
      const input = evaluationInput(currentPackRevisionId(runtime), goal.id, candidate);
      expectOk(await runtime.service.execute("evaluation.create", input));
      expectOk(await runtime.service.execute("evaluation.create", input));
      expect(runtime.storage.listEvaluationContracts(VENTURE_ID)).toHaveLength(1);

      const conflict = await runtime.service.execute("evaluation.create", {
        ...input,
        hypothesis: "A different hypothesis cannot overwrite the frozen contract"
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.error?.message).toMatch(/conflict|idempot|immutable/i);
      expect(runtime.storage.listEvaluationContracts(VENTURE_ID)[0]?.hypothesis).toBe(input.hypothesis);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects an evaluator whose observation window already ended before freeze", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const goal = await confirmGoal(runtime, goalInput(), await previewGoal(runtime, goalInput()));
      const candidate = await createCandidateSkill(runtime);
      const input = evaluationInput(currentPackRevisionId(runtime), goal.id, candidate);
      const response = await runtime.service.execute("evaluation.create", {
        ...input,
        observationWindow: {
          startsAt: new Date(Date.now() - 120_000).toISOString(),
          endsAt: new Date(Date.now() - 60_000).toISOString()
        },
        idempotencyKey: "evaluation-phase9-expired-window-v1"
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("evaluation-window-expired");
      expect(runtime.storage.listEvaluationContracts(VENTURE_ID)).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects attempts that predate the frozen evaluator", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const goal = await confirmGoal(runtime, goalInput(), await previewGoal(runtime, goalInput()));
      const candidate = await createCandidateSkill(runtime);
      const input = evaluationInput(currentPackRevisionId(runtime), goal.id, candidate);
      expectOk(
        await runtime.service.execute("evaluation.create", {
          ...input,
          observationWindow: {
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: new Date(Date.now() + 60 * 60_000).toISOString()
          },
          idempotencyKey: "evaluation-phase9-temporal-boundary-v1"
        })
      );
      const evaluation = runtime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
      if (!evaluation) throw new Error("temporal-boundary evaluation missing");
      seedBoundExperimentReceipts(runtime, evaluation, candidate);
      const base = experimentInput(goal, evaluation, candidate);
      const startedAt = new Date(Date.parse(evaluation.frozenAt) - 1_000).toISOString();
      const completedAt = evaluation.frozenAt;
      const response = await runtime.service.execute("experiment.record", {
        ...base,
        attempts: base.attempts.map((attempt) => ({ ...attempt, startedAt, completedAt, elapsedMs: 1_000 })),
        idempotencyKey: "experiment-phase9-predates-evaluator-v1"
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("experiment-predates-evaluator");
      expect(runtime.storage.listExperimentRecords(VENTURE_ID)).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("records a kept experiment without changing venture business state", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(runtime);
      const before = businessStateHash(runtime);
      expectOk(await runtime.service.execute("experiment.record", experimentInput(goal, evaluation, candidate)));
      const experiments = runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id);
      expect(experiments).toHaveLength(1);
      expect(experiments[0]?.disposition).toBe("keep");
      expect(businessStateHash(runtime)).toBe(before);
      expect(runtime.storage.getVenture(VENTURE_ID)?.lifecycle_state).toBe("externally-live");
    } finally {
      await runtime.cleanup();
    }
  });

  it("freezes manual-local baselines but rejects them from keep", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime, { baselineTrust: "manual-local", promotionEligible: false });
      const { goal, evaluation, candidate } = await createEvaluationFixture(runtime);
      const response = await runtime.service.execute("experiment.record", {
        ...experimentInput(goal, evaluation, candidate),
        idempotencyKey: "experiment-phase9-manual-baseline-keep-v1"
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("baseline-non-promotable");
      expect(runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id)).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("verifies receipt attachment bytes and containment before stamping attached-artifact origin", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const receiptDirectory = path.join(runtime.root, "receipts");
      const artifactPath = path.join(receiptDirectory, "phase9-attached.md");
      await mkdir(receiptDirectory, { recursive: true });
      await cp(path.join(process.cwd(), "skills/run-bounded-gtme-experiment/SKILL.md"), artifactPath);
      const contentHash = sha256(await readFile(artifactPath, "utf8"));
      const input = {
        id: "receipt_phase9_attached",
        ventureId: VENTURE_ID,
        proofTier: "scaffolded" as const,
        outcome: "success" as const,
        actor: "phase9-service-test",
        adapter: "manual-attachment",
        artifactPath: "receipts/phase9-attached.md",
        contentHash,
        occurredAt: START,
        metadata: { receiptType: "supporting-artifact" }
      };

      expectOk(await runtime.service.execute("receipt.attach", input));
      expect(runtime.storage.listReceipts(VENTURE_ID).find((receipt) => receipt.id === input.id)).toMatchObject({
        artifactPath: await realpath(artifactPath),
        origin: "attached-artifact"
      });

      const injectedOrigin = await runtime.service.execute("receipt.attach", { ...input, id: "receipt_phase9_origin_injected", origin: "dispatch" });
      expect(injectedOrigin.ok).toBe(false);
      expect(injectedOrigin.error?.code).toBe("invalid-input");

      const outsidePath = path.join(runtime.root, "ventures/example-a/pack.yaml");
      const outside = await runtime.service.execute("receipt.attach", {
        ...input,
        id: "receipt_phase9_outside",
        artifactPath: outsidePath,
        contentHash: sha256(await readFile(outsidePath, "utf8"))
      });
      expect(outside.ok).toBe(false);
      expect(outside.error?.code).toBe("receipt-artifact-outside-root");

      const mismatched = await runtime.service.execute("receipt.attach", {
        ...input,
        id: "receipt_phase9_hash_mismatch",
        contentHash: sha256("different bytes")
      });
      expect(mismatched.ok).toBe(false);
      expect(mismatched.error?.code).toBe("receipt-artifact-hash-mismatch");
    } finally {
      await runtime.cleanup();
    }
  });

  it("records gated zero-attempt experiments while preserving known zero versus unknown null", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(runtime);
      const zeroTerminal = "receipt_phase9_gated_zero_terminal";
      const zeroMissing = ["attempts", "outcomeReceiptId", "primaryMetricResult", "hardGateResults", "reviewer"] as const;
      attachTerminalReceipt(runtime, evaluation, candidate, zeroTerminal, "gated", zeroMissing);
      const zeroInput = incompleteExperimentInput(goal, evaluation, candidate, zeroTerminal, {
        missingOutputs: zeroMissing,
        idempotencyKey: "experiment-phase9-gated-known-zero-v1"
      });
      expectOk(await runtime.service.execute("experiment.record", zeroInput));

      const nullTerminal = "receipt_phase9_gated_unknown_terminal";
      const nullMissing = [
        "attempts",
        "costs.providerCostCents",
        "costs.modelCostCents",
        "costs.otherCostCents",
        "costs.founderMinutes",
        "costs.reviewerMinutes",
        "costs.elapsedMs",
        "outcomeReceiptId",
        "primaryMetricResult",
        "hardGateResults",
        "reviewer"
      ] as const;
      attachTerminalReceipt(runtime, evaluation, candidate, nullTerminal, "gated", nullMissing);
      const nullInput = incompleteExperimentInput(goal, evaluation, candidate, nullTerminal, {
        costs: {
          providerCostCents: null,
          modelCostCents: null,
          otherCostCents: null,
          founderMinutes: null,
          reviewerMinutes: null,
          elapsedMs: null
        },
        missingOutputs: nullMissing,
        idempotencyKey: "experiment-phase9-gated-unknown-null-v1"
      });
      expectOk(await runtime.service.execute("experiment.record", nullInput));

      const records = runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id);
      const knownZero = records.find((record) => record.idempotencyKey === "experiment-phase9-gated-known-zero-v1");
      const unknown = records.find((record) => record.idempotencyKey === "experiment-phase9-gated-unknown-null-v1");
      expect(knownZero?.attempts).toEqual([]);
      expect(knownZero?.costs).toEqual({
        providerCostCents: 0,
        modelCostCents: 0,
        otherCostCents: 0,
        founderMinutes: 0,
        reviewerMinutes: 0,
        elapsedMs: 0
      });
      expect(knownZero?.missingOutputs).toEqual([...zeroMissing]);
      expect(unknown?.costs).toEqual({
        providerCostCents: null,
        modelCostCents: null,
        otherCostCents: null,
        founderMinutes: null,
        reviewerMinutes: null,
        elapsedMs: null
      });
      expect(unknown?.missingOutputs).toEqual([...nullMissing]);

      if (!knownZero) throw new Error("known-zero gated experiment missing");
      const promotion = await runtime.service.execute("play.promotion.record", promotionInput(evaluation, knownZero, candidate));
      expect(promotion.ok).toBe(false);
      expect(promotion.error?.code).toBe("promotion-proof-insufficient");
    } finally {
      await runtime.cleanup();
    }
  });

  it("preserves exact missing outputs for inconclusive, crash, and unsafe terminals", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(runtime);
      const bindingReceipts = [RECEIPTS.baseline, RECEIPTS.attempt];
      const attempt = {
        attempt: 1,
        startedAt: START,
        completedAt: ATTEMPT_END,
        candidateHash: candidate.artifactHash,
        outcome: "failed" as const,
        receiptIds: [RECEIPTS.attempt],
        providerCostCents: 0,
        modelCostCents: 0,
        elapsedMs: 1_000,
        founderMinutes: 0,
        reviewerMinutes: 0,
        sideEffects: [],
        confounders: []
      };

      const inconclusiveTerminal = "receipt_phase9_inconclusive_terminal";
      const inconclusiveMissing = [
        "attempts.costs",
        "costs.providerCostCents",
        "costs.modelCostCents",
        "costs.founderMinutes",
        "costs.reviewerMinutes",
        "costs.elapsedMs",
        "primaryMetricResult",
        "reviewer"
      ] as const;
      attachTerminalReceipt(runtime, evaluation, candidate, inconclusiveTerminal, "inconclusive", inconclusiveMissing);
      const inconclusive = incompleteExperimentInput(goal, evaluation, candidate, inconclusiveTerminal, {
        attempts: [
          {
            ...attempt,
            providerCostCents: null,
            modelCostCents: null,
            elapsedMs: null,
            founderMinutes: null,
            reviewerMinutes: null
          }
        ],
        costs: {
          providerCostCents: null,
          modelCostCents: null,
          otherCostCents: 0,
          founderMinutes: null,
          reviewerMinutes: null,
          elapsedMs: null
        },
        receiptIds: [...bindingReceipts, RECEIPTS.gate],
        outcomeReceiptId: RECEIPTS.attempt,
        hardGateResults: [
          {
            hardGateId: "gate_phase9_safety",
            passed: true,
            evidenceIds: [RECEIPTS.gate],
            reason: "The attempt remained bounded"
          }
        ],
        missingOutputs: inconclusiveMissing,
        disposition: "inconclusive",
        implementationState: "reverted",
        idempotencyKey: "experiment-phase9-inconclusive-exact-missing-v1"
      });
      expectOk(await runtime.service.execute("experiment.record", inconclusive));

      const terminalCases = [
        { disposition: "crash" as const, outcome: "crashed" as const, terminal: "receipt_phase9_crash_terminal" },
        { disposition: "unsafe" as const, outcome: "unsafe" as const, terminal: "receipt_phase9_unsafe_terminal" }
      ];
      const terminalMissing = ["primaryMetricResult", "hardGateResults", "reviewer"] as const;
      for (const terminalCase of terminalCases) {
        attachTerminalReceipt(runtime, evaluation, candidate, terminalCase.terminal, terminalCase.disposition, terminalMissing);
        const input = incompleteExperimentInput(goal, evaluation, candidate, terminalCase.terminal, {
          attempts: [{ ...attempt, outcome: terminalCase.outcome }],
          costs: {
            providerCostCents: 0,
            modelCostCents: 0,
            otherCostCents: 0,
            founderMinutes: 0,
            reviewerMinutes: 0,
            elapsedMs: 1_000
          },
          receiptIds: [...bindingReceipts],
          outcomeReceiptId: RECEIPTS.attempt,
          missingOutputs: terminalMissing,
          disposition: terminalCase.disposition,
          implementationState: "reverted",
          idempotencyKey: `experiment-phase9-${terminalCase.disposition}-exact-missing-v1`
        });
        expectOk(await runtime.service.execute("experiment.record", input));
      }

      const records = runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id);
      expect(records.find((record) => record.disposition === "inconclusive")?.missingOutputs).toEqual([...inconclusiveMissing]);
      for (const terminalCase of terminalCases) {
        expect(records.find((record) => record.disposition === terminalCase.disposition)?.missingOutputs).toEqual([...terminalMissing]);
      }
    } finally {
      await runtime.cleanup();
    }
  });

  it("requires a frozen score and independent review for keep and discard", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(runtime, {
        scoring: { candidateValue: 0.7 },
        review: { verdict: "discard" },
        terminal: { disposition: "discard" }
      });
      const kept = experimentInput(goal, evaluation, candidate);
      const incompleteKeep = await runtime.service.execute("experiment.record", {
        ...kept,
        reviewer: null,
        missingOutputs: ["reviewer"],
        idempotencyKey: "experiment-phase9-keep-without-review-v1"
      });
      expect(incompleteKeep.ok).toBe(false);
      expect(incompleteKeep.error?.code).toBe("invalid-input");

      const discard = ExperimentRecordInputSchema.parse({
        ...kept,
        primaryMetricResult: {
          ...kept.primaryMetricResult,
          candidateValue: 0.7,
          improvement: 0,
          thresholdPassed: false
        },
        reviewer: { ...kept.reviewer, verdict: "discard" },
        disposition: "discard",
        implementationState: "reverted",
        idempotencyKey: "experiment-phase9-valid-discard-v1"
      });
      const incompleteDiscard = await runtime.service.execute("experiment.record", {
        ...discard,
        primaryMetricResult: null,
        missingOutputs: ["primaryMetricResult"],
        idempotencyKey: "experiment-phase9-discard-without-score-v1"
      });
      expect(incompleteDiscard.ok).toBe(false);
      expect(incompleteDiscard.error?.code).toBe("invalid-input");

      expectOk(await runtime.service.execute("experiment.record", discard));
      expect(runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id)).toHaveLength(1);
      expect(runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id)[0]?.disposition).toBe("discard");
    } finally {
      await runtime.cleanup();
    }
  });

  it("honors each frozen hard-gate failure disposition and rejects a terminal mismatch", async () => {
    for (const failureDisposition of ["gated", "discard", "unsafe"] as const) {
      const runtime = await tempRuntime();
      try {
        await runtime.loadPacks();
        seedEvaluationEvidence(runtime);
        const goal = await confirmGoal(runtime, goalInput(), await previewGoal(runtime, goalInput()));
        const candidate = await createCandidateSkill(runtime);
        const baseEvaluation = evaluationInput(currentPackRevisionId(runtime), goal.id, candidate);
        const request = EvaluationContractInputSchema.parse({
          ...baseEvaluation,
          hardGates: baseEvaluation.hardGates.map((gate) => ({ ...gate, failureDisposition })),
          idempotencyKey: `evaluation-phase9-failed-gate-${failureDisposition}-v1`
        });
        expectOk(await runtime.service.execute("evaluation.create", request));
        const evaluation = runtime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
        if (!evaluation) throw new Error(`failed-gate evaluation missing: ${failureDisposition}`);
        seedBoundExperimentReceipts(
          runtime,
          evaluation,
          candidate,
          failureDisposition === "discard"
            ? { scoring: { candidateValue: 0.7 }, review: { verdict: "discard" } }
            : {}
        );
        const terminalId = `receipt_phase9_failed_gate_${failureDisposition}_terminal`;
        const missingOutputs =
          failureDisposition === "discard"
            ? ([] as const)
            : (["attempts", "outcomeReceiptId", "primaryMetricResult", "reviewer"] as const);
        attachTerminalReceipt(runtime, evaluation, candidate, terminalId, failureDisposition, missingOutputs);

        const failedGate = {
          hardGateId: "gate_phase9_safety",
          passed: false,
          evidenceIds: [RECEIPTS.gate],
          reason: `The frozen gate requires ${failureDisposition}`
        };
        const input =
          failureDisposition === "discard"
            ? ExperimentRecordInputSchema.parse({
                ...experimentInput(goal, evaluation, candidate),
                receiptIds: [
                  RECEIPTS.baseline,
                  RECEIPTS.attempt,
                  RECEIPTS.scoring,
                  RECEIPTS.review,
                  RECEIPTS.gate
                ],
                primaryMetricResult: {
                  metricId: "metric_phase9_quality",
                  baselineValue: 0.7,
                  candidateValue: 0.7,
                  improvement: 0,
                  sampleSize: 1,
                  thresholdPassed: false,
                  scoringReceiptId: RECEIPTS.scoring
                },
                hardGateResults: [failedGate],
                reviewer: {
                  reviewerId: "reviewer",
                  reviewedAt: END,
                  independentFromProducer: true,
                  receiptId: RECEIPTS.review,
                  verdict: "discard",
                  notes: "The failed frozen gate requires discard"
                },
                disposition: "discard",
                implementationState: "reverted",
                idempotencyKey: "experiment-phase9-failed-gate-discard-v1"
              })
            : incompleteExperimentInput(goal, evaluation, candidate, terminalId, {
                receiptIds: [RECEIPTS.baseline, RECEIPTS.gate],
                hardGateResults: [failedGate],
                missingOutputs,
                disposition: failureDisposition,
                implementationState: "not-applied",
                idempotencyKey: `experiment-phase9-failed-gate-${failureDisposition}-v1`
              });
        expectOk(await runtime.service.execute("experiment.record", input));
        expect(runtime.storage.listExperimentRecords(VENTURE_ID, evaluation.id)[0]?.disposition).toBe(failureDisposition);

        if (failureDisposition === "gated") {
          const mismatchTerminal = "receipt_phase9_failed_gate_mismatch_terminal";
          attachTerminalReceipt(runtime, evaluation, candidate, mismatchTerminal, "unsafe", missingOutputs);
          const mismatch = incompleteExperimentInput(goal, evaluation, candidate, mismatchTerminal, {
            receiptIds: [RECEIPTS.baseline, RECEIPTS.gate],
            hardGateResults: [failedGate],
            missingOutputs,
            disposition: "unsafe",
            implementationState: "not-applied",
            idempotencyKey: "experiment-phase9-failed-gate-mismatch-v1"
          });
          const response = await runtime.service.execute("experiment.record", mismatch);
          expect(response.ok).toBe(false);
          expect(response.error?.code).toBe("hard-gate-disposition-mismatch");
        }
      } finally {
        await runtime.cleanup();
      }
    }
  });

  it("fails closed when failed frozen hard gates require conflicting dispositions", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const goal = await confirmGoal(runtime, goalInput(), await previewGoal(runtime, goalInput()));
      const candidate = await createCandidateSkill(runtime);
      const baseEvaluation = evaluationInput(currentPackRevisionId(runtime), goal.id, candidate);
      const secondRequirement = "Independent provider authorization";
      const request = EvaluationContractInputSchema.parse({
        ...baseEvaluation,
        hardGates: [
          { ...baseEvaluation.hardGates[0], failureDisposition: "gated" },
          {
            id: "gate_phase9_provider_authority",
            description: "Provider authority is present",
            evidenceRequirement: secondRequirement,
            failureDisposition: "unsafe"
          }
        ],
        idempotencyKey: "evaluation-phase9-conflicting-gates-v1"
      });
      expectOk(await runtime.service.execute("evaluation.create", request));
      const evaluation = runtime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
      if (!evaluation) throw new Error("conflicting-gate evaluation missing");
      seedBoundExperimentReceipts(runtime, evaluation, candidate);
      const binding = {
        evaluationContractId: evaluation.id,
        evaluationContractHash: evaluation.canonicalHash,
        candidateVersion: candidate.version,
        candidateArtifactHash: candidate.artifactHash
      };
      const secondGateReceipt = "receipt_phase9_conflicting_gate";
      attachReceipt(
        runtime,
        secondGateReceipt,
        "gate-proof",
        {
          ...binding,
          hardGateId: "gate_phase9_provider_authority",
          evidenceRequirementHash: sha256(secondRequirement)
        },
        "reviewer"
      );
      const terminalId = "receipt_phase9_conflicting_gate_terminal";
      const missingOutputs = ["attempts", "outcomeReceiptId", "primaryMetricResult", "reviewer"] as const;
      attachTerminalReceipt(runtime, evaluation, candidate, terminalId, "unsafe", missingOutputs);
      const input = incompleteExperimentInput(goal, evaluation, candidate, terminalId, {
        receiptIds: [RECEIPTS.baseline, RECEIPTS.gate, secondGateReceipt],
        hardGateResults: [
          {
            hardGateId: "gate_phase9_safety",
            passed: false,
            evidenceIds: [RECEIPTS.gate],
            reason: "The first frozen gate failed"
          },
          {
            hardGateId: "gate_phase9_provider_authority",
            passed: false,
            evidenceIds: [secondGateReceipt],
            reason: "The second frozen gate failed"
          }
        ],
        missingOutputs,
        disposition: "unsafe",
        implementationState: "not-applied",
        idempotencyKey: "experiment-phase9-conflicting-gates-v1"
      });
      const response = await runtime.service.execute("experiment.record", input);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("hard-gate-disposition-conflict");
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects weak scoring origins and a dispatch whose stored task lacks evaluator bindings", async () => {
    const weakOrigins: Array<{ label: string; provenance: ReceiptProvenance }> = [
      { label: "attached-artifact", provenance: { origin: "attached-artifact" } },
      { label: "fixture-origin", provenance: { origin: "fixture" } },
      { label: "legacy", provenance: { origin: "legacy" } },
      { label: "fixture-adapter", provenance: { origin: "engine-derived", adapter: "fixture" } }
    ];
    for (const weak of weakOrigins) {
      const runtime = await tempRuntime();
      try {
        await runtime.loadPacks();
        seedEvaluationEvidence(runtime);
        const { goal, evaluation, candidate } = await createEvaluationFixture(runtime, {}, { scoring: weak.provenance });
        const response = await runtime.service.execute("experiment.record", experimentInput(goal, evaluation, candidate));
        expect(response.ok, weak.label).toBe(false);
        expect(response.error?.code, weak.label).toBe("receipt-origin-untrusted");
      } finally {
        await runtime.cleanup();
      }
    }

    const dispatchRuntime = await tempRuntime();
    try {
      await dispatchRuntime.loadPacks();
      seedEvaluationEvidence(dispatchRuntime);
      const goal = await confirmGoal(dispatchRuntime, goalInput(), await previewGoal(dispatchRuntime, goalInput()));
      const candidate = await createCandidateSkill(dispatchRuntime);
      expectOk(
        await dispatchRuntime.service.execute(
          "evaluation.create",
          evaluationInput(currentPackRevisionId(dispatchRuntime), goal.id, candidate)
        )
      );
      const evaluation = dispatchRuntime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
      if (!evaluation) throw new Error("dispatch-bound evaluation missing");
      const task = TaskDefinitionSchema.parse({
        id: "task_phase9_scoring_spoof",
        ventureId: VENTURE_ID,
        purpose: "Score the frozen candidate",
        expectedOutcome: "An authoritative scoring receipt",
        ownerRole: "evaluator",
        dependencies: [],
        sourceRefs: ["case_phase9_001"],
        mode: "internal-read-only",
        expectedProof: "Candidate-bound scoring receipt",
        gateClass: "public-research-free",
        actionBounds: {},
        budgetCents: 0,
        costCeilingCents: 0,
        approvalRequired: false,
        idempotencyKey: "task-phase9-scoring-spoof-v1",
        maxAttempts: 1,
        backoffMs: 0,
        timeoutMs: 10_000,
        lifecycleEffect: {},
        metricEffects: []
      });
      dispatchRuntime.storage.createTask(task, sha256(task), "succeeded");
      dispatchRuntime.storage.createDispatch({
        ventureId: VENTURE_ID,
        id: "dispatch_phase9_scoring_spoof",
        taskId: task.id,
        adapter: "hermes-kanban",
        ownerRole: "evaluator"
      });
      dispatchRuntime.storage.updateDispatch({
        ventureId: VENTURE_ID,
        id: "dispatch_phase9_scoring_spoof",
        status: "completed",
        startedAt: START,
        completedAt: ATTEMPT_END,
        result: { outcome: "success" }
      });
      seedBoundExperimentReceipts(
        dispatchRuntime,
        evaluation,
        candidate,
        {},
        {
          scoring: {
            origin: "dispatch",
            adapter: "hermes-kanban",
            taskId: task.id,
            dispatchId: "dispatch_phase9_scoring_spoof"
          }
        }
      );
      const response = await dispatchRuntime.service.execute("experiment.record", experimentInput(goal, evaluation, candidate));
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("dispatch-evaluation-binding-missing");
    } finally {
      await dispatchRuntime.cleanup();
    }
  });

  it("marks fixture worker receipts as fixture provenance", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const planned = unwrap<{ id: string }>(
        expectOk(await runtime.service.execute("task.plan", { ventureId: VENTURE_ID })),
        "task"
      );
      expectOk(await runtime.service.execute("task.run_safe", { ventureId: VENTURE_ID, taskId: planned.id }));
      expect((await runtime.worker.runOnce())?.outcome).toBe("success");
      const receipt = runtime.storage.listReceipts(VENTURE_ID).find((candidate) => candidate.taskId === planned.id);
      expect(receipt).toMatchObject({ adapter: "fixture", origin: "fixture", proofTier: "fixture-verified" });
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects experiment substitution of the frozen skill, version, or artifact", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(runtime);
      const otherSkill = await createCandidateSkill(runtime, {
        skillId: "skill_phase9_unrelated",
        name: "Unrelated candidate",
        idempotencyKey: "skill-phase9-unrelated-v1"
      });
      const base = experimentInput(goal, evaluation, candidate);
      const wrongSkill = await runtime.service.execute("experiment.record", {
        ...base,
        skillVersionId: otherSkill.id,
        idempotencyKey: "experiment-phase9-wrong-skill-v1"
      });
      expect(wrongSkill.ok).toBe(false);
      expect(wrongSkill.error?.code).toBe("skill-version-mismatch");

      const wrongVersion = await runtime.service.execute("experiment.record", {
        ...base,
        candidateVersion: "0.2.0",
        idempotencyKey: "experiment-phase9-wrong-version-v1"
      });
      expect(wrongVersion.ok).toBe(false);
      expect(wrongVersion.error?.code).toBe("candidate-version-mismatch");

      const foreignHash = sha256("unrelated-artifact");
      const wrongArtifact = await runtime.service.execute("experiment.record", {
        ...base,
        candidateArtifactHash: foreignHash,
        attempts: base.attempts.map((attempt) => ({ ...attempt, candidateHash: foreignHash })),
        idempotencyKey: "experiment-phase9-wrong-artifact-v1"
      });
      expect(wrongArtifact.ok).toBe(false);
      expect(wrongArtifact.error?.code).toBe("candidate-artifact-mismatch");
      expect(runtime.storage.listExperimentRecords(VENTURE_ID)).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects baseline substitution, empty hard-gate proof, and falsified elapsed time", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(runtime);
      const base = experimentInput(goal, evaluation, candidate);

      const baselineSwap = await runtime.service.execute("experiment.record", {
        ...base,
        baselineReceiptId: RECEIPTS.plainAgent,
        receiptIds: base.receiptIds.map((receiptId) => (receiptId === RECEIPTS.baseline ? RECEIPTS.plainAgent : receiptId)),
        idempotencyKey: "experiment-phase9-baseline-swap-v1"
      });
      expect(baselineSwap.ok).toBe(false);
      expect(baselineSwap.error?.code).toBe("baseline-mismatch");

      const emptyGateProof = await runtime.service.execute("experiment.record", {
        ...base,
        hardGateResults: base.hardGateResults.map((gate) => ({ ...gate, evidenceIds: [] })),
        idempotencyKey: "experiment-phase9-empty-gate-v1"
      });
      expect(emptyGateProof.ok).toBe(false);
      expect(emptyGateProof.error?.code).toBe("invalid-input");

      const falsifiedElapsed = await runtime.service.execute("experiment.record", {
        ...base,
        attempts: base.attempts.map((attempt) => ({ ...attempt, elapsedMs: 1 })),
        costs: { ...base.costs, elapsedMs: 1 },
        idempotencyKey: "experiment-phase9-false-elapsed-v1"
      });
      expect(falsifiedElapsed.ok).toBe(false);
      expect(falsifiedElapsed.error?.code).toBe("attempt-elapsed-mismatch");
      expect(runtime.storage.listExperimentRecords(VENTURE_ID)).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("requires typed candidate-bound receipts and an exact frozen sample commitment", async () => {
    const badTypeRuntime = await tempRuntime();
    try {
      await badTypeRuntime.loadPacks();
      seedEvaluationEvidence(badTypeRuntime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(badTypeRuntime, {
        attempt: { receiptType: "opaque" }
      });
      const response = await badTypeRuntime.service.execute("experiment.record", experimentInput(goal, evaluation, candidate));
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("expected-receipt-missing");
    } finally {
      await badTypeRuntime.cleanup();
    }

    const badGateRuntime = await tempRuntime();
    try {
      await badGateRuntime.loadPacks();
      seedEvaluationEvidence(badGateRuntime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(badGateRuntime, {
        gate: { hardGateId: "gate_unrelated" }
      });
      const response = await badGateRuntime.service.execute("experiment.record", experimentInput(goal, evaluation, candidate));
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("hard-gate-proof-mismatch");
    } finally {
      await badGateRuntime.cleanup();
    }

    const badSampleRuntime = await tempRuntime();
    try {
      await badSampleRuntime.loadPacks();
      seedEvaluationEvidence(badSampleRuntime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(badSampleRuntime, {
        scoring: { sampleSize: 2 }
      });
      const base = experimentInput(goal, evaluation, candidate);
      const response = await badSampleRuntime.service.execute("experiment.record", {
        ...base,
        primaryMetricResult: { ...base.primaryMetricResult, sampleSize: 2 },
        idempotencyKey: "experiment-phase9-sample-inflation-v1"
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("sample-population-mismatch");
    } finally {
      await badSampleRuntime.cleanup();
    }
  });

  it("enforces the stronger promotion metric threshold and derived frozen-baseline tolerances", async () => {
    const thresholdRuntime = await tempRuntime();
    try {
      await thresholdRuntime.loadPacks();
      seedEvaluationEvidence(thresholdRuntime);
      const goal = await confirmGoal(thresholdRuntime, goalInput(), await previewGoal(thresholdRuntime, goalInput()));
      const candidate = await createCandidateSkill(thresholdRuntime);
      const baseEvaluation = evaluationInput(currentPackRevisionId(thresholdRuntime), goal.id, candidate);
      const promotionRule = { ...baseEvaluation.promotionRule, minimumPrimaryMetricImprovement: 0.15 };
      expectOk(
        await thresholdRuntime.service.execute("evaluation.create", {
          ...baseEvaluation,
          promotionRule,
          promotionRuleHash: sha256(promotionRule),
          idempotencyKey: "evaluation-phase9-strong-threshold-v1"
        })
      );
      const evaluation = thresholdRuntime.storage.listEvaluationContracts(VENTURE_ID).at(-1);
      if (!evaluation) throw new Error("strong-threshold evaluation missing");
      seedBoundExperimentReceipts(thresholdRuntime, evaluation, candidate);
      const response = await thresholdRuntime.service.execute("experiment.record", experimentInput(goal, evaluation, candidate));
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("metric-threshold-mismatch");
    } finally {
      await thresholdRuntime.cleanup();
    }

    const costRuntime = await tempRuntime();
    try {
      await costRuntime.loadPacks();
      seedEvaluationEvidence(costRuntime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(costRuntime);
      const base = experimentInput(goal, evaluation, candidate);
      const excessiveCost = await costRuntime.service.execute("experiment.record", {
        ...base,
        attempts: base.attempts.map((attempt) => ({ ...attempt, providerCostCents: 35 })),
        costs: { ...base.costs, providerCostCents: 35 },
        idempotencyKey: "experiment-phase9-cost-tolerance-v1"
      });
      expect(excessiveCost.ok).toBe(false);
      expect(excessiveCost.error?.code).toBe("experiment-tolerance-exceeded");

      const founderIncrease = await costRuntime.service.execute("experiment.record", {
        ...base,
        attempts: base.attempts.map((attempt) => ({ ...attempt, founderMinutes: 1 })),
        costs: { ...base.costs, founderMinutes: 1 },
        idempotencyKey: "experiment-phase9-founder-tolerance-v1"
      });
      expect(founderIncrease.ok).toBe(false);
      expect(founderIncrease.error?.code).toBe("experiment-tolerance-exceeded");
    } finally {
      await costRuntime.cleanup();
    }

    const complexityRuntime = await tempRuntime();
    try {
      await complexityRuntime.loadPacks();
      seedEvaluationEvidence(complexityRuntime);
      const { goal, evaluation, candidate } = await createEvaluationFixture(complexityRuntime, {
        scoring: { candidateComplexityUnits: 110 }
      });
      const base = experimentInput(goal, evaluation, candidate);
      const response = await complexityRuntime.service.execute("experiment.record", {
        ...base,
        complexityDeltaPercent: 10,
        idempotencyKey: "experiment-phase9-complexity-tolerance-v1"
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("experiment-tolerance-exceeded");
    } finally {
      await complexityRuntime.cleanup();
    }
  });

  it("rejects direct skill evidence-state promotion", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { evaluation, experiment, candidate } = await createExperimentFixture(runtime);
      const directPromotion = await runtime.service.execute(
        "skill.version.record",
        SkillVersionInputSchema.parse({
          ...candidateSkillInput(candidate.artifactHash),
          version: candidate.version,
          state: "held-out-verified",
          evidenceIds: [promotionEvidenceId(evaluation)],
          evaluationContractIds: [evaluation.id],
          experimentRecordIds: [experiment.id],
          supersedesSkillVersionId: candidate.id,
          recordedBy: "promotion-authority",
          reason: "Attempt to bypass the promotion command",
          idempotencyKey: "skill-phase9-direct-promotion-v1"
        })
      );
      expect(directPromotion.ok).toBe(false);
      expect(directPromotion.error?.message).toMatch(/promotion|state|candidate/i);
      expect(runtime.storage.listSkillVersions(VENTURE_ID, { skillId: candidate.skillId })).toHaveLength(1);
      expect(runtime.storage.listSkillVersions(VENTURE_ID, { skillId: candidate.skillId })[0]?.state).toBe("candidate");
    } finally {
      await runtime.cleanup();
    }
  });

  it("binds promotion and the next evidence-state revision to the exact evaluated artifact", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { evaluation, experiment, candidate } = await createExperimentFixture(runtime);
      const unrelated = await createCandidateSkill(runtime, {
        skillId: "skill_phase9_unrelated_promotion",
        name: "Unrelated promotion target",
        idempotencyKey: "skill-phase9-unrelated-promotion-v1"
      });
      const wrongTarget = await runtime.service.execute(
        "play.promotion.record",
        promotionInput(evaluation, experiment, unrelated, {
          skillVersionId: unrelated.id,
          idempotencyKey: "promotion-phase9-wrong-target-v1"
        })
      );
      expect(wrongTarget.ok).toBe(false);
      expect(wrongTarget.error?.code).toBe("promotion-candidate-mismatch");

      expectOk(await runtime.service.execute("play.promotion.record", promotionInput(evaluation, experiment, candidate)));
      const changedArtifact = await seedDifferentSkillArtifact(runtime);
      const swappedArtifact = await runtime.service.execute(
        "skill.version.record",
        SkillVersionInputSchema.parse({
          ...candidateSkillInput(changedArtifact.hash, {
            version: candidate.version,
            artifactPath: changedArtifact.path,
            state: "held-out-verified",
            evidenceIds: [promotionEvidenceId(evaluation)],
            evaluationContractIds: [evaluation.id],
            experimentRecordIds: [experiment.id],
            supersedesSkillVersionId: candidate.id,
            recordedBy: "promotion-authority",
            reason: "Attempt to advance a different artifact",
            idempotencyKey: "skill-phase9-swapped-artifact-v1"
          })
        })
      );
      expect(swappedArtifact.ok).toBe(false);
      expect(swappedArtifact.error?.code).toBe("promoted-artifact-mismatch");

      const exactRevision = await runtime.service.execute(
        "skill.version.record",
        SkillVersionInputSchema.parse({
          ...candidateSkillInput(candidate.artifactHash, {
            version: candidate.version,
            state: "held-out-verified",
            evidenceIds: [promotionEvidenceId(evaluation)],
            evaluationContractIds: [evaluation.id],
            experimentRecordIds: [experiment.id],
            supersedesSkillVersionId: candidate.id,
            recordedBy: "promotion-authority",
            reason: "Advance only the exact sealed candidate evidence state",
            idempotencyKey: "skill-phase9-held-out-v1"
          })
        })
      );
      expectOk(exactRevision);
      expect(runtime.storage.listSkillVersions(VENTURE_ID, { skillId: candidate.skillId })).toHaveLength(2);
    } finally {
      await runtime.cleanup();
    }
  });

  it("does not let a superseded promote decision authorize a later skill revision", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { evaluation, experiment, candidate } = await createExperimentFixture(runtime);
      expectOk(await runtime.service.execute("play.promotion.record", promotionInput(evaluation, experiment, candidate)));
      expectOk(
        await runtime.service.execute(
          "play.promotion.record",
          promotionInput(evaluation, experiment, candidate, {
            decision: "refuse",
            toState: "candidate",
            reason: "Independent authority superseded the earlier promote decision",
            nextBoundedTest: "Collect another frozen run",
            idempotencyKey: "promotion-phase9-latest-refusal-v1"
          })
        )
      );
      const staleAuthorization = await runtime.service.execute(
        "skill.version.record",
        SkillVersionInputSchema.parse({
          ...candidateSkillInput(candidate.artifactHash, {
            version: candidate.version,
            state: "held-out-verified",
            evidenceIds: [promotionEvidenceId(evaluation)],
            evaluationContractIds: [evaluation.id],
            experimentRecordIds: [experiment.id],
            supersedesSkillVersionId: candidate.id,
            recordedBy: "promotion-authority",
            reason: "Attempt to reuse the superseded promote decision",
            idempotencyKey: "skill-phase9-stale-promotion-v1"
          })
        })
      );
      expect(staleAuthorization.ok).toBe(false);
      expect(staleAuthorization.error?.code).toBe("promotion-required");
      expect(runtime.storage.listPlayPromotions(VENTURE_ID, { skillVersionId: candidate.id })).toHaveLength(2);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects cross-venture promotion when transfer outcomes are not comparable", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const origin = await createHeldOutOriginFixture(runtime);
      const transfer = await createExampleCTransferFixture(runtime, true);
      const response = await runtime.service.execute(
        "play.promotion.record",
        promotionInput(origin.evaluation, origin.experiment, origin.candidate, {
          toState: "cross-venture-proven",
          fromState: "held-out-verified",
          evaluationContractIds: [origin.evaluation.id, transfer.evaluation.id],
          experimentRecordIds: [origin.experiment.id, transfer.experiment.id],
          transferVentureIds: [transfer.ventureId],
          noHistoryBaselineReceiptIds: [RECEIPTS.noHistory, transfer.ids.noHistory],
          plainAgentBaselineReceiptIds: [RECEIPTS.plainAgent, transfer.ids.plainAgent],
          idempotencyKey: "promotion-phase9-incomparable-transfer-v1"
        })
      );
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("cross-venture-outcome-mismatch");
    } finally {
      await runtime.cleanup();
    }
  });

  it("requires frozen baselines for every transfer venture before cross-venture promotion", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const origin = await createHeldOutOriginFixture(runtime);
      const transfer = await createExampleCTransferFixture(runtime);
      const baseOverrides = {
        fromState: "held-out-verified",
        toState: "cross-venture-proven",
        evaluationContractIds: [origin.evaluation.id, transfer.evaluation.id],
        experimentRecordIds: [origin.experiment.id, transfer.experiment.id],
        transferVentureIds: [transfer.ventureId]
      };
      const missingTransferBaselines = await runtime.service.execute(
        "play.promotion.record",
        promotionInput(origin.evaluation, origin.experiment, origin.candidate, {
          ...baseOverrides,
          noHistoryBaselineReceiptIds: [RECEIPTS.noHistory],
          plainAgentBaselineReceiptIds: [RECEIPTS.plainAgent],
          idempotencyKey: "promotion-phase9-missing-transfer-baselines-v1"
        })
      );
      expect(missingTransferBaselines.ok).toBe(false);
      expect(missingTransferBaselines.error?.code).toBe("promotion-baseline-missing");

      expectOk(
        await runtime.service.execute(
          "play.promotion.record",
          promotionInput(origin.evaluation, origin.experiment, origin.candidate, {
            ...baseOverrides,
            noHistoryBaselineReceiptIds: [RECEIPTS.noHistory, transfer.ids.noHistory],
            plainAgentBaselineReceiptIds: [RECEIPTS.plainAgent, transfer.ids.plainAgent],
            idempotencyKey: "promotion-phase9-comparable-transfer-v1"
          })
        )
      );
    } finally {
      await runtime.cleanup();
    }
  });

  it("persists a refused promotion without advancing the skill", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { evaluation, experiment, candidate } = await createExperimentFixture(runtime);
      const refusal = PlayPromotionInputSchema.parse({
        ventureId: VENTURE_ID,
        playId: "play_example_a_channel_evidence_v1",
        skillVersionId: candidate.id,
        fromState: "candidate",
        toState: "candidate",
        decision: "refuse",
        evaluationContractIds: [evaluation.id],
        experimentRecordIds: [experiment.id],
        evidenceIds: ["evidence_phase9_quality"],
        transferVentureIds: [],
        outcomeDefinitionHash: sha256({
          primaryMetric: evaluation.primaryMetric,
          hardGates: evaluation.hardGates,
          evaluationPopulation: evaluation.evaluationPopulation,
          expectedReceiptTypes: evaluation.expectedReceiptTypes
        }),
        supportedArchetypes: ["founder-led software"],
        unsupportedArchetypes: [],
        noHistoryBaselineReceiptIds: [],
        plainAgentBaselineReceiptIds: [],
        hardGatesPassed: true,
        leakageDetected: false,
        costWithinTolerance: true,
        founderTimeWithinTolerance: true,
        complexityWithinTolerance: true,
        producerId: "producer",
        evaluatorId: "evaluator",
        reviewerId: "reviewer",
        promotionAuthorityId: "promotion-authority",
        reason: "The evidence is valid but not sufficient for promotion",
        nextBoundedTest: "Run a larger hidden holdout",
        requestedAt: END,
        idempotencyKey: "promotion-phase9-refusal-v1"
      });
      expectOk(await runtime.service.execute("play.promotion.record", refusal));

      const listed = unwrapList<Record<string, unknown>>(
        expectOk(await runtime.service.execute("play.promotion.list", { ventureId: VENTURE_ID, playId: refusal.playId })),
        "promotions"
      );
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ decision: "refuse", fromState: "candidate", toState: "candidate" });
      const skills = runtime.storage.listSkillVersions(VENTURE_ID, { skillId: candidate.skillId });
      expect(skills).toHaveLength(1);
      expect(skills[0]?.state).toBe("candidate");
    } finally {
      await runtime.cleanup();
    }
  });

  it("refuses evaluated initiative selection when the command has no evaluator-produced candidate scores", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      seedEvaluationEvidence(runtime);
      const { goal, evaluation } = await createEvaluationFixture(runtime);
      const response = await runtime.service.execute(
        "initiative.decide",
        InitiativeDecisionInputSchema.parse({
          ventureId: VENTURE_ID,
          packRevisionId: currentPackRevisionId(runtime),
          goalRevisionId: goal.id,
          candidates: [
            {
              id: "initiative_phase9_candidate",
              ventureId: VENTURE_ID,
              goalRevisionId: goal.id,
              capabilityId: "market-problem-research",
              title: "Candidate without a scored output",
              hypothesis: "The generic heuristic must not masquerade as evaluation",
              dependencyIds: [],
              requirementIds: [],
              expectedOutcome: "A fail-closed response",
              expectedProof: "No decision trace",
              successThreshold: "Command refuses evaluated mode",
              failureThreshold: "Generic heuristic selects the candidate",
              stopCondition: "Stop on refusal",
              estimatedHours: 1,
              estimatedCostCents: 0,
              autonomyMode: "propose",
              gateClasses: [],
              uncertainty: 0.2,
              uncertaintyReason: "No immutable candidate score exists",
              assumptions: [],
              evidenceIds: ["evidence_phase9_quality"]
            }
          ],
          selectionMode: "evaluated",
          baseline: {
            kind: "prior-version",
            description: "Frozen baseline exists but no per-candidate scored outputs do",
            receiptIds: [RECEIPTS.baseline]
          },
          evaluationContractId: evaluation.id,
          plannerId: "planner",
          evaluatorId: "evaluator",
          decisionPolicy: "Use only immutable evaluator-produced candidate scores",
          evidenceIds: ["evidence_phase9_quality"],
          requestedAt: END,
          idempotencyKey: "initiative-phase9-evaluated-unavailable-v1"
        })
      );
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("evaluated-selection-unavailable");
      expect(runtime.storage.listDecisionTraces(VENTURE_ID)).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("persists an honest initiative abstention when no goal exists", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const response = await runtime.service.execute(
        "initiative.decide",
        InitiativeDecisionInputSchema.parse({
          ventureId: VENTURE_ID,
          packRevisionId: currentPackRevisionId(runtime),
          candidates: [],
          selectionMode: "deterministic-eligibility",
          baseline: { kind: "none", description: "No goal means no comparable decision", receiptIds: [] },
          plannerId: "planner",
          evaluatorId: "eligibility-rules",
          decisionPolicy: "Abstain until a founder confirms the company destination",
          evidenceIds: [],
          requestedAt: START,
          idempotencyKey: "initiative-phase9-no-goal-v1"
        })
      );
      const trace = unwrap<Record<string, unknown>>(expectOk(response), "trace");
      expect(trace).toMatchObject({ abstain: true });
      expect(trace.selectedCandidateId).toBeUndefined();
      expect(String(trace.abstainReason)).toContain("no confirmed goal");
      expect(runtime.storage.listDecisionTraces(VENTURE_ID)).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });
});
