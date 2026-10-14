import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageSummarySchema } from "@amped-studio-os/contracts";
import { UsageView, type UsageViewState } from "./ui.js";

const baseSummary = UsageSummarySchema.parse({
  schema: "gtm-usage-summary-v1",
  readAt: "2026-08-18T05:00:00.000Z",
  window: {
    days: 30,
    since: "2026-07-19T05:00:00.000Z",
    until: "2026-08-18T05:00:00.000Z",
    timezone: "UTC"
  },
  scope: { ventureId: "venture_alpha", companiesRead: 1 },
  measured: true,
  ledger: { recordsFound: 4, duplicatesIgnored: 0, countedInWindow: 3, outsideWindow: 0, couldNotAttribute: 1 },
  work: {
    cycles: 3,
    byOutcome: { selected: 1, abstained: 1, killed: 1 },
    initiativesSelected: 1,
    tasksPlanned: 2,
    taskReferences: 3,
    repeatedTaskReferences: 1,
    receiptsAttached: 3,
    receiptReferences: 3,
    repeatedReceiptReferences: 0
  },
  proof: { verified: 1, inconclusive: 1, failed: 1 },
  byCompany: [{ ventureId: "venture_alpha", name: "Alpha", recordsFound: 4, cycles: 3, couldNotAttribute: 1 }],
  byDay: [{ day: "2026-08-18", cycles: 3 }],
  couldNotAttribute: [{
    reason: "unreadable-record",
    records: 1,
    explanation: "The runtime wrote a work record this view could not read, so its work is counted as unknown rather than as nothing."
  }],
  deferred: ["This view measures what the runtime did. Customer-defined value is deliberately not part of this view yet."]
});

function render(state: UsageViewState): string {
  return renderToStaticMarkup(createElement(UsageView, { state }));
}

test("usage view renders the measured counts, basis, proof split, and attribution unknown without supply-side vocabulary", () => {
  const markup = render({ status: "ready", summary: baseSummary });
  assert.match(markup, /30-day window/);
  assert.match(markup, /Read <time/);
  assert.match(markup, /Completed cycles/);
  assert.match(markup, /Initiatives selected/);
  assert.match(markup, /Tasks planned/);
  assert.match(markup, /Receipts attached/);
  assert.match(markup, /Selected<\/dt><dd>1/);
  assert.match(markup, /Abstained<\/dt><dd>1/);
  assert.match(markup, /Killed<\/dt><dd>1/);
  assert.match(markup, /Verified<\/dt><dd>1/);
  assert.match(markup, /Inconclusive<\/dt><dd>1/);
  assert.match(markup, /Failed<\/dt><dd>1/);
  assert.match(markup, /Could not attribute:<\/strong> 1 record remained unattributed/);
  assert.match(markup, /Customer-defined value is deliberately not part of this view yet/);
  assert.doesNotMatch(markup, /\b(?:tokens?|provider|model|dollars?|ROI|savings?|ratio|return|balance|runway)\b/i);
});

test("usage view renders the exact absent-ledger state without presenting count cards", () => {
  const empty = UsageSummarySchema.parse({
    ...baseSummary,
    measured: false,
    ledger: { recordsFound: 0, duplicatesIgnored: 0, countedInWindow: 0, outsideWindow: 0, couldNotAttribute: 0 },
    work: {
      cycles: 0,
      byOutcome: { selected: 0, abstained: 0, killed: 0 },
      initiativesSelected: 0,
      tasksPlanned: 0,
      taskReferences: 0,
      repeatedTaskReferences: 0,
      receiptsAttached: 0,
      receiptReferences: 0,
      repeatedReceiptReferences: 0
    },
    proof: { verified: 0, inconclusive: 0, failed: 0 },
    byCompany: [{ ventureId: "venture_alpha", name: "Alpha", recordsFound: 0, cycles: 0, couldNotAttribute: 0 }],
    byDay: [],
    couldNotAttribute: []
  });
  const markup = render({ status: "ready", summary: empty });
  assert.match(markup, /We have not measured any runtime work for this company yet\./);
  assert.match(markup, /Could not attribute:<\/strong> 0 records\. Every ledger record in scope was attributable\./);
  assert.doesNotMatch(markup, /Completed cycles/);
});

test("usage view refuses to replace an unavailable measurement with a number", () => {
  const markup = render({ status: "unavailable" });
  assert.match(markup, /measurement is unavailable right now/i);
  assert.match(markup, /No value has been inferred in its place/);
  assert.doesNotMatch(markup, /Completed cycles/);
});
