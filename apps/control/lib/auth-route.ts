import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { sha256, type WorkspaceInvite } from "@amped-studio-os/contracts";
import {
  KernelStorageAccessError,
  KernelStorageConflictError,
  type WorkspaceMembership,
  type WorkspaceRole
} from "@amped-studio-os/storage";
import type { ConsumeAuthRateLimit, MutableAuthAction } from "./auth-rate-limit";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(128),
  inviteToken: inviteTokenSchema.optional()
}).strict();
// Self-serve reversed the invite-only lock, so `inviteToken` is optional here. When it is present
// every invite rule below still applies unchanged; when it is absent the signup provisions its own
// workspace instead. Nothing else about invites was relaxed.
const signupSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(128),
  inviteToken: inviteTokenSchema.optional()
}).strict();
const emailOnlySchema = z.object({ email: emailSchema }).strict();
const passwordOnlySchema = z.object({ password: z.string().min(8).max(128) }).strict();
const emptySchema = z.object({}).strict();
const googleSchema = z.object({ inviteToken: inviteTokenSchema.optional() }).strict();
const authSubjectSchema = z.uuid();
const workspaceIdSchema = z.string().regex(/^workspace_[a-z0-9][a-z0-9_-]{0,149}$/);
const selectWorkspaceSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
const membershipSchema = z.object({ authSubject: authSubjectSchema, role: z.enum(["owner", "operator", "viewer"]).nullable() }).strict();
const MAX_BODY_BYTES = 8_192;

type AuthAction = MutableAuthAction | "session" | "invite";

export interface AuthRouteDependencies {
  appOrigin: string;
  googleSignInEnabled?: boolean;
  createClient(): Promise<SupabaseClient>;
  resolveWorkspace(authSubject: string): Promise<WorkspaceMembership>;
  listWorkspaces(authSubject: string): Promise<WorkspaceMembership[]>;
  selectWorkspace(authSubject: string, workspaceId: string): Promise<WorkspaceMembership>;
  setMembership(actorAuthSubject: string, workspaceId: string, authSubject: string, role: WorkspaceRole | null): Promise<WorkspaceMembership | undefined>;
  getInvite(tokenHash: string): Promise<WorkspaceInvite | undefined>;
  acceptInvite(tokenHash: string, invitedEmail: string, authSubject: string): Promise<WorkspaceMembership>;
  provisionWorkspace(authSubject: string): Promise<WorkspaceMembership>;
  consumeRateLimit: ConsumeAuthRateLimit;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
      expires: "0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function failure(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return json({ ok: false, error: { code, message } }, status, headers);
}

function providerRateLimited(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return record.status === 429 || code.includes("rate") || message.includes("rate limit");
}

function providerFailure(error: unknown, fallback: string): Response {
  if (providerRateLimited(error)) return failure(429, "auth-rate-limited", "Too many requests. Try again later.", { "retry-after": "60" });
  return failure(400, "auth-rejected", fallback);
}

async function body(request: Request): Promise<unknown | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "json-required", "Content-Type must be application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return failure(413, "body-too-large", "Request body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return failure(400, "invalid-json", "Request body must be valid JSON.");
  }
}

async function verifiedClaims(client: SupabaseClient, accessToken?: string): Promise<{ subject: string; email: string } | Response> {
  const { data, error } = await client.auth.getClaims(accessToken);
  const claims = data?.claims;
  const subject = authSubjectSchema.safeParse(claims?.sub);
  const email = emailSchema.safeParse(claims?.email);
  if (error || !subject.success || !email.success || claims?.role !== "authenticated") {
    return failure(401, "auth-required", "A verified session is required.");
  }
  return { subject: subject.data, email: email.data };
}

async function identityResponse(
  identity: { subject: string; email: string },
  dependencies: AuthRouteDependencies,
  selected?: WorkspaceMembership
): Promise<Response> {
  let memberships = await dependencies.listWorkspaces(identity.subject);
  let membership = selected;
  if (!membership) {
    try {
      membership = await dependencies.resolveWorkspace(identity.subject);
    } catch (error) {
      if (!(error instanceof KernelStorageAccessError) || memberships.length > 0) throw error;
      // A verified, confirmed account with zero memberships is a stranded self-serve signup, not a
      // platform identity. Found live 2026-08-05: confirming the signup email on a different device
      // fails the PKCE exchange, so the callback that owns provisioning never runs, and every later
      // sign-in landed here permanently workspace-less. Provisioning is idempotent per subject
      // (advisory-locked, returns the existing membership), so healing at every verified touch is
      // safe. Invite bindings are unaffected: an invite token is handled before this point, and a
      // pending invite can still be accepted later.
      try {
        membership = await dependencies.provisionWorkspace(identity.subject);
        memberships = await dependencies.listWorkspaces(identity.subject);
      } catch (provisionError) {
        console.error(
          "workspace-heal-failed",
          identity.subject,
          provisionError instanceof Error ? `${provisionError.name}: ${provisionError.message}` : String(provisionError)
        );
        return json({
          ok: true,
          user: { email: identity.email },
          workspace: null,
          workspaces: []
        });
      }
    }
  }
  return json({
    ok: true,
    user: { email: identity.email },
    workspace: { id: membership.workspaceId, role: membership.role },
    workspaces: memberships.map((item) => ({ id: item.workspaceId, role: item.role }))
  });
}

