import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256, type WorkspaceInvite } from "@amped-studio-os/contracts";
import { KernelStorageAccessError, type PostgresKernelStorage, type WorkspaceMembership } from "@amped-studio-os/storage";
import { handleAuthCallback } from "../apps/control/lib/auth-callback.js";
import { createPostgresAuthRateLimiter } from "../apps/control/lib/auth-rate-limit.js";
import { handleAuthRequest, type AuthRouteDependencies } from "../apps/control/lib/auth-route.js";
import { readSupabaseServerConfig } from "../apps/control/lib/supabase/config.js";
import { localAuthResponse } from "../apps/control/lib/local-mode.js";

const ORIGIN = "https://example.test";
const SUBJECT = "00000000-0000-4000-8000-000000000001";
const INVITE_TOKEN = "private-invite-token-12345678901234567890";
const INVITE: WorkspaceInvite = {
  schemaVersion: "workspace-invite-v1",
  id: "invite_auth",
  tokenHash: sha256(INVITE_TOKEN),
  invitedEmail: "synthetic-contact-008@example.test",
  targetWorkspaceId: "workspace_member_1",
  role: "owner",
  creatorSubject: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-07-20T11:00:00.000Z",
  expiresAt: "2026-07-21T11:00:00.000Z",
  status: "pending"
};
const MEMBERSHIP: WorkspaceMembership = {
  authSubject: SUBJECT,
  workspaceId: "workspace_member_1",
  role: "owner",
  createdAt: "2026-07-20T12:00:00.000Z"
};
type AuthClient = Awaited<ReturnType<AuthRouteDependencies["createClient"]>>;

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.8", ...headers },
    body: JSON.stringify(body)
  });
}

function client(overrides: Record<string, unknown> = {}): AuthClient {
  return {
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: SUBJECT, email: "synthetic-contact-008@example.test", role: "authenticated" } }, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: { session: { access_token: "verified-token" } }, error: null })),
      signInWithOAuth: vi.fn(async () => ({ data: { url: "https://synthetic-project.supabase.co/auth/v1/authorize?provider=google" }, error: null })),
      signUp: vi.fn(async () => ({ data: { session: null }, error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ data: {}, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: null })),
      ...overrides
    }
  } as unknown as AuthClient;
}

function dependencies(authClient = client()): AuthRouteDependencies {
  return {
    appOrigin: ORIGIN,
    createClient: vi.fn(async () => authClient),
    resolveWorkspace: vi.fn(async () => MEMBERSHIP),
    listWorkspaces: vi.fn(async () => [MEMBERSHIP]),
    selectWorkspace: vi.fn(async () => MEMBERSHIP),
    setMembership: vi.fn(async (_actor, _workspaceId, authSubject, role) => role ? {
      authSubject,
      workspaceId: MEMBERSHIP.workspaceId,
      role,
      createdAt: MEMBERSHIP.createdAt
    } : undefined),
    getInvite: vi.fn(async (tokenHash) => tokenHash === INVITE.tokenHash ? INVITE : undefined),
    acceptInvite: vi.fn(async () => MEMBERSHIP),
    provisionWorkspace: vi.fn(async () => MEMBERSHIP),
    consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }))
  };
}

function callbackDependencies(authClient: AuthClient) {
  return {
    appOrigin: ORIGIN,
    createClient: async () => authClient,
    getInvite: vi.fn(async (tokenHash: string) => tokenHash === INVITE.tokenHash ? INVITE : undefined),
    acceptInvite: vi.fn(async () => MEMBERSHIP),
    provisionWorkspace: vi.fn(async () => MEMBERSHIP)
  };
}

