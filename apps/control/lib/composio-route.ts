import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMPOSIO_TOOLKIT_CATALOG,
  COMPOSIO_TOOLKIT_ORDER,
  ComposioToolkitIdSchema,
  makeId,
  type ComposioToolkitId
} from "@amped-studio-os/contracts";
import { ComposioAdapter, readComposioConfig } from "@amped-studio-os/adapters";
import type { KernelConnection, KernelStorage, WorkspaceMembership } from "@amped-studio-os/storage";

const ventureIdSchema = z.string().regex(/^venture_[a-z0-9][a-z0-9_-]{0,149}$/);
const connectionIdSchema = z.string().regex(/^connection_[a-z0-9][a-z0-9_-]{0,149}$/);
const initiateSchema = z.object({
  ventureId: ventureIdSchema,
  toolkit: ComposioToolkitIdSchema
}).strict();
const revokeSchema = z.object({
  ventureId: ventureIdSchema,
  connectionId: connectionIdSchema
}).strict();
const authSubjectSchema = z.uuid();
const MAX_JSON_BYTES = 64 * 1024;

export interface ComposioAuthDependencies {
  appOrigin: string;
  localWorkspaceId?: string;
  createClient(): Promise<SupabaseClient>;
  resolveWorkspace(authSubject: string): Promise<WorkspaceMembership>;
  consumeRateLimit(workspaceId: string, request: Request): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface ComposioRouteDependencies {
  storage: KernelStorage;
  auth?: ComposioAuthDependencies;
  composio?: ComposioAdapter;
  /** Optional clock for tests. */
  now?: () => string;
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

async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return failure(413, "body-too-large", "Request body is too large.");
  const body = new Uint8Array(await request.arrayBuffer());
  return body.byteLength > maxBytes ? failure(413, "body-too-large", "Request body is too large.") : body;
}

async function requireSession(
  request: Request,
  dependencies: ComposioRouteDependencies,
  options: { requireOrigin: boolean; requireOwner: boolean }
): Promise<{ workspaceId: string; role: WorkspaceMembership["role"] } | Response> {
  const auth = dependencies.auth;
  if (!auth) return failure(503, "connections-unavailable", "Connections are unavailable.");
  if (options.requireOrigin && request.headers.get("origin") !== auth.appOrigin) {
    return failure(403, "origin-rejected", "Request origin was rejected.");
  }
  if (auth.localWorkspaceId) {
    const rate = await auth.consumeRateLimit(auth.localWorkspaceId, request);
    if (!rate.allowed) {
      return failure(429, "provider-rate-limited", "Too many provider requests. Try again later.", {
        "retry-after": String(rate.retryAfterSeconds)
      });
    }
    return { workspaceId: auth.localWorkspaceId, role: "owner" };
  }
  const client = await auth.createClient();
  const { data, error } = await client.auth.getClaims();
  const subject = authSubjectSchema.safeParse(data?.claims?.sub);
  if (error || !subject.success || data?.claims?.role !== "authenticated") {
    return failure(401, "auth-required", "A verified session is required.");
  }
  const membership = await auth.resolveWorkspace(subject.data);
  if (options.requireOwner && membership.role !== "owner") {
    return failure(403, "workspace-access-denied", "Workspace owner access is required.");
  }
  if (!["owner", "operator", "viewer"].includes(membership.role)) {
    return failure(403, "workspace-access-denied", "Workspace access is required.");
  }
  const rate = await auth.consumeRateLimit(membership.workspaceId, request);
  if (!rate.allowed) {
    return failure(429, "provider-rate-limited", "Too many provider requests. Try again later.", {
      "retry-after": String(rate.retryAfterSeconds)
    });
  }
  return { workspaceId: membership.workspaceId, role: membership.role };
}

async function ownerJson<T>(
  request: Request,
  dependencies: ComposioRouteDependencies,
  schema: z.ZodType<T>
): Promise<{ workspaceId: string; body: T } | Response> {
  if (request.method !== "POST") return failure(405, "method-not-allowed", "Connections mutations require POST.", { allow: "POST" });
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "json-required", "Content-Type must be application/json.");
  }
  const session = await requireSession(request, dependencies, { requireOrigin: true, requireOwner: true });
  if (session instanceof Response) return session;
  const raw = await boundedBody(request, MAX_JSON_BYTES);
  if (raw instanceof Response) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return failure(400, "invalid-json", "Request body must be valid JSON.");
  }
  const body = schema.safeParse(parsed);
  if (!body.success) return failure(400, "invalid-connections-request", "Connections request fields are invalid.");
  return { workspaceId: session.workspaceId, body: body.data };
}

