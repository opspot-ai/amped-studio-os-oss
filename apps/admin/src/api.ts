import { z } from "zod";

const WorkspaceSchema = z.object({
  schemaVersion: z.literal("admin-workspace-summary-v1"),
  workspaceId: z.string(),
  inviteStatus: z.enum(["none", "pending", "accepted", "revoked", "expired"]),
  accountStatus: z.enum(["pending", "active"]),
  companyCount: z.number().int().nonnegative(),
  selectedCompanyId: z.string().nullable(),
  selectedCompanyName: z.string().nullable(),
  goal: z.string().nullable(),
  lifecycle: z.string().nullable(),
  highestBlocker: z.string().nullable(),
  initiative: z.string().nullable(),
  graphRunState: z.string().nullable(),
  pendingHumanGates: z.number().int().nonnegative(),
  lastActivityAt: z.string(),
  workerHealth: z.enum(["idle", "healthy", "attention"]),
  failedWorkCount: z.number().int().nonnegative(),
  boundedCostCents: z.number().int().nonnegative(),
  receiptCount: z.number().int().nonnegative(),
  orgoStatus: z.literal("unproven")
}).strict();

const WorkspacePageSchema = z.object({
  schemaVersion: z.literal("admin-workspace-page-v1"),
  workspaces: z.array(WorkspaceSchema),
  nextCursor: z.string().optional()
}).strict();

const SupportSessionSchema = z.object({
  schemaVersion: z.literal("admin-support-session-v1"),
  id: z.string(),
  adminSubject: z.string().uuid(),
  targetWorkspaceId: z.string(),
  reason: z.string(),
  startedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(["active", "ended", "expired"]),
  endedAt: z.string().optional()
}).strict();

const AuditSchema = z.object({
  schemaVersion: z.literal("admin-support-audit-v1"),
  id: z.string(),
  supportSessionId: z.string(),
  adminSubject: z.string().uuid(),
  targetWorkspaceId: z.string(),
  command: z.string(),
  inputDigest: z.string(),
  outcome: z.enum(["attempted", "succeeded", "denied", "failed"]),
  resultCode: z.string(),
  attemptedAt: z.string()
}).strict();

const SessionSchema = z.object({
  ok: z.literal(true),
  user: z.object({ email: z.string().email() }).strict()
}).passthrough();

export type AdminWorkspace = z.infer<typeof WorkspaceSchema>;
export type SupportSession = z.infer<typeof SupportSessionSchema>;
export type SupportAudit = z.infer<typeof AuditSchema>;

export class AdminApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function request(path: string, input?: unknown): Promise<unknown> {
  const response = await fetch(path, input === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const raw = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).passthrough().safeParse(raw);
    throw new AdminApiError(parsed.success ? parsed.data.error.code : "request-failed", parsed.success ? parsed.data.error.message : "Request failed.", response.status);
  }
  return raw;
}

async function action<T>(name: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  const raw = await request(`/api/admin/${name}`, input);
  return schema.parse(z.object({ ok: z.literal(true), data: z.unknown() }).passthrough().parse(raw).data);
}

export async function session() {
  return SessionSchema.parse(await request("/api/auth/session"));
}

export async function signIn(email: string, password: string) {
  return SessionSchema.parse(await request("/api/auth/sign-in", { email, password }));
}

export async function signOut() {
  await request("/api/auth/sign-out", {});
}

export function listWorkspaces(cursor?: string): Promise<{ workspaces: AdminWorkspace[]; nextCursor?: string }> {
  return action("workspace.list", { limit: 50, ...(cursor ? { cursor } : {}) }, WorkspacePageSchema);
}

export function createInvite(email: string, targetWorkspaceId?: string) {
  return action("invite.create", {
    email,
    role: "owner",
    expiresInHours: 168,
    ...(targetWorkspaceId ? { targetWorkspaceId } : {})
  }, z.object({
    invite: z.object({ id: z.string(), targetWorkspaceId: z.string(), status: z.string() }).passthrough(),
    privateLink: z.string().url(),
    emailSent: z.literal(false)
  }).strict());
}

export function startSupport(targetWorkspaceId: string, reason: string, expiresInMinutes: number): Promise<SupportSession> {
  return action("support.start", { targetWorkspaceId, reason, expiresInMinutes }, SupportSessionSchema);
}

export function getSupport(supportSessionId: string): Promise<SupportSession> {
  return action("support.get", { supportSessionId }, SupportSessionSchema);
}

export function endSupport(supportSessionId: string): Promise<SupportSession> {
  return action("support.end", { supportSessionId }, SupportSessionSchema);
}

export async function listCompaniesAsSupport(support: SupportSession): Promise<unknown> {
  const raw = await request("/api/admin/support.command", {
    supportSessionId: support.id,
    targetWorkspaceId: support.targetWorkspaceId,
    command: "company.list",
    input: {}
  });
  return z.object({
    ok: z.literal(true),
    command: z.literal("company.list"),
    data: z.unknown(),
    principal: z.object({
      kind: z.literal("support-delegation"),
      adminSubject: z.string().uuid(),
      supportSessionId: z.string(),
      targetWorkspaceId: z.string(),
      capability: z.literal("customer-owner-command")
    }).strict()
  }).strict().parse(raw);
}

export function listAudit(support: SupportSession): Promise<SupportAudit[]> {
  return action("support.audit", {
    supportSessionId: support.id,
    targetWorkspaceId: support.targetWorkspaceId,
    limit: 200
  }, z.object({ events: z.array(AuditSchema) }).strict()).then((value) => value.events);
}
