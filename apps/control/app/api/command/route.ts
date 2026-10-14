import path from "node:path";
import { LOCAL_WORKSPACE_ID } from "@amped-studio-os/contracts";
import { handleCloudCommandRequest, handleLocalCommandRequest } from "../../../lib/cloud-command-route";
import { createCloudCompanyCommandService, createLocalCompanyRuntime } from "../../../lib/company-runtime";
import { createPostgresCommandRateLimiter } from "../../../lib/command-rate-limit";
import { getCloudKernelStorage } from "../../../lib/kernel-storage";
import { readSupabaseServerConfig } from "../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import { KernelStorageAccessError } from "@amped-studio-os/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function engineRoot(): string {
  if (process.env.ENGINE_ROOT) return path.resolve(process.env.ENGINE_ROOT);
  const current = process.cwd();
  return path.basename(current) === "control" && path.basename(path.dirname(current)) === "apps" ? path.resolve(current, "../..") : current;
}

export function isExplicitLocalCommandRequest(request: Request, environment: NodeJS.ProcessEnv = process.env): boolean {
  const hostname = new URL(request.url).hostname;
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (environment.ENGINE_MODE === "cloud") return false;
  if (environment.ENGINE_MODE === "local") return environment.ENGINE_WORKSPACE_ID === LOCAL_WORKSPACE_ID && loopback;
  return environment.NODE_ENV !== "production" && environment.ENGINE_WORKSPACE_ID === LOCAL_WORKSPACE_ID && loopback;
}

function unavailable(): Response {
  return Response.json({ ok: false, error: { code: "command-unavailable", message: "Company commands are temporarily unavailable." } }, {
    status: 503,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
  });
}

export async function POST(request: Request): Promise<Response> {
  if (isExplicitLocalCommandRequest(request)) {
    const local = createLocalCompanyRuntime(engineRoot());
    try {
      return await handleLocalCommandRequest(request, {
        appOrigin: new URL(request.url).origin,
        workspaceId: local.workspaceId,
        execute: (_workspaceId, command, input) => local.service.execute(local.workspaceId, String(command), input)
      });
    } finally {
      local.close();
    }
  }
  try {
    const config = readSupabaseServerConfig();
    const resolveWorkspace = async (authSubject: string) => {
      const membership = await (await getCloudKernelStorage()).resolveWorkspaceForAuthSubject(authSubject);
      if (!membership) throw new KernelStorageAccessError();
      return membership;
    };
    return await handleCloudCommandRequest(request, {
      appOrigin: config.appOrigin,
      createClient: createServerSupabaseClient,
      resolveWorkspace,
      consumeRateLimit: createPostgresCommandRateLimiter(getCloudKernelStorage),
      execute: async (workspaceId, command, input) => (await createCloudCompanyCommandService()).execute(workspaceId, command, input)
    });
  } catch {
    return unavailable();
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ ok: false, error: { code: "method-not-allowed", message: "Company commands require POST." } }, {
    status: 405,
    headers: { allow: "POST", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
  });
}
