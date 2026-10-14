import { describe, expect, it, vi } from "vitest";
import {
  AdminSupportAuditEventSchema,
  AdminSupportSessionSchema,
  AmpedApprovalDecisionPacketBodySchema,
  AmpedApprovalDecisionPacketSchema,
  TaskDefinitionSchema,
  WorkspaceInviteSchema,
  decisionPacketActionDigest,
  sha256,
  type TaskDefinition
} from "@amped-studio-os/contracts";
import {
  EngineStorage,
  KernelStorageAccessError,
  KernelStorageConflictError,
  PostgresKernelStorage,
  SqliteKernelStorage
} from "@amped-studio-os/storage";
import { handleAdminRequest, platformAdminSubjects, type AdminRouteDependencies } from "../apps/control/lib/admin-route.js";
import { handleAuthRequest, type AuthRouteDependencies } from "../apps/control/lib/auth-route.js";

const NOW = "2026-07-29T03:00:00.000Z";
const LATER = "2026-07-29T04:00:00.000Z";
const ADMIN = "00000000-0000-4000-8000-000000000001";
const FOUNDER = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
const WORKSPACE = "workspace_readiness";
const TOKEN = "invite-token-with-enough-entropy-1234567890";
const TOKEN_HASH = sha256(TOKEN);

function gatedTask(): TaskDefinition {
  return TaskDefinitionSchema.parse({
    id: "task_founder_gate",
    ventureId: "venture_readiness",
    taskKind: "venture-play",
    purpose: "Approve the exact evidence-bound replan",
    expectedOutcome: "one bounded founder decision",
    ownerRole: "human",
    dependencies: ["task_verified_offer"],
    sourceRefs: ["engine://amped/run/run_readiness"],
    mode: "internal-read-only",
    expectedProof: "exact founder approval",
    gateClass: "unfamiliar-claim",
    actionBounds: {
      executionClass: "amped-human-resume",
      authorityDisposition: "approval-required",
      senderOrSystem: "founder",
      graphRunId: "run_readiness",
      nodeActivationId: "activation_founder",
      nextNodeId: "learn",
      runVersion: 1,
      exactCommandOrProviderCall: "amped-human-resume:run_readiness:activation_founder"
    },
    budgetCents: 0,
    costCeilingCents: 0,
    approvalRequired: true,
    approvalId: "approval_readiness",
    idempotencyKey: "amped:run_readiness:activation_founder",
    maxAttempts: 1,
    backoffMs: 0,
    timeoutMs: 120_000,
    lifecycleEffect: {},
    metricEffects: []
  });
}

function packetBody() {
  return AmpedApprovalDecisionPacketBodySchema.parse({
    schemaVersion: "amped-approval-decision-v1",
    approvalId: "approval_readiness",
    expiresAt: LATER,
    companyId: "venture_readiness",
    companyName: "Readiness Company",
    initiativeId: "initiative_readiness",
    initiativeTitle: "Verify one bounded offer",
    question: "May the graph continue from verified offer evidence into the next internal replan?",
    whyNow: "Independent offer verification passed and the next branch requires founder authority.",
    orderedAgentActions: [
      { order: 1, role: "specialist", action: "Commit the approved teaching record." },
      { order: 2, role: "planner", action: "Replan only from cited verified evidence." }
    ],
    allowedSourceScopes: ["owning-repository", "stored-company-evidence", "public-primary-sources"],
    allowedToolIds: ["structured_output"],
    limits: {
      maxTimeMinutes: 2,
      maxInputTokens: 12_000,
      maxOutputTokens: 3_000,
      maxCostCents: 0,
      maxOutreach: 0,
      maxExternalEffects: 0
    },
    forbiddenActions: [
      "outreach",
      "public posting",
      "deployment",
      "credential mutation",
      "billing",
      "customer-system mutation",
      "another-company action"
    ],
    expectedArtifact: {
      kind: "evidence-bound replan",
      requiredFields: ["decision trace", "teaching record", "next initiative"]
    },
    verifier: {
      identity: "verifier_amped",
      role: "independent verifier",
      separationRule: "The verifier must not be the producing specialist or planner."
    },
    proofRequired: ["cited evidence", "independent verifier receipt", "material next-initiative decision"],
    successSignals: ["The next initiative changes only from material verified evidence."],
    failureSignals: ["Evidence is missing, conflicting, stale, or insufficient."],
    stopConditions: ["Stop when new authority, unfamiliar claims, private sources, or external effects are required."],
    escalationRoute: "Pause the company and return a new exact founder decision packet.",
    exactUnlock: {
      nodeId: "learn",
      action: "Resume only activation activation_founder into the learn node."
    },
    remainsLocked: [
      "spend",
      "outreach",
      "public posting",
      "deployment",
      "credentials",
      "billing",
      "other companies"
    ]
  });
}

