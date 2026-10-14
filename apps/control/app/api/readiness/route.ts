import { getCloudKernelStorage } from "../../../lib/kernel-storage";
import { readSupabaseServerConfig } from "../../../lib/supabase/config";
import { kernelVersion } from "../../../lib/kernel-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export async function GET(): Promise<Response> {
  try {
    readSupabaseServerConfig();
    await getCloudKernelStorage();
    return Response.json({
      ok: true,
      status: "ready",
      kernelVersion: kernelVersion()
    }, { headers });
  } catch {
    return Response.json({ ok: false, status: "not-ready" }, { status: 503, headers });
  }
}
