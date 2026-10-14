import {
  AmpedGraphDefinitionSchema,
  AmpedGraphRunVersionSchema,
  AmpedApprovalDecisionPacketSchema,
  AmpedTeachingRecordSchema,
  AmpedTraceRecordSchema,
  type AmpedGraphDefinition,
  type AmpedGraphRunVersion,
  type AmpedTeachingRecord,
  type AmpedTraceRecord
} from "../../../packages/contracts/src/amped";
import { z } from "zod";
import {
  CommandInputSchemas,
  CompanyStateSchema,
  type CommandName,
  type CompanyBootstrapInput,
  type CompanyState
} from "./contracts";

const ApprovalSchema = z.object({
  workspaceId: z.string(),
  companyId: z.string(),
  id: z.string(),
  taskId: z.string(),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "approved", "revoked"]),
  packet: z.unknown(),
  expiresAt: z.string(),
  createdAt: z.string()
}).passthrough().transform((approval) => {
  const packet = AmpedApprovalDecisionPacketSchema.safeParse(approval.packet);
  return {
    ...approval,
    packet: packet.success ? packet.data : null,
    packetState: packet.success ? "valid" as const : "legacy-unapprovable" as const
  };
});

const AuthSessionSchema = z.object({
  ok: z.literal(true),
  user: z.object({ email: z.string().email() }).strict(),
  workspace: z.object({
    id: z.string(),
    role: z.enum(["owner", "operator", "viewer"])
  }).strict(),
  workspaces: z.array(z.object({
    id: z.string(),
    role: z.enum(["owner", "operator", "viewer"])
  }).strict())
}).strict();

const AuthWithoutWorkspaceSchema = z.object({
  ok: z.literal(true),
  user: z.object({ email: z.string().email() }).strict(),
  workspace: z.null(),
  workspaces: z.tuple([])
}).strict();

const InviteInfoSchema = z.object({
  ok: z.literal(true),
  invite: z.object({
    email: z.string().email(),
    workspaceId: z.string(),
    role: z.enum(["owner", "operator", "viewer"]),
    expiresAt: z.string()
  }).strict()
}).strict();

const CompanyListItemSchema = z.object({
  ventureId: z.string(),
  name: z.string(),
  slug: z.string(),
  killed: z.boolean(),
  state: CompanyStateSchema,
  entitlement: z.unknown().nullable()
}).strict();

const CompanyListSchema = z.object({
  companies: z.array(CompanyListItemSchema)
}).strict();

const CompanyDetailSchema = z.object({
  ventureId: z.string(),
  state: CompanyStateSchema,
  entitlement: z.unknown().nullable(),
  evidence: z.array(z.unknown()),
  receipts: z.array(z.unknown()),
  cycles: z.array(z.unknown()),
  approvals: z.array(ApprovalSchema),
  approvalEvents: z.array(z.unknown()),
  failedJobs: z.array(z.unknown()).optional()
}).passthrough();

const AmpedSnapshotSchema = z.object({
  graph: AmpedGraphDefinitionSchema,
  run: AmpedGraphRunVersionSchema,
  traces: z.array(AmpedTraceRecordSchema),
  teaching: z.array(AmpedTeachingRecordSchema)
}).strict();

const AmpedStartSchema = z.object({
  created: z.boolean(),
  graph: AmpedGraphDefinitionSchema,
  run: AmpedGraphRunVersionSchema
}).strict();

const CommandEnvelopeSchema = z.object({
  ok: z.boolean(),
  command: z.string().optional(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string()
  }).optional()
}).passthrough();

export type PendingApproval = z.infer<typeof ApprovalSchema>;
export type CompanyListItem = z.infer<typeof CompanyListItemSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type InviteInfo = z.infer<typeof InviteInfoSchema>["invite"];

export interface CompanyDetail {
  ventureId: string;
  state: CompanyState;
  entitlement: unknown;
  evidence: unknown[];
  receipts: unknown[];
  cycles: unknown[];
  approvals: PendingApproval[];
  approvalEvents: unknown[];
  failedJobs?: unknown[];
}

export interface AmpedSnapshot {
  graph: AmpedGraphDefinition;
  run: AmpedGraphRunVersion;
  traces: AmpedTraceRecord[];
  teaching: AmpedTeachingRecord[];
}

export class StudioApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