describe("Cloud Supabase auth boundary", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("authorizes a session only from verified claims.sub and provisions its private workspace", async () => {
    const deps = dependencies();
    const response = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/session`), "session", deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      user: { email: "synthetic-contact-008@example.test" },
      workspace: { id: MEMBERSHIP.workspaceId, role: "owner" },
      workspaces: [{ id: MEMBERSHIP.workspaceId, role: "owner" }]
    });
    expect(deps.resolveWorkspace).toHaveBeenCalledWith(SUBJECT);
    expect(deps.listWorkspaces).toHaveBeenCalledWith(SUBJECT);
  });

  it("heals a stranded confirmed account by provisioning its self-serve workspace at any verified touch", async () => {
    // Found live 2026-08-05: confirming the signup email on a phone fails the device-bound PKCE
    // exchange, so the callback that owned provisioning never ran; every later sign-in returned
    // workspace: null and the product refused every command. A verified session with zero
    // memberships must provision, not strand.
    const healed: WorkspaceMembership = { ...MEMBERSHIP, workspaceId: "workspace_healed_1" };
    function strandedDeps(): AuthRouteDependencies {
      const deps = dependencies();
      let provisioned = false;
      deps.listWorkspaces = vi.fn(async () => provisioned ? [healed] : []);
      deps.resolveWorkspace = vi.fn(async () => { throw new KernelStorageAccessError(); });
      deps.provisionWorkspace = vi.fn(async () => { provisioned = true; return healed; });
      return deps;
    }

    const signIn = strandedDeps();
    const response = await handleAuthRequest(request("sign-in", {
      email: "synthetic-contact-008@example.test",
      password: "password1"
    }), "sign-in", signIn);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      user: { email: "synthetic-contact-008@example.test" },
      workspace: { id: "workspace_healed_1", role: "owner" },
      workspaces: [{ id: "workspace_healed_1", role: "owner" }]
    });
    expect(signIn.provisionWorkspace).toHaveBeenCalledWith(SUBJECT);

    // An already-stranded session heals on its next session load, without a fresh sign-in.
    const session = strandedDeps();
    const sessionResponse = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/session`), "session", session);
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({ workspace: { id: "workspace_healed_1" } });
    expect(session.provisionWorkspace).toHaveBeenCalledWith(SUBJECT);

    // Healing is only for zero-membership subjects: a member whose selection is denied is an
    // access problem, never a reason to invent a second workspace.
    const denied = dependencies();
    denied.resolveWorkspace = vi.fn(async () => { throw new KernelStorageAccessError(); });
    const deniedResponse = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/session`), "session", denied);
    expect(deniedResponse.status).toBe(403);
    expect(denied.provisionWorkspace).not.toHaveBeenCalled();

    // If healing itself fails, the sign-in still succeeds honestly with no workspace.
    const failing = strandedDeps();
    failing.provisionWorkspace = vi.fn(async () => { throw new Error("storage down"); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const degraded = await handleAuthRequest(request("sign-in", {
      email: "synthetic-contact-008@example.test",
      password: "password1"
    }), "sign-in", failing);
    expect(degraded.status).toBe(200);
    expect(await degraded.json()).toMatchObject({ ok: true, workspace: null, workspaces: [] });
  });

  it("selects only a verified subject membership and lets only the selected owner manage roles", async () => {
    const deps = dependencies();
    const selected = await handleAuthRequest(request("select-workspace", { workspaceId: "workspace_member_2" }), "select-workspace", deps);
    expect(selected.status).toBe(200);
    expect(deps.selectWorkspace).toHaveBeenCalledWith(SUBJECT, "workspace_member_2");
    expect(deps.consumeRateLimit).toHaveBeenCalledWith("select-workspace", expect.any(Request), undefined);

    const target = "00000000-0000-4000-8000-000000000003";
    const updated = await handleAuthRequest(request("membership", { authSubject: target, role: "operator" }), "membership", deps);
    expect(updated.status).toBe(200);
    expect(deps.setMembership).toHaveBeenCalledWith(SUBJECT, MEMBERSHIP.workspaceId, target, "operator");

    const removed = await handleAuthRequest(request("membership", { authSubject: target, role: null }), "membership", deps);
    expect(removed.status).toBe(200);
    expect(deps.setMembership).toHaveBeenLastCalledWith(SUBJECT, MEMBERSHIP.workspaceId, target, null);

    const injected = await handleAuthRequest(
      request("membership", { authSubject: target, role: "viewer", workspaceId: "workspace_attacker" }),
      "membership",
      deps
    );
    expect(injected.status).toBe(400);
  });

  it("rejects cross-origin, non-JSON, malformed, and request-supplied tenancy fields before Supabase", async () => {
    const authClient = client();
    const deps = dependencies(authClient);
    expect((await handleAuthRequest(request("sign-in", { email: "synthetic-contact-008@example.test", password: "password1" }, { origin: "https://evil.test" }), "sign-in", deps)).status).toBe(403);
    expect((await handleAuthRequest(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" }), "sign-in", deps)).status).toBe(415);
    expect((await handleAuthRequest(new Request(`${ORIGIN}/api/auth/sign-in`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{" }), "sign-in", deps)).status).toBe(400);
    const tenancy = await handleAuthRequest(request("sign-in", { email: "synthetic-contact-008@example.test", password: "password1", workspaceId: "workspace_attacker" }), "sign-in", deps);
    expect(tenancy.status).toBe(400);
    expect(authClient.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("normalizes sign-in input, verifies the returned token, and never takes subject from the body", async () => {
    const authClient = client();
    const deps = dependencies(authClient);
    const response = await handleAuthRequest(request("sign-in", { email: " synthetic-contact-007@example.test ", password: "password1" }), "sign-in", deps);
    expect(response.status).toBe(200);
    expect(authClient.auth.signInWithPassword).toHaveBeenCalledWith({ email: "synthetic-contact-008@example.test", password: "password1" });
    expect(authClient.auth.getClaims).toHaveBeenCalledWith("verified-token");
    expect(deps.resolveWorkspace).toHaveBeenCalledWith(SUBJECT);
  });

  it("atomically accepts a matching invite for an existing verified account", async () => {
    const authClient = client();
    const deps = dependencies(authClient);
    const response = await handleAuthRequest(request("sign-in", {
      email: "synthetic-contact-008@example.test",
      password: "password1",
      inviteToken: INVITE_TOKEN
    }), "sign-in", deps);
    expect(response.status).toBe(200);
    expect(authClient.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "synthetic-contact-008@example.test",
      password: "password1"
    });
    expect(deps.acceptInvite).toHaveBeenCalledWith(INVITE.tokenHash, "synthetic-contact-008@example.test", SUBJECT);

    const wrong = await handleAuthRequest(request("sign-in", {
      email: "synthetic-contact-031@example.test",
      password: "password1",
      inviteToken: INVITE_TOKEN
    }), "sign-in", deps);
    expect(wrong.status).toBe(403);
    expect(authClient.auth.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it("returns an honest confirmation-required signup and a usable recovery callback URL", async () => {
    const authClient = client();
    const deps = dependencies(authClient);
    const signup = await handleAuthRequest(request("sign-up", {
      email: "synthetic-contact-008@example.test",
      password: "password1",
      inviteToken: INVITE_TOKEN
    }), "sign-up", deps);
    expect(signup.status).toBe(202);
    expect(await signup.json()).toMatchObject({ ok: true, user: null, confirmationRequired: true });
    expect(authClient.auth.signUp).toHaveBeenCalledWith({
      email: "synthetic-contact-008@example.test",
      password: "password1",
      options: { emailRedirectTo: `${ORIGIN}/auth/callback?next=%2Fapp&invite=${INVITE_TOKEN}` }
    });
    const recover = await handleAuthRequest(request("recover", { email: "synthetic-contact-008@example.test" }), "recover", deps);
    expect(recover.status).toBe(200);
    expect(authClient.auth.resetPasswordForEmail).toHaveBeenCalledWith("synthetic-contact-008@example.test", {
      redirectTo: `${ORIGIN}/auth/callback?next=%2Freset-password`
    });
  });

  it("keeps Google dark by default and starts the rate-limited PKCE redirect only when enabled", async () => {
    const authClient = client();
    const dark = dependencies(authClient);
    const hidden = await handleAuthRequest(request("google", {}), "google", dark);
    expect(hidden.status).toBe(404);
    expect(dark.consumeRateLimit).not.toHaveBeenCalled();
    expect(authClient.auth.signInWithOAuth).not.toHaveBeenCalled();

    const enabled = dependencies(authClient);
    enabled.googleSignInEnabled = true;
    const response = await handleAuthRequest(request("google", { inviteToken: INVITE_TOKEN }), "google", enabled);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      url: "https://synthetic-project.supabase.co/auth/v1/authorize?provider=google"
    });
    expect(enabled.consumeRateLimit).toHaveBeenCalledWith("google", expect.any(Request), undefined);
    expect(authClient.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: `${ORIGIN}/auth/callback?next=%2Fapp&invite=${INVITE_TOKEN}`,
        skipBrowserRedirect: true
      }
    });
  });

  it("maps provider and application rate limits to 429 without leaking provider details", async () => {
    const providerClient = client({
      signInWithPassword: vi.fn(async () => ({ data: { session: null }, error: { status: 429, message: "provider secret details" } }))
    });
    const providerResponse = await handleAuthRequest(request("sign-in", { email: "synthetic-contact-008@example.test", password: "password1" }), "sign-in", dependencies(providerClient));
    expect(providerResponse.status).toBe(429);
    expect(JSON.stringify(await providerResponse.json())).not.toContain("provider secret details");

    const appClient = client();
    const deps = dependencies(appClient);
    deps.consumeRateLimit = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 37 }));
    const appResponse = await handleAuthRequest(request("sign-in", { email: "synthetic-contact-008@example.test", password: "password1" }), "sign-in", deps);
    expect(appResponse.status).toBe(429);
    expect(appResponse.headers.get("retry-after")).toBe("37");
    expect(appClient.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("provisions a self-serve workspace at email confirmation, and never lets a bad invite degrade into one", async () => {
    // The stranger path: signup without an invite sends a callback URL with no `invite` param.
    // Caught live on 2026-08-03: the callback demanded an invitation from every confirmed account,
    // so a self-serve signup could create an account, confirm it, and then be refused at the door.
    const authClient = client();
    const deps = callbackDependencies(authClient);
    const selfServe = await handleAuthCallback(new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2Fapp`), deps);
    expect(selfServe.status).toBe(303);
    expect(selfServe.headers.get("location")).toBe(`${ORIGIN}/app`);
    expect(deps.provisionWorkspace).toHaveBeenCalledWith(SUBJECT);
    expect(deps.acceptInvite).not.toHaveBeenCalled();

    // A present-but-invalid invite must refuse, not fall through to a fresh workspace: an invite
    // binds an email to a specific workspace, and degrading would strand a mis-invited founder in
    // an empty one. Refusals are human-readable redirects now, never raw JSON in a browser tab.
    const badInvite = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2Fapp&invite=${"a".repeat(40)}`),
      deps
    );
    expect(badInvite.status).toBe(303);
    expect(badInvite.headers.get("location")).toBe(`${ORIGIN}/login?notice=invite-link`);
    expect(deps.provisionWorkspace).toHaveBeenCalledTimes(1);

    // An unauthenticated exchange provisions nothing.
    const anonClient = client({ getClaims: vi.fn(async () => ({ data: { claims: null }, error: null })) });
    const anonDeps = callbackDependencies(anonClient);
    const anon = await handleAuthCallback(new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2Fapp`), anonDeps);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`${ORIGIN}/login?notice=confirm-link`);
    expect(anonDeps.provisionWorkspace).not.toHaveBeenCalled();

    // Provisioning failure fails closed to the login screen, never into /app.
    const failingDeps = { ...callbackDependencies(client()), provisionWorkspace: vi.fn(async () => { throw new Error("storage down"); }) };
    const failed = await handleAuthCallback(new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2Fapp`), failingDeps);
    expect(failed.status).toBe(303);
    expect(failed.headers.get("location")).toBe(`${ORIGIN}/login?notice=confirm-link`);
  });

  it("keeps a matching verified Google email on its existing auth subject and workspace", async () => {
    // Supabase automatic identity linking preserves the existing subject for the same verified
    // email. The callback then exercises the existing idempotent per-subject provisioner, so it
    // returns the existing membership instead of creating a second workspace.
    const deps = {
      ...callbackDependencies(client()),
      provisionWorkspace: vi.fn(async (authSubject: string) => {
        expect(authSubject).toBe(MEMBERSHIP.authSubject);
        return MEMBERSHIP;
      })
    };
    const response = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=google-code&next=%2Fapp`),
      deps
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/app`);
    expect(deps.provisionWorkspace).toHaveBeenCalledOnce();
    expect(deps.acceptInvite).not.toHaveBeenCalled();
  });

  it("turns a failed email-link exchange into a human login notice, per flow", async () => {
    // The cross-device case: the code verifier lives only in the browser that started signup, so
    // the phone that opens the email cannot complete the exchange. The email itself is already
    // confirmed by then, so the login screen tells the visitor to just sign in — and the identity
    // route provisions the workspace the callback never got to create.
    const exchangeFails = client({ exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: { message: "code verifier missing" } })) });
    const confirm = await handleAuthCallback(new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2Fapp`), callbackDependencies(exchangeFails));
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get("location")).toBe(`${ORIGIN}/login?notice=confirm-link`);

    const recovery = await handleAuthCallback(new Request(`${ORIGIN}/auth/callback?code=recovery-code&next=%2Freset-password`), callbackDependencies(exchangeFails));
    expect(recovery.status).toBe(303);
    expect(recovery.headers.get("location")).toBe(`${ORIGIN}/login?notice=recovery-link`);
  });

  it("completes the recovery code exchange and password update contracts", async () => {
    const authClient = client();
    const callback = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=recovery-code&next=%2Freset-password`),
      callbackDependencies(authClient)
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
    expect(authClient.auth.exchangeCodeForSession).toHaveBeenCalledWith("recovery-code");
    const signupCallback = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2Fapp&invite=${INVITE_TOKEN}`),
      callbackDependencies(authClient)
    );
    expect(signupCallback.status).toBe(303);
    expect(signupCallback.headers.get("location")).toBe(`${ORIGIN}/app`);
    // An off-allowlist `next` must land on our own login screen, never wherever the URL said.
    const evil = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=recovery-code&next=https%3A%2F%2Fevil.test`),
      callbackDependencies(authClient)
    );
    expect(evil.status).toBe(303);
    expect(evil.headers.get("location")).toBe(`${ORIGIN}/login?notice=confirm-link`);
    // `/` is the public landing page now, so it is off the allowlist. A confirmation link that
    // still asks for it is stale, and must be refused rather than dropping a confirmed founder on
    // marketing copy with no workspace provisioned.
    const stale = await handleAuthCallback(
      new Request(`${ORIGIN}/auth/callback?code=signup-code&next=%2F`),
      callbackDependencies(authClient)
    );
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe(`${ORIGIN}/login?notice=confirm-link`);
    const updated = await handleAuthRequest(request("update-password", { password: "new-password-1" }), "update-password", dependencies(authClient));
    expect(updated.status).toBe(200);
    expect(authClient.auth.updateUser).toHaveBeenCalledWith({ password: "new-password-1" });
  });

  it("HMACs trusted Vercel IP and email before the durable limiter sees either value", async () => {
    const consumeAuthRateLimit = vi.fn(async (_input: { bucketKeys: readonly string[] }) => ({ allowed: true, retryAfterSeconds: 0 }));
    const limiter = createPostgresAuthRateLimiter(
      async () => ({ consumeAuthRateLimit } as unknown as PostgresKernelStorage),
      { VERCEL: "1", NODE_ENV: "production", AUTH_RATE_LIMIT_SECRET: "0123456789abcdef0123456789abcdef" }
    );
    await limiter("sign-in", request("sign-in", {}), "synthetic-contact-006@example.test");
    const input = consumeAuthRateLimit.mock.calls[0]![0];
    expect(input.bucketKeys).toHaveLength(2);
    expect(input.bucketKeys.every((value: string) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(JSON.stringify(input)).not.toContain("Founder");
    expect(JSON.stringify(input)).not.toContain("203.0.113.8");
  });

  it("rejects secret keys in the publishable-key slot", () => {
    expect(() => readSupabaseServerConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_forbidden",
      OPSPOT_APP_ORIGIN: ORIGIN,
      NODE_ENV: "production"
    })).toThrow("must never be used");
  });

  it("derives only a Vercel preview origin when the canonical origin is absent", () => {
    const config = readSupabaseServerConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_preview",
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "synthetic-preview-123.vercel.app"
    });
    expect(config.appOrigin).toBe("https://example.test");
    expect(() => readSupabaseServerConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_preview",
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "attacker.example"
    })).toThrow("must be a Vercel preview hostname");
  });

  it("still requires the configured origin outside Vercel previews", () => {
    expect(() => readSupabaseServerConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_production",
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_URL: "synthetic-app.vercel.app"
    })).toThrow("OPSPOT_APP_ORIGIN is required");
  });

  it("keeps local mode loopback-only and never synthesizes cloud auth", async () => {
    const session = localAuthResponse(new Request("http://127.0.0.1:3210/api/auth/session"), "session", { NODE_ENV: "test", ENGINE_MODE: "local" });
    expect(session?.status).toBe(503);
    expect(await session?.json()).toMatchObject({ ok: false, error: { code: "auth-unavailable" } });
    const mutation = localAuthResponse(request("sign-in", { email: "synthetic-contact-008@example.test", password: "password1" }), "sign-in", { NODE_ENV: "test", ENGINE_MODE: "local" });
    expect(mutation?.status).toBe(403);
    expect(await mutation?.json()).toMatchObject({ ok: false, error: { code: "local-origin-required" } });
    const localMutation = localAuthResponse(new Request("http://localhost:3210/api/auth/sign-in", { method: "POST" }), "sign-in", { NODE_ENV: "test", ENGINE_MODE: "local" });
    expect(localMutation?.status).toBe(403);
    expect(await localMutation?.json()).toMatchObject({ ok: false, error: { code: "local-auth-disabled" } });
    expect(localAuthResponse(new Request(`${ORIGIN}/api/auth/session`), "session", { NODE_ENV: "test", ENGINE_MODE: "cloud" })).toBeUndefined();
  });
});