describe("Amped dogfood-readiness contracts", () => {
  it("binds every packet-body field and the exact task action into one non-circular digest", () => {
    const task = gatedTask();
    const body = packetBody();
    const digest = decisionPacketActionDigest(task, body);
    const packet = AmpedApprovalDecisionPacketSchema.parse({ ...body, actionDigest: digest });
    expect(packet.actionDigest).toBe(digest);
    expect(decisionPacketActionDigest(task, { ...body, whyNow: `${body.whyNow} Changed.` })).not.toBe(digest);
    expect(decisionPacketActionDigest({ ...task, purpose: `${task.purpose} changed` }, body)).not.toBe(digest);
    expect(decisionPacketActionDigest(task, {
      ...body,
      allowedSourceScopes: [...body.allowedSourceScopes].reverse()
    })).not.toBe(digest);
    expect(() => AmpedApprovalDecisionPacketBodySchema.parse({ ...body, actionDigest: digest })).toThrow();
  });

  it("keeps invite, support-session, and support-audit records strict and secret-free", () => {
    const invite = WorkspaceInviteSchema.parse({
      schemaVersion: "workspace-invite-v1",
      id: "invite_readiness",
      tokenHash: TOKEN_HASH,
      invitedEmail: "synthetic-contact-008@example.test",
      targetWorkspaceId: WORKSPACE,
      role: "owner",
      creatorSubject: ADMIN,
      createdAt: NOW,
      expiresAt: LATER,
      status: "pending"
    });
    expect(JSON.stringify(invite)).not.toContain(TOKEN);
    expect(() => WorkspaceInviteSchema.parse({ ...invite, rawToken: TOKEN })).toThrow();
    expect(AdminSupportSessionSchema.parse({
      schemaVersion: "admin-support-session-v1",
      id: "support_readiness",
      adminSubject: ADMIN,
      targetWorkspaceId: WORKSPACE,
      reason: "Verify the invited founder's empty workspace.",
      startedAt: NOW,
      expiresAt: LATER,
      status: "active"
    }).status).toBe("active");
    expect(AdminSupportAuditEventSchema.parse({
      schemaVersion: "admin-support-audit-v1",
      id: "support_audit_readiness",
      supportSessionId: "support_readiness",
      adminSubject: ADMIN,
      targetWorkspaceId: WORKSPACE,
      command: "company.list",
      inputDigest: sha256({}),
      outcome: "succeeded",
      resultCode: "ok",
      attemptedAt: NOW
    }).outcome).toBe("succeeded");
  });
});

