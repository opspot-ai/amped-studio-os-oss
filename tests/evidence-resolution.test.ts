import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EvidenceItemSchema,
  sha256,
  type EvidenceItem,
  type EvidenceStatus
} from "@amped-studio-os/contracts";
import {
  evidenceAuthoritySatisfiesType,
  EVIDENCE_STATUS_CONSUMER_MATRIX,
  evidenceStatusAcceptedForConsumer,
  evidenceStatusBehaviorForConsumer,
  evidenceStatusRejectionForConsumer,
  resolveEvidenceStatuses
} from "@amped-studio-os/domain";

const NOW = Date.parse("2026-08-19T18:45:00.000Z");
const OBSERVED = "2026-08-19T18:00:00.000Z";

function evidence(id: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return EvidenceItemSchema.parse({
    id,
    ventureId: "venture_ops385",
    type: "initiative-internal-artifact",
    proofTier: "internally-live",
    authority: "company",
    sourceRef: `source_${id}`,
    observedAt: OBSERVED,
    status: "current",
    contentHash: sha256(id),
    metadata: { capabilityId: "market-problem-research" },
    ...overrides
  });
}

function byId(items: readonly EvidenceItem[]): Record<string, EvidenceStatus> {
  return Object.fromEntries(items.map((item) => [item.id, item.status]));
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  );
}

describe("resolveEvidenceStatuses", () => {
  it("marks equal-time contradictory claims symmetrically", () => {
    const left = evidence("evidence_left");
    const right = evidence("evidence_right");

    expect(byId(resolveEvidenceStatuses([left, right], NOW))).toEqual({
      evidence_left: "conflicting",
      evidence_right: "conflicting"
    });
  });

  it("lets a newer equally trusted item with the same claim key supersede the prior claim", () => {
    const prior = evidence("evidence_prior", { authority: "engine" });
    const current = evidence("evidence_current", {
      authority: "public",
      observedAt: "2026-08-19T18:30:00.000Z"
    });

    expect(byId(resolveEvidenceStatuses([prior, current], NOW))).toEqual({
      evidence_current: "current",
      evidence_prior: "superseded"
    });
  });

  it("never lets a lower trust tier supersede a higher trust tier", () => {
    const trusted = evidence("evidence_trusted", { authority: "customer" });
    const fixture = evidence("evidence_fixture", {
      authority: "fixture",
      observedAt: "2026-08-19T18:30:00.000Z"
    });

    expect(byId(resolveEvidenceStatuses([trusted, fixture], NOW))).toEqual({
      evidence_fixture: "conflicting",
      evidence_trusted: "conflicting"
    });
  });

  it("uses domain compatibility instead of a total authority ranking", () => {
    const prior = evidence("evidence_external_prior", { authority: "fulfillment" });
    const current = evidence("evidence_external_current", {
      authority: "product",
      observedAt: "2026-08-19T18:30:00.000Z"
    });

    expect(byId(resolveEvidenceStatuses([prior, current], NOW))).toEqual({
      evidence_external_current: "current",
      evidence_external_prior: "superseded"
    });
  });

  it("requires the superseding authority to satisfy the evidence type", () => {
    const payment = evidence("evidence_payment", {
      type: "authoritative-payment-collected",
      authority: "payment"
    });
    const customer = evidence("evidence_customer", {
      type: "authoritative-payment-collected",
      authority: "customer",
      observedAt: "2026-08-19T18:30:00.000Z"
    });

    expect(evidenceAuthoritySatisfiesType(payment)).toBe(true);
    expect(evidenceAuthoritySatisfiesType(customer)).toBe(false);
  });

  it("does not group unregistered evidence types", () => {
    const left = evidence("evidence_unregistered_left", { type: "buyer-validation" });
    const right = evidence("evidence_unregistered_right", {
      type: "buyer-validation",
      observedAt: "2026-08-19T18:30:00.000Z"
    });

    expect(byId(resolveEvidenceStatuses([left, right], NOW))).toEqual({
      evidence_unregistered_left: "current",
      evidence_unregistered_right: "current"
    });
  });

  it("does not group different claim keys within a registered evidence type", () => {
    const asset = evidence("evidence_asset", {
      metadata: { capabilityId: "minimum-sellable-asset" }
    });
    const positioning = evidence("evidence_positioning", {
      metadata: { capabilityId: "icp-offer-positioning-pricing" }
    });

    expect(byId(resolveEvidenceStatuses([asset, positioning], NOW))).toEqual({
      evidence_asset: "current",
      evidence_positioning: "current"
    });
  });

  it("fails closed when registered evidence has a missing or unusable claim key", () => {
    const invalidKeys = [
      { label: "missing", metadata: {} },
      { label: "non_string", metadata: { capabilityId: 42 } },
      { label: "empty", metadata: { capabilityId: "   " } }
    ];
    for (const { label, metadata } of invalidKeys) {
      const left = evidence(`evidence_keyless_left_${label}`, { metadata });
      const right = evidence(`evidence_keyless_right_${label}`, {
        metadata,
        observedAt: "2026-08-19T18:30:00.000Z"
      });

      expect(resolveEvidenceStatuses([left, right], NOW).every((item) => item.status === "unavailable")).toBe(true);
    }
  });

  it("does not treat equal content hashes as contradictory", () => {
    const left = evidence("evidence_same_left", { contentHash: sha256("same") });
    const right = evidence("evidence_same_right", { contentHash: sha256("same") });

    expect(byId(resolveEvidenceStatuses([left, right], NOW))).toEqual({
      evidence_same_left: "current",
      evidence_same_right: "current"
    });
  });

  it("preserves the previously passing single-current path", () => {
    expect(resolveEvidenceStatuses([evidence("evidence_single")], NOW)[0]?.status).toBe("current");
  });

  it("is monotone downward for every stored non-current status", () => {
    const statuses = ["stale", "conflicting", "superseded", "unavailable"] as const;
    const inputs = statuses.map((status) => evidence(`evidence_${status}`, { status }));

    expect(resolveEvidenceStatuses(inputs, NOW).map((item) => item.status).sort()).toEqual([...statuses].sort());
  });

  it("does not depend on a stored supersession pointer", () => {
    const pointed = {
      ...evidence("evidence_pointer_ignored"),
      supersededBy: "evidence_absent"
    } as EvidenceItem;

    expect(resolveEvidenceStatuses([pointed], NOW)[0]?.status).toBe("current");
  });

  it("returns identical output for every arrival-order permutation", () => {
    const input = [
      evidence("evidence_old", { authority: "engine" }),
      evidence("evidence_new_a", { authority: "public", observedAt: "2026-08-19T18:30:00.000Z" }),
      evidence("evidence_new_b", { authority: "customer", observedAt: "2026-08-19T18:30:00.000Z" }),
      evidence("evidence_other_key", {
        metadata: { capabilityId: "minimum-sellable-asset" },
        observedAt: "2026-08-19T18:45:00.000Z"
      })
    ];
    const expected = resolveEvidenceStatuses(input, NOW);
    expect(byId(expected).evidence_other_key).toBe("current");

    for (const arrivalOrder of permutations(input)) {
      expect(resolveEvidenceStatuses(arrivalOrder, NOW)).toEqual(expected);
    }
  });
});

