import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  serverExternalPackages: ["node:sqlite"],
  transpilePackages: ["@amped-studio-os/contracts", "@amped-studio-os/packs", "@amped-studio-os/policy", "@amped-studio-os/storage", "@amped-studio-os/dispatch", "@amped-studio-os/adapters", "@amped-studio-os/domain"],
  // The Studio SPA is built into `public/studio` so it shares this origin, which is what lets its
  // relative `/api/*` calls carry the auth cookie. Next serves `public/studio/index.html` only at
  // that exact path, so `/studio` and `/studio/` need an explicit rewrite.
  async rewrites() {
    return [
      { source: "/studio", destination: "/studio/index.html" },
      { source: "/studio/", destination: "/studio/index.html" }
    ];
  },
  async headers() {
    // PostHog is the only third party the CSP admits: its loader in script-src, its ingest and
    // asset hosts in connect-src. Named hosts, not a wildcard, so adding a second vendor stays a
    // deliberate edit here rather than a silent ride-along. Google auth adds no host here: the
    // fetch is same-origin under connect-src 'self', then Supabase and Google are full-page
    // navigations, not form-action or connect-src requests. Found the hard way: with 'self' alone
    // the PostHog snippet runs, array.js is refused, and every capture queues forever with no error
    // anywhere but the browser console.
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "default-src 'self'; base-uri 'self'; connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'unsafe-inline' https://us-assets.i.posthog.com; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=()" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" }
      ]
    }];
  }
};

export default nextConfig;
