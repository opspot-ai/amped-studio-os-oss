import { describe, expect, it } from "vitest";
import { SourceReferenceSchema } from "@amped-studio-os/contracts";
import { specialistCitations } from "@amped-studio-os/adapters";

const observedAt = "2026-07-20T03:30:00.000Z";

function fileSource(id: string, filePath: string) {
  return SourceReferenceSchema.parse({
    id,
    kind: "file",
    authority: "engine",
    path: filePath,
    observedAt,
    freshForHours: 24,
    confidence: 1,
    rights: "owned",
    description: `Source ${id}`
  });
}

function urlSource(id: string, url: string) {
  return SourceReferenceSchema.parse({
    id,
    kind: "url",
    authority: "public",
    url,
    observedAt,
    freshForHours: 24,
    confidence: 1,
    rights: "public",
    description: `Source ${id}`
  });
}

describe("specialist citation contracts", () => {
  it("accepts named local pack sources without inventing public URLs", () => {
    const sources = [fileSource("gtme_goal", "/engine/GTME-example-plan.md"), fileSource("gtme_status", "/engine/STATUS.md")];
    expect(
      specialistCitations(
        { ventureId: "venture_example_b", gateClass: "safe-internal-read-only", sourceRefs: sources.map((source) => source.id) },
        sources,
        { summary: "gtme_goal defines the destination; gtme_status preserves the current proof boundary." }
      )
    ).toEqual(["/engine/GTME-example-plan.md", "/engine/STATUS.md"]);
  });

  it("rejects external browsing and unnamed evidence in a local-only run", () => {
    const sources = [fileSource("gtme_goal", "/engine/GTME-example-plan.md"), fileSource("gtme_status", "/engine/STATUS.md")];
    expect(() =>
      specialistCitations(
        { ventureId: "venture_example_b", gateClass: "safe-internal-read-only", sourceRefs: sources.map((source) => source.id) },
        sources,
        { summary: "gtme_goal plus https://example.test" }
      )
    ).toThrow(/external URL/);
    expect(() =>
      specialistCitations(
        { ventureId: "venture_example_b", gateClass: "safe-internal-read-only", sourceRefs: sources.map((source) => source.id) },
        sources,
        { summary: "Only gtme_goal is named." }
      )
    ).toThrow(/fewer than two named/);
  });

  it("keeps the existing two-direct-URL requirement for public research", () => {
    const sources = [urlSource("public_home", "https://example.test")];
    const task = { ventureId: "venture_example_a", gateClass: "public-research-free" as const, sourceRefs: [sources[0]!.id] };
    expect(
      specialistCitations(task, sources, {
        summary: "Primary https://example.test supports the product; https://www.iana.org/domains/reserved supports the domain status."
      })
    ).toHaveLength(2);
    expect(() => specialistCitations(task, sources, { summary: "Only https://example.test is present." })).toThrow(/fewer than two direct/);
  });
});
