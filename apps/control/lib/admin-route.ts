import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  AdminSupportAuditEventSchema,
  AdminSupportDelegationPrincipalSchema,
  AdminSupportSessionSchema,
  WorkspaceInviteSchema,
  makeId,
  sha256
} from "@amped-studio-os/contracts";
import { COMPANY_COMMAND_NAMES, type CompanyCommandResponse } from "@amped-studio-os/domain";
import {
  KernelStorageAccessError,
  KernelStorageConflictError,
  type KernelStorage
} from "@amped-studio-os/storage";

const authSubjectSchema = z.uuid();
const workspaceIdSchema = z.string().regex(/^workspace_[a-z0-9][a-z0-9_-]{0,149}$/);
const actionSchema = z.enum([
  "workspace.list",
  "invite.create",
  "invite.revoke",
  "support.start",
  "support.get",
  "support.end",
  "support.command",
  "support.audit"
]);
const MAX_BODY_BYTES = 64 * 1024;

const actionInputs = {
  "workspace.list": z.object({
    limit: z.number().int().min(1).max(50).optional(),
    cursor: workspaceIdSchema.optional()
  }).strict(),
  "invite.create": z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(["owner", "operator", "viewer"]).default("owner"),
    targetWorkspaceId: workspaceIdSchema.optional(),
    expiresInHours: z.number().int().min(1).max(168).default(168)
  }).strict(),
  "invite.revoke": z.object({ inviteId: z.string().min(3).max(160) }).strict(),
  "support.start": z.object({
    targetWorkspaceId: workspaceIdSchema,
    reason: z.string().trim().min(10).max(2_000),
    expiresInMinutes: z.number().int().min(1).max(60).default(30)
  }).strict(),
  "support.get": z.object({ supportSessionId: z.string().min(3).max(160) }).strict(),
  "support.end": z.object({ supportSessionId: z.string().min(3).max(160) }).strict(),
  "support.command": z.object({
    supportSessionId: z.string().min(3).max(160),
    targetWorkspaceId: workspaceIdSchema,
    command: z.unknown(),
    input: z.unknown().optional()
  }).strict(),
  "support.audit": z.object({
    supportSessionId: z.string().min(3).max(160),
    targetWorkspaceId: workspaceIdSchema,
    limit: z.number().int().min(1).max(200).optional()
  }).strict()
} satisfies Record<z.infer<typeof actionSchema>, z.ZodType>;

export interface AdminRouteDependencies {
  appOrigin: string;
  studioOrigin: string;
  createClient(): Promise<SupabaseClient>;
  isPlatformAdmin(authSubject: string): boolean;
  storage: KernelStorage;
  execute(
    workspaceId: string,
    command: unknown,
    input: unknown,
    principal: z.infer<typeof AdminSupportDelegationPrincipalSchema>
  ): Promise<CompanyCommandResponse>;
}

export function platformAdminSubjects(environment: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const values = (environment.OPSPOT_PLATFORM_ADMIN_SUBJECTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const parsed = z.array(authSubjectSchema).safeParse(values);
  return new Set(parsed.success ? parsed.data : []);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
      expires: "0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

function failure(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return json({ ok: false, error: { code, message } }, status, headers);
}

async function body(request: Request): Promise<unknown | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "json-required", "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return failure(400, "invalid-json", "Request body must be valid JSON.");
  }
}

async function platformIdentity(dependencies: AdminRouteDependencies): Promise<string | Response> {
  const { data, error } = await (await dependencies.createClient()).auth.getClaims();
  const subject = authSubjectSchema.safeParse(data?.claims?.sub);
  if (error || !subject.success || data?.claims?.role !== "authenticated") {
    return failure(401, "auth-required", "A verified session is required.");
  }
  if (!dependencies.isPlatformAdmin(subject.data)) {
    return failure(403, "platform-admin-required", "Platform admin access is required.");
  }
  return subject.data;
}