describe("dogfood-readiness durable storage", () => {
  it("accepts an invite exactly once and keeps support audit immutable across SQLite", async () => {
    const engine = new EngineStorage(":memory:");
    const storage = new SqliteKernelStorage(engine);
    await storage.ensureWorkspace(WORKSPACE);
    await storage.ensureWorkspace("workspace_other");
    const invite = WorkspaceInviteSchema.parse({
      schemaVersion: "workspace-invite-v1",
      id: "invite_readiness",
      tokenHash: TOKEN_HASH,
      invitedEmail: "synthetic-contact-008@example.test",
      targetWorkspaceId: WORKSPACE,
      role: "owner",
      creatorSubject: ADMIN,
      createdAt: NOW,
      expiresAt: LATER,
      status: "pending"
    });
    expect((await storage.createWorkspaceInvite(invite)).created).toBe(true);
    expect(JSON.stringify(engine.db.prepare("SELECT * FROM workspace_invites").all())).not.toContain(TOKEN);
    await expect(storage.acceptWorkspaceInvite({
      tokenHash: TOKEN_HASH,
      invitedEmail: "synthetic-contact-031@example.test",
      authSubject: FOUNDER,
      acceptedAt: "2026-07-29T03:10:00.000Z"
    })).rejects.toBeInstanceOf(KernelStorageAccessError);
    const accepted = await storage.acceptWorkspaceInvite({
      tokenHash: TOKEN_HASH,
      invitedEmail: "synthetic-contact-008@example.test",
      authSubject: FOUNDER,
      acceptedAt: "2026-07-29T03:10:00.000Z"
    });
    expect(accepted).toMatchObject({ workspaceId: WORKSPACE, authSubject: FOUNDER, role: "owner" });
    expect(await storage.acceptWorkspaceInvite({
      tokenHash: TOKEN_HASH,
      invitedEmail: "synthetic-contact-008@example.test",
      authSubject: FOUNDER,
      acceptedAt: "2026-07-29T03:11:00.000Z"
    })).toEqual(accepted);
    await expect(storage.acceptWorkspaceInvite({
      tokenHash: TOKEN_HASH,
      invitedEmail: "synthetic-contact-008@example.test",
      authSubject: OTHER,
      acceptedAt: "2026-07-29T03:12:00.000Z"
    })).rejects.toBeInstanceOf(KernelStorageConflictError);

    const session = AdminSupportSessionSchema.parse({
      schemaVersion: "admin-support-session-v1",
      id: "support_readiness",
      adminSubject: ADMIN,
      targetWorkspaceId: WORKSPACE,
      reason: "Verify the invited founder's empty workspace.",
      startedAt: NOW,
      expiresAt: LATER,
      status: "active"
    });
    expect((await storage.createSupportSession(session)).created).toBe(true);
    const audit = AdminSupportAuditEventSchema.parse({
      schemaVersion: "admin-support-audit-v1",
      id: "support_audit_readiness",
      supportSessionId: session.id,
      adminSubject: ADMIN,
      targetWorkspaceId: WORKSPACE,
      command: "company.list",
      inputDigest: sha256({}),
      outcome: "succeeded",
      resultCode: "ok",
      attemptedAt: NOW
    });
    expect((await storage.appendSupportAuditEvent(audit)).created).toBe(true);
    expect(await storage.listSupportAuditEvents(ADMIN, WORKSPACE, session.id)).toEqual([audit]);
    expect(() => engine.db.prepare("UPDATE support_audit_events SET outcome='failed'").run()).toThrow();
    expect(() => engine.db.prepare("DELETE FROM support_audit_events").run()).toThrow();
    expect((await storage.getSupportSession(ADMIN, session.id, "2026-07-29T04:01:00.000Z"))?.status).toBe("expired");
    engine.close();
  });
});

type AuthClient = Awaited<ReturnType<AuthRouteDependencies["createClient"]>>;

function authClient(): AuthClient {
  return {
    auth: {
      getClaims: vi.fn(async () => ({
        data: { claims: { sub: FOUNDER, email: "synthetic-contact-008@example.test", role: "authenticated" } },
        error: null
      })),
      signUp: vi.fn(async () => ({ data: { session: { access_token: "verified-token" } }, error: null })),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
      signOut: vi.fn()
    }
  } as unknown as AuthClient;
}