async function requireCompany(storage: KernelStorage, workspaceId: string, companyId: string) {
  const company = await storage.getCompany(workspaceId, companyId);
  if (!company || company.killed) return undefined;
  return company;
}

function nowIso(dependencies: ComposioRouteDependencies): string {
  return dependencies.now?.() ?? new Date().toISOString();
}

/**
 * Prefer the freshest non-revoked row per toolkit for the cockpit surface.
 * Revoked rows stay in storage for audit/export but do not block a new Connect.
 */
function primaryConnectionForToolkit(rows: KernelConnection[], toolkit: ComposioToolkitId): KernelConnection | undefined {
  const candidates = rows
    .filter((row) => row.toolkit === toolkit && row.status !== "revoked")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  return candidates[0];
}

async function reconcilePending(
  storage: KernelStorage,
  adapter: ComposioAdapter,
  connection: KernelConnection
): Promise<KernelConnection> {
  if (connection.status !== "pending") return connection;
  try {
    const live = await adapter.getConnectedAccount(connection.composioAccountId);
    if (live.status === "connected") {
      return await storage.updateConnectionStatus(
        connection.workspaceId,
        connection.companyId,
        connection.id,
        "connected"
      ) ?? { ...connection, status: "connected" };
    }
    if (live.status === "failed") {
      return await storage.updateConnectionStatus(
        connection.workspaceId,
        connection.companyId,
        connection.id,
        "failed"
      ) ?? { ...connection, status: "failed" };
    }
    return connection;
  } catch (error) {
    // List must stay available even when Composio is briefly unreachable; leave pending as-is.
    console.error(
      "composio-reconcile-failed",
      connection.id,
      error instanceof Error ? error.message : String(error)
    );
    return connection;
  }
}

async function listConnections(
  request: Request,
  dependencies: ComposioRouteDependencies
): Promise<Response> {
  if (request.method !== "GET") return failure(405, "method-not-allowed", "List requires GET.", { allow: "GET" });
  if (!dependencies.composio) return failure(503, "connections-unavailable", "Connections are unavailable.");
  const session = await requireSession(request, dependencies, { requireOrigin: false, requireOwner: false });
  if (session instanceof Response) return session;
  const ventureId = new URL(request.url).searchParams.get("ventureId") ?? "";
  const parsedVenture = ventureIdSchema.safeParse(ventureId);
  if (!parsedVenture.success) return failure(400, "invalid-connections-request", "Connections request fields are invalid.");
  if (!await requireCompany(dependencies.storage, session.workspaceId, parsedVenture.data)) {
    return failure(404, "company-not-found", "Company was not found.");
  }
  const rows = await dependencies.storage.listConnections(session.workspaceId, parsedVenture.data);
  const reconciled: KernelConnection[] = [];
  for (const row of rows) {
    reconciled.push(await reconcilePending(dependencies.storage, dependencies.composio, row));
  }
  const connections = COMPOSIO_TOOLKIT_ORDER.map((toolkit) => {
    const catalog = COMPOSIO_TOOLKIT_CATALOG[toolkit];
    const row = primaryConnectionForToolkit(reconciled, toolkit);
    return {
      toolkit,
      displayName: catalog.displayName,
      unlocks: catalog.unlocks,
      status: row?.status ?? "not-connected",
      ...(row ? { connectionId: row.id } : {})
    };
  });
  return json({ ok: true, connections });
}

