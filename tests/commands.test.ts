import { describe, expect, it } from "vitest";
import { CommandInputSchemas, CommandNameSchema } from "@amped-studio-os/contracts";
import { tempRuntime } from "./helpers.js";

describe("canonical command service", () => {
  it("exposes the required CLI/MCP command contract", () => {
    expect(CommandNameSchema.options).toEqual(
      expect.arrayContaining([
        "venture.create_or_update_pack",
        "venture.get",
        "venture.readiness",
        "venture.request_transition",
        "play.propose",
        "task.plan",
        "task.run_safe",
        "task.get",
        "approval.list_pending",
        "amped.start",
        "amped.get",
        "amped.replay",
        "amped.shadow",
        "receipt.attach",
        "evaluation.baseline.capture",
        "evaluation.tasks.plan",
        "experiment.record",
        "portfolio.scorecard"
      ])
    );
    for (const name of CommandNameSchema.options) expect(CommandInputSchemas[name]).toBeDefined();
  });

  it("persists real controls and reports literal proof tiers", async () => {
    const runtime = await tempRuntime();
    try {
      await runtime.loadPacks();
      const proposal = await runtime.service.execute("play.propose", { ventureId: "venture_example_c" });
      expect(proposal.ok).toBe(true);
      expect((proposal.data as any).selectionMode).toBe("deterministic-eligibility");
      expect((proposal.data as any).reason).toContain("value is not evaluated");
      expect((proposal.data as any).reason).not.toContain("highest-value");
      const unknownPlay = await runtime.service.execute("task.plan", { ventureId: "venture_example_c", playId: "play_missing" });
      expect(unknownPlay.ok).toBe(false);
      expect(unknownPlay.error?.code).toBe("play-not-found");
      const plan = await runtime.service.execute("task.plan", { ventureId: "venture_example_c" });
      expect((plan.data as any).status).toBe("ready");
      const queue = await runtime.service.execute("task.run_safe", { ventureId: "venture_example_c", taskId: (plan.data as any).task.id });
      expect((queue.data as any).status).toBe("queued");
      const scorecard = await runtime.service.execute("portfolio.scorecard", {});
      expect((scorecard.data as any).proofVocabulary).toEqual([
        "scaffolded",
        "fixture-verified",
        "internally-live",
        "externally-live",
        "revenue-verified",
        "fulfillment-verified",
        "blocked"
      ]);
      expect((scorecard.data as any).ventures.find((item: any) => item.ventureId === "venture_example_c").verifiedRevenue).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });
});
