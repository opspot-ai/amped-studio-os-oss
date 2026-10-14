import { handleAdminRequest, platformAdminSubjects } from "../../../../lib/admin-route";
import { createCloudCompanyCommandService } from "../../../../lib/company-runtime";
import { getCloudKernelStorage } from "../../../../lib/kernel-storage";
import { readSupabaseServerConfig } from "../../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ action: string }> };

function studioOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.OPSPOT_STUDIO_ORIGIN ?? "http://127.0.0.1:4173";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OPSPOT_STUDIO_ORIGIN must be an exact HTTP(S) origin");
  }
  return url.origin;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { action } = await context.params;
    const config = readSupabaseServerConfig();
    const storage = await getCloudKernelStorage();
    const admins = platformAdminSubjects();
    return await handleAdminRequest(request, action, {
      appOrigin: config.appOrigin,
      studioOrigin: studioOrigin(),
      createClient: createServerSupabaseClient,
      isPlatformAdmin: (authSubject) => admins.has(authSubject),
      storage,
      execute: async (workspaceId, command, input, principal) => {
        if (principal.targetWorkspaceId !== workspaceId) throw new Error("support delegation target mismatch");
        return (await createCloudCompanyCommandService()).execute(workspaceId, command, input);
      }
    });
  } catch {
    return Response.json({ ok: false, error: { code: "admin-unavailable", message: "The private admin service is temporarily unavailable." } }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ ok: false, error: { code: "method-not-allowed", message: "Admin routes require POST." } }, {
    status: 405,
    headers: { allow: "POST", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
  });
}