async function initiateConnection(
  request: Request,
  dependencies: ComposioRouteDependencies
): Promise<Response> {
  if (!dependencies.composio || !dependencies.auth) {
    return failure(503, "connections-unavailable", "Connections are unavailable.");
  }
  const parsed = await ownerJson(request, dependencies, initiateSchema);
  if (parsed instanceof Response) return parsed;
  if (!await requireCompany(dependencies.storage, parsed.workspaceId, parsed.body.ventureId)) {
    return failure(404, "company-not-found", "Company was not found.");
  }
  // Off-list toolkit is rejected by the schema; this guard is the mutation bar for the allowlist.
  if (!ComposioToolkitIdSchema.safeParse(parsed.body.toolkit).success) {
    return failure(400, "toolkit-not-allowed", "That toolkit is not available.");
  }
  const at = nowIso(dependencies);
  const authConfig = await dependencies.composio.ensureAuthConfig(parsed.body.toolkit);
  const link = await dependencies.composio.initiateConnection({
    authConfigId: authConfig.id,
    userId: parsed.body.ventureId,
    callbackUrl: `${dependencies.auth.appOrigin}/app`
  });
  const connection: KernelConnection = {
    workspaceId: parsed.workspaceId,
    companyId: parsed.body.ventureId,
    id: makeId("connection", {
      workspaceId: parsed.workspaceId,
      ventureId: parsed.body.ventureId,
      toolkit: parsed.body.toolkit,
      composioAccountId: link.connectedAccountId
    }),
    toolkit: parsed.body.toolkit,
    composioAccountId: link.connectedAccountId,
    composioAuthConfigId: authConfig.id,
    status: "pending",
    createdAt: at,
    updatedAt: at
  };
  await dependencies.storage.createConnection(connection);
  return json({
    ok: true,
    redirectUrl: link.redirectUrl,
    connectionId: connection.id,
    toolkit: connection.toolkit,
    status: connection.status
  });
}

async function revokeConnection(
  request: Request,
  dependencies: ComposioRouteDependencies
): Promise<Response> {
  if (!dependencies.composio) return failure(503, "connections-unavailable", "Connections are unavailable.");
  const parsed = await ownerJson(request, dependencies, revokeSchema);
  if (parsed instanceof Response) return parsed;
  if (!await requireCompany(dependencies.storage, parsed.workspaceId, parsed.body.ventureId)) {
    return failure(404, "company-not-found", "Company was not found.");
  }
  const rows = await dependencies.storage.listConnections(parsed.workspaceId, parsed.body.ventureId);
  const connection = rows.find((row) => row.id === parsed.body.connectionId);
  if (!connection) return failure(404, "connection-not-found", "Connection was not found.");
  if (connection.status === "revoked") {
    return json({ ok: true, connectionId: connection.id, status: "revoked" });
  }
  try {
    await dependencies.composio.revokeConnectedAccount(connection.composioAccountId);
  } catch (error) {
    console.error(
      "composio-revoke-failed",
      connection.id,
      error instanceof Error ? error.message : String(error)
    );
    return failure(502, "provider-operation-failed", "Provider operation could not be completed.");
  }
  const updated = await dependencies.storage.updateConnectionStatus(
    parsed.workspaceId,
    parsed.body.ventureId,
    connection.id,
    "revoked"
  );
  return json({ ok: true, connectionId: connection.id, status: updated?.status ?? "revoked" });
}

export async function handleComposioRequest(
  request: Request,
  action: string,
  dependencies: ComposioRouteDependencies
): Promise<Response> {
  try {
    if (action === "list") return await listConnections(request, dependencies);
    if (action === "initiate") return await initiateConnection(request, dependencies);
    if (action === "revoke") return await revokeConnection(request, dependencies);
    return failure(404, "provider-route-not-found", "Provider route was not found.");
  } catch (error) {
    console.error(
      "composio-operation-failed",
      action,
      error instanceof Error ? error.message : String(error)
    );
    return failure(502, "provider-operation-failed", "Provider operation could not be completed.");
  }
}

/** Build route dependencies from env; COMPOSIO_API_KEY absence yields no adapter (503). */
export function composioFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): ComposioAdapter | undefined {
  const config = readComposioConfig(environment);
  return config ? new ComposioAdapter(config.apiKey, fetchImpl) : undefined;
}
