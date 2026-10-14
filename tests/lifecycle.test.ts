import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { TaskDefinitionSchema, makeId, sha256, type EvidenceItem, type TaskDefinition } from "@amped-studio-os/contracts";
import { actionDigest, evaluatePolicy } from "@amped-studio-os/policy";
import { tempRuntime } from "./helpers.js";

function evidence(ventureId: string, type: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  const at = new Date().toISOString();
  return {
    id: makeId("evidence", { ventureId, type, at, overrides }),
    ventureId,
    type,
    proofTier: "fixture-verified",
    authority: "engine",
    sourceRef: "fixture_source",
    observedAt: at,
    status: "current",
    contentHash: sha256({ ventureId, type, at, overrides }),
    metadata: { fixture: true },
    ...overrides
  };
}

function transitionApprovalTask(id = "task_ops384_transition"): TaskDefinition {
  return TaskDefinitionSchema.parse({
    id,
    ventureId: "venture_example_a",
    purpose: "request an evidence-bound lifecycle transition",
    expectedOutcome: "a lifecycle transition with an exact task-bound approval",
    ownerRole: "fixture",
    dependencies: [],
    sourceRefs: ["bsd_public_site"],
    mode: "external",
    expectedProof: "a denied or successful lifecycle transition receipt",
    gateClass: "public-posting",
    actionBounds: { target: "venture_example_a", senderOrSystem: "fixture" },
    budgetCents: 0,
    costCeilingCents: 0,
    approvalRequired: true,
    idempotencyKey: `ops384-transition-${id}`,
    maxAttempts: 1,
    backoffMs: 0,
    timeoutMs: 1_000,
    lifecycleEffect: {},
    metricEffects: []
  });
}

async function prepareApprovalTransition(runtime: Awaited<ReturnType<typeof tempRuntime>>, task = transitionApprovalTask()) {
  await runtime.loadPacks();
  runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state='candidate' WHERE id='venture_example_a'").run();
  const items = ["problem-defined", "buyer-defined", "founder-boundaries-defined", "source-references-present"].map((type) =>
    evidence("venture_example_a", type)
  );
  items.forEach((item) => runtime.storage.addEvidence(item));
  runtime.storage.createTask(task, actionDigest(task), "blocked");
  return { task, evidenceIds: items.map((item) => item.id) };
}

const fixturePromotionCases = [
  {
    label: "externally-live",
    expectedState: "launch-ready",
    targetState: "externally-live",
    type: "external-surface-live",
    realProofTier: "externally-live",
    rejection: "external state requires a non-fixture live-surface evidence item"
  },
  {
    label: "scaling",
    expectedState: "fulfillment-verified",
    targetState: "scaling",
    type: "repeatable-economics-within-bounds",
    realProofTier: "fulfillment-verified",
    rejection: "scaling requires a non-fixture repeatable-economics evidence item"
  }
] as const;

const paymentBindingLenderCases = [
  {
    label: "authority-only marker",
    authority: "fixture",
    proofTier: "fulfillment-verified",
    metadata: { fixture: false, paymentObjectId: "pi_lend" }
  },
  {
    label: "proofTier-only marker",
    authority: "fulfillment",
    proofTier: "fixture-verified",
    metadata: { fixture: false, paymentObjectId: "pi_lend" }
  },
  {
    label: "metadata.fixture-only marker",
    authority: "fulfillment",
    proofTier: "fulfillment-verified",
    metadata: { fixture: true, paymentObjectId: "pi_lend" }
  }
] as const;

