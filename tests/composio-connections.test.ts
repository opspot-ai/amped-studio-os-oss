import { describe, expect, it, vi } from "vitest";
import { ComposioAdapter } from "@amped-studio-os/adapters";
import { COMPOSIO_TOOLKIT_ORDER, sha256 } from "@amped-studio-os/contracts";
import { CompanyAutonomy, UnconfiguredCeoExecutor } from "@amped-studio-os/domain";
import { EngineStorage, SqliteKernelStorage, type KernelConnection } from "@amped-studio-os/storage";
import { handleComposioRequest, type ComposioRouteDependencies } from "../apps/control/lib/composio-route.js";

const ORIGIN = "https://example.test";
const SUBJECT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "workspace_conn_test";
const VENTURE = "venture_conn_test";

function companyState() {
  const snapshot = {
    operatingEnvelope: {
      modelBudgetCents: 1_000,
      toolBudgetCents: 0,
      operatingBudgetCents: 0,
      dailyActionCap: 0,
      weeklyActionCap: 0,
      publicationAllowed: false,
      expiresAt: "2027-01-01T00:00:00.000Z",
      senderIdentities: [],
      allowedChannels: [],
      recipientRules: [],
      suppressions: [],
      quietHours: [],
      approvedClaims: [],
      prohibitedClaims: [],
      credentialScopes: [],
      deploymentBoundaries: []
    }
  };
  return { bootstrap: { digest: sha256(snapshot), snapshot }, runState: "idle", lifecycleState: "candidate" };
}

async function storageWithCompany() {
  const storage = new SqliteKernelStorage(new EngineStorage(":memory:"));
  await storage.ensureWorkspace(WORKSPACE);
  const at = "2026-08-05T12:00:00.000Z";
  await storage.createCompany({
    workspaceId: WORKSPACE,
    companyId: VENTURE,
    slug: "conn-test",
    name: "Connection Test Co",
    owner: "founder",
    owningRepo: "synthetic/conn-test",
    lifecycleState: "candidate",
    state: companyState(),
    createdAt: at,
    updatedAt: at
  });
  return storage;
}

type AdapterStub = Pick<ComposioAdapter, "ensureAuthConfig" | "initiateConnection" | "getConnectedAccount" | "revokeConnectedAccount">;

function adapterStub(overrides: Partial<AdapterStub> = {}): ComposioAdapter {
  return {
    ensureAuthConfig: vi.fn(async (slug: string) => ({ id: "ac_test", toolkitSlug: slug, isComposioManaged: true })),
    initiateConnection: vi.fn(async () => ({
      linkToken: "lk_test",
      redirectUrl: "https://connect.composio.dev/link/lk_test",
      connectedAccountId: "ca_test_1"
    })),
    getConnectedAccount: vi.fn(async (id: string) => ({ id, status: "pending" as const, rawStatus: "INITIALIZING" })),
    revokeConnectedAccount: vi.fn(async () => undefined),
    ...overrides
  } as unknown as ComposioAdapter;
}

function authDeps() {
  return {
    appOrigin: ORIGIN,
    createClient: async () => ({
      auth: {
        getClaims: vi.fn(async () => ({ data: { claims: { sub: SUBJECT, email: "synthetic-contact-008@example.test", role: "authenticated" } }, error: null }))
      }
    }) as never,
    resolveWorkspace: vi.fn(async () => ({ authSubject: SUBJECT, workspaceId: WORKSPACE, role: "owner" as const, createdAt: "2026-08-05T12:00:00.000Z" })),
    consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }))
  };
}

async function dependencies(overrides: Partial<ComposioRouteDependencies> = {}): Promise<ComposioRouteDependencies> {
  return {
    storage: await storageWithCompany(),
    auth: authDeps(),
    composio: adapterStub(),
    now: () => "2026-08-05T12:30:00.000Z",
    ...overrides
  };
}

