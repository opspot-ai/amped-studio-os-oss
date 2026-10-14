import {
  canonicalize,
  type EvidenceItem,
  type EvidenceStatus
} from "@amped-studio-os/contracts";

type EvidenceAuthority = EvidenceItem["authority"];

type EvidenceTypePolicy = Readonly<{
  requiredAuthority: EvidenceAuthority | undefined;
  claimKey: ((item: EvidenceItem) => unknown | undefined) | undefined;
}>;

export const EVIDENCE_TYPE_POLICY_REGISTRY = Object.freeze({
  "authoritative-payment-collected": Object.freeze({
    requiredAuthority: "payment",
    claimKey: undefined
  }),
  "authoritative-fulfillment-delivered": Object.freeze({
    requiredAuthority: "fulfillment",
    claimKey: undefined
  }),
  "initiative-internal-artifact": Object.freeze({
    requiredAuthority: undefined,
    claimKey: (item: EvidenceItem) => {
      const capabilityId = item.metadata.capabilityId;
      return typeof capabilityId === "string" && capabilityId.trim().length > 0
        ? capabilityId
        : undefined;
    }
  })
} satisfies Readonly<Record<string, EvidenceTypePolicy>>);

type EvidenceStatusBehavior =
  | "accept"
  | "reject"
  | `reject:${Exclude<EvidenceStatus, "current">}`;

const REJECT_NON_CURRENT = Object.freeze({
  current: "accept",
  stale: "reject",
  conflicting: "reject",
  superseded: "reject",
  unavailable: "reject"
} satisfies Record<EvidenceStatus, EvidenceStatusBehavior>);

const SURFACE_RESOLVED_STATUS = Object.freeze({
  current: "accept",
  stale: "reject:stale",
  conflicting: "reject:conflicting",
  superseded: "reject:superseded",
  unavailable: "reject:unavailable"
} satisfies Record<EvidenceStatus, EvidenceStatusBehavior>);

type EvidenceConsumerPolicy = Readonly<{
  source: string;
  statuses: Readonly<Record<EvidenceStatus, EvidenceStatusBehavior>>;
}>;

/**
 * Executable census of every EvidenceItem.status decision in the domain package.
 * Consumers must route through this matrix so sibling reads cannot silently retain
 * stored `current` while another read uses derived contradiction/supersession state.
 */
export const EVIDENCE_STATUS_CONSUMER_MATRIX = Object.freeze({
  "evaluation-contract-population": Object.freeze({
    source: "packages/domain/src/index.ts#freezeEvaluationContract",
    statuses: REJECT_NON_CURRENT
  }),
  "evaluation-case-materialization": Object.freeze({
    source: "packages/domain/src/index.ts#resolveEvaluationCase",
    statuses: REJECT_NON_CURRENT
  }),
  "experiment-hard-gate-proof": Object.freeze({
    source: "packages/domain/src/index.ts#recordExperiment",
    statuses: REJECT_NON_CURRENT
  }),
  "promotion-evidence": Object.freeze({
    source: "packages/domain/src/index.ts#promoteSkill",
    statuses: REJECT_NON_CURRENT
  }),
  "stored-hard-gate-proof": Object.freeze({
    source: "packages/domain/src/index.ts#assertStoredExperimentPromotable",
    statuses: REJECT_NON_CURRENT
  }),
  "scorecard-revenue": Object.freeze({
    source: "packages/domain/src/index.ts#scorecard",
    statuses: REJECT_NON_CURRENT
  }),
  "lifecycle-transition": Object.freeze({
    source: "packages/domain/src/index.ts#evaluateTransition",
    statuses: SURFACE_RESOLVED_STATUS
  }),
  "fulfillment-predicate": Object.freeze({
    source: "packages/domain/src/capabilities.ts#isPaymentBoundAuthoritativeFulfillmentEvidence",
    statuses: REJECT_NON_CURRENT
  }),
  "capability-prerequisite": Object.freeze({
    source: "packages/domain/src/capabilities.ts#evidenceSatisfiesCapabilityPrerequisite",
    statuses: REJECT_NON_CURRENT
  }),
  "public-asset-source": Object.freeze({
    source: "packages/domain/src/golden-provider.ts#publicAssetSource",
    statuses: REJECT_NON_CURRENT
  }),
  "provider-control": Object.freeze({
    source: "packages/domain/src/golden-provider.ts#providerControl",
    statuses: REJECT_NON_CURRENT
  }),
  "material-evidence-projection": Object.freeze({
    source: "packages/domain/src/autonomous.ts#materialEvidenceProjection",
    statuses: REJECT_NON_CURRENT
  })
} satisfies Record<string, EvidenceConsumerPolicy>);