function supportInput(input: unknown, adminSubject: string, supportSessionId: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input) || !("actor" in input)) return input ?? {};
  return {
    ...input as Record<string, unknown>,
    actor: `platform-admin:${adminSubject}:support:${supportSessionId}`
  };
}

async function supportAudit(
  dependencies: AdminRouteDependencies,
  input: {
    supportSessionId: string;
    adminSubject: string;
    targetWorkspaceId: string;
    command: string;
    inputDigest: string;
    outcome: "attempted" | "succeeded" | "denied" | "failed";
    resultCode: string;
    attemptedAt: string;
  }
): Promise<void> {
  await dependencies.storage.appendSupportAuditEvent(AdminSupportAuditEventSchema.parse({
    schemaVersion: "admin-support-audit-v1",
    id: makeId("support_audit", { ...input, nonce: randomUUID() }),
    ...input
  }));
}

async function executeSupportCommand(
  adminSubject: string,
  input: z.infer<(typeof actionInputs)["support.command"]>,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const attemptedAt = new Date().toISOString();
  const command = typeof input.command === "string" ? input.command : "invalid-command";
  const effectiveInput = supportInput(input.input, adminSubject, input.supportSessionId);
  const inputDigest = sha256({ command: input.command, input: effectiveInput });
  const auditBase = {
    supportSessionId: input.supportSessionId,
    adminSubject,
    targetWorkspaceId: input.targetWorkspaceId,
    command,
    inputDigest,
    attemptedAt
  };
  await supportAudit(dependencies, { ...auditBase, outcome: "attempted", resultCode: "attempt-started" });

  const session = await dependencies.storage.getSupportSession(adminSubject, input.supportSessionId, attemptedAt);
  if (!session || session.status !== "active" || session.targetWorkspaceId !== input.targetWorkspaceId) {
    await supportAudit(dependencies, { ...auditBase, outcome: "denied", resultCode: "support-session-denied" });
    return failure(403, "support-session-denied", "The support session is absent, expired, ended, or targets another workspace.");
  }
  if (!COMPANY_COMMAND_NAMES.includes(command as (typeof COMPANY_COMMAND_NAMES)[number])) {
    await supportAudit(dependencies, { ...auditBase, outcome: "denied", resultCode: "command-not-allowed" });
    return failure(403, "command-not-allowed", "The command is not in the customer command allowlist.");
  }

  const principal = AdminSupportDelegationPrincipalSchema.parse({
    kind: "support-delegation",
    adminSubject,
    supportSessionId: session.id,
    targetWorkspaceId: session.targetWorkspaceId,
    capability: "customer-owner-command"
  });
  try {
    const result = await dependencies.execute(session.targetWorkspaceId, command, effectiveInput, principal);
    const outcome = result.ok ? "succeeded" : result.error.code === "workspace-access-denied" ? "denied" : "failed";
    const resultCode = result.ok ? "ok" : result.error.code;
    await supportAudit(dependencies, { ...auditBase, outcome, resultCode });
    return json({ ...result, principal }, result.ok ? 200 : outcome === "denied" ? 403 : 400);
  } catch {
    await supportAudit(dependencies, { ...auditBase, outcome: "failed", resultCode: "command-execution-failed" });
    return failure(503, "support-command-failed", "The support command failed without changing delegated authority.");
  }
}

