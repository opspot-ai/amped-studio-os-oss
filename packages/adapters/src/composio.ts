/**
 * Composio v3 adapter for per-company Connections (GTM seam 05).
 *
 * PINNED API surface — verified live 2026-08-05 with real calls. Build against exactly this.
 * Base: https://backend.composio.dev
 * Auth header: x-api-key: <COMPOSIO_API_KEY>
 * Bodies: application/json
 *
 * 1. Ensure auth config (reuse before create):
 *    GET  /api/v3/auth_configs?limit=100
 *      → { items: [{ id: "ac_...", auth_scheme, is_composio_managed, toolkit?: { slug } | toolkit_slug?, ... }] }
 *    POST /api/v3/auth_configs
 *      body { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } }
 *      → { toolkit: { slug }, auth_config: { id: "ac_...", auth_scheme, is_composio_managed, ... } }
 *    Reuse by toolkit when a managed config already exists (e.g. gmail ac_hhwUlsssACwk).
 *
 * 2. Initiate hosted connection:
 *    POST /api/v3/connected_accounts/link
 *      body { auth_config_id, user_id, callback_url }
 *      → { link_token, redirect_url, expires_at, connected_account_id }
 *    Do NOT use plain POST /api/v3/connected_accounts for composio-managed OAuth (rejected).
 *
 * 3. Status:
 *    GET /api/v3/connected_accounts/{ca_id}
 *      → { id, status, user_id, toolkit: { slug }, ... }
 *    ACTIVE → connected; INITIALIZING|INITIATED → pending; FAILED|EXPIRED|other → failed.
 *
 * 4. Revoke:
 *    DELETE /api/v3/connected_accounts/{ca_id} → HTTP 200.
 *
 * The API key never reaches the client. Errors carry Composio's code/message for server logs only.
 */

const COMPOSIO_API = "https://backend.composio.dev";
const CONNECT_HOST = "connect.composio.dev";

export type ComposioConnectionStatus = "pending" | "connected" | "failed";

export type ComposioAuthConfig = {
  id: string;
  toolkitSlug: string;
  authScheme?: string;
  isComposioManaged?: boolean;
};

export type ComposioLinkSession = {
  linkToken: string;
  redirectUrl: string;
  expiresAt?: string;
  connectedAccountId: string;
};

export type ComposioConnectedAccount = {
  id: string;
  status: ComposioConnectionStatus;
  rawStatus: string;
  userId?: string;
  toolkitSlug?: string;
};

export type ComposioConfig = {
  apiKey: string;
};

/** Read COMPOSIO_API_KEY; routes treat absence as connections-unavailable (503). */
export function readComposioConfig(environment: NodeJS.ProcessEnv = process.env): ComposioConfig | undefined {
  const apiKey = environment.COMPOSIO_API_KEY?.trim();
  if (!apiKey) return undefined;
  return { apiKey };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolkitSlugFrom(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.slug === "string" && record.slug) return record.slug;
  if (typeof record.toolkit_slug === "string" && record.toolkit_slug) return record.toolkit_slug;
  const nested = asRecord(record.toolkit);
  if (nested && typeof nested.slug === "string" && nested.slug) return nested.slug;
  return undefined;
}

function mapComposioStatus(raw: string): ComposioConnectionStatus {
  const status = raw.trim().toUpperCase();
  if (status === "ACTIVE") return "connected";
  if (status === "INITIALIZING" || status === "INITIATED") return "pending";
  return "failed";
}

