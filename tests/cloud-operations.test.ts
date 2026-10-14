import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GET as health } from "../apps/control/app/api/health/route.js";
import { GET as readiness } from "../apps/control/app/api/readiness/route.js";

afterEach(() => vi.unstubAllEnvs());

describe("Cloud operational boundaries", () => {
  test("reports process health without exposing configuration", async () => {
    vi.stubEnv("OPSPOT_KERNEL_VERSION", "test-kernel");
    const response = await health();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, status: "healthy", kernelVersion: "test-kernel" });
  });

  test("fails readiness closed when Cloud configuration is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("OPSPOT_APP_ORIGIN", "");
    vi.stubEnv("DATABASE_URL", "");
    const response = await readiness();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, status: "not-ready" });
  });

  test("sets the minimum browser security policy at the framework boundary", async () => {
    const config = await readFile("apps/control/next.config.mjs", "utf8");
    for (const header of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy"
    ]) expect(config).toContain(header);
    const csp = config.match(/key: "Content-Security-Policy", value: "([^"]+)"/)?.[1];
    expect(csp).toBe("default-src 'self'; base-uri 'self'; connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'unsafe-inline' https://us-assets.i.posthog.com; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests");
    expect([...new Set(csp?.match(/https:\/\/[^\s;]+/g) ?? [])].sort()).toEqual([
      "https://us-assets.i.posthog.com",
      "https://us.i.posthog.com"
    ]);
    expect(csp).not.toContain("*");
    expect(config).toContain("poweredByHeader: false");
  });
});