export type EvidenceStatusConsumer = keyof typeof EVIDENCE_STATUS_CONSUMER_MATRIX;

export function evidenceAuthoritySatisfiesType(item: EvidenceItem): boolean {
  const policy = EVIDENCE_TYPE_POLICY_REGISTRY[item.type as keyof typeof EVIDENCE_TYPE_POLICY_REGISTRY];
  const required = policy?.requiredAuthority;
  return required === undefined || item.authority === required;
}

function trustTier(authority: EvidenceAuthority): 0 | 1 | 2 {
  if (authority === "fixture") return 0;
  if (authority === "engine") return 1;
  return 2;
}

function isOtherwiseValid(item: EvidenceItem, now: number): boolean {
  return item.status === "current"
    && (item.expiresAt === undefined || Date.parse(item.expiresAt) > now);
}

type EvidenceClaimIdentity =
  | Readonly<{ kind: "unregistered" }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "registered"; key: string }>;

function evidenceClaimIdentity(item: EvidenceItem): EvidenceClaimIdentity {
  const policy = EVIDENCE_TYPE_POLICY_REGISTRY[item.type as keyof typeof EVIDENCE_TYPE_POLICY_REGISTRY];
  if (!policy?.claimKey) return { kind: "unregistered" };
  const value = policy.claimKey(item);
  return value === undefined
    ? { kind: "malformed" }
    : { kind: "registered", key: canonicalize(value) };
}

function isSameClaim(left: EvidenceItem, right: EvidenceItem): boolean {
  if (left.ventureId !== right.ventureId || left.type !== right.type) return false;
  const leftIdentity = evidenceClaimIdentity(left);
  const rightIdentity = evidenceClaimIdentity(right);
  return leftIdentity.kind === "registered"
    && rightIdentity.kind === "registered"
    && leftIdentity.key === rightIdentity.key;
}

function supersedes(candidate: EvidenceItem, prior: EvidenceItem, now: number): boolean {
  return isSameClaim(candidate, prior)
    && isOtherwiseValid(candidate, now)
    && evidenceAuthoritySatisfiesType(candidate)
    && trustTier(candidate.authority) >= trustTier(prior.authority)
    && Date.parse(candidate.observedAt) > Date.parse(prior.observedAt);
}

function stableEvidenceOrder(left: EvidenceItem, right: EvidenceItem): number {
  return canonicalize(left).localeCompare(canonicalize(right));
}

export function resolveEvidenceStatuses(items: readonly EvidenceItem[], now: number): EvidenceItem[] {
  const resolved = items.map((item, index) => {
    if (evidenceClaimIdentity(item).kind === "malformed") {
      return { ...item, status: "unavailable" as const };
    }
    if (item.status !== "current") return { ...item };

    const superseded = items.some((candidate, candidateIndex) =>
      candidateIndex !== index && supersedes(candidate, item, now)
    );
    if (superseded) return { ...item, status: "superseded" as const };

    const conflicting = isOtherwiseValid(item, now) && items.some((candidate, candidateIndex) =>
      candidateIndex !== index
      && isSameClaim(candidate, item)
      && candidate.contentHash !== item.contentHash
      && isOtherwiseValid(candidate, now)
      && !supersedes(candidate, item, now)
      && !supersedes(item, candidate, now)
    );
    return conflicting ? { ...item, status: "conflicting" as const } : { ...item };
  });

  return resolved.sort(stableEvidenceOrder);
}

export function resolveEvidenceForConsumer(
  consumer: EvidenceStatusConsumer,
  items: readonly EvidenceItem[],
  now: number
): EvidenceItem[] {
  void EVIDENCE_STATUS_CONSUMER_MATRIX[consumer];
  return resolveEvidenceStatuses(items, now);
}

export function evidenceStatusBehaviorForConsumer(
  consumer: EvidenceStatusConsumer,
  status: EvidenceStatus
): EvidenceStatusBehavior {
  return EVIDENCE_STATUS_CONSUMER_MATRIX[consumer].statuses[status];
}

export function evidenceStatusAcceptedForConsumer(
  consumer: EvidenceStatusConsumer,
  status: EvidenceStatus
): boolean {
  return evidenceStatusBehaviorForConsumer(consumer, status) === "accept";
}

export function evidenceStatusRejectionForConsumer(
  consumer: EvidenceStatusConsumer,
  status: EvidenceStatus
): string | undefined {
  const behavior = evidenceStatusBehaviorForConsumer(consumer, status);
  if (behavior === "accept") return undefined;
  return behavior === "reject" ? "not current" : behavior.slice("reject:".length);
}
