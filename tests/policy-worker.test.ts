import { describe, expect, it } from "vitest";
import { TaskDefinitionSchema, sha256 } from "@amped-studio-os/contracts";
import { actionDigest, evaluatePolicy, validateApproval } from "@amped-studio-os/policy";
import { tempRuntime } from "./helpers.js";

function task(overrides: Record<string, unknown> = {}) {
  return TaskDefinitionSchema.parse({
    id: "task_policy",
    ventureId: "venture_example_a",
    purpose: "read public evidence",
    expectedOutcome: "cited evidence",
    ownerRole: "scout",
    dependencies: [],
    sourceRefs: ["bsd_public_site"],
    mode: "internal-read-only",
    expectedProof: "receipt",
    gateClass: "public-research-free",
    actionBounds: { target: "BSD", senderOrSystem: "scout" },
    budgetCents: 0,
    costCeilingCents: 0,
    approvalRequired: false,
    idempotencyKey: "policy-task-key",
    maxAttempts: 3,
    backoffMs: 0,
    timeoutMs: 1000,
    lifecycleEffect: {},
    metricEffects: [],
    ...overrides
  });
}

describe("policy, approvals, and worker durability", () => {
  it("allows zero-cost read-only work and binds approvals to the exact action digest", () => {
    const safe = task();
    expect(evaluatePolicy(safe).decision).toBe("allow");
    const gated = task({ mode: "external", gateClass: "public-posting", budgetCents: 500, costCeilingCents: 500, approvalRequired: true });
    const decision = evaluatePolicy(gated);
    expect(decision.decision).toBe("approval-required");
    const approval = {
      venture_id: gated.ventureId,
      id: "approval_policy",
      task_id: gated.id,
      action_digest: actionDigest(gated),
      status: "approved",
      expires_at: new Date(Date.now() + 60_000).toISOString()
    };
    expect(validateApproval(gated, approval).valid).toBe(true);
    const changed = task({ mode: "external", gateClass: "public-posting", budgetCents: 501, costCeilingCents: 501, approvalRequired: true });
    expect(validateApproval(changed, approval).reason).toContain("digest");
    expect(validateApproval(gated, { ...approval, expires_at: new Date(Date.now() - 1).toISOString() }).reason).toContain("expired");
    expect(validateApproval(gated, { ...approval, status: "revoked", revoked_at: new Date().toISOString() }).valid).toBe(false);
  });

  it("retries once, completes once, and suppresses duplicate dispatch/effects", async () => {
    const runtime = await tempRuntime({ fixtureBehavior: "fail-once" });
    try {
      await runtime.loadPacks();
      const planned = await runtime.service.execute("task.plan", { ventureId: "venture_example_a" });
      const taskId = (planned.data as any).task.id;
      await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId });
      const first = await runtime.worker.runOnce();
      expect(first?.outcome).toBe("retry");
      runtime.storage.db.prepare("UPDATE jobs SET available_at=? WHERE venture_id=? AND task_id=?").run(new Date().toISOString(), "venture_example_a", taskId);
      const second = await runtime.worker.runOnce();
      expect(second?.outcome).toBe("success");
      expect(runtime.storage.listDispatches("venture_example_a")).toHaveLength(1);
      expect(runtime.storage.listReceipts("venture_example_a").filter((receipt) => receipt.taskId === taskId)).toHaveLength(1);
      await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId });
      expect(await runtime.worker.runOnce()).toBeNull();
      expect(runtime.storage.listDispatches("venture_example_a")).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("dead-letters on the configured attempt ceiling and aborts on the kill switch", async () => {
    const timeoutRuntime = await tempRuntime({ fixtureBehavior: "timeout" });
    try {
      await timeoutRuntime.loadPacks();
      const limited = task({ id: "task_timeout", maxAttempts: 1, idempotencyKey: "timeout-task-key", mode: "fixture" });
      timeoutRuntime.storage.createTask(limited, sha256(limited), "ready");
      timeoutRuntime.storage.enqueueJob({ ventureId: limited.ventureId, id: "job_timeout", taskId: limited.id, kind: "role-dispatch", payload: {} });
      expect((await timeoutRuntime.worker.runOnce())?.outcome).toBe("dead-letter");
      expect(timeoutRuntime.storage.getTask(limited.ventureId, limited.id)?.status).toBe("dead-letter");
    } finally {
      await timeoutRuntime.cleanup();
    }

    const killedRuntime = await tempRuntime();
    try {
      await killedRuntime.loadPacks();
      const planned = await killedRuntime.service.execute("task.plan", { ventureId: "venture_example_c" });
      const taskId = (planned.data as any).task.id;
      await killedRuntime.service.execute("task.run_safe", { ventureId: "venture_example_c", taskId });
      killedRuntime.storage.setKillSwitch("venture_example_c", true);
      const result = await killedRuntime.worker.runOnce();
      expect(result?.outcome).toBe("dead-letter");
      expect(result?.error).toContain("kill switch");
    } finally {
      await killedRuntime.cleanup();
    }
  });

  it("cancels queued work without dispatching", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const planned = await runtime.service.execute("task.plan", { ventureId: "venture_example_a" });
      const taskId = (planned.data as any).task.id;
      await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId });
      expect(runtime.storage.cancelTask("venture_example_a", taskId)).toBe(true);
      expect(await runtime.worker.runOnce()).toBeNull();
      expect(runtime.storage.getTask("venture_example_a", taskId)?.status).toBe("cancelled");
    } finally {
      await runtime.cleanup();
    }
  });
});
