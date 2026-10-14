import { describe, expect, it } from "vitest";
import { CeoCycleSchema, UsageSummarySchema, sha256, type CeoCycle } from "@amped-studio-os/contracts";
import { summarizeUsageLedger, type UsageLedgerEvent } from "../packages/domain/src/usage-summary.js";

const READ_AT = "2026-08-18T05:00:00.000Z";

function candidate(ventureId: string, id: string) {
  return {
    id,
    ventureId,
    goalRevisionId: "goal_usage_view",
    capabilityId: "market-problem-research" as const,
    title: `Candidate ${id}`,
    hypothesis: "A bounded read can produce attributable work.",
    dependencyIds: [],
    requirementIds: [],
    expectedOutcome: "An attributable result",
    expectedProof: "A stored receipt",
    successThreshold: "One verified result",
    failureThreshold: "No attributable result",
    stopCondition: "Stop after the bounded read",
    estimatedHours: 1,
    estimatedCostCents: 0,
    autonomyMode: "prepare" as const,
    gateClasses: ["safe-internal-read-only" as const],
    uncertainty: 0.25,
    uncertaintyReason: "The result is not known before the read.",
    assumptions: [],
    evidenceIds: []
  };
}

function cycle(input: {
  id: string;
  ventureId?: string;
  completedAt: string;
  idempotencyKey: string;
  outcome: "selected" | "abstained" | "killed";
  verification: "verified" | "inconclusive" | "failed";
  plannedTaskIds?: string[];
  receiptIds?: string[];
}): CeoCycle {
  const ventureId = input.ventureId ?? "venture_alpha";
  const alternatives = [candidate(ventureId, `${input.id}_candidate_a`), candidate(ventureId, `${input.id}_candidate_b`)];
  const semantic = {
    id: input.id,
    ventureId,
    sequence: 1,
    bootstrapDigest: sha256(`${input.id}:bootstrap`),
    observedStateDigest: sha256(`${input.id}:state`),
    materialEvidenceDigest: sha256(`${input.id}:evidence`),
    evidenceIds: [],
    alternatives,
    decisionTraceId: `${input.id}_trace`,
    outcome: input.outcome,
    ...(input.outcome === "selected" ? { selectedCandidateId: alternatives[0]!.id } : {}),
    plannedTaskIds: input.plannedTaskIds ?? [],
    receiptIds: input.receiptIds ?? [`${input.id}_receipt`],
    verification: {
      status: input.verification,
      summary: `${input.verification} result`,
      evidenceDigest: sha256(`${input.id}:verification`)
    },
    replan: { materialChange: false },
    provider: "internal-provider",
    model: "internal-model",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    costCents: 7,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    idempotencyKey: input.idempotencyKey
  };
  return CeoCycleSchema.parse({ ...semantic, canonicalHash: sha256(semantic) });
}

function event(payload: unknown, companyId = "venture_alpha"): UsageLedgerEvent {
  return { companyId, payload, occurredAt: READ_AT };
}