describe("EvidenceItem status consumer matrix", () => {
  const expectedConsumers = [
    "evaluation-contract-population",
    "evaluation-case-materialization",
    "experiment-hard-gate-proof",
    "promotion-evidence",
    "stored-hard-gate-proof",
    "scorecard-revenue",
    "lifecycle-transition",
    "fulfillment-predicate",
    "capability-prerequisite",
    "public-asset-source",
    "provider-control",
    "material-evidence-projection"
  ];

  it("enumerates the exact twelve-site base census", () => {
    expect(Object.keys(EVIDENCE_STATUS_CONSUMER_MATRIX)).toEqual(expectedConsumers);
  });

  it("keeps every consumer fail-closed while surfacing conflicting and superseded distinctly", () => {
    for (const consumer of expectedConsumers) {
      const typedConsumer = consumer as keyof typeof EVIDENCE_STATUS_CONSUMER_MATRIX;
      expect(evidenceStatusAcceptedForConsumer(typedConsumer, "current")).toBe(true);
      for (const status of ["stale", "conflicting", "superseded", "unavailable"] as const) {
        expect(evidenceStatusAcceptedForConsumer(typedConsumer, status)).toBe(false);
      }
    }

    expect(evidenceStatusBehaviorForConsumer("lifecycle-transition", "conflicting"))
      .not.toBe(evidenceStatusBehaviorForConsumer("lifecycle-transition", "superseded"));
    expect(evidenceStatusRejectionForConsumer("lifecycle-transition", "conflicting")).toBe("conflicting");
    expect(evidenceStatusRejectionForConsumer("lifecycle-transition", "superseded")).toBe("superseded");
  });

  it("binds every matrix entry to executable source and leaves only SourceHealth literal comparisons", () => {
    for (const [consumer, policy] of Object.entries(EVIDENCE_STATUS_CONSUMER_MATRIX)) {
      const sourceFile = policy.source.split("#")[0]!;
      expect(readFileSync(sourceFile, "utf8"), `${consumer} is not routed in ${sourceFile}`)
        .toContain(`"${consumer}"`);
    }

    const indexSource = readFileSync("packages/domain/src/index.ts", "utf8");
    const siblingSources = [
      "packages/domain/src/capabilities.ts",
      "packages/domain/src/golden-provider.ts",
      "packages/domain/src/autonomous.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    const literalStatusComparisons = /\.status\s*(?:===|!==)\s*"current"/g;
    expect(indexSource.match(literalStatusComparisons)).toHaveLength(3);
    expect(siblingSources.match(literalStatusComparisons) ?? []).toHaveLength(0);
  });
});
