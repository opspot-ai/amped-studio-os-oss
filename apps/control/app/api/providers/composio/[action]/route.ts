import { createPostgresCommandRateLimiter } from "../../../../../lib/command-rate-limit";
import { composioFromEnvironment, handleComposioRequest, type ComposioRouteDependencies } from "../../../../../lib/composio-route";
import { readEngineMode, createLocalCompanyRuntime } from "../../../../../lib/company-runtime";
import { getCloudKernelStorage } from "../../../../../lib/kernel-storage";
import { readSupabaseServerConfig } from "../../../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This static segment wins over the generic [provider] route, which stays POST-only;
// the connections list is a GET surface so it gets its own wiring here.

let localEngine: ReturnType<typeof createLocalCompanyRuntime> | undefined;
const localRate = new Map<string, { startedAt: number; count: number }>();

function localRuntime() {
  return localEngine ??= createLocalCompanyRuntime(process.env.ENGINE_ROOT ?? process.cwd());
}

async function consumeLocalRateLimit(workspaceId: string) {
  const now = Date.now();
  const current = localRate.get(workspaceId);
  if (!current || now - current.startedAt >= 60_000) {
    localRate.set(workspaceId, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  current.count += 1;
  return { allowed: current.count <= 120, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1000)) };
}

async function dependencies(): Promise<ComposioRouteDependencies> {
  const mode = readEngineMode();
  const local = mode === "local" ? localRuntime() : undefined;
  const cloudStorage = mode === "cloud" ? await getCloudKernelStorage() : undefined;
  const storage = local?.storage ?? cloudStorage!;
  const composio = composioFromEnvironment();
  const result: ComposioRouteDependencies = {
    storage,
    ...(composio ? { composio } : {})
  };
  if (mode === "cloud") {
    const config = readSupabaseServerConfig();
    result.auth = {
      appOrigin: config.appOrigin,
      createClient: createServerSupabaseClient,
      resolveWorkspace: (authSubject) => cloudStorage!.resolveOrCreateSelectedWorkspaceForAuthSubject(authSubject),
      consumeRateLimit: createPostgresCommandRateLimiter(getCloudKernelStorage)
    };
  } else {
    result.auth = {
      appOrigin: process.env.ENGINE_DASHBOARD_URL ?? "http://127.0.0.1:3210",
      localWorkspaceId: "workspace_local",
      createClient: async () => { throw new Error("local connections use CLI or MCP"); },
      resolveWorkspace: async () => { throw new Error("local connections use CLI or MCP"); },
      consumeRateLimit: consumeLocalRateLimit
    };
  }
  return result;
}

async function execute(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await context.params;
  try {
    return await handleComposioRequest(request, action, await dependencies());
  } catch {
    return Response.json({ ok: false, error: { code: "provider-unavailable", message: "Provider route is temporarily unavailable." } }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  }
}

export async function GET(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  return execute(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  return execute(request, context);
}
