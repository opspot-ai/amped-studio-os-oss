import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultRuntime } from "@amped-studio-os/domain";
import type { CeoExecutor, CompanyDistributionMode } from "../packages/domain/src/autonomous.js";
import type { InitiativeExecutor } from "../packages/domain/src/initiative.js";

export async function tempRuntime(options: {
  fixtureBehavior?: "success" | "fail-once" | "timeout" | "blocked";
  ceoExecutor?: CeoExecutor;
  initiativeExecutor?: InitiativeExecutor;
  distributionMode?: CompanyDistributionMode;
  legacyDispatcher?: "fixture" | "hermes" | "default";
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cle-test-"));
  await cp(path.join(process.cwd(), "ventures"), path.join(directory, "ventures"), { recursive: true });
  const runtime = createDefaultRuntime({
    root: directory,
    databasePath: ":memory:",
    ...(options.legacyDispatcher === "default" ? {} : { dispatcher: options.legacyDispatcher ?? "fixture" }),
    ...(options.fixtureBehavior ? { fixtureBehavior: options.fixtureBehavior } : {}),
    ...(options.ceoExecutor ? { ceoExecutor: options.ceoExecutor } : {}),
    ...(options.initiativeExecutor ? { initiativeExecutor: options.initiativeExecutor } : {}),
    ...(options.distributionMode ? { distributionMode: options.distributionMode } : {}),
    fetchImpl: async (input) => new Response(`<html><title>${String(input)}</title></html>`, { status: 200 })
  });
  return {
    ...runtime,
    root: directory,
    async loadPacks() {
      for (const relative of ["ventures/example-a/pack.yaml", "ventures/example-b/pack.yaml", "ventures/example-c/pack.yaml"]) {
        const result = await runtime.service.execute("venture.create_or_update_pack", { packPath: path.join(directory, relative) });
        if (!result.ok) throw new Error(result.error?.message);
      }
    },
    async cleanup() {
      runtime.storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}