describe("evidence-gated lifecycle", () => {
  it("fails closed on missing and cross-venture evidence, then transitions atomically", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state='candidate' WHERE id='venture_example_a'").run();
      const failed = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_a",
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds: [],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "transition-missing-evidence",
        requestedAt: new Date().toISOString()
      });
      expect((failed.data as any).outcome).toBe("failure");
      expect(runtime.storage.getVenture("venture_example_a")?.lifecycle_state).toBe("candidate");

      const other = evidence("venture_example_c", "problem-defined");
      runtime.storage.addEvidence(other);
      const cross = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_a",
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds: [other.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "transition-cross-evidence",
        requestedAt: new Date().toISOString()
      });
      expect((cross.data as any).reason).toContain("another venture");

      const items = ["problem-defined", "buyer-defined", "founder-boundaries-defined", "source-references-present"].map((type) => evidence("venture_example_a", type));
      items.forEach((item) => runtime.storage.addEvidence(item));
      const successInput = {
        ventureId: "venture_example_a",
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds: items.map((item) => item.id),
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "transition-valid-evidence",
        requestedAt: new Date().toISOString()
      };
      const success = await runtime.service.execute("venture.request_transition", successInput);
      expect((success.data as any).outcome).toBe("success");
      expect(runtime.storage.getVenture("venture_example_a")?.lifecycle_state).toBe("validating");
      const replay = await runtime.service.execute("venture.request_transition", successInput);
      expect((replay.data as any).idempotentReplay).toBe(true);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects a forged task-bound approval and preserves the denial on idempotent replay", async () => {
    const runtime = await tempRuntime();
    try {
      const { task, evidenceIds } = await prepareApprovalTransition(runtime);
      const approvalId = "approval_forged_ops384_local_0001";
      const input = {
        ventureId: "venture_example_a",
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds,
        requestingTaskId: task.id,
        requestingAgent: "fixture",
        approvalId,
        actor: "fixture",
        idempotencyKey: "transition-forged-approval-ops384",
        requestedAt: new Date().toISOString()
      };

      const rejected = await runtime.service.execute("venture.request_transition", input);
      expect((rejected.data as any).outcome).toBe("failure");
      expect((rejected.data as any).reason).toBe("approval not found");
      expect(runtime.storage.getVenture("venture_example_a")?.lifecycle_state).toBe("candidate");

      const stored = runtime.storage.findTransitionByIdempotency("venture_example_a", input.idempotencyKey) as any;
      expect(stored).toMatchObject({ outcome: "failure", reason: "approval not found", approval_id: approvalId });
      expect(JSON.parse(stored.policy_json)).toMatchObject({ decision: "deny", reason: "approval not found" });

      const receipt = runtime.storage.listReceipts("venture_example_a").find((item) => item.id === stored.receipt_id);
      expect(receipt).toBeDefined();
      const receiptMachine = JSON.parse(await readFile(receipt!.artifactPath, "utf8"));
      expect(receiptMachine).toMatchObject({ outcome: "failure", reason: "approval not found" });
      expect(receiptMachine.policy).toMatchObject({ decision: "deny", reason: "approval not found" });

      const audit = runtime.storage
        .listAuditEvents("venture_example_a")
        .find((item) => item.entity_type === "transition" && item.entity_id === stored.id);
      expect(audit?.event_type).toBe("lifecycle-transition-failed");
      expect(audit?.payload.policy).toMatchObject({ decision: "deny", reason: "approval not found" });

      const replay = await runtime.service.execute("venture.request_transition", input);
      expect(replay.data).toMatchObject({ idempotentReplay: true, outcome: "failure", reason: "approval not found" });
      expect(runtime.storage.getVenture("venture_example_a")?.lifecycle_state).toBe("candidate");
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects a supplied approval that has no requesting task with its own reason", async () => {
    const runtime = await tempRuntime();
    try {
      const { evidenceIds } = await prepareApprovalTransition(runtime);
      const rejected = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_a",
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds,
        requestingAgent: "fixture",
        approvalId: "approval_unbindable_ops384",
        actor: "fixture",
        idempotencyKey: "transition-unbindable-approval-ops384",
        requestedAt: new Date().toISOString()
      });
      expect((rejected.data as any).outcome).toBe("failure");
      expect((rejected.data as any).reason).toBe("transition approval cannot be validated without requestingTaskId");
      expect(runtime.storage.getVenture("venture_example_a")?.lifecycle_state).toBe("candidate");
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects a supplied approval when its requesting task does not exist", async () => {
    const runtime = await tempRuntime();
    try {
      const { evidenceIds } = await prepareApprovalTransition(runtime);
      const rejected = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_a",
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds,
        requestingTaskId: "task_missing_ops384",
        requestingAgent: "fixture",
        approvalId: "approval_missing_task_ops384",
        actor: "fixture",
        idempotencyKey: "transition-missing-task-ops384",
        requestedAt: new Date().toISOString()
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toEqual({
        code: "requesting-task-not-found",
        message: "requesting task not found: venture_example_a/task_missing_ops384"
      });
      expect(runtime.storage.getVenture("venture_example_a")?.lifecycle_state).toBe("candidate");
    } finally {
      await runtime.cleanup();
    }
  });

  it.each([
    ["another task", "task", "approval belongs to another venture or task"],
    ["another action digest", "digest", "approval action digest does not match current target/payload/budget/channel/provider"],
    ["pending status", "pending", "approval status is pending"],
    ["revocation", "revoked", "approval was revoked"],
    ["prior consumption", "consumed", "approval was already consumed"],
    ["expiry", "expired", "approval expired"]
  ] as const)("rejects an approval invalidated by %s for exactly one reason", async (_label, invalidation, expectedReason) => {
    const runtime = await tempRuntime();
    try {
      const { task, evidenceIds } = await prepareApprovalTransition(runtime);
      const approvalId = `approval_ops384_${invalidation}`;
      let approvalTask = task;
      if (invalidation === "task") {
        approvalTask = transitionApprovalTask("task_ops384_other");
        runtime.storage.createTask(approvalTask, actionDigest(approvalTask), "blocked");
      }
      runtime.storage.createApproval({
        ventureId: task.ventureId,
        id: approvalId,
        taskId: approvalTask.id,
        actionDigest: invalidation === "digest" ? sha256("wrong-action") : actionDigest(task),
        packet: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      if (invalidation !== "pending") {
        runtime.storage.db.prepare("UPDATE approvals SET status='approved' WHERE venture_id=? AND id=?").run(task.ventureId, approvalId);
      }
      if (invalidation === "revoked") {
        runtime.storage.db.prepare("UPDATE approvals SET revoked_at=? WHERE venture_id=? AND id=?").run(new Date().toISOString(), task.ventureId, approvalId);
      }
      if (invalidation === "consumed") {
        runtime.storage.db.prepare("UPDATE approvals SET consumed_at=? WHERE venture_id=? AND id=?").run(new Date().toISOString(), task.ventureId, approvalId);
      }
      if (invalidation === "expired") {
        runtime.storage.db.prepare("UPDATE approvals SET expires_at=? WHERE venture_id=? AND id=?").run(new Date(Date.now() - 1).toISOString(), task.ventureId, approvalId);
      }

      const rejected = await runtime.service.execute("venture.request_transition", {
        ventureId: task.ventureId,
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds,
        requestingTaskId: task.id,
        requestingAgent: "fixture",
        approvalId,
        actor: "fixture",
        idempotencyKey: `transition-invalid-${invalidation}-ops384`,
        requestedAt: new Date().toISOString()
      });
      expect((rejected.data as any).outcome).toBe("failure");
      expect((rejected.data as any).reason).toBe(expectedReason);
      expect(runtime.storage.getVenture(task.ventureId)?.lifecycle_state).toBe("candidate");
    } finally {
      await runtime.cleanup();
    }
  });

  it("accepts an exact approved task-bound approval", async () => {
    const runtime = await tempRuntime();
    try {
      const { task, evidenceIds } = await prepareApprovalTransition(runtime);
      const approvalId = "approval_exact_ops384";
      runtime.storage.createApproval({
        ventureId: task.ventureId,
        id: approvalId,
        taskId: task.id,
        actionDigest: actionDigest(task),
        packet: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      runtime.storage.db.prepare("UPDATE approvals SET status='approved' WHERE venture_id=? AND id=?").run(task.ventureId, approvalId);

      const accepted = await runtime.service.execute("venture.request_transition", {
        ventureId: task.ventureId,
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds,
        requestingTaskId: task.id,
        requestingAgent: "fixture",
        approvalId,
        actor: "fixture",
        idempotencyKey: "transition-exact-approval-ops384",
        requestedAt: new Date().toISOString()
      });
      expect((accepted.data as any).outcome).toBe("success");
      expect(runtime.storage.getVenture(task.ventureId)?.lifecycle_state).toBe("validating");
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps the no-approval path unchanged even when a bound task policy would require approval", async () => {
    const runtime = await tempRuntime();
    try {
      const { task, evidenceIds } = await prepareApprovalTransition(runtime);
      expect(evaluatePolicy(task).decision).toBe("approval-required");

      const accepted = await runtime.service.execute("venture.request_transition", {
        ventureId: task.ventureId,
        expectedState: "candidate",
        targetState: "validating",
        evidenceIds,
        requestingTaskId: task.id,
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "transition-no-approval-ops384",
        requestedAt: new Date().toISOString()
      });
      expect((accepted.data as any).outcome).toBe("success");
      expect(runtime.storage.getVenture(task.ventureId)?.lifecycle_state).toBe("validating");
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects fixture payment and fulfillment as authoritative real-world state", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const fixturePayment = evidence("venture_example_c", "authoritative-payment-collected", { authority: "payment", proofTier: "revenue-verified", metadata: { fixture: true } });
      runtime.storage.addEvidence(fixturePayment);
      const rejected = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_c",
        expectedState: "externally-live",
        targetState: "revenue-verified",
        evidenceIds: [fixturePayment.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "fixture-payment-rejected",
        requestedAt: new Date().toISOString()
      });
      expect((rejected.data as any).reason).toContain("non-fixture authoritative payment");
      expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe("externally-live");

      const realPayment = evidence("venture_example_c", "authoritative-payment-collected", { authority: "payment", proofTier: "revenue-verified", metadata: { fixture: false } });
      runtime.storage.addEvidence(realPayment);
      const accepted = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_c",
        expectedState: "externally-live",
        targetState: "revenue-verified",
        evidenceIds: [realPayment.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "authoritative-payment-accepted",
        requestedAt: new Date().toISOString()
      });
      expect((accepted.data as any).outcome).toBe("success");

      const fixtureFulfillment = evidence("venture_example_c", "authoritative-fulfillment-delivered", { authority: "fulfillment", proofTier: "fulfillment-verified", metadata: { fixture: true } });
      runtime.storage.addEvidence(fixtureFulfillment);
      const rejectedFulfillment = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_c",
        expectedState: "revenue-verified",
        targetState: "fulfillment-verified",
        evidenceIds: [fixtureFulfillment.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "fixture-fulfillment-rejected",
        requestedAt: new Date().toISOString()
      });
      expect((rejectedFulfillment.data as any).reason).toContain("non-fixture authoritative delivery");
    } finally {
      await runtime.cleanup();
    }
  });

  it("requires the same authoritative fulfillment candidate to carry a payment identity", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state='revenue-verified' WHERE id='venture_example_c'").run();
      const unboundFulfillment = evidence("venture_example_c", "authoritative-fulfillment-delivered", {
        authority: "fulfillment",
        proofTier: "fulfillment-verified",
        metadata: { fixture: false },
        observedAt: "2026-08-19T07:20:00.000Z"
      });
      const boundFixture = evidence("venture_example_c", "authoritative-fulfillment-delivered", {
        authority: "fixture",
        proofTier: "fixture-verified",
        metadata: { fixture: true, paymentObjectId: "pi_fixture" },
        observedAt: "2026-08-19T07:21:00.000Z"
      });
      const blankFulfillment = evidence("venture_example_c", "authoritative-fulfillment-delivered", {
        authority: "fulfillment",
        proofTier: "fulfillment-verified",
        metadata: { fixture: false, paymentObjectId: "   " },
        observedAt: "2026-08-19T07:21:30.000Z"
      });
      runtime.storage.addEvidence(unboundFulfillment);
      runtime.storage.addEvidence(boundFixture);
      runtime.storage.addEvidence(blankFulfillment);

      const rejected = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_c",
        expectedState: "revenue-verified",
        targetState: "fulfillment-verified",
        evidenceIds: [unboundFulfillment.id, boundFixture.id, blankFulfillment.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "unbound-authoritative-fulfillment-rejected",
        requestedAt: new Date().toISOString()
      });
      expect((rejected.data as any).outcome).toBe("failure");
      expect((rejected.data as any).reason).toBe("fulfillment requires a payment-bound authoritative delivery event");
      expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe("revenue-verified");

      const boundFulfillment = evidence("venture_example_c", "authoritative-fulfillment-delivered", {
        authority: "fulfillment",
        proofTier: "fulfillment-verified",
        metadata: { fixture: false, paymentObjectId: "pi_paid" },
        observedAt: "2026-08-19T07:22:00.000Z"
      });
      runtime.storage.addEvidence(boundFulfillment);
      const accepted = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_c",
        expectedState: "revenue-verified",
        targetState: "fulfillment-verified",
        evidenceIds: [unboundFulfillment.id, boundFixture.id, blankFulfillment.id, boundFulfillment.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: "payment-bound-authoritative-fulfillment-accepted",
        requestedAt: new Date().toISOString()
      });
      expect((accepted.data as any).outcome).toBe("success");
      expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe("fulfillment-verified");
    } finally {
      await runtime.cleanup();
    }
  });

  it.each(paymentBindingLenderCases)("rejects payment binding lent by a candidate with a $label", async ({ authority, proofTier, metadata }) => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state='revenue-verified' WHERE id='venture_example_c'").run();
      const unboundFulfillment = evidence("venture_example_c", "authoritative-fulfillment-delivered", {
        authority: "fulfillment",
        proofTier: "fulfillment-verified",
        metadata: { fixture: false },
        observedAt: "2026-08-19T07:20:00.000Z"
      });
      const lender = evidence("venture_example_c", "authoritative-fulfillment-delivered", {
        authority,
        proofTier,
        metadata,
        observedAt: "2026-08-19T07:21:00.000Z"
      });
      runtime.storage.addEvidence(unboundFulfillment);
      runtime.storage.addEvidence(lender);

      const rejected = await runtime.service.execute("venture.request_transition", {
        ventureId: "venture_example_c",
        expectedState: "revenue-verified",
        targetState: "fulfillment-verified",
        evidenceIds: [unboundFulfillment.id, lender.id],
        requestingAgent: "fixture",
        actor: "fixture",
        idempotencyKey: `single-fixture-marker-lender-${authority}-${proofTier}-${metadata.fixture}`,
        requestedAt: new Date().toISOString()
      });
      expect((rejected.data as any).outcome).toBe("failure");
      expect((rejected.data as any).reason).toBe("fulfillment requires a payment-bound authoritative delivery event");
      expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe("revenue-verified");
    } finally {
      await runtime.cleanup();
    }
  });

  describe.each(fixturePromotionCases)("$label fixture promotion guard", ({ expectedState, targetState, type, realProofTier, rejection }) => {
    it("rejects each independent fixture marker", async () => {
      const runtime = await tempRuntime();
      try {
        await runtime.loadPacks();
        runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state = ? WHERE id = ?").run(expectedState, "venture_example_c");
        const fixtureMarkers: Array<Partial<EvidenceItem>> = [
          { authority: "fixture", proofTier: realProofTier, metadata: { fixture: false } },
          { authority: "engine", proofTier: "fixture-verified", metadata: { fixture: false } },
          { authority: "engine", proofTier: realProofTier, metadata: { fixture: true } }
        ];

        for (const [index, overrides] of fixtureMarkers.entries()) {
          const item = evidence("venture_example_c", type, overrides);
          runtime.storage.addEvidence(item);
          const result = await runtime.service.execute("venture.request_transition", {
            ventureId: "venture_example_c",
            expectedState,
            targetState,
            evidenceIds: [item.id],
            requestingAgent: "fixture",
            actor: "fixture",
            idempotencyKey: `${targetState}-fixture-marker-${index}`,
            requestedAt: new Date().toISOString()
          });
          expect((result.data as any).outcome).toBe("failure");
          expect((result.data as any).reason).toBe(rejection);
          expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe(expectedState);
        }
      } finally {
        await runtime.cleanup();
      }
    });

    it("allows one current non-fixture candidate alongside a fixture candidate", async () => {
      const runtime = await tempRuntime();
      try {
        await runtime.loadPacks();
        runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state = ? WHERE id = ?").run(expectedState, "venture_example_c");
        const fixtureItem = evidence("venture_example_c", type, {
          authority: "fixture",
          proofTier: "fixture-verified",
          metadata: { fixture: true }
        });
        const realItem = evidence("venture_example_c", type, {
          authority: "engine",
          proofTier: realProofTier,
          metadata: { fixture: false }
        });
        runtime.storage.addEvidence(fixtureItem);
        runtime.storage.addEvidence(realItem);

        const result = await runtime.service.execute("venture.request_transition", {
          ventureId: "venture_example_c",
          expectedState,
          targetState,
          evidenceIds: [fixtureItem.id, realItem.id],
          requestingAgent: "fixture",
          actor: "fixture",
          idempotencyKey: `${targetState}-mixed-candidates`,
          requestedAt: new Date().toISOString()
        });
        expect((result.data as any).outcome).toBe("success");
        expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe(targetState);
      } finally {
        await runtime.cleanup();
      }
    });

    it("reports stale evidence before fixture classification", async () => {
      const runtime = await tempRuntime();
      try {
        await runtime.loadPacks();
        runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state = ? WHERE id = ?").run(expectedState, "venture_example_c");
        const staleFixture = evidence("venture_example_c", type, {
          authority: "fixture",
          proofTier: "fixture-verified",
          metadata: { fixture: true },
          status: "stale"
        });
        runtime.storage.addEvidence(staleFixture);

        const result = await runtime.service.execute("venture.request_transition", {
          ventureId: "venture_example_c",
          expectedState,
          targetState,
          evidenceIds: [staleFixture.id],
          requestingAgent: "fixture",
          actor: "fixture",
          idempotencyKey: `${targetState}-stale-fixture`,
          requestedAt: new Date().toISOString()
        });
        expect((result.data as any).outcome).toBe("failure");
        expect((result.data as any).reason).toBe(`evidence ${staleFixture.id} is stale`);
        expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe(expectedState);
      } finally {
        await runtime.cleanup();
      }
    });
  });

  it("surfaces conflicting and superseded transition reasons distinctly", async () => {
    for (const scenario of ["conflicting", "superseded"] as const) {
      const runtime = await tempRuntime();
      try {
        await runtime.loadPacks();
        runtime.storage.db.prepare("UPDATE ventures SET lifecycle_state = 'launch-ready' WHERE id = 'venture_example_c'").run();
        const selected = evidence("venture_example_c", "external-surface-live", {
          authority: "public",
          proofTier: "externally-live",
          metadata: { fixture: false },
          status: scenario,
          contentHash: sha256(`${scenario}-selected`)
        });
        runtime.storage.addEvidence(selected);

        const result = await runtime.service.execute("venture.request_transition", {
          ventureId: "venture_example_c",
          expectedState: "launch-ready",
          targetState: "externally-live",
          evidenceIds: [selected.id],
          requestingAgent: "fixture",
          actor: "fixture",
          idempotencyKey: `${scenario}-reason`,
          requestedAt: new Date().toISOString()
        });

        expect((result.data as any).outcome).toBe("failure");
        expect((result.data as any).reason).toBe(`evidence ${selected.id} is ${scenario}`);
        expect(runtime.storage.getVenture("venture_example_c")?.lifecycle_state).toBe("launch-ready");
      } finally {
        await runtime.cleanup();
      }
    }
  });

  it("marks superseded and conflicting source assertions as readiness gaps", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const assertion = runtime.storage.getVenture("venture_example_a")?.pack?.assertions.buyer.problem;
      if (!assertion?.observedAt || assertion.freshForHours === undefined) {
        throw new Error("BSD buyer.problem fixture requires an explicit freshness boundary");
      }
      vi.useFakeTimers();
      vi.setSystemTime(new Date(new Date(assertion.observedAt).getTime() + assertion.freshForHours * 3_600_000 - 1));
      runtime.storage.db.prepare("UPDATE source_snapshots SET status='superseded' WHERE venture_id='venture_example_a' AND source_ref='bsd_plan_gating'").run();
      const superseded = await runtime.service.execute("venture.readiness", { ventureId: "venture_example_a" });
      expect((superseded.data as any).gaps.some((gap: any) => gap.reason === "stale" && gap.sourceRefs.includes("bsd_plan_gating"))).toBe(true);
      runtime.storage.db.prepare("UPDATE source_snapshots SET status='conflicting' WHERE venture_id='venture_example_a' AND source_ref='bsd_plan_gating'").run();
      const result = await runtime.service.execute("venture.readiness", { ventureId: "venture_example_a" });
      expect((result.data as any).gaps.some((gap: any) => gap.reason === "conflicting")).toBe(true);
    } finally {
      vi.useRealTimers();
      await runtime.cleanup();
    }
  });
});