async function auth(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/auth/${path}`, init);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new StudioApiError("invalid-response", "The private auth API returned an unreadable response.", response.status);
  }
  if (!response.ok) {
    const error = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).passthrough().safeParse(raw);
    throw new StudioApiError(
      error.success ? error.data.error.code : "auth-failed",
      error.success ? error.data.error.message : "Authentication failed.",
      response.status
    );
  }
  return raw;
}

function authPost(path: string, body: unknown): Promise<unknown> {
  return auth(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function getSession(): Promise<AuthSession> {
  const raw = await auth("session");
  const session = AuthSessionSchema.safeParse(raw);
  if (session.success) return session.data;
  if (AuthWithoutWorkspaceSchema.safeParse(raw).success) {
    throw new StudioApiError("workspace-access-denied", "A valid private invitation is required.", 403);
  }
  return AuthSessionSchema.parse(raw);
}

export async function getInvite(token: string): Promise<InviteInfo> {
  return InviteInfoSchema.parse(await auth(`invite?token=${encodeURIComponent(token)}`)).invite;
}

export async function signIn(email: string, password: string, inviteToken?: string): Promise<AuthSession> {
  return AuthSessionSchema.parse(await authPost("sign-in", {
    email,
    password,
    ...(inviteToken ? { inviteToken } : {})
  }));
}

export async function signUp(email: string, password: string, inviteToken: string): Promise<AuthSession | { confirmationRequired: true }> {
  const raw = await authPost("sign-up", { email, password, inviteToken });
  const confirmation = z.object({ ok: z.literal(true), user: z.null(), confirmationRequired: z.literal(true) }).strict().safeParse(raw);
  return confirmation.success ? { confirmationRequired: true } : AuthSessionSchema.parse(raw);
}

export async function requestRecovery(email: string): Promise<void> {
  await authPost("recover", { email });
}

export async function signOut(): Promise<void> {
  await authPost("sign-out", {});
}

export async function selectWorkspace(workspaceId: string): Promise<AuthSession> {
  return AuthSessionSchema.parse(await authPost("select-workspace", { workspaceId }));
}

async function command(name: CommandName, input: unknown): Promise<unknown> {
  const parsedInput = CommandInputSchemas[name].parse(input);
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: name, input: parsedInput })
  });

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new StudioApiError("invalid-response", "The studio API returned an unreadable response.", response.status);
  }

  const envelope = CommandEnvelopeSchema.parse(raw);
  if (!response.ok || !envelope.ok) {
    throw new StudioApiError(
      envelope.error?.code ?? "command-failed",
      envelope.error?.message ?? "The studio command failed.",
      response.status
    );
  }
  return envelope.data;
}

export async function listCompanies(): Promise<CompanyListItem[]> {
  return CompanyListSchema.parse(await command("company.list", {})).companies;
}

export async function getCompany(ventureId: string): Promise<CompanyDetail> {
  return CompanyDetailSchema.parse(await command("company.get", { ventureId })) as CompanyDetail;
}

export async function startAmped(ventureId: string): Promise<AmpedSnapshot> {
  const started = AmpedStartSchema.parse(await command("amped.start", {
    ventureId,
    requestedAt: new Date().toISOString(),
    idempotencyKey: `studio-amped-${crypto.randomUUID()}`
  }));
  return { graph: started.graph, run: started.run, traces: [], teaching: [] };
}

export async function getAmped(ventureId: string, runId: string): Promise<AmpedSnapshot> {
  return AmpedSnapshotSchema.parse(await command("amped.get", { ventureId, runId })) as AmpedSnapshot;
}

export async function pauseCompany(ventureId: string, actor: string): Promise<void> {
  await command("company.pause", {
    ventureId,
    reason: "Paused from the Amped Studio decision room",
    actor,
    requestedAt: new Date().toISOString(),
    idempotencyKey: `studio-pause-${crypto.randomUUID()}`
  });
}

export async function resolveApproval(
  approval: PendingApproval,
  decision: "approve" | "deny",
  actor: string
): Promise<void> {
  await command("approval.resolve", {
    ventureId: approval.companyId,
    approvalId: approval.id,
    expectedActionDigest: approval.actionDigest,
    decision,
    actor,
    resolvedAt: new Date().toISOString(),
    idempotencyKey: `studio-${decision}-${crypto.randomUUID()}`
  });
}

export async function bootstrapCompany(input: Omit<CompanyBootstrapInput, "requestedAt" | "idempotencyKey">): Promise<string> {
  const data = z.object({ ventureId: z.string() }).passthrough().parse(await command("company.bootstrap", {
    ...input,
    requestedAt: new Date().toISOString(),
    idempotencyKey: `studio-bootstrap-${crypto.randomUUID()}`
  }));
  return data.ventureId;
}
