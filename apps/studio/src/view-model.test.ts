import { describe, expect, it } from "vitest";
import { graphStateLabel, lifecycleStage } from "./view-model";

describe("studio view model", () => {
  it("keeps backend lifecycle and graph states literal", () => {
    expect(lifecycleStage("candidate")).toBe("Ideation");
    expect(lifecycleStage("offer-ready")).toBe("Validation");
    expect(lifecycleStage("launch-ready")).toBe("Build");
    expect(lifecycleStage("externally-live")).toBe("Launch & Grow");
    expect(graphStateLabel()).toBe("Not started");
    expect(graphStateLabel({ state: "waiting-human" } as never)).toBe("Waiting for approval");
    expect(graphStateLabel({ state: "waiting-reconciliation" } as never)).toBe("Waiting for reconciliation");
  });
});
