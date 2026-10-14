import { randomUUID } from "node:crypto";
import { getCloudKernelStorage } from "../../../../lib/kernel-storage";
import { handleAuthRequest } from "../../../../lib/auth-route";
import { createPostgresAuthRateLimiter } from "../../../../lib/auth-rate-limit";
import { localAuthResponse } from "../../../../lib/local-mode";
import { readSupabaseServerConfig } from "../../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../../lib/supabase/server";
import { KernelStorageAccessError } from "@amped-studio-os/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ action: string }> };

async function execute(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { action } = await context.params;
    const local = localAuthResponse(request, action);
    if (local) return local;
    const config = readSupabaseServerConfig();
    const storage = await getCloudKernelStorage();
    const resolveWorkspace = async (authSubject: string) => {
      const membership = await storage.resolveWorkspaceForAuthSubject(authSubject);
      if (!membership) throw new KernelStorageAccessError();
      return membership;
    };
    return await handleAuthRequest(request, action, {
      appOrigin: config.appOrigin,
      googleSignInEnabled: process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED === "1",
      createClient: createServerSupabaseClient,
      consumeRateLimit: createPostgresAuthRateLimiter(getCloudKernelStorage),
      resolveWorkspace,
      listWorkspaces: (authSubject) => storage.listWorkspaceMembershipsForAuthSubject(authSubject),
      selectWorkspace: (authSubject, workspaceId) => storage.selectWorkspaceForAuthSubject(authSubject, workspaceId),
      setMembership: (actor, workspaceId, authSubject, role) => role
        ? storage.setWorkspaceMembership(actor, workspaceId, authSubject, role)
        : storage.removeWorkspaceMembership(actor, workspaceId, authSubject).then(() => undefined),
      getInvite: (tokenHash) => storage.getWorkspaceInvite(tokenHash),
      acceptInvite: (tokenHash, invitedEmail, authSubject) => storage.acceptWorkspaceInvite({
        tokenHash,
        invitedEmail,
        authSubject
      }),
      provisionWorkspace: (authSubject) => storage.provisionSelfServeWorkspace({
        authSubject,
        workspaceId: `workspace_${randomUUID().replace(/-/g, "")}`
      })
    });
  } catch {
    return Response.json({ ok: false, error: { code: "auth-unavailable", message: "Authentication is temporarily unavailable." } }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    });
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return execute(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return execute(request, context);
}