export async function handleAdminRequest(
  request: Request,
  rawAction: string,
  dependencies: AdminRouteDependencies
): Promise<Response> {
  const action = actionSchema.safeParse(rawAction);
  if (!action.success) return failure(404, "admin-route-not-found", "Admin route not found.");
  if (request.method !== "POST") return failure(405, "method-not-allowed", "Admin routes require POST.", { allow: "POST" });
  if (request.headers.get("origin") !== dependencies.appOrigin) return failure(403, "origin-rejected", "Request origin was rejected.");
  const rawBody = await body(request);
  if (rawBody instanceof Response) return rawBody;
  const parsed = actionInputs[action.data].safeParse(rawBody);
  if (!parsed.success) return failure(400, "invalid-admin-input", "Admin request fields are invalid.");
  const adminSubject = await platformIdentity(dependencies);
  if (adminSubject instanceof Response) return adminSubject;

  try {
    switch (action.data) {
      case "workspace.list":
        {
          const input = parsed.data as z.infer<(typeof actionInputs)["workspace.list"]>;
          return json({
            ok: true,
            data: await dependencies.storage.listAdminWorkspaces(adminSubject, {
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor })
            })
          });
        }
      case "invite.create": {
        const input = parsed.data as z.infer<(typeof actionInputs)["invite.create"]>;
        const token = randomBytes(32).toString("base64url");
        const tokenHash = sha256(token);
        const workspaceId = input.targetWorkspaceId ?? `workspace_${tokenHash.slice(0, 24)}`;
        await dependencies.storage.ensureWorkspace(workspaceId);
        const createdAt = new Date().toISOString();
        const invite = WorkspaceInviteSchema.parse({
          schemaVersion: "workspace-invite-v1",
          id: makeId("invite", { tokenHash, workspaceId }),
          tokenHash,
          invitedEmail: input.email,
          targetWorkspaceId: workspaceId,
          role: input.role,
          creatorSubject: adminSubject,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + input.expiresInHours * 60 * 60_000).toISOString(),
          status: "pending"
        });
        const stored = await dependencies.storage.createWorkspaceInvite(invite);
        const link = new URL("/", dependencies.studioOrigin);
        link.searchParams.set("invite", token);
        link.searchParams.set("email", input.email);
        return json({
          ok: true,
          data: {
            invite: stored.invite,
            privateLink: link.toString(),
            emailSent: false
          }
        }, stored.created ? 201 : 200);
      }
      case "invite.revoke": {
        const input = parsed.data as z.infer<(typeof actionInputs)["invite.revoke"]>;
        return json({ ok: true, data: await dependencies.storage.revokeWorkspaceInvite(adminSubject, input.inviteId) });
      }
      case "support.start": {
        const input = parsed.data as z.infer<(typeof actionInputs)["support.start"]>;
        const startedAt = new Date().toISOString();
        const session = AdminSupportSessionSchema.parse({
          schemaVersion: "admin-support-session-v1",
          id: makeId("support", { adminSubject, targetWorkspaceId: input.targetWorkspaceId, startedAt, nonce: randomUUID() }),
          adminSubject,
          targetWorkspaceId: input.targetWorkspaceId,
          reason: input.reason,
          startedAt,
          expiresAt: new Date(Date.parse(startedAt) + input.expiresInMinutes * 60_000).toISOString(),
          status: "active"
        });
        return json({ ok: true, data: (await dependencies.storage.createSupportSession(session)).session }, 201);
      }
      case "support.get": {
        const input = parsed.data as z.infer<(typeof actionInputs)["support.get"]>;
        const session = await dependencies.storage.getSupportSession(adminSubject, input.supportSessionId);
        return session ? json({ ok: true, data: session }) : failure(404, "support-session-not-found", "Support session not found.");
      }
      case "support.end": {
        const input = parsed.data as z.infer<(typeof actionInputs)["support.end"]>;
        return json({ ok: true, data: await dependencies.storage.endSupportSession(adminSubject, input.supportSessionId) });
      }
      case "support.command":
        return executeSupportCommand(adminSubject, parsed.data as z.infer<(typeof actionInputs)["support.command"]>, dependencies);
      case "support.audit": {
        const input = parsed.data as z.infer<(typeof actionInputs)["support.audit"]>;
        return json({
          ok: true,
          data: {
            events: await dependencies.storage.listSupportAuditEvents(
              adminSubject,
              input.targetWorkspaceId,
              input.supportSessionId,
              input.limit
            )
          }
        });
      }
    }
  } catch (error) {
    if (error instanceof KernelStorageAccessError) return failure(403, "workspace-access-denied", "Workspace access denied.");
    if (error instanceof KernelStorageConflictError) return failure(409, "admin-conflict", "The request conflicted with current durable state.");
    return failure(503, "admin-unavailable", "The private admin service is temporarily unavailable.");
  }
}
