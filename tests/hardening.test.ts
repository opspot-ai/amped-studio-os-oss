import { describe, expect, it } from "vitest";
import { GateClassSchema, ReceiptSchema, makeId, sha256 } from "@amped-studio-os/contracts";
import { evaluatePolicy } from "@amped-studio-os/policy";
import { tempRuntime } from "./helpers.js";

describe("storage and proof hardening", () => {
  it("loads packs idempotently and preserves immutable audit and receipts", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const initialRevisions = runtime.storage.tableCounts().pack_revisions;
      const initialAudit = runtime.storage.tableCounts().audit_events;
      const initialPlay = runtime.storage.listPlays("venture_example_a")[0];
      await runtime.loadPacks();
      expect(runtime.storage.tableCounts().pack_revisions).toBe(initialRevisions);
      expect(runtime.storage.tableCounts().audit_events).toBe(initialAudit);
      expect(runtime.storage.listPlays("venture_example_a")).toHaveLength(1);
      const changedPlay = { ...initialPlay, name: `${initialPlay.name} revised`, reusable: Boolean(initialPlay.reusable) };
      delete changedPlay.version;
      expect(runtime.storage.upsertPlay("venture_example_a", changedPlay)).toEqual({ created: true, version: 2 });
      expect(runtime.storage.listPlays("venture_example_a")[0]?.version).toBe(2);
      expect(() => runtime.storage.db.prepare("UPDATE audit_events SET actor='tampered'").run()).toThrow("immutable");

      const planned = await runtime.service.execute("task.plan", { ventureId: "venture_example_a" });
      const taskId = (planned.data as any).task.id;
      await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId });
      expect((await runtime.worker.runOnce())?.outcome).toBe("success");
      expect(() => runtime.storage.db.prepare("DELETE FROM receipts WHERE venture_id='venture_example_a'").run()).toThrow("immutable");
      runtime.storage.setMetric({
        ventureId: "venture_example_a",
        id: "derived_metric",
        name: "Derived metric",
        value: 7,
        unit: "count",
        status: "known",
        sourceRef: "receipt_fixture",
        observedAt: new Date().toISOString()
      });
      runtime.storage.ensureMetricDefinition({
        ventureId: "venture_example_a",
        id: "derived_metric",
        name: "Derived metric renamed",
        unit: "count",
        status: "missing",
        observedAt: new Date().toISOString()
      });
      expect(runtime.storage.listMetrics("venture_example_a").find((item) => item.id === "derived_metric")?.value).toBe(7);
    } finally {
      await runtime.cleanup();
    }
  });

  it("recovers an expired worker lease without duplicating dispatch or lifecycle effects", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const planned = await runtime.service.execute("task.plan", { ventureId: "venture_example_c" });
      const taskId = (planned.data as any).task.id;
      await runtime.service.execute("task.run_safe", { ventureId: "venture_example_c", taskId });
      const abandoned = runtime.storage.claimNextJob("workspace_local", "crashed-worker", 1);
      expect(abandoned?.task_id).toBe(taskId);
      expect(runtime.storage.recoverExpiredJobs("workspace_local", new Date(Date.now() + 1000).toISOString())).toBe(1);
      expect((await runtime.worker.runOnce())?.outcome).toBe("success");
      expect(runtime.storage.listDispatches("venture_example_c")).toHaveLength(1);
      expect(runtime.storage.listReceipts("venture_example_c").filter((item) => item.taskId === taskId)).toHaveLength(1);
      expect(runtime.storage.listMetrics("venture_example_c").find((item) => item.id === "safe_specialist_outcomes")?.value).toBe(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("covers every gate, enforces budgets, and creates exact approval packets", () => {
    for (const gateClass of GateClassSchema.options) {
      const safe = gateClass === "safe-internal-read-only" || gateClass === "public-research-free";
      const task = {
        id: `task_${gateClass.replaceAll("-", "_")}`,
        ventureId: "venture_example_a",
        taskKind: "venture-play" as const,
        purpose: `exercise ${gateClass}`,
        expectedOutcome: "bounded result",
        ownerRole: "scout",
        dependencies: [],
        sourceRefs: ["bsd_public_site"],
        mode: safe ? ("internal-read-only" as const) : ("external" as const),
        expectedProof: "receipt",
        gateClass,
        actionBounds: { target: "exact target", senderOrSystem: "exact system", exactCommandOrProviderCall: "disabled-example", rollbackOrKillRoute: "kill switch" },
        budgetCents: safe ? 0 : 100,
        costCeilingCents: safe ? 0 : 100,
        approvalRequired: !safe,
        idempotencyKey: `gate-matrix-${gateClass}`,
        maxAttempts: 1,
        backoffMs: 0,
        timeoutMs: 1000,
        lifecycleEffect: {},
        metricEffects: []
      };
      const decision = evaluatePolicy(task);
      expect(decision.decision).toBe(safe ? "allow" : "approval-required");
      if (!safe) {
        expect(decision.approvalPacket?.target).toBe("exact target");
        expect(decision.approvalPacket?.exactCommandOrProviderCall).toBe("disabled-example");
      }
    }
    const overBudget = evaluatePolicy({
      id: "task_over_budget",
      ventureId: "venture_example_a",
      taskKind: "venture-play",
      purpose: "over budget",
      expectedOutcome: "none",
      ownerRole: "scout",
      dependencies: [],
      sourceRefs: ["bsd_public_site"],
      mode: "external",
      expectedProof: "receipt",
      gateClass: "paid-research",
      actionBounds: {},
      budgetCents: 99,
      costCeilingCents: 100,
      approvalRequired: true,
      idempotencyKey: "over-budget-policy",
      maxAttempts: 1,
      backoffMs: 0,
      timeoutMs: 1000,
      lifecycleEffect: {},
      metricEffects: []
    });
    expect(overBudget.decision).toBe("deny");
    expect(overBudget.reason).toContain("exceeds task budget");
  });

  it("does not convert a claimed receipt or fixture evidence into verified revenue", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const fakeReceipt = ReceiptSchema.parse({
        id: "receipt_claimed_revenue",
        ventureId: "venture_example_c",
        proofTier: "revenue-verified",
        outcome: "success",
        actor: "fixture",
        adapter: "fixture",
        artifactPath: "receipts/fixture.json",
        contentHash: sha256("claimed revenue"),
        occurredAt: new Date().toISOString(),
        metadata: { fixture: true }
      });
      runtime.storage.attachReceipt(fakeReceipt);
      runtime.storage.addEvidence({
        id: makeId("evidence", "fixture-revenue"),
        ventureId: "venture_example_c",
        type: "authoritative-payment-collected",
        proofTier: "revenue-verified",
        authority: "payment",
        sourceRef: fakeReceipt.id,
        observedAt: new Date().toISOString(),
        status: "current",
        contentHash: sha256("fixture revenue evidence"),
        metadata: { fixture: true }
      });
      const scorecard = await runtime.service.execute("portfolio.scorecard", {});
      expect((scorecard.data as any).ventures.find((item: any) => item.ventureId === "venture_example_c").verifiedRevenue).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });
});