async function verifiedIdentity(client: SupabaseClient, dependencies: AuthRouteDependencies, accessToken?: string): Promise<Response> {
  const identity = await verifiedClaims(client, accessToken);
  if (identity instanceof Response) return identity;
  try {
    return await identityResponse(identity, dependencies);
  } catch (error) {
    return workspaceFailure(error);
  }
}

function parseAction(action: string): AuthAction | undefined {
  return (["session", "invite", "sign-in", "sign-up", "google", "recover", "sign-out", "update-password", "select-workspace", "membership"] as const)
    .find((candidate) => candidate === action);
}

function workspaceFailure(error: unknown): Response {
  if (error instanceof KernelStorageAccessError) return failure(403, "workspace-access-denied", "Workspace access denied.");
  if (error instanceof KernelStorageConflictError) return failure(409, "workspace-conflict", "Workspace membership conflicted with current state.");
  throw error;
}

export async function handleAuthRequest(request: Request, rawAction: string, dependencies: AuthRouteDependencies): Promise<Response> {
  const action = parseAction(rawAction);
  if (!action || (action === "google" && dependencies.googleSignInEnabled !== true)) {
    return failure(404, "auth-route-not-found", "Auth route not found.");
  }
  if (request.method === "GET") {
    if (action === "invite") {
      const token = inviteTokenSchema.safeParse(new URL(request.url).searchParams.get("token"));
      if (!token.success) return failure(404, "private-access-required", "A valid private invitation is required.");
      const invite = await dependencies.getInvite(sha256(token.data));
      if (!invite || invite.status !== "pending") return failure(404, "private-access-required", "A valid private invitation is required.");
      return json({
        ok: true,
        invite: {
          email: invite.invitedEmail,
          workspaceId: invite.targetWorkspaceId,
          role: invite.role,
          expiresAt: invite.expiresAt
        }
      });
    }
    if (action !== "session") return failure(405, "method-not-allowed", "This auth route requires POST.", { allow: "POST" });
    return verifiedIdentity(await dependencies.createClient(), dependencies);
  }
  if (request.method !== "POST" || action === "session" || action === "invite") {
    return failure(405, "method-not-allowed", action === "session" || action === "invite" ? "This lookup requires GET." : "This auth route requires POST.", { allow: action === "session" || action === "invite" ? "GET" : "POST" });
  }
  if (request.headers.get("origin") !== dependencies.appOrigin) return failure(403, "origin-rejected", "Request origin was rejected.");
  const parsedBody = await body(request);
  if (parsedBody instanceof Response) return parsedBody;

  const empty = action === "sign-out" ? emptySchema.safeParse(parsedBody) : undefined;
  const emailOnly = action === "recover" ? emailOnlySchema.safeParse(parsedBody) : undefined;
  const credentials = action === "sign-in" ? credentialsSchema.safeParse(parsedBody) : undefined;
  const signup = action === "sign-up" ? signupSchema.safeParse(parsedBody) : undefined;
  const google = action === "google" ? googleSchema.safeParse(parsedBody) : undefined;
  const passwordOnly = action === "update-password" ? passwordOnlySchema.safeParse(parsedBody) : undefined;
  const selection = action === "select-workspace" ? selectWorkspaceSchema.safeParse(parsedBody) : undefined;
  const membershipChange = action === "membership" ? membershipSchema.safeParse(parsedBody) : undefined;
  if (
    empty?.success === false ||
    emailOnly?.success === false ||
    credentials?.success === false ||
    signup?.success === false ||
    google?.success === false ||
    passwordOnly?.success === false ||
    selection?.success === false ||
    membershipChange?.success === false
  ) {
    return failure(400, "invalid-auth-input", "Auth request fields are invalid.");
  }
  const email = emailOnly?.success ? emailOnly.data.email : credentials?.success ? credentials.data.email : signup?.success ? signup.data.email : undefined;
  const rate = await dependencies.consumeRateLimit(action, request, email);
  if (!rate.allowed) {
    return failure(429, "auth-rate-limited", "Too many requests. Try again later.", { "retry-after": String(rate.retryAfterSeconds) });
  }

  const client = await dependencies.createClient();
  if (action === "select-workspace" || action === "membership") {
    const identity = await verifiedClaims(client);
    if (identity instanceof Response) return identity;
    try {
      if (action === "select-workspace") {
        const selected = await dependencies.selectWorkspace(identity.subject, selection!.data.workspaceId);
        return identityResponse(identity, dependencies, selected);
      }
      const selected = await dependencies.resolveWorkspace(identity.subject);
      if (selected.role !== "owner") return failure(403, "workspace-access-denied", "Workspace owner access is required.");
      const updated = await dependencies.setMembership(
        identity.subject,
        selected.workspaceId,
        membershipChange!.data.authSubject,
        membershipChange!.data.role
      );
      return json({
        ok: true,
        workspace: { id: selected.workspaceId, role: selected.role },
        membership: updated ? { role: updated.role } : null
      });
    } catch (error) {
      return workspaceFailure(error);
    }
  }
  if (action === "update-password") {
    const { data: claimsData, error: claimsError } = await client.auth.getClaims();
    const claims = claimsData?.claims;
    if (claimsError || !authSubjectSchema.safeParse(claims?.sub).success || claims?.role !== "authenticated") {
      return failure(401, "auth-required", "A verified recovery session is required.");
    }
    const { error } = await client.auth.updateUser({ password: passwordOnly!.data.password });
    if (error) return providerFailure(error, "Password could not be updated.");
    return json({ ok: true, user: { email: emailSchema.safeParse(claims.email).data ?? null } });
  }
  if (action === "sign-out") {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) return providerFailure(error, "Sign-out could not be completed.");
    return json({ ok: true, user: null });
  }
  if (action === "recover") {
    const callback = new URL("/auth/callback", dependencies.appOrigin);
    callback.searchParams.set("next", "/reset-password");
    const { error } = await client.auth.resetPasswordForEmail(emailOnly!.data.email, { redirectTo: callback.toString() });
    if (error) return providerFailure(error, "Recovery could not be requested.");
    return json({ ok: true, user: null });
  }
  if (action === "google") {
    const inviteToken = google!.data.inviteToken;
    if (inviteToken) {
      const invite = await dependencies.getInvite(sha256(inviteToken));
      if (!invite || invite.status !== "pending") {
        return failure(403, "private-access-required", "A valid private invitation is required.");
      }
    }
    const callback = new URL("/auth/callback", dependencies.appOrigin);
    callback.searchParams.set("next", "/app");
    if (inviteToken) callback.searchParams.set("invite", inviteToken);
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString(), skipBrowserRedirect: true }
    });
    if (error || !data.url) return providerFailure(error, "Google sign-in could not be started.");
    return json({ ok: true, url: data.url });
  }
  if (action === "sign-in") {
    const { inviteToken, ...providerCredentials } = credentials!.data;
    const inviteHash = inviteToken ? sha256(inviteToken) : undefined;
    const invite = inviteHash ? await dependencies.getInvite(inviteHash) : undefined;
    if (inviteHash && (!invite || invite.status !== "pending")) {
      return failure(403, "private-access-required", "A valid private invitation is required.");
    }
    if (invite && invite.invitedEmail !== providerCredentials.email) {
      return failure(403, "invite-email-mismatch", "The invitation does not match this email.");
    }
    const { data, error } = await client.auth.signInWithPassword(providerCredentials);
    if (error || !data.session?.access_token) return providerFailure(error, "Invalid email or password.");
    if (inviteHash) {
      const identity = await verifiedClaims(client, data.session.access_token);
      if (identity instanceof Response) return identity;
      try {
        await dependencies.acceptInvite(inviteHash, identity.email, identity.subject);
        return await identityResponse(identity, dependencies);
      } catch (acceptError) {
        return workspaceFailure(acceptError);
      }
    }
    return verifiedIdentity(client, dependencies, data.session.access_token);
  }
  const signupToken = signup!.data.inviteToken;
  const inviteHash = signupToken ? sha256(signupToken) : undefined;
  // An invited signup is still gated exactly as before: the invite must exist, be pending, and be
  // bound to this email. Only the no-token case is new.
  if (inviteHash) {
    const invite = await dependencies.getInvite(inviteHash);
    if (!invite || invite.status !== "pending") return failure(403, "private-access-required", "A valid private invitation is required.");
    if (invite.invitedEmail !== signup!.data.email) return failure(403, "invite-email-mismatch", "The invitation does not match this email.");
  }
  const signupCallback = new URL("/auth/callback", dependencies.appOrigin);
  // `/` is the public landing page; the confirmed account belongs on the authenticated surface.
  signupCallback.searchParams.set("next", "/app");
  if (signupToken) signupCallback.searchParams.set("invite", signupToken);
  const { data, error } = await client.auth.signUp({
    email: signup!.data.email,
    password: signup!.data.password,
    options: { emailRedirectTo: signupCallback.toString() }
  });
  if (error) return providerFailure(error, "Account could not be created.");
  if (!data.session?.access_token) return json({ ok: true, user: null, confirmationRequired: true }, 202);
  const identity = await verifiedClaims(client, data.session.access_token);
  if (identity instanceof Response) return identity;
  try {
    if (inviteHash) await dependencies.acceptInvite(inviteHash, identity.email, identity.subject);
    else await dependencies.provisionWorkspace(identity.subject);
    return await identityResponse(identity, dependencies);
  } catch (acceptError) {
    return workspaceFailure(acceptError);
  }
}
