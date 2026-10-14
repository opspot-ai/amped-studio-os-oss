import { describe, expect, it } from "vitest";
import {
  GoalChangeInputSchema,
  GoalConfirmChangeInputSchema,
  type GoalChangeImpact,
  type GoalChangeInput,
  type GoalRevision,
  type TaskDefinition
} from "@amped-studio-os/contracts";
import { tempRuntime } from "./helpers.js";

const REQUESTED_AT = "2026-07-20T03:00:00.000Z";
const CONFIRMED_AT = "2026-07-20T04:00:00.000Z";

interface Preview {
  previewId: string;
  previewHash: string;
  impact: GoalChangeImpact;
}

function goalInput(overrides: Partial<GoalChangeInput> = {}): GoalChangeInput {
  return GoalChangeInputSchema.parse({
    ventureId: "venture_example_a",
    destination: "cash-flow",
    target: "First authoritative paid pilot",
    horizon: "30 days",
    constraints: ["No external action without approval"],
    successConditions: ["One authoritative payment event"],
    killConditions: ["No paid demand after the bounded test"],
    reason: "Prove the narrow wedge",
    requestedBy: "founder",
    requestedAt: REQUESTED_AT,
    idempotencyKey: "goal-reconciliation-initial-v1",
    ...overrides
  });
}

async function preview(runtime: Awaited<ReturnType<typeof tempRuntime>>, input: GoalChangeInput): Promise<Preview> {
  const response = await runtime.service.execute("goal.preview_change", input);
  expect(response.ok, response.error?.message).toBe(true);
  return response.data as Preview;
}

async function confirm(
  runtime: Awaited<ReturnType<typeof tempRuntime>>,
  input: GoalChangeInput,
  goalPreview: Preview
): Promise<GoalRevision> {
  const response = await runtime.service.execute(
    "goal.confirm_change",
    GoalConfirmChangeInputSchema.parse({
      ...input,
      founderConfirmation: {
        previewId: goalPreview.previewId,
        previewHash: goalPreview.previewHash,
        confirmedBy: "founder",
        authority: "Bounded local test confirmation",
        confirmedAt: CONFIRMED_AT
      }
    })
  );
  expect(response.ok, response.error?.message).toBe(true);
  const goal = runtime.storage.getLatestGoalRevision(input.ventureId);
  if (!goal) throw new Error("goal revision was not stored");
  return goal;
}

async function plan(runtime: Awaited<ReturnType<typeof tempRuntime>>, ventureId = "venture_example_a"): Promise<TaskDefinition> {
  const response = await runtime.service.execute("task.plan", { ventureId });
  expect(response.ok, response.error?.message).toBe(true);
  return (response.data as { task: TaskDefinition }).task;
}

function changedGoal(current: GoalRevision, suffix: string): GoalChangeInput {
  return goalInput({
    target: `Authoritative paid pilot ${suffix}`,
    expectedGoalRevisionId: current.id,
    requestedAt: "2026-07-20T03:02:00.000Z",
    idempotencyKey: `goal-reconciliation-${suffix}-v2`
  });
}

