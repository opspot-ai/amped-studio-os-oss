import { kernelVersion } from "../../../lib/kernel-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    status: "healthy",
    kernelVersion: kernelVersion()
  }, { headers });
}