function isHttpsHostUrl(value: string, host: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export class ComposioAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async ensureAuthConfig(toolkitSlug: string): Promise<ComposioAuthConfig> {
    const slug = toolkitSlug.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slug)) throw new Error("invalid Composio toolkit slug");
    const existing = await this.listAuthConfigs();
    const match = existing.find((item) => item.toolkitSlug === slug && item.isComposioManaged !== false);
    if (match) return match;
    const body = await this.request<Record<string, unknown>>("POST", "/api/v3/auth_configs", {
      toolkit: { slug },
      auth_config: { type: "use_composio_managed_auth" }
    });
    const authConfig = asRecord(body.auth_config);
    const id = typeof authConfig?.id === "string" ? authConfig.id : typeof body.id === "string" ? body.id : undefined;
    if (!id || !id.startsWith("ac_")) throw new Error("Composio auth config response is missing id");
    return {
      id,
      toolkitSlug: toolkitSlugFrom(body) ?? toolkitSlugFrom(authConfig) ?? slug,
      ...(typeof authConfig?.auth_scheme === "string" ? { authScheme: authConfig.auth_scheme } : {}),
      isComposioManaged: authConfig?.is_composio_managed !== false
    };
  }

  async listAuthConfigs(): Promise<ComposioAuthConfig[]> {
    const body = await this.request<Record<string, unknown>>("GET", "/api/v3/auth_configs?limit=100");
    const items = Array.isArray(body.items) ? body.items : Array.isArray(body) ? body : [];
    return items.flatMap((item) => {
      const record = asRecord(item);
      if (!record) return [];
      const nested = asRecord(record.auth_config);
      const id = typeof record.id === "string" ? record.id
        : typeof nested?.id === "string" ? nested.id
          : undefined;
      if (!id || !id.startsWith("ac_")) return [];
      const slug = toolkitSlugFrom(record) ?? toolkitSlugFrom(nested);
      if (!slug) return [];
      const managed = record.is_composio_managed ?? nested?.is_composio_managed;
      return [{
        id,
        toolkitSlug: slug,
        ...(typeof (record.auth_scheme ?? nested?.auth_scheme) === "string"
          ? { authScheme: String(record.auth_scheme ?? nested?.auth_scheme) }
          : {}),
        ...(typeof managed === "boolean" ? { isComposioManaged: managed } : {})
      }];
    });
  }

  async initiateConnection(input: {
    authConfigId: string;
    userId: string;
    callbackUrl: string;
  }): Promise<ComposioLinkSession> {
    if (!input.authConfigId.startsWith("ac_")) throw new Error("invalid Composio auth config id");
    if (!input.userId.trim()) throw new Error("Composio user_id is required");
    try {
      // callback_url is our app origin; Composio hosts the OAuth, then sends the user back here.
      new URL(input.callbackUrl);
    } catch {
      throw new Error("Composio callback_url must be an absolute URL");
    }
    const body = await this.request<Record<string, unknown>>("POST", "/api/v3/connected_accounts/link", {
      auth_config_id: input.authConfigId,
      user_id: input.userId,
      callback_url: input.callbackUrl
    });
    const redirectUrl = typeof body.redirect_url === "string" ? body.redirect_url : undefined;
    const connectedAccountId = typeof body.connected_account_id === "string" ? body.connected_account_id : undefined;
    const linkToken = typeof body.link_token === "string" ? body.link_token : undefined;
    if (!redirectUrl || !isHttpsHostUrl(redirectUrl, CONNECT_HOST)) {
      throw new Error("Composio returned an invalid hosted connect redirect URL");
    }
    if (!connectedAccountId || !connectedAccountId.startsWith("ca_")) {
      throw new Error("Composio link response is missing connected_account_id");
    }
    if (!linkToken) throw new Error("Composio link response is missing link_token");
    return {
      linkToken,
      redirectUrl,
      connectedAccountId,
      ...(typeof body.expires_at === "string" ? { expiresAt: body.expires_at } : {})
    };
  }

  async getConnectedAccount(accountId: string): Promise<ComposioConnectedAccount> {
    if (!accountId.startsWith("ca_")) throw new Error("invalid Composio connected account id");
    const body = await this.request<Record<string, unknown>>(
      "GET",
      `/api/v3/connected_accounts/${encodeURIComponent(accountId)}`
    );
    const id = typeof body.id === "string" ? body.id : accountId;
    const rawStatus = typeof body.status === "string" ? body.status : "UNKNOWN";
    const toolkitSlug = toolkitSlugFrom(body);
    return {
      id,
      status: mapComposioStatus(rawStatus),
      rawStatus,
      ...(typeof body.user_id === "string" ? { userId: body.user_id } : {}),
      ...(toolkitSlug ? { toolkitSlug } : {})
    };
  }

  async revokeConnectedAccount(accountId: string): Promise<void> {
    if (!accountId.startsWith("ca_")) throw new Error("invalid Composio connected account id");
    await this.request<unknown>("DELETE", `/api/v3/connected_accounts/${encodeURIComponent(accountId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey.trim()) throw new Error("Composio API key is required");
    const response = await this.fetchImpl(`${COMPOSIO_API}${path}`, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Composio response is not JSON (${response.status})`);
      }
    }
    if (!response.ok) {
      const record = asRecord(parsed);
      const error = asRecord(record?.error) ?? record;
      const code = typeof error?.code === "string" ? error.code
        : typeof error?.error_code === "string" ? error.error_code
          : typeof record?.error_code === "string" ? record.error_code
            : undefined;
      const message = typeof error?.message === "string" ? error.message
        : typeof record?.message === "string" ? record.message
          : undefined;
      // Carry Composio's own code/message for server logs. Responses to the browser stay opaque.
      throw new Error(
        `Composio API error ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message.slice(0, 200)}` : ""}`
      );
    }
    return (parsed ?? {}) as T;
  }
}