function post(action: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/providers/composio/${action}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function list(ventureId: string): Request {
  return new Request(`${ORIGIN}/api/providers/composio/list?ventureId=${ventureId}`);
}

describe("Composio connections boundary", () => {
  it("is unavailable without a configured adapter and refuses unverified or cross-origin callers", async () => {
    const noAdapter = await dependencies({ composio: undefined as never });
    delete (noAdapter as { composio?: unknown }).composio;
    expect((await handleComposioRequest(list(VENTURE), "list", noAdapter)).status).toBe(503);

    const anonAuth = authDeps();
    anonAuth.createClient = async () => ({
      auth: { getClaims: vi.fn(async () => ({ data: { claims: null }, error: null })) }
    }) as never;
    const anon = await dependencies({ auth: anonAuth });
    expect((await handleComposioRequest(list(VENTURE), "list", anon)).status).toBe(401);

    const deps = await dependencies();
    const crossOrigin = await handleComposioRequest(
      post("initiate", { ventureId: VENTURE, toolkit: "gmail" }, { origin: "https://evil.test" }),
      "initiate",
      deps
    );
    expect(crossOrigin.status).toBe(403);
    expect(deps.composio!.initiateConnection).not.toHaveBeenCalled();
  });

  it("rejects off-list toolkits and ventures outside the caller's workspace before touching Composio", async () => {
    const deps = await dependencies();
    const offList = await handleComposioRequest(
      post("initiate", { ventureId: VENTURE, toolkit: "definitely-not-curated" }),
      "initiate",
      deps
    );
    expect(offList.status).toBe(400);

    // The scoping mutation bar: a venture id that is not a company in the caller's resolved
    // workspace must 404 without a single Composio call. Removing the requireCompany check
    // turns this red.
    const foreign = await handleComposioRequest(
      post("initiate", { ventureId: "venture_someone_elses", toolkit: "gmail" }),
      "initiate",
      deps
    );
    expect(foreign.status).toBe(404);
    expect(deps.composio!.ensureAuthConfig).not.toHaveBeenCalled();
    expect(deps.composio!.initiateConnection).not.toHaveBeenCalled();

    const foreignList = await handleComposioRequest(list("venture_someone_elses"), "list", deps);
    expect(foreignList.status).toBe(404);
  });

  it("initiates a hosted connect flow, persists the pending row, and reconciles it to connected", async () => {
    const deps = await dependencies();
    const initiated = await handleComposioRequest(
      post("initiate", { ventureId: VENTURE, toolkit: "gmail" }),
      "initiate",
      deps
    );
    expect(initiated.status).toBe(200);
    const body = await initiated.json() as { redirectUrl: string; connectionId: string; status: string };
    expect(body.redirectUrl).toBe("https://connect.composio.dev/link/lk_test");
    expect(body.status).toBe("pending");
    expect(deps.composio!.initiateConnection).toHaveBeenCalledWith({
      authConfigId: "ac_test",
      userId: VENTURE,
      callbackUrl: `${ORIGIN}/app`
    });

    const stored = await deps.storage.listConnections(WORKSPACE, VENTURE);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("pending");
    expect(stored[0]!.composioAccountId).toBe("ca_test_1");

    // While Composio reports the OAuth incomplete the row stays pending...
    const stillPending = await handleComposioRequest(list(VENTURE), "list", deps);
    const pendingRows = (await stillPending.json() as { connections: Array<{ toolkit: string; status: string }> }).connections;
    expect(pendingRows.find((row) => row.toolkit === "gmail")!.status).toBe("pending");

    // ...and once Composio reports ACTIVE, the list flips AND persists the flip.
    (deps.composio!.getConnectedAccount as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "ca_test_1", status: "connected", rawStatus: "ACTIVE" });
    const reconciled = await handleComposioRequest(list(VENTURE), "list", deps);
    const rows = (await reconciled.json() as { connections: Array<{ toolkit: string; status: string; connectionId?: string }> }).connections;
    expect(rows).toHaveLength(COMPOSIO_TOOLKIT_ORDER.length);
    expect(rows.find((row) => row.toolkit === "gmail")!.status).toBe("connected");
    const persisted = await deps.storage.listConnections(WORKSPACE, VENTURE);
    expect(persisted[0]!.status).toBe("connected");
  });

  it("keeps the list available when Composio is unreachable, leaving pending rows pending", async () => {
    const deps = await dependencies();
    await handleComposioRequest(post("initiate", { ventureId: VENTURE, toolkit: "square" }), "initiate", deps);
    (deps.composio!.getConnectedAccount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("composio down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleComposioRequest(list(VENTURE), "list", deps);
    expect(response.status).toBe(200);
    const rows = (await response.json() as { connections: Array<{ toolkit: string; status: string }> }).connections;
    expect(rows.find((row) => row.toolkit === "square")!.status).toBe("pending");
  });

  it("revokes at Composio first and only then marks the row revoked", async () => {
    const deps = await dependencies();
    await handleComposioRequest(post("initiate", { ventureId: VENTURE, toolkit: "gmail" }), "initiate", deps);
    const [connection] = await deps.storage.listConnections(WORKSPACE, VENTURE);

    const revoked = await handleComposioRequest(
      post("revoke", { ventureId: VENTURE, connectionId: connection!.id }),
      "revoke",
      deps
    );
    expect(revoked.status).toBe(200);
    expect(deps.composio!.revokeConnectedAccount).toHaveBeenCalledWith("ca_test_1");
    expect((await deps.storage.listConnections(WORKSPACE, VENTURE))[0]!.status).toBe("revoked");

    // A second revoke is an idempotent yes, not an error.
    const again = await handleComposioRequest(
      post("revoke", { ventureId: VENTURE, connectionId: connection!.id }),
      "revoke",
      deps
    );
    expect(again.status).toBe(200);
    expect(deps.composio!.revokeConnectedAccount).toHaveBeenCalledTimes(1);

    // If Composio refuses the revoke, the row must NOT be marked revoked — the customer would
    // believe access was cut while the token still lives.
    const failing = await dependencies({ composio: adapterStub({ revokeConnectedAccount: vi.fn(async () => { throw new Error("composio down"); }) }) });
    await handleComposioRequest(post("initiate", { ventureId: VENTURE, toolkit: "gmail" }), "initiate", failing);
    const [failingConnection] = await failing.storage.listConnections(WORKSPACE, VENTURE);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = await handleComposioRequest(
      post("revoke", { ventureId: VENTURE, connectionId: failingConnection!.id }),
      "revoke",
      failing
    );
    expect(refused.status).toBe(502);
    expect((await failing.storage.listConnections(WORKSPACE, VENTURE))[0]!.status).toBe("pending");
  });
});

describe("Composio adapter contract", () => {
  it("reuses an existing managed auth config instead of creating a duplicate", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: "ac_existing", toolkit: { slug: "gmail" }, is_composio_managed: true, auth_scheme: "OAUTH2" }]
    }), { status: 200 }));
    const adapter = new ComposioAdapter("key", fetchImpl as unknown as typeof fetch);
    const config = await adapter.ensureAuthConfig("gmail");
    expect(config.id).toBe("ac_existing");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("/api/v3/auth_configs");
  });

  it("initiates through connected_accounts/link and refuses a redirect off Composio's connect host", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://backend.composio.dev/api/v3/connected_accounts/link");
      return new Response(JSON.stringify({
        link_token: "lk_1",
        redirect_url: "https://evil.example/phish",
        connected_account_id: "ca_1"
      }), { status: 200 });
    });
    const adapter = new ComposioAdapter("key", fetchImpl as unknown as typeof fetch);
    await expect(adapter.initiateConnection({
      authConfigId: "ac_1",
      userId: VENTURE,
      callbackUrl: `${ORIGIN}/app`
    })).rejects.toThrow(/invalid hosted connect redirect/);
  });

  it("surfaces Composio's code and message for server logs and sends the API key only as a header", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("key");
      expect(String(init?.body ?? "")).not.toContain("key");
      return new Response(JSON.stringify({ error: { code: 600, slug: "ConnectedAccount_BadRequest", message: "no longer supported" } }), { status: 400 });
    });
    const adapter = new ComposioAdapter("key", fetchImpl as unknown as typeof fetch);
    await expect(adapter.getConnectedAccount("ca_1")).rejects.toThrow(/Composio API error 400.*no longer supported/);
  });
});

