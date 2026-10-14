import { randomUUID } from "node:crypto";
import { handleAuthCallback } from "../../../lib/auth-callback";
import { readSupabaseServerConfig } from "../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import { getCloudKernelStorage } from "../../../lib/kernel-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const config = readSupabaseServerConfig();
    const storage = await getCloudKernelStorage();
    return await handleAuthCallback(request, {
      appOrigin: config.appOrigin,
      createClient: createServerSupabaseClient,
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
