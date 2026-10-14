import { describe, expect, it } from "vitest";
import { GoalChangeInputSchema, GoalRevisionSchema, InitiativeDecisionInputSchema, sha256 } from "@amped-studio-os/contracts";
import { buildDecisionTrace, buildGoalPreview } from "../packages/domain/src/phase9.js";

const at = "2026-07-20T03:00:00.000Z";

describe("phase 9 pure decision behavior", () => {
  const goalSnapshot = {
    evidenceCount: 3,
    taskCount: 7,
    receiptCount: 4,
    lifecycleState: "externally-live" as const,
    packRevisionId: "packrev_bsd_v1",
    readinessGaps: [
      {
        ventureId: "venture_example_a",
        group: "payment" as const,
        field: "payment.authoritativeEvent",
        reason: "missing" as const,
        sourceRefs: ["source_payment"],
        blockingStates: ["revenue-verified" as const]
      }
    ],
    tasks: [
      {
        taskId: "task_terminal",
        purpose: "Historical proof",
        status: "succeeded" as const,
        actionDigest: sha256("terminal")
      },
      {
        taskId: "task_planned",
        purpose: "Revise planned work",
        status: "planned" as const,
        actionDigest: sha256("planned"),
        goalTaskBinding: { scope: "goal-specific" as const, goalRevisionId: "goal_old", onMaterialChange: "revise" as const }
      },
      {
        taskId: "task_independent",
        purpose: "Keep independent work",
        status: "ready" as const,
        actionDigest: sha256("independent"),
        goalTaskBinding: { scope: "goal-independent" as const, onMaterialChange: "cancel" as const }
      },
      {
        taskId: "task_blocked",
        purpose: "Defer gated work",
        status: "blocked" as const,
        actionDigest: sha256("blocked"),
        goalTaskBinding: { scope: "goal-specific" as const, goalRevisionId: "goal_old", onMaterialChange: "defer" as const }
      },
      {
        taskId: "task_queued",
        purpose: "Cancel queued evaluation",
        status: "queued" as const,
        actionDigest: sha256("queued"),
        goalTaskBinding: { scope: "goal-specific" as const, goalRevisionId: "goal_old", onMaterialChange: "cancel" as const }
      },
      {
        taskId: "task_running",
        purpose: "Let running lease finish without retry",
        status: "running" as const,
        actionDigest: sha256("running"),
        goalTaskBinding: { scope: "goal-specific" as const, goalRevisionId: "goal_old", onMaterialChange: "cancel" as const }
      },
      {
        taskId: "task_legacy",
        purpose: "Fail closed for legacy task",
        status: "ready" as const,
        actionDigest: sha256("legacy")
      }
    ]
  };

  it("reconciles every nonterminal task exactly once from status and structured binding", () => {
    const input = GoalChangeInputSchema.parse({
      ventureId: "venture_example_a",
      destination: "cash-flow",
      target: "First authoritative paid pilot",
      horizon: "30 days",
      constraints: ["No external action without approval"],
      successConditions: ["Non-fixture authoritative payment event"],
      killConditions: ["No paid demand after the bounded test"],
      reason: "Prove the narrow wedge before scaling product depth",
      requestedBy: "founder",
      requestedAt: at,
      idempotencyKey: "goal-preview-bsd-v1"
    });
    const preview = buildGoalPreview(input, undefined, goalSnapshot);
    expect(preview.confirmationRequired).toBe(true);
    expect(preview.impact).toMatchObject({ evidencePreserved: true, tasksPreserved: true, receiptsPreserved: true });
    expect(preview.impact.activeWorkAutomaticallyCancelled).toBe(false);
    expect(preview.impact.activeTaskCount).toBe(6);
    expect(preview.impact.taskReconciliation.map((item) => item.taskId)).toEqual([
      "task_blocked",
      "task_independent",
      "task_legacy",
      "task_planned",
      "task_queued",
      "task_running"
    ]);
    expect(preview.impact.taskReconciliation).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "task_terminal" })])
    );
    expect(preview.impact.taskReconciliation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "task_independent", disposition: "keep" }),
        expect.objectContaining({ taskId: "task_legacy", disposition: "revise" }),
        expect.objectContaining({ taskId: "task_planned", disposition: "revise" }),
        expect.objectContaining({ taskId: "task_blocked", disposition: "defer" }),
        expect.objectContaining({ taskId: "task_queued", disposition: "cancel" }),
        expect.objectContaining({ taskId: "task_running", disposition: "defer", ruleCode: "defer-active-work" })
      ])
    );
    expect(preview.impact.taskReconciliation.filter((item) => item.disposition === "cancel")).toEqual([
      expect.objectContaining({ taskId: "task_queued", goalTaskBinding: expect.objectContaining({ onMaterialChange: "cancel" }) })
    ]);
    expect(preview.impact.gapSnapshot).toMatchObject({ gapCount: 1 });
    expect(preview.impact.roadmap).toMatchObject({
      state: "recalculation-required",
      packRevisionId: "packrev_bsd_v1",
      gapSnapshotHash: preview.impact.gapSnapshot.canonicalHash
    });

    const reordered = buildGoalPreview(input, undefined, { ...goalSnapshot, tasks: [...goalSnapshot.tasks].reverse() });
    expect(reordered).toEqual(preview);

    const changedSnapshot = buildGoalPreview(input, undefined, { ...goalSnapshot, evidenceCount: 4 });
    expect(changedSnapshot.previewHash).not.toBe(preview.previewHash);
    expect(changedSnapshot.previewId).not.toBe(preview.previewId);
  });

  it("keeps tasks for unchanged goal semantics and reports destination changes narrowly", () => {
    const currentInput = GoalChangeInputSchema.parse({
      ventureId: "venture_example_a",
      destination: "cash-flow",
      target: "First authoritative paid pilot",
      horizon: "30 days",
      constraints: ["No external action without approval"],
      successConditions: ["Non-fixture authoritative payment event"],
      killConditions: ["No paid demand after the bounded test"],
      reason: "Initial reason",
      requestedBy: "founder",
      requestedAt: at,
      idempotencyKey: "goal-current-bsd-v1"
    });
    const current = GoalRevisionSchema.parse({
      id: "goal_current",
      revision: 1,
      ...currentInput,
      founderConfirmation: {
        previewId: "goalpreview_current",
        previewHash: sha256("current-preview"),
        confirmedBy: "founder",
        authority: "Founder",
        confirmedAt: at
      },
      createdAt: at,
      canonicalHash: sha256("current-goal")
    });
    const metadataOnly = GoalChangeInputSchema.parse({
      ...currentInput,
      expectedGoalRevisionId: current.id,
      reason: "Updated explanation only",
      requestedAt: "2026-07-20T04:00:00.000Z",
      idempotencyKey: "goal-metadata-only-v2"
    });
    const unchanged = buildGoalPreview(metadataOnly, current, goalSnapshot);
    expect(unchanged.impact.materialGoalChange).toBe(false);
    expect(unchanged.impact.destinationChanged).toBe(false);
    expect(unchanged.impact.roadmap.state).toBe("unchanged");
    expect(new Set(unchanged.impact.taskReconciliation.map((item) => item.disposition))).toEqual(new Set(["keep"]));

    const targetOnly = GoalChangeInputSchema.parse({
      ...metadataOnly,
      target: "Second authoritative paid pilot",
      idempotencyKey: "goal-target-only-v3"
    });
    const changed = buildGoalPreview(targetOnly, current, goalSnapshot);
    expect(changed.impact.materialGoalChange).toBe(true);
    expect(changed.impact.destinationChanged).toBe(false);
  });

  it("emits an honest immutable abstention when no goal exists", () => {
    const input = InitiativeDecisionInputSchema.parse({
      ventureId: "venture_example_a",
      packRevisionId: "packrev_bsd",
      candidates: [],
      selectionMode: "deterministic-eligibility",
      baseline: { kind: "none", description: "No quality baseline has run", receiptIds: [] },
      plannerId: "planner",
      evaluatorId: "eligibility-rules",
      decisionPolicy: "Only evaluate venture-scoped candidates against current truth",
      evidenceIds: [],
      requestedAt: at,
      idempotencyKey: "decision-no-goal-v1"
    });
    const trace = buildDecisionTrace(input, { knownEvidenceIds: new Set(), evaluatorContractExists: false, createdAt: at });
    expect(trace.abstain).toBe(true);
    expect(trace.selectedCandidateId).toBeUndefined();
    expect(trace.abstainReason).toContain("no confirmed goal");
  });

  it("keeps deterministic eligibility stable across candidate ordering and labels it unproven", () => {
    const candidate = (id: string, uncertainty: number) => ({
      id,
      ventureId: "venture_example_a" as const,
      goalRevisionId: "goal_bsd",
      capabilityId: "market-problem-research" as const,
      title: id,
      hypothesis: "Bounded hypothesis",
      dependencyIds: [],
      requirementIds: [],
      expectedOutcome: "Reduce one evidence gap",
      expectedProof: "Current cited receipt",
      successThreshold: "Threshold",
      failureThreshold: "Failure threshold",
      stopCondition: "Stop after one bounded run",
      estimatedHours: 1,
      estimatedCostCents: 0,
      autonomyMode: "inspect" as const,
      gateClasses: ["safe-internal-read-only" as const],
      uncertainty,
      uncertaintyReason: "Not evaluated on held-out outcomes",
      assumptions: [],
      evidenceIds: ["evidence_safe"]
    });
    const makeInput = (candidates: ReturnType<typeof candidate>[]) =>
      InitiativeDecisionInputSchema.parse({
        ventureId: "venture_example_a",
        packRevisionId: "packrev_bsd",
        goalRevisionId: "goal_bsd",
        candidates,
        selectionMode: "deterministic-eligibility",
        baseline: { kind: "none", description: "Eligibility only", receiptIds: [] },
        plannerId: "planner",
        evaluatorId: "eligibility-rules",
        decisionPolicy: "Stable candidate ID ordering after eligibility checks",
        evidenceIds: ["evidence_safe"],
        requestedAt: at,
        idempotencyKey: "decision-stable-v1"
      });
    const context = { knownEvidenceIds: new Set(["evidence_safe"]), evaluatorContractExists: false, createdAt: at };
    const first = buildDecisionTrace(makeInput([candidate("initiative_z", 0.1), candidate("initiative_a", 0.8)]), context);
    const second = buildDecisionTrace(makeInput([candidate("initiative_a", 0.8), candidate("initiative_z", 0.1)]), context);
    expect(first.selectedCandidateId).toBe("initiative_a");
    expect(second.selectedCandidateId).toBe(first.selectedCandidateId);
    expect(sha256(first.assessments)).toBe(sha256(second.assessments));
    expect(first.assessments[0]?.rationale).toContain("not evidence of highest value");
  });
});