describe("connections die with the company", () => {
  it("revokes every live connection at delete time and still deletes when the provider is down", async () => {
    const storage = await storageWithCompany();
    const at = "2026-08-05T12:00:00.000Z";
    const rows: KernelConnection[] = [
      { workspaceId: WORKSPACE, companyId: VENTURE, id: "connection_live1", toolkit: "gmail", composioAccountId: "ca_live_1", composioAuthConfigId: "ac_1", status: "connected", createdAt: at, updatedAt: at },
      { workspaceId: WORKSPACE, companyId: VENTURE, id: "connection_gone1", toolkit: "slack", composioAccountId: "ca_gone_1", composioAuthConfigId: "ac_2", status: "revoked", createdAt: at, updatedAt: at }
    ];
    for (const row of rows) await storage.createConnection(row);

    const revoke = vi.fn(async (_accountId: string) => undefined);
    const autonomy = new CompanyAutonomy({
      storage,
      executor: new UnconfiguredCeoExecutor(),
      revokeExternalConnections: async (workspaceId, companyId) => {
        for (const connection of await storage.listConnections(workspaceId, companyId)) {
          if (connection.status !== "revoked") await revoke(connection.composioAccountId);
        }
      }
    });
    const result = await autonomy.delete(WORKSPACE, {
      ventureId: VENTURE,
      confirmVentureId: VENTURE,
      actor: "founder",
      requestedAt: at,
      idempotencyKey: "delete-1"
    } as never);
    expect(result.deleted).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("ca_live_1");

    // Provider unreachability must never block deletion: export/delete is a customer right.
    const storage2 = await storageWithCompany();
    await storage2.createConnection(rows[0]!);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = new CompanyAutonomy({
      storage: storage2,
      executor: new UnconfiguredCeoExecutor(),
      revokeExternalConnections: async () => { throw new Error("composio down"); }
    });
    const stillDeleted = await failing.delete(WORKSPACE, {
      ventureId: VENTURE,
      confirmVentureId: VENTURE,
      actor: "founder",
      requestedAt: at,
      idempotencyKey: "delete-2"
    } as never);
    expect(stillDeleted.deleted).toBe(true);
  });
});
