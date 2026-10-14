import { timingSafeEqual } from "node:crypto";

const workspaceIdPattern = /^workspace_[a-z0-9][a-z0-9_-]{0,149}$/;

export interface RunnableWorkspacePage {
  workspaceIds: string[];
  nextCursor?: string;
}

export interface CloudWorkerRouteDependencies {
  cronSecret?: string;
  /**
   * A second accepted Bearer value, held by the operator rather than injected by the platform
   * scheduler. Exists because the scheduler is a single point of failure for the whole product's
   * autonomy: on 2026-08-05 Vercel's cron simply stopped invoking the route, and the only
   * platform-held secret meant nobody could tick the worker. Either secret authorizes; both are
   * timing-safe; the route still fails closed when neither is configured.
   */
  operatorTickSecret?: string;
  listRunnableWorkspaceIds(input: { after?: string; limit: number }): Promise<RunnableWorkspacePage>;
  runWorkspaceOnce(workspaceId: string): Promise<Record<string, unknown> | null>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
      expires: "0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff"
    }
  });
}

function authorized(actual: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(actual ?? "", "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function handleCloudWorkerRequest(request: Request, dependencies: CloudWorkerRouteDependencies): Promise<Response> {
  if (request.method !== "GET") return json({ ok: false, error: { code: "method-not-allowed", message: "Cloud worker requires GET." } }, 405);
  const secrets = [dependencies.cronSecret, dependencies.operatorTickSecret].filter((secret): secret is string => Boolean(secret));
  if (secrets.length === 0) return json({ ok: false, error: { code: "cron-unavailable", message: "Cloud worker is unavailable." } }, 503);
  if (!secrets.some((secret) => authorized(request.headers.get("authorization"), secret))) {
    return json({ ok: false, error: { code: "cron-auth-required", message: "Cloud worker authorization failed." } }, 401);
  }
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 5 : Number(rawLimit);
  if ((cursor && !workspaceIdPattern.test(cursor)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    return json({ ok: false, error: { code: "invalid-worker-page", message: "Cloud worker page is invalid." } }, 400);
  }
  const page = await dependencies.listRunnableWorkspaceIds({ ...(cursor ? { after: cursor } : {}), limit });
  const results: Array<{ workspaceId: string; outcome: "processed" | "idle" | "failed"; result?: Record<string, unknown> }> = [];
  for (const workspaceId of page.workspaceIds) {
    try {
      const result = await dependencies.runWorkspaceOnce(workspaceId);
      results.push({ workspaceId, outcome: result ? "processed" : "idle", ...(result ? { result } : {}) });
    } catch (error) {
      // The response stays opaque, but the cause must reach the server logs: this exact catch hid
      // why a customer's cycle failed on 2026-08-05 (fourth silent catch found live this way).
      console.error(
        "worker-workspace-failed",
        workspaceId,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      );
      results.push({ workspaceId, outcome: "failed" });
    }
  }
  return json({ ok: true, processedWorkspaces: results.length, results, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
}
