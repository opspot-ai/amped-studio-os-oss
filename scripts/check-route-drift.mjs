#!/usr/bin/env node
/**
 * Route drift check: listed paths should resolve on the configured local server.
 * Does not invent routes. Compares live HTTP status against the frozen inventory.
 *
 *   BASE_URL=http://127.0.0.1:3210 node scripts/check-route-drift.mjs
 */
const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:3210").replace(/\/$/, "");

const ROUTES = [
  { path: "/", expect: [200] },
  { path: "/app", expect: [200] },
  { path: "/login", expect: [200] },
  { path: "/signup", expect: [200] },
  { path: "/pricing", expect: [200] },
  { path: "/proof", expect: [200] },
  { path: "/privacy", expect: [200] },
  { path: "/terms", expect: [200] },
  { path: "/support", expect: [200] },
  { path: "/security", expect: [200] },
  { path: "/reset-password", expect: [200] }
];

async function main() {
  const results = [];
  for (const route of ROUTES) {
    const url = `${baseUrl}${route.path}`;
    try {
      const response = await fetch(url, { redirect: "manual" });
      const ok = route.expect.includes(response.status);
      results.push({ path: route.path, status: response.status, ok });
      console.log(`${ok ? "ok  " : "FAIL"} ${response.status} ${route.path}`);
    } catch (error) {
      results.push({ path: route.path, status: null, ok: false, error: String(error) });
      console.log(`FAIL ERR ${route.path} ${error}`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`RESULT: ${failed.length} route drift failure(s).`);
    process.exit(1);
  }
  console.log(`RESULT: ${results.length} routes match inventory.`);
}

main();
