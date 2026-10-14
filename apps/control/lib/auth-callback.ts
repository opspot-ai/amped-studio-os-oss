import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { sha256, type WorkspaceInvite } from "@amped-studio-os/contracts";
import type { WorkspaceMembership } from "@amped-studio-os/storage";

export interface AuthCallbackDependencies {
  appOrigin: string;
  createClient(): Promise<SupabaseClient>;
  getInvite(tokenHash: string): Promise<WorkspaceInvite | undefined>;
  acceptInvite(tokenHash: string, invitedEmail: string, authSubject: string): Promise<WorkspaceMembership>;
  provisionWorkspace(authSubject: string): Promise<WorkspaceMembership>;
}

/** The fixed set of failure notices the login screen knows how to explain. */
export type AuthCallbackNotice = "confirm-link" | "recovery-link" | "invite-link";

function failure(code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status: 400,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
  });
}

// A person clicking an email link must land on a page that explains itself, never on raw JSON.
// Found live 2026-08-05: opening the confirmation email on a phone fails the PKCE exchange (the
// code verifier only exists in the browser that started signup), and the black JSON screen gave a
// paying customer nothing to do next. The notice is a fixed enum on our own origin — no reflected
// content, no open redirect.
function refused(appOrigin: string, notice: AuthCallbackNotice): Response {
  const location = new URL("/login", appOrigin);
  location.searchParams.set("notice", notice);
  return new Response(null, {
    status: 303,
    headers: { location: location.toString(), "cache-control": "private, no-store" }
  });
}

export async function handleAuthCallback(request: Request, dependencies: AuthCallbackDependencies): Promise<Response> {
  if (request.method !== "GET") return failure("method-not-allowed", "Auth callback requires GET.");
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  const inviteToken = url.searchParams.get("invite");
  const flowNotice: AuthCallbackNotice = next === "/reset-password" ? "recovery-link" : "confirm-link";
  // Still a strict two-value allowlist, not an open redirect. `/app` took `/`'s place when the
  // root path became the public landing page, so a confirmed signup arrives at the authenticated
  // surface instead of marketing copy.
  if (!code || code.length > 2_048 || (next !== "/app" && next !== "/reset-password")) {
    return refused(dependencies.appOrigin, flowNotice);
  }
  const client = await dependencies.createClient();
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) return refused(dependencies.appOrigin, flowNotice);
  if (next === "/app") {
    const { data, error: claimsError } = await client.auth.getClaims();
    const subject = z.uuid().safeParse(data?.claims?.sub);
    const email = z.string().trim().toLowerCase().email().max(254).safeParse(data?.claims?.email);
    if (!subject.success || !email.success || data?.claims?.role !== "authenticated" || claimsError) {
      return refused(dependencies.appOrigin, "confirm-link");
    }
    // Signup only appends `invite` to the callback URL when a real token existed at signup, so its
    // absence means the self-serve path: the confirmed account gets its own private workspace,
    // idempotently per auth subject. A token that is present but invalid must never degrade into
    // self-serve success; an invite binds an email to a specific workspace, and falling through
    // would silently land a mis-invited founder in a fresh empty one instead.
    if (inviteToken === null) {
      try {
        await dependencies.provisionWorkspace(subject.data);
      } catch {
        // Fails closed to the login screen rather than into /app; the identity route heals the
        // missing workspace at the next verified sign-in or session load.
        return refused(dependencies.appOrigin, "confirm-link");
      }
    } else {
      const token = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).safeParse(inviteToken);
      if (!token.success) return refused(dependencies.appOrigin, "invite-link");
      const tokenHash = sha256(token.data);
      const invite = await dependencies.getInvite(tokenHash);
      if (!invite || invite.status !== "pending" || invite.invitedEmail !== email.data) {
        return refused(dependencies.appOrigin, "invite-link");
      }
      try {
        await dependencies.acceptInvite(tokenHash, email.data, subject.data);
      } catch {
        return refused(dependencies.appOrigin, "invite-link");
      }
    }
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(next, dependencies.appOrigin).toString(),
      "cache-control": "private, no-store"
    }
  });
}
