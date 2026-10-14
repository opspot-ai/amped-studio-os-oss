import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EngineStorage } from "@amped-studio-os/storage";
import { ReadOnlySourceAdapter } from "@amped-studio-os/adapters";
import { EngineWorker } from "@amped-studio-os/domain";
import { TaskDefinitionSchema, cloudExecutionContext, executionContext, localExecutionContext, sha256, type VenturePack } from "@amped-studio-os/contracts";
import { isExplicitLocalCommandRequest } from "../apps/control/app/api/command/route.js";
import { tempRuntime } from "./helpers.js";

describe("venture isolation", () => {
  it("rejects cross-venture task/receipt and evidence access", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const planned = await runtime.service.execute("task.plan", { ventureId: "venture_example_a" });
      expect(planned.ok).toBe(true);
      const taskId = (planned.data as any).task.id;
      expect(runtime.storage.getTask("venture_example_c", taskId)).toBeUndefined();
      expect(() =>
        runtime.storage.attachReceipt({
          id: "receipt_crossventure",
          ventureId: "venture_example_c",
          taskId,
          proofTier: "fixture-verified",
          outcome: "success",
          actor: "fixture",
          adapter: "fixture",
          artifactPath: "receipts/nope.json",
          contentHash: sha256("cross-venture"),
          occurredAt: new Date().toISOString(),
          metadata: {}
        })
      ).toThrow();
    } finally {
      await runtime.cleanup();
    }
  });

  it("requires same-venture dependencies and blocks child claims until parents succeed", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const base = TaskDefinitionSchema.parse({
        id: "task_parent",
        ventureId: "venture_example_a",
        purpose: "parent",
        expectedOutcome: "parent proof",
        ownerRole: "scout",
        dependencies: [],
        sourceRefs: ["bsd_public_site"],
        mode: "fixture",
        expectedProof: "fixture",
        gateClass: "safe-internal-read-only",
        actionBounds: {},
        budgetCents: 0,
        costCeilingCents: 0,
        approvalRequired: false,
        idempotencyKey: "parent-task-key",
        maxAttempts: 1,
        backoffMs: 0,
        timeoutMs: 1000,
        lifecycleEffect: {},
        metricEffects: []
      });
      runtime.storage.createTask(base, sha256(base), "ready");
      const child = TaskDefinitionSchema.parse({ ...base, id: "task_child", purpose: "child", dependencies: [base.id], idempotencyKey: "child-task-key" });
      runtime.storage.createTask(child, sha256(child), "ready");
      runtime.storage.enqueueJob({ ventureId: child.ventureId, id: "job_child", taskId: child.id, kind: "role-dispatch", payload: {} });
      expect(runtime.storage.claimNextJob("workspace_local", "worker", 1000)).toBeUndefined();
      runtime.storage.setTaskStatus(base.ventureId, base.id, "succeeded");
      expect(runtime.storage.claimNextJob("workspace_local", "worker", 1000)?.task_id).toBe(child.id);

      const foreign = TaskDefinitionSchema.parse({ ...base, id: "task_foreign", ventureId: "venture_example_c", idempotencyKey: "foreign-task-key" });
      expect(() => runtime.storage.createTask({ ...foreign, dependencies: [base.id] }, sha256(foreign), "ready")).toThrow();
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps initiative and golden jobs away from the legacy role dispatcher", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const base = TaskDefinitionSchema.parse({
        id: "task_dedicated_worker_base",
        ventureId: "venture_example_a",
        purpose: "dedicated worker only",
        expectedOutcome: "dedicated worker receipt",
        ownerRole: "scout",
        dependencies: [],
        sourceRefs: ["bsd_public_site"],
        mode: "internal-read-only",
        expectedProof: "task-bound receipt",
        gateClass: "safe-internal-read-only",
        actionBounds: {},
        budgetCents: 0,
        costCeilingCents: 0,
        approvalRequired: false,
        idempotencyKey: "dedicated-worker-base",
        maxAttempts: 1,
        backoffMs: 0,
        timeoutMs: 1000,
        lifecycleEffect: {},
        metricEffects: []
      });
      const initiative = TaskDefinitionSchema.parse({ ...base, id: "task_initiative_only", idempotencyKey: "initiative-only" });
      const golden = TaskDefinitionSchema.parse({ ...base, id: "task_golden_only", mode: "external", idempotencyKey: "golden-only" });
      runtime.storage.createTask(initiative, sha256(initiative), "ready");
      runtime.storage.createTask(golden, sha256(golden), "ready");
      runtime.storage.enqueueJob({ ventureId: initiative.ventureId, id: "job_initiative_only", taskId: initiative.id, kind: "initiative-execution", payload: {} });
      runtime.storage.enqueueJob({ ventureId: golden.ventureId, id: "job_golden_only", taskId: golden.id, kind: "golden-execution", payload: {} });
      expect(await runtime.worker.runOnce()).toBeNull();
      expect(runtime.storage.db.prepare("SELECT kind,status FROM jobs WHERE id IN (?,?) ORDER BY kind").all(
        "job_initiative_only",
        "job_golden_only"
      )).toEqual([
        { kind: "golden-execution", status: "queued" },
        { kind: "initiative-execution", status: "queued" }
      ]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects traversal, outside roots, secret-like files, and symlinks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cle-source-test-"));
    const allowed = path.join(directory, "allowed");
    const outside = path.join(directory, "outside.txt");
    await mkdir(allowed);
    await writeFile(path.join(allowed, "ok.txt"), "safe");
    await writeFile(outside, "outside");
    await writeFile(path.join(allowed, ".env"), "SECRET=value");
    await symlink(outside, path.join(allowed, "link.txt"));
    const adapter = new ReadOnlySourceAdapter({ venture_test: [allowed] });
    const source = (candidate: string) => ({
      id: "source_test",
      kind: "file" as const,
      authority: "product" as const,
      path: candidate,
      observedAt: new Date().toISOString(),
      freshForHours: 24,
      confidence: 1,
      rights: "owned" as const,
      description: "test"
    });
    try {
      await expect(adapter.readText("venture_test", source(path.join(allowed, "ok.txt")))).resolves.toBe("safe");
      await expect(adapter.readText("venture_test", source(outside))).rejects.toThrow("outside allowed roots");
      await expect(adapter.readText("venture_test", source(`${allowed}/../outside.txt`))).rejects.toThrow("path traversal");
      await expect(adapter.readText("venture_test", source(path.join(allowed, ".env")))).rejects.toThrow("secret-like");
      await expect(adapter.readText("venture_test", source(path.join(allowed, "link.txt")))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps identical entity IDs isolated by compound venture keys", () => {
    const storage = new EngineStorage(":memory:");
    try {
      const pack = (id: string, slug: string) => ({
        schemaVersion: "1.0.0",
        venture: { id, slug, name: slug, owner: "owner", owningRepo: `/tmp/${slug}`, declaredState: "candidate" }
      }) as unknown as VenturePack;
      for (const [id, slug] of [["venture_one", "one"], ["venture_two", "two"]] as const) {
        storage.upsertPack({ pack: pack(id, slug), workspaceId: "workspace_local", canonicalHash: sha256({ id }), canonicalJson: JSON.stringify(pack(id, slug)), sourcePath: `/tmp/${slug}.yaml`, revisionId: `rev_${slug}`, createdAt: new Date().toISOString() });
      }
      expect(storage.listVentures().map((item) => item.id)).toEqual(["venture_one", "venture_two"]);
    } finally {
      storage.close();
    }
  });

  it("allows the same company slug in different workspaces without exposing storage namespacing", () => {
    const storage = new EngineStorage(":memory:");
    const pack = (id: string) => ({
      schemaVersion: "1.0.0",
      venture: { id, slug: "shared-company", name: "Shared", owner: "owner", owningRepo: `/tmp/${id}`, declaredState: "candidate" }
    }) as unknown as VenturePack;
    try {
      for (const workspaceId of ["workspace_alpha", "workspace_beta"]) storage.ensureWorkspace(workspaceId);
      for (const [workspaceId, ventureId] of [["workspace_alpha", "venture_alpha"], ["workspace_beta", "venture_beta"]] as const) {
        storage.upsertPack({
          pack: pack(ventureId),
          workspaceId,
          canonicalHash: sha256({ workspaceId, ventureId }),
          canonicalJson: JSON.stringify(pack(ventureId)),
          sourcePath: `/tmp/${ventureId}.yaml`,
          revisionId: `revision_${ventureId}`,
          createdAt: new Date().toISOString()
        });
      }
      expect(storage.listVenturesInWorkspace("workspace_alpha").map((venture) => venture.slug)).toEqual(["shared-company"]);
      expect(storage.listVenturesInWorkspace("workspace_beta").map((venture) => venture.slug)).toEqual(["shared-company"]);
    } finally {
      storage.close();
    }
  });

  it("fails closed across immutable A/B contexts and keeps a foreign canary out of queries", async () => {
    const runtime = await tempRuntime();
    const workspaceA = executionContext("workspace_alpha", "api");
    const workspaceB = executionContext("workspace_beta", "api");
    try {
      const packA = path.join(runtime.root, "ventures/example-a/pack.yaml");
      const packB = path.join(runtime.root, "ventures/example-c/pack.yaml");
      expect((await runtime.service.execute("venture.create_or_update_pack", { packPath: packA }, workspaceA)).ok).toBe(true);
      expect((await runtime.service.execute("venture.create_or_update_pack", { packPath: packB }, workspaceB)).ok).toBe(true);
      expect((await runtime.service.execute("venture.create_or_update_pack", { packPath: packA }, workspaceB)).error?.code).toBe("workspace-access-denied");
      expect(Object.isFrozen(workspaceA)).toBe(true);
      expect(Object.isFrozen(cloudExecutionContext("workspace_cloud"))).toBe(true);
      expect(localExecutionContext("cli").workspaceId).toBe("workspace_local");

      const foreign = await runtime.service.execute("venture.get", { ventureId: "venture_example_a" }, workspaceB);
      const missing = await runtime.service.execute("venture.get", { ventureId: "venture_missing" }, workspaceB);
      expect(foreign.error?.code).toBe("workspace-access-denied");
      expect(missing.error?.code).toBe(foreign.error?.code);
      expect((await runtime.service.execute("receipt.attach", {
        id: "receipt_workspace_attack",
        ventureId: "venture_example_a",
        proofTier: "fixture-verified",
        outcome: "success",
        actor: "attacker",
        adapter: "fixture",
        artifactPath: "receipts/attack.json",
        contentHash: sha256("workspace-attack"),
        occurredAt: new Date().toISOString(),
        metadata: {}
      }, workspaceB)).error?.code).toBe("workspace-access-denied");

      expect((await runtime.service.execute("venture.get", {
        ventureId: "venture_example_a",
        workspaceId: "workspace_beta"
      }, workspaceA)).error?.code).toBe("invalid-input");
      expect((await runtime.service.execute("skill.version.record", {
        ventureId: "venture_example_a",
        skillId: "skill_workspace_attack",
        version: "0.1.0",
        name: "Workspace attack",
        state: "candidate",
        artifactPath: "skills/workspace-attack/SKILL.md",
        artifactHash: sha256("workspace-attack"),
        applicability: ["workspace attack"],
        mutableSurface: ["none"],
        evaluatedVentureIds: ["venture_example_c"],
        producerId: "attacker",
        recordedBy: "attacker",
        reason: "attempt a cross-workspace reference",
        recordedAt: new Date().toISOString(),
        idempotencyKey: "workspace-attack-skill-v1"
      }, workspaceA)).error?.code).toBe("workspace-access-denied");

      const canary = "CANARY_WORKSPACE_B_7cbb5db4";
      runtime.storage.attachReceipt({
        id: "receipt_workspace_beta_canary",
        ventureId: "venture_example_c",
        proofTier: "fixture-verified",
        outcome: "success",
        actor: "fixture",
        adapter: "fixture",
        artifactPath: "receipts/workspace-beta-canary.json",
        contentHash: sha256(canary),
        occurredAt: new Date().toISOString(),
        metadata: { canary }
      });
      const betaTask = (await runtime.service.execute("task.plan", { ventureId: "venture_example_c" }, workspaceB)).data as any;
      const betaTaskRecord = runtime.storage.getTask("venture_example_c", betaTask.task.id)!;
      runtime.storage.createApproval({
        ventureId: "venture_example_c",
        id: "approval_workspace_beta_canary",
        taskId: betaTask.task.id,
        actionDigest: betaTaskRecord.actionDigest,
        packet: { canary },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      const alphaViews = await Promise.all([
        runtime.service.execute("venture.get", { ventureId: "venture_example_a" }, workspaceA),
        runtime.service.execute("portfolio.scorecard", {}, workspaceA),
        runtime.service.execute("approval.list_pending", {}, workspaceA)
      ]);
      expect(JSON.stringify(alphaViews)).not.toContain(canary);
      expect(JSON.stringify(await runtime.service.execute("approval.list_pending", {}, workspaceB))).toContain(canary);
      expect(runtime.storage.workspaceForVenture("venture_example_a")).toBe("workspace_alpha");
      expect(runtime.storage.workspaceForVenture("venture_example_c")).toBe("workspace_beta");
    } finally {
      await runtime.cleanup();
    }
  });

  it("leases, recovers, executes, and receipts jobs only inside the worker workspace", async () => {
    const runtime = await tempRuntime();
    const workspaceA = executionContext("workspace_alpha", "api");
    const workspaceB = executionContext("workspace_beta", "api");
    try {
      await runtime.service.execute("venture.create_or_update_pack", { packPath: path.join(runtime.root, "ventures/example-a/pack.yaml") }, workspaceA);
      await runtime.service.execute("venture.create_or_update_pack", { packPath: path.join(runtime.root, "ventures/example-c/pack.yaml") }, workspaceB);
      const taskA = (await runtime.service.execute("task.plan", { ventureId: "venture_example_a" }, workspaceA)).data as any;
      const taskB = (await runtime.service.execute("task.plan", { ventureId: "venture_example_c" }, workspaceB)).data as any;
      await runtime.service.execute("task.run_safe", { ventureId: "venture_example_a", taskId: taskA.task.id }, workspaceA);
      await runtime.service.execute("task.run_safe", { ventureId: "venture_example_c", taskId: taskB.task.id }, workspaceB);

      expect(runtime.storage.claimNextJob("workspace_beta", "crashed-beta", 1)?.venture_id).toBe("venture_example_c");
      const afterLease = new Date(Date.now() + 1000).toISOString();
      expect(runtime.storage.recoverExpiredJobs("workspace_alpha", afterLease)).toBe(0);
      expect(runtime.storage.listJobs("venture_example_c")).toEqual([expect.objectContaining({ status: "leased" })]);
      expect(runtime.storage.recoverExpiredJobs("workspace_beta", afterLease)).toBe(1);

      const workerA = new EngineWorker(runtime.service, "worker-alpha", executionContext("workspace_alpha", "worker"));
      const resultA = await workerA.runOnce();
      expect(resultA).toMatchObject({ ventureId: "venture_example_a", outcome: "success" });
      expect(runtime.storage.listJobs("venture_example_c")).toEqual([expect.objectContaining({ status: "queued" })]);
      expect(runtime.storage.listReceipts("venture_example_c")).toEqual([]);

      const workerB = new EngineWorker(runtime.service, "worker-beta", executionContext("workspace_beta", "worker"));
      expect(await workerB.runOnce()).toMatchObject({ ventureId: "venture_example_c", outcome: "success" });
      expect(runtime.storage.listReceipts("venture_example_a")).toHaveLength(1);
      expect(runtime.storage.listReceipts("venture_example_c")).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("migrates a populated v4 database into immutable local workspace ownership", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cle-workspace-migration-"));
    const filename = path.join(directory, "engine.db");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,name,applied_at) VALUES
        (1,'core','2026-01-01T00:00:00.000Z'),(2,'records','2026-01-01T00:00:00.000Z'),
        (3,'receipts','2026-01-01T00:00:00.000Z'),(4,'tasks','2026-01-01T00:00:00.000Z');
      CREATE TABLE ventures (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, owner TEXT NOT NULL,
        owning_repo TEXT NOT NULL, lifecycle_state TEXT NOT NULL, current_pack_hash TEXT,
        current_pack_revision_id TEXT, kill_switch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO ventures(id,slug,name,owner,owning_repo,lifecycle_state,created_at,updated_at)
      VALUES('venture_legacy','legacy','Legacy','owner','/tmp/legacy','candidate','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    `);
    legacy.close();
    const storage = new EngineStorage(filename);
    try {
      expect(storage.workspaceForVenture("venture_legacy")).toBe("workspace_local");
      storage.ensureWorkspace("workspace_alpha");
      expect(() => storage.db.prepare("UPDATE ventures SET workspace_id='workspace_alpha' WHERE id='venture_legacy'").run()).toThrow("venture workspace is immutable");
      expect(() => storage.db.prepare("DELETE FROM workspaces WHERE id='workspace_local'").run()).toThrow("workspace is in use");
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never selects local authority from request headers or body", () => {
    const request = new Request("http://localhost/api/command", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opspot-workspace-id": "workspace_attacker" },
      body: JSON.stringify({ command: "company.list", input: { workspaceId: "workspace_attacker" } })
    });
    expect(isExplicitLocalCommandRequest(request, { NODE_ENV: "test", ENGINE_WORKSPACE_ID: "" })).toBe(false);
    expect(isExplicitLocalCommandRequest(request, { NODE_ENV: "production", ENGINE_WORKSPACE_ID: "workspace_local" })).toBe(false);
    expect(isExplicitLocalCommandRequest(request, { NODE_ENV: "production", ENGINE_MODE: "local", ENGINE_WORKSPACE_ID: "workspace_local" })).toBe(true);
    expect(isExplicitLocalCommandRequest(request, { NODE_ENV: "development", ENGINE_MODE: "cloud", ENGINE_WORKSPACE_ID: "workspace_local" })).toBe(false);
    expect(isExplicitLocalCommandRequest(new Request("https://example.test/api/command"), {
      NODE_ENV: "development",
      ENGINE_WORKSPACE_ID: "workspace_local"
    })).toBe(false);
    expect(isExplicitLocalCommandRequest(request, { NODE_ENV: "development", ENGINE_WORKSPACE_ID: "workspace_local" })).toBe(true);
  });
});