describe("goal-change task reconciliation", () => {
  it("goal-binds new tasks and persists the exact impact, gaps, and roadmap marker", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const initialInput = goalInput();
      const initial = await confirm(runtime, initialInput, await preview(runtime, initialInput));
      const task = await plan(runtime);
      const hwpTask = await plan(runtime, "venture_example_c");
      expect(task.goalTaskBinding).toEqual({
        scope: "goal-specific",
        goalRevisionId: initial.id,
        onMaterialChange: "revise"
      });
      expect(task.idempotencyKey).toMatch(/^plan:goal-[a-f0-9]{64}:v3$/);

      const before = {
        lifecycle: runtime.storage.getVenture("venture_example_a")?.lifecycle_state,
        evidence: runtime.storage.listEvidence("venture_example_a").length,
        receipts: runtime.storage.listReceipts("venture_example_a").length,
        metrics: runtime.storage.listMetrics("venture_example_a")
      };
      const input = changedGoal(initial, "persisted-impact");
      const goalPreview = await preview(runtime, input);
      expect(goalPreview.impact.taskReconciliation).toEqual([
        expect.objectContaining({
          taskId: task.id,
          taskStatus: "ready",
          taskActionDigest: runtime.storage.getTask("venture_example_a", task.id)?.actionDigest,
          disposition: "revise",
          executionBlocked: true
        })
      ]);
      expect(goalPreview.impact.taskReconciliation.some((item) => item.taskId === hwpTask.id)).toBe(false);
      expect(goalPreview.impact.gapSnapshot.gapCount).toBe(goalPreview.impact.gapSnapshot.items.length);
      expect(goalPreview.impact.roadmap).toMatchObject({
        state: "recalculation-required",
        gapSnapshotHash: goalPreview.impact.gapSnapshot.canonicalHash,
        taskReconciliationHash: goalPreview.impact.taskReconciliationHash
      });

      const confirmed = await confirm(runtime, input, goalPreview);
      expect(confirmed.changeImpact).toEqual(goalPreview.impact);
      expect(runtime.storage.getVenture("venture_example_a")?.lifecycle_state).toBe(before.lifecycle);
      expect(runtime.storage.listEvidence("venture_example_a")).toHaveLength(before.evidence);
      expect(runtime.storage.listReceipts("venture_example_a")).toHaveLength(before.receipts);
      expect(runtime.storage.listMetrics("venture_example_a")).toEqual(before.metrics);

      const blocked = await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId: task.id });
      expect(blocked.ok).toBe(false);
      expect(blocked.error?.code).toBe("task-goal-reconciliation-blocked");
      expect(runtime.storage.listJobs("venture_example_a")).toHaveLength(0);

      const revisedTask = await plan(runtime);
      expect(revisedTask.id).not.toBe(task.id);
      expect(revisedTask.goalTaskBinding).toEqual({
        scope: "goal-specific",
        goalRevisionId: confirmed.id,
        onMaterialChange: "revise"
      });
      expect((await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId: revisedTask.id })).ok).toBe(true);
      const replay = await runtime.service.execute("goal.confirm_change", {
        ...input,
        founderConfirmation: {
          previewId: goalPreview.previewId,
          previewHash: goalPreview.previewHash,
          confirmedBy: "founder",
          authority: "Bounded local test confirmation",
          confirmedAt: CONFIRMED_AT
        }
      });
      expect(replay.ok, replay.error?.message).toBe(true);
      expect((replay.data as { preview: Preview }).preview).toEqual(goalPreview);

      const metadataOnlyInput = goalInput({
        target: input.target,
        expectedGoalRevisionId: confirmed.id,
        reason: "Explanation changed without changing the structured goal",
        requestedAt: "2026-07-20T03:03:00.000Z",
        idempotencyKey: "goal-reconciliation-metadata-only-v3"
      });
      const metadataOnlyPreview = await preview(runtime, metadataOnlyInput);
      expect(metadataOnlyPreview.impact.materialGoalChange).toBe(false);
      expect(metadataOnlyPreview.impact.taskReconciliation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: task.id, disposition: "revise" }),
          expect.objectContaining({ taskId: revisedTask.id, disposition: "keep" })
        ])
      );
      const metadataOnlyGoal = await confirm(runtime, metadataOnlyInput, metadataOnlyPreview);
      const replayedPlan = await plan(runtime);
      expect(replayedPlan.id).toBe(revisedTask.id);
      expect(runtime.storage.listTasks("venture_example_a")).toHaveLength(2);
      expect(runtime.service.goalExecutionBlock(runtime.storage.getTask("venture_example_a", task.id)!)).toMatchObject({
        disposition: "revise",
        goalRevisionId: metadataOnlyGoal.id
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects confirmation when task state drifts after preview", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const initialInput = goalInput({ idempotencyKey: "goal-reconciliation-drift-initial-v1" });
      const initial = await confirm(runtime, initialInput, await preview(runtime, initialInput));
      const task = await plan(runtime);
      const input = changedGoal(initial, "drift");
      const stalePreview = await preview(runtime, input);
      runtime.storage.setTaskStatus("venture_example_a", task.id, "queued");

      const response = await runtime.service.execute("goal.confirm_change", {
        ...input,
        founderConfirmation: {
          previewId: stalePreview.previewId,
          previewHash: stalePreview.previewHash,
          confirmedBy: "founder",
          authority: "Bounded local test confirmation",
          confirmedAt: CONFIRMED_AT
        }
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("goal-preview-mismatch");
      expect(runtime.storage.listGoalRevisions("venture_example_a").map((goal) => goal.id)).toEqual([initial.id]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("stops queued work before provider dispatch for a non-keep disposition", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const initialInput = goalInput({ idempotencyKey: "goal-reconciliation-queued-initial-v1" });
      const initial = await confirm(runtime, initialInput, await preview(runtime, initialInput));
      const task = await plan(runtime);
      const queued = await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId: task.id });
      expect(queued.ok).toBe(true);

      const input = changedGoal(initial, "queued");
      const goalPreview = await preview(runtime, input);
      expect(goalPreview.impact.taskReconciliation).toEqual([
        expect.objectContaining({ taskId: task.id, taskStatus: "queued", disposition: "defer" })
      ]);
      await confirm(runtime, input, goalPreview);

      const result = await runtime.worker.runOnce();
      expect(result).toMatchObject({
        outcome: "goal-reconciliation-blocked",
        disposition: "defer",
        providerCancellationAttempted: false
      });
      expect(runtime.storage.listDispatches("venture_example_a")).toHaveLength(0);
      expect(runtime.storage.getTask("venture_example_a", task.id)?.status).toBe("blocked");
      expect(runtime.storage.listJobs("venture_example_a")[0]?.status).toBe("cancelled");
    } finally {
      await runtime.cleanup();
    }
  });

  it("lets a failed running attempt finish but suppresses its retry after the goal changes", async () => {
    const runtime = await tempRuntime({ fixtureBehavior: "fail-once" });
    try {
      await runtime.loadPacks();
      const initialInput = goalInput({ idempotencyKey: "goal-reconciliation-retry-initial-v1" });
      const initial = await confirm(runtime, initialInput, await preview(runtime, initialInput));
      const task = await plan(runtime);
      expect((await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId: task.id })).ok).toBe(true);
      expect(await runtime.worker.runOnce()).toMatchObject({ outcome: "retry" });

      const input = changedGoal(initial, "retry");
      const goalPreview = await preview(runtime, input);
      expect(goalPreview.impact.taskReconciliation).toEqual([
        expect.objectContaining({ taskId: task.id, taskStatus: "queued", disposition: "defer" })
      ]);
      await confirm(runtime, input, goalPreview);
      runtime.storage.db
        .prepare("UPDATE jobs SET available_at=? WHERE venture_id=? AND task_id=?")
        .run(new Date().toISOString(), "venture_example_a", task.id);

      expect(await runtime.worker.runOnce()).toMatchObject({
        outcome: "goal-reconciliation-blocked",
        disposition: "defer",
        providerCancellationAttempted: false
      });
      expect(runtime.storage.listDispatches("venture_example_a")).toEqual([
        expect.objectContaining({ task_id: task.id, status: "blocked" })
      ]);
      expect(runtime.storage.listReceipts("venture_example_a").filter((receipt) => receipt.taskId === task.id)).toHaveLength(0);
      expect(await runtime.worker.runOnce()).toBeNull();
    } finally {
      await runtime.cleanup();
    }
  });
});
