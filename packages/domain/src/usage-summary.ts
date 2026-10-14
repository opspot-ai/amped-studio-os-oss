import {
  CeoCycleSchema,
  UsageSummarySchema,
  type UsageSummary,
  type UsageUnattributedReason
} from "@amped-studio-os/contracts";

/**
 * One raw `ceo-cycle-completed` row as the kernel stored it, before anything is trusted about it.
 *
 * `payload` stays `unknown` on purpose. The legacy detail read omits malformed completion rows, while
 * this summary must retain each one as an unattributed fact instead of showing nothing.
 */
export interface UsageLedgerEvent {
  companyId: string;
  payload: unknown;
  occurredAt: string;
}

export interface UsageLedgerCompany {
  ventureId: string;
  name: string;
}

export interface UsageSummaryRequest {
  companies: readonly UsageLedgerCompany[];
  events: readonly UsageLedgerEvent[];
  windowDays: number;
  readAt: string;
  ventureId?: string;
}

const REASON_EXPLANATIONS: Record<UsageUnattributedReason, string> = {
  "unreadable-record": "The runtime wrote a work record this view could not read, so its work is counted as unknown rather than as nothing.",
  "company-mismatch": "The record named a different company than the one it was filed under, so it is not attributed to either.",
  "conflicting-duplicate": "Two records shared one identity but described different work, so only the first was counted and the second is reported here."
};

const DEFERRED_NOTES = [
  "This view measures what the runtime did. Customer-defined value is deliberately not part of this view yet."
];

function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Read the CEO cycle ledger into the customer-facing usage view.
 *
 * Pure by design: it takes rows and returns the parsed summary, so every counting rule below is
 * testable without a database, an external connector, or a clock.
 *
 * What is deliberately NOT computed here:
 *
 * - `sequence` is a per-company running counter. Summing a running counter is exactly how a phase 1
 *   meter overstated volume 3.4x, so it is never added to anything.
 * - `evidenceIds` is a cumulative snapshot of the company's whole evidence set at cycle time
 *   (`autonomous.ts` builds it from `listEvidence`, not from what the cycle produced). Summing it
 *   across cycles would count the same evidence once per cycle, so this view does not report an
 *   evidence count at all.
 * - Inference-supply and internal-accounting fields never leave this function. They are operating
 *   detail, not customer truth.
 */
export function summarizeUsageLedger(request: UsageSummaryRequest): UsageSummary {
  const untilMs = Date.parse(request.readAt);
  if (!Number.isFinite(untilMs)) throw new Error("usage summary needs a real read time");
  const sinceMs = untilMs - request.windowDays * 24 * 60 * 60_000;

  const companies = request.ventureId
    ? request.companies.filter((company) => company.ventureId === request.ventureId)
    : [...request.companies];

  const inScope = new Set(companies.map((company) => company.ventureId));
  const recordsFound = new Map<string, number>();
  const unattributedByCompany = new Map<string, number>();
  const cyclesByCompany = new Map<string, number>();
  const cyclesByDay = new Map<string, number>();
  const reasonCounts = new Map<UsageUnattributedReason, number>();
  const seen = new Map<string, string>();
  const selectedInitiatives = new Set<string>();
  const distinctTasks = new Set<string>();
  const distinctReceipts = new Set<string>();

  let duplicatesIgnored = 0;
  let countedInWindow = 0;
  let outsideWindow = 0;
  let couldNotAttribute = 0;
  let taskReferences = 0;
  let receiptReferences = 0;
  const byOutcome = { selected: 0, abstained: 0, killed: 0 };
  const proof = { verified: 0, inconclusive: 0, failed: 0 };

  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  // Entity ids are venture-scoped in durable storage. Bind every distinct reference to the company
  // that owns it so a workspace-wide read cannot collapse equal ids from two companies and flatter
  // the view with an undercount.
  const scopedReference = (companyId: string, entityId: string) => JSON.stringify([companyId, entityId]);
  const reject = (companyId: string, reason: UsageUnattributedReason) => {
    couldNotAttribute += 1;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    bump(unattributedByCompany, companyId);
  };

  for (const event of request.events) {
    if (!inScope.has(event.companyId)) continue;
    bump(recordsFound, event.companyId);

    const parsed = CeoCycleSchema.safeParse(event.payload);
    if (!parsed.success) {
      reject(event.companyId, "unreadable-record");
      continue;
    }
    const cycle = parsed.data;
    if (cycle.ventureId !== event.companyId) {
      reject(event.companyId, "company-mismatch");
      continue;
    }

    // Contract law 1: dedup on the record's own idempotency key before counting anything. A replayed
    // append that carries the identical canonical hash is the same work seen twice; a shared key
    // over different content is a collision this view refuses to silently pick a winner for.
    const previous = seen.get(cycle.idempotencyKey);
    if (previous !== undefined) {
      if (previous === cycle.canonicalHash) duplicatesIgnored += 1;
      else reject(event.companyId, "conflicting-duplicate");
      continue;
    }
    seen.set(cycle.idempotencyKey, cycle.canonicalHash);

    const completedMs = Date.parse(cycle.completedAt);
    if (completedMs < sinceMs || completedMs > untilMs) {
      outsideWindow += 1;
      continue;
    }

    countedInWindow += 1;
    byOutcome[cycle.outcome] += 1;
    proof[cycle.verification.status] += 1;
    bump(cyclesByCompany, event.companyId);
    bump(cyclesByDay, utcDay(cycle.completedAt));
    if (cycle.selectedCandidateId) selectedInitiatives.add(scopedReference(event.companyId, cycle.selectedCandidateId));
    taskReferences += cycle.plannedTaskIds.length;
    for (const taskId of cycle.plannedTaskIds) distinctTasks.add(scopedReference(event.companyId, taskId));
    receiptReferences += cycle.receiptIds.length;
    for (const receiptId of cycle.receiptIds) distinctReceipts.add(scopedReference(event.companyId, receiptId));
  }

  const totalRecords = [...recordsFound.values()].reduce((total, count) => total + count, 0);

  return UsageSummarySchema.parse({
    schema: "gtm-usage-summary-v1",
    readAt: request.readAt,
    window: {
      days: request.windowDays,
      since: new Date(sinceMs).toISOString(),
      until: request.readAt,
      timezone: "UTC"
    },
    scope: {
      ...(request.ventureId ? { ventureId: request.ventureId } : {}),
      companiesRead: companies.length
    },
    measured: totalRecords > 0,
    ledger: { recordsFound: totalRecords, duplicatesIgnored, countedInWindow, outsideWindow, couldNotAttribute },
    work: {
      cycles: countedInWindow,
      byOutcome,
      initiativesSelected: selectedInitiatives.size,
      tasksPlanned: distinctTasks.size,
      taskReferences,
      repeatedTaskReferences: taskReferences - distinctTasks.size,
      receiptsAttached: distinctReceipts.size,
      receiptReferences,
      repeatedReceiptReferences: receiptReferences - distinctReceipts.size
    },
    proof,
    byCompany: companies.map((company) => ({
      ventureId: company.ventureId,
      name: company.name,
      recordsFound: recordsFound.get(company.ventureId) ?? 0,
      cycles: cyclesByCompany.get(company.ventureId) ?? 0,
      couldNotAttribute: unattributedByCompany.get(company.ventureId) ?? 0
    })),
    byDay: [...cyclesByDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, cycles]) => ({ day, cycles })),
    couldNotAttribute: [...reasonCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, records]) => ({ reason, records, explanation: REASON_EXPLANATIONS[reason] })),
    deferred: DEFERRED_NOTES
  });
}