describe("truthful customer usage summary", () => {
  it("partitions every row, deduplicates before counting, and preserves proof and attribution unknowns", () => {
    const selected = cycle({
      id: "cycle_selected",
      completedAt: "2026-08-18T03:00:00.000Z",
      idempotencyKey: "cycle-alpha-selected",
      outcome: "selected",
      verification: "verified",
      plannedTaskIds: ["task_one", "task_two"],
      receiptIds: ["receipt_one", "receipt_two"]
    });
    const abstained = cycle({
      id: "cycle_abstained",
      completedAt: "2026-08-17T03:00:00.000Z",
      idempotencyKey: "cycle-alpha-abstained",
      outcome: "abstained",
      verification: "inconclusive",
      plannedTaskIds: ["task_two", "task_three"],
      receiptIds: ["receipt_two"]
    });
    const outsideWindow = cycle({
      id: "cycle_old",
      completedAt: "2026-06-01T03:00:00.000Z",
      idempotencyKey: "cycle-alpha-old",
      outcome: "killed",
      verification: "failed"
    });
    const conflictingDuplicate = cycle({
      id: "cycle_conflict",
      completedAt: "2026-08-18T03:00:00.000Z",
      idempotencyKey: selected.idempotencyKey,
      outcome: "selected",
      verification: "verified",
      receiptIds: ["receipt_conflict"]
    });
    const wrongCompany = cycle({
      id: "cycle_wrong_company",
      ventureId: "venture_beta",
      completedAt: "2026-08-18T04:00:00.000Z",
      idempotencyKey: "cycle-beta-filed-alpha",
      outcome: "selected",
      verification: "verified"
    });

    const summary = summarizeUsageLedger({
      companies: [{ ventureId: "venture_alpha", name: "Alpha" }],
      events: [
        event(selected),
        event(selected),
        event(abstained),
        event(outsideWindow),
        event({ unreadable: true }),
        event(conflictingDuplicate),
        event(wrongCompany)
      ],
      windowDays: 30,
      readAt: READ_AT,
      ventureId: "venture_alpha"
    });

    expect(summary.ledger).toEqual({
      recordsFound: 7,
      duplicatesIgnored: 1,
      countedInWindow: 2,
      outsideWindow: 1,
      couldNotAttribute: 3
    });
    expect(summary.work).toEqual({
      cycles: 2,
      byOutcome: { selected: 1, abstained: 1, killed: 0 },
      initiativesSelected: 1,
      tasksPlanned: 3,
      taskReferences: 4,
      repeatedTaskReferences: 1,
      receiptsAttached: 2,
      receiptReferences: 3,
      repeatedReceiptReferences: 1
    });
    expect(summary.proof).toEqual({ verified: 1, inconclusive: 1, failed: 0 });
    expect(summary.couldNotAttribute.map(({ reason, records }) => ({ reason, records }))).toEqual([
      { reason: "company-mismatch", records: 1 },
      { reason: "conflicting-duplicate", records: 1 },
      { reason: "unreadable-record", records: 1 }
    ]);
    expect(summary.byCompany).toEqual([{ ventureId: "venture_alpha", name: "Alpha", recordsFound: 7, cycles: 2, couldNotAttribute: 3 }]);
    expect(summary.byDay).toEqual([
      { day: "2026-08-17", cycles: 1 },
      { day: "2026-08-18", cycles: 1 }
    ]);

    const browserPayload = JSON.stringify(summary);
    expect(browserPayload).not.toMatch(/inputTokens|outputTokens|totalTokens|reasoningTokens|costCents|internal-provider|internal-model/i);
    expect(browserPayload).not.toMatch(/\b(?:ROI|savings?|ratio|return)\b/i);
  });

  it("distinguishes an absent ledger from measured zero", () => {
    const summary = summarizeUsageLedger({
      companies: [{ ventureId: "venture_alpha", name: "Alpha" }],
      events: [],
      windowDays: 30,
      readAt: READ_AT,
      ventureId: "venture_alpha"
    });
    expect(summary.measured).toBe(false);
    expect(summary.ledger.recordsFound).toBe(0);
    expect(summary.work.cycles).toBe(0);
    expect(summary.scope).toEqual({ ventureId: "venture_alpha", companiesRead: 1 });
  });

  it("keeps equal entity ids distinct across companies in a workspace-wide read", () => {
    const alpha = cycle({
      id: "cycle_workspace_alpha",
      completedAt: "2026-08-18T03:00:00.000Z",
      idempotencyKey: "cycle-workspace-alpha",
      outcome: "selected",
      verification: "verified",
      plannedTaskIds: ["task_shared"],
      receiptIds: ["receipt_shared"]
    });
    const beta = cycle({
      id: "cycle_workspace_beta",
      ventureId: "venture_beta",
      completedAt: "2026-08-18T04:00:00.000Z",
      idempotencyKey: "cycle-workspace-beta",
      outcome: "selected",
      verification: "verified",
      plannedTaskIds: ["task_shared"],
      receiptIds: ["receipt_shared"]
    });
    const summary = summarizeUsageLedger({
      companies: [
        { ventureId: "venture_alpha", name: "Alpha" },
        { ventureId: "venture_beta", name: "Beta" }
      ],
      events: [event(alpha), event(beta, "venture_beta")],
      windowDays: 30,
      readAt: READ_AT
    });
    expect(summary.work.tasksPlanned).toBe(2);
    expect(summary.work.taskReferences).toBe(2);
    expect(summary.work.receiptsAttached).toBe(2);
    expect(summary.work.receiptReferences).toBe(2);
    expect(summary.byCompany).toHaveLength(2);
  });

  it("rejects both undercounts and overcounts across conservation boundaries", () => {
    const valid = summarizeUsageLedger({
      companies: [{ ventureId: "venture_alpha", name: "Alpha" }],
      events: [event(cycle({
        id: "cycle_guard",
        completedAt: "2026-08-18T03:00:00.000Z",
        idempotencyKey: "cycle-alpha-guard",
        outcome: "selected",
        verification: "verified"
      }))],
      windowDays: 30,
      readAt: READ_AT,
      ventureId: "venture_alpha"
    });
    expect(UsageSummarySchema.safeParse({ ...valid, proof: { ...valid.proof, verified: 0 } }).success).toBe(false);
    expect(UsageSummarySchema.safeParse({ ...valid, proof: { ...valid.proof, verified: 2 } }).success).toBe(false);
  });
});
