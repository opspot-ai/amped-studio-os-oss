import path from "node:path";
import { describe, expect, it } from "vitest";
import { VenturePackSchema, canonicalize, sha256 } from "@amped-studio-os/contracts";
import { loadPack, migratePack, venturePackJsonSchema } from "@amped-studio-os/packs";

describe("Venture Pack contracts", () => {
  it("loads and deterministically hashes two synthetic packs", async () => {
    const root = path.join(process.cwd(), "ventures");
    const exampleA = await loadPack(path.join(root, "example-a", "pack.yaml"), root);
    const exampleC = await loadPack(path.join(root, "example-c", "pack.yaml"), root);
    expect(VenturePackSchema.parse(exampleA.pack).venture.id).toBe("venture_example_a");
    expect(VenturePackSchema.parse(exampleC.pack).venture.id).toBe("venture_example_c");
    expect(exampleA.canonicalHash).toBe(sha256(canonicalize(exampleA.pack)));
    expect(exampleC.canonicalHash).not.toBe(exampleA.canonicalHash);
  });

  it("exports JSON Schema and migrates the supported prior version", async () => {
    const root = path.join(process.cwd(), "ventures");
    const loaded = await loadPack(path.join(root, "example-a", "pack.yaml"), root);
    const old = structuredClone(loaded.pack) as any;
    old.schemaVersion = "0.9.0";
    delete old.policy.dataRetention;
    const migrated = migratePack(old);
    expect(migrated.migratedFrom).toBe("0.9.0");
    expect(VenturePackSchema.parse(migrated.value).schemaVersion).toBe("1.0.0");
    const schema = venturePackJsonSchema();
    expect(schema).toHaveProperty("$schema");
  });

  it("rejects unknown sources and dishonest missing values", async () => {
    const root = path.join(process.cwd(), "ventures");
    const loaded = await loadPack(path.join(root, "example-a", "pack.yaml"), root);
    const bad = structuredClone(loaded.pack) as any;
    bad.assertions.buyer.problem.sourceRefs = ["source_does_not_exist"];
    bad.assertions.payment.authoritative_payment_event.value = "fake payment";
    expect(VenturePackSchema.safeParse(bad).success).toBe(false);
  });
});