describe("canonical signup auth boundary", () => {
  it("rejects missing and wrong-email invites before the auth provider and accepts the matching invite", async () => {
    const client = authClient();
    const invite = WorkspaceInviteSchema.parse({
      schemaVersion: "workspace-invite-v1",
      id: "invite_readiness",
      tokenHash: TOKEN_HASH,
      invitedEmail: "synthetic-contact-008@example.test",
      targetWorkspaceId: WORKSPACE,
      role: "owner",
      creatorSubject: ADMIN,
      createdAt: NOW,
      expiresAt: LATER,
      status: "pending"
    });
    const dependencies = {
      appOrigin: "https://studio.example",
      createClient: vi.fn(async () => client),
      resolveWorkspace: vi.fn(async () => ({
        authSubject: FOUNDER,
        workspaceId: WORKSPACE,
        role: "owner" as const,
        createdAt: NOW
      })),
      listWorkspaces: vi.fn(async () => []),
      selectWorkspace: vi.fn(),
      setMembership: vi.fn(),
      consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
      getInvite: vi.fn(async (tokenHash: string) => tokenHash === TOKEN_HASH ? invite : undefined),
      acceptInvite: vi.fn(async () => ({
        authSubject: FOUNDER,
        workspaceId: WORKSPACE,
        role: "owner" as const,
        createdAt: NOW
      })),
      provisionWorkspace: vi.fn(async () => ({
        authSubject: FOUNDER,
        workspaceId: "workspace_selfserve",
        role: "owner" as const,
        createdAt: NOW
      }))
    } satisfies AuthRouteDependencies;
    const request = (body: unknown) => new Request("https://studio.example/api/auth/sign-up", {
      method: "POST",
      headers: { origin: "https://studio.example", "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    // Every invite rule is still enforced before the auth provider is ever reached.
    expect((await handleAuthRequest(request({
      email: "synthetic-contact-031@example.test",
      password: "password1",
      inviteToken: TOKEN
    }), "sign-up", dependencies)).status).toBe(403);
    expect(client.auth.signUp).not.toHaveBeenCalled();
    expect((await handleAuthRequest(request({
      email: "synthetic-contact-008@example.test",
      password: "password1",
      inviteToken: "a".repeat(40)
    }), "sign-up", dependencies)).status).toBe(403);
    expect(client.auth.signUp).not.toHaveBeenCalled();
    expect((await handleAuthRequest(request({
      email: "synthetic-contact-008@example.test",
      password: "password1",
      inviteToken: "short"
    }), "sign-up", dependencies)).status).toBe(400);
    expect(client.auth.signUp).not.toHaveBeenCalled();

    const response = await handleAuthRequest(request({
      email: "synthetic-contact-008@example.test",
      password: "password1",
      inviteToken: TOKEN
    }), "sign-up", dependencies);
    expect(response.status).toBe(200);
    expect(dependencies.acceptInvite).toHaveBeenCalledWith(
      TOKEN_HASH,
      "synthetic-contact-008@example.test",
      FOUNDER
    );
    expect(dependencies.resolveWorkspace).toHaveBeenCalledAfter(dependencies.acceptInvite);

    // Self-serve: signup with no invite is now allowed and provisions its own workspace. It must
    // never reach the invite path, which is what would let a stranger land in a workspace that
    // already belongs to someone else.
    const acceptedBefore = dependencies.acceptInvite.mock.calls.length;
    const selfServe = await handleAuthRequest(request({
      email: "synthetic-contact-008@example.test",
      password: "password1"
    }), "sign-up", dependencies);
    expect(selfServe.status).toBe(200);
    expect(dependencies.provisionWorkspace).toHaveBeenCalledWith(FOUNDER);
    expect(dependencies.acceptInvite.mock.calls.length).toBe(acceptedBefore);
  });
});

describe("platform support boundary", () => {
  it("uses the real admin identity, customer command path, and immutable per-command audit", async () => {
    const engine = new EngineStorage(":memory:");
    const storage = new SqliteKernelStorage(engine);
    await storage.ensureWorkspace(WORKSPACE);
    await storage.ensureWorkspace("workspace_other");
    const execute = vi.fn(async (workspaceId: string, command: unknown) => ({
      ok: true as const,
      command: command as "company.list",
      data: { workspaceId, companies: [] }
    }));
    const dependencies = {
      appOrigin: "https://admin.example",
      studioOrigin: "https://studio.example",
      createClient: vi.fn(async () => ({
        auth: {
          getClaims: vi.fn(async () => ({
            data: { claims: { sub: ADMIN, role: "authenticated" } },
            error: null
          }))
        }
      } as unknown as Awaited<ReturnType<AdminRouteDependencies["createClient"]>>)),
      isPlatformAdmin: (subject: string) => subject === ADMIN,
      storage,
      execute
    } satisfies AdminRouteDependencies;
    const request = (action: string, input: unknown) => handleAdminRequest(new Request(`https://admin.example/api/admin/${action}`, {
      method: "POST",
      headers: { origin: "https://admin.example", "content-type": "application/json" },
      body: JSON.stringify(input)
    }), action, dependencies);

    const started = await request("support.start", {
      targetWorkspaceId: WORKSPACE,
      reason: "Verify the empty invited workspace through the customer path.",
      expiresInMinutes: 15
    });
    expect(started.status).toBe(201);
    const support = AdminSupportSessionSchema.parse((await started.json() as { data: unknown }).data);
    const command = await request("support.command", {
      supportSessionId: support.id,
      targetWorkspaceId: WORKSPACE,
      command: "company.list",
      input: {}
    });
    expect(command.status).toBe(200);
    expect(await command.json()).toMatchObject({
      ok: true,
      principal: {
        kind: "support-delegation",
        adminSubject: ADMIN,
        supportSessionId: support.id,
        targetWorkspaceId: WORKSPACE
      }
    });
    expect(execute).toHaveBeenCalledWith(WORKSPACE, "company.list", {}, expect.objectContaining({
      kind: "support-delegation",
      adminSubject: ADMIN,
      supportSessionId: support.id,
      targetWorkspaceId: WORKSPACE
    }));
    expect(engine.db.prepare("SELECT 1 FROM workspace_members WHERE auth_subject=?").get(ADMIN)).toBeUndefined();
    expect((await storage.listSupportAuditEvents(ADMIN, WORKSPACE, support.id)).map((event) => event.outcome)).toEqual([
      "attempted",
      "succeeded"
    ]);

    execute.mockRejectedValueOnce(new Error("provider unavailable"));
    expect((await request("support.command", {
      supportSessionId: support.id,
      targetWorkspaceId: WORKSPACE,
      command: "company.list",
      input: {}
    })).status).toBe(503);
    expect((await storage.listSupportAuditEvents(ADMIN, WORKSPACE, support.id)).map((event) => event.outcome)).toEqual([
      "attempted",
      "succeeded",
      "attempted",
      "failed"
    ]);

    expect((await request("support.command", {
      supportSessionId: support.id,
      targetWorkspaceId: "workspace_other",
      command: "company.list",
      input: {}
    })).status).toBe(403);
    expect((await storage.listSupportAuditEvents(ADMIN, "workspace_other", support.id)).map((event) => event.outcome)).toEqual([
      "attempted",
      "denied"
    ]);
    expect(platformAdminSubjects({ ...process.env, OPSPOT_PLATFORM_ADMIN_SUBJECTS: `${ADMIN},not-a-uuid` })).toEqual(new Set());
    engine.close();
  });
});

describe("private-readiness PostgreSQL conformance", () => {
  const postgresUrl = process.env.TEST_POSTGRES_URL;
  (postgresUrl ? it : it.skip)("proves invite, pagination, tenant denial, support expiry, and zero companies", async () => {
    const storage = await PostgresKernelStorage.connect(postgresUrl!, {
      schema: process.env.TEST_POSTGRES_SCHEMA ?? "ops107_private_readiness"
    });
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 60 * 60_000).toISOString();
    try {
      await storage.ensureWorkspace(WORKSPACE);
      await storage.ensureWorkspace("workspace_other");
      const invite = WorkspaceInviteSchema.parse({
        schemaVersion: "workspace-invite-v1",
        id: "invite_postgres_readiness",
        tokenHash: TOKEN_HASH,
        invitedEmail: "synthetic-contact-008@example.test",
        targetWorkspaceId: WORKSPACE,
        role: "owner",
        creatorSubject: ADMIN,
        createdAt,
        expiresAt,
        status: "pending"
      });
      expect((await storage.createWorkspaceInvite(invite)).created).toBe(true);
      await expect(storage.acceptWorkspaceInvite({
        tokenHash: TOKEN_HASH,
        invitedEmail: "synthetic-contact-031@example.test",
        authSubject: FOUNDER
      })).rejects.toBeInstanceOf(KernelStorageAccessError);
      const accepted = await storage.acceptWorkspaceInvite({
        tokenHash: TOKEN_HASH,
        invitedEmail: invite.invitedEmail,
        authSubject: FOUNDER
      });
      expect(await storage.acceptWorkspaceInvite({
        tokenHash: TOKEN_HASH,
        invitedEmail: invite.invitedEmail,
        authSubject: FOUNDER
      })).toEqual(accepted);
      await expect(storage.acceptWorkspaceInvite({
        tokenHash: TOKEN_HASH,
        invitedEmail: invite.invitedEmail,
        authSubject: OTHER
      })).rejects.toBeInstanceOf(KernelStorageConflictError);

      const page = await storage.listAdminWorkspaces(ADMIN, { limit: 1 });
      expect(page.workspaces).toHaveLength(1);
      expect(page.nextCursor).toBe(page.workspaces[0]!.workspaceId);
      const support = AdminSupportSessionSchema.parse({
        schemaVersion: "admin-support-session-v1",
        id: "support_postgres_readiness",
        adminSubject: ADMIN,
        targetWorkspaceId: WORKSPACE,
        reason: "Verify the empty invited workspace against real PostgreSQL.",
        startedAt: createdAt,
        expiresAt,
        status: "active"
      });
      expect((await storage.createSupportSession(support)).created).toBe(true);
      const event = AdminSupportAuditEventSchema.parse({
        schemaVersion: "admin-support-audit-v1",
        id: "support_audit_postgres_readiness",
        supportSessionId: support.id,
        adminSubject: ADMIN,
        targetWorkspaceId: WORKSPACE,
        command: "company.list",
        inputDigest: sha256({}),
        outcome: "succeeded",
        resultCode: "ok",
        attemptedAt: createdAt
      });
      expect((await storage.appendSupportAuditEvent(event)).created).toBe(true);
      expect(await storage.listSupportAuditEvents(ADMIN, WORKSPACE, support.id)).toEqual([event]);
      expect(await storage.listSupportAuditEvents(OTHER, WORKSPACE, support.id)).toEqual([]);
      expect(await storage.getSupportSession(OTHER, support.id)).toBeUndefined();
      expect((await storage.getSupportSession(ADMIN, support.id, new Date(Date.parse(expiresAt) + 1).toISOString()))?.status).toBe("expired");
      expect(await storage.listCompanies(WORKSPACE)).toEqual([]);
      expect(await storage.listCompanies("workspace_other")).toEqual([]);
    } finally {
      await storage.close();
    }
  }, 30_000);
});

describe("self-serve workspace provisioning", () => {
  it("gives a public signup its own owned workspace and refuses to mint a second one on replay", async () => {
    const engine = new EngineStorage(":memory:");
    const storage = new SqliteKernelStorage(engine);

    const first = await storage.provisionSelfServeWorkspace({
      authSubject: FOUNDER,
      workspaceId: "workspace_selfserve_one"
    });
    expect(first.workspaceId).toBe("workspace_selfserve_one");
    expect(first.role).toBe("owner");

    // A retried or replayed signup must return the workspace the subject already owns. Minting a
    // fresh one per attempt would let a single account spawn workspaces without bound.
    const replay = await storage.provisionSelfServeWorkspace({
      authSubject: FOUNDER,
      workspaceId: "workspace_selfserve_two"
    });
    expect(replay.workspaceId).toBe("workspace_selfserve_one");

    // The workspace id the replay offered was never claimed, which is what proves the replay
    // created nothing: a third subject can still take it.
    const bystander = "00000000-0000-4000-8000-000000000005";
    expect((await storage.provisionSelfServeWorkspace({
      authSubject: bystander,
      workspaceId: "workspace_selfserve_two"
    })).workspaceId).toBe("workspace_selfserve_two");

    // A stranger must never be provisioned into a workspace that already has members.
    await expect(storage.provisionSelfServeWorkspace({
      authSubject: OTHER,
      workspaceId: "workspace_selfserve_one"
    })).rejects.toBeInstanceOf(KernelStorageConflictError);

    const other = await storage.provisionSelfServeWorkspace({
      authSubject: OTHER,
      workspaceId: "workspace_selfserve_three"
    });
    expect(other.workspaceId).toBe("workspace_selfserve_three");
    expect(other.authSubject).toBe(OTHER);
  });
});
