import { describe, expect, it } from "vitest";
import {
  AMPED_BACKEND_CONTRACT_VERSION,
  AMPED_HELD_OUT_CASES_V1,
  AMPED_SCALE_INVARIANTS_V1,
  AmpedGraphDefinitionSchema,
  AmpedHeldOutCaseSchema,
  AmpedEvaluatorVersionSchema,
  AmpedModelToolPolicySchema,
  AmpedNodeExecutionContractSchema,
  AmpedPlaybookPackSchema,
  AmpedReplayIdentitySchema,
  AmpedRuntimeVersionSchema,
  AmpedTeachingRecordSchema,
  AmpedTeachingRubricSchema,
  sha256
} from "@amped-studio-os/contracts";

const at = "2026-07-27T12:00:00.000Z";
const hash = (value: string) => sha256(value);
const version = (id: string, revision = 1) => ({ id, version: revision, hash: hash(`${id}:${revision}`) });
const limits = { maxAttempts: 3, timeoutMs: 60_000, maxInputTokens: 8_000, maxOutputTokens: 2_000, maxCostCents: 500, maxEffects: 1 };
const node = (id: string, role: "planner" | "specialist" | "verifier" | "human") => ({
  id,
  version: 1,
  hash: hash(id),
  hierarchy: "initiative" as const,
  role,
  purpose: `Execute ${id}`,
  inputContract: ["canonical company state"],
  outputContract: ["structured node result"],
  allowedEvidenceTypes: ["evidence_current"],
  limits
});
const edge = (id: string, fromNodeId: string, toNodeId: string) => ({
  id,
  version: 1,
  hash: hash(id),
  fromNodeId,
  toNodeId,
  kind: "forward" as const,
  priority: 0,
  maxTraversals: 1,
  condition: { kind: "always" as const }
});

describe("Amped Studio OS frozen backend contracts", () => {
  it("freezes the held-out teaching and adversarial routing cases before implementation", () => {
    expect(AMPED_HELD_OUT_CASES_V1).toHaveLength(10);
    expect(new Set(AMPED_HELD_OUT_CASES_V1.map((item) => item.id)).size).toBe(10);
    for (const item of AMPED_HELD_OUT_CASES_V1) expect(AmpedHeldOutCaseSchema.parse(item)).toEqual(item);
    expect(sha256(AMPED_HELD_OUT_CASES_V1)).toBe("f2cfcac94213384c05eaf5ea8b1fe8650ca76615f31cd946a274f62e93f30934");
  });

  it("accepts a versioned graph and rejects dangling or nondeterministic human-gate edges", () => {
    const graph = {
      schemaVersion: AMPED_BACKEND_CONTRACT_VERSION,
      id: "graph_amped_v1",
      version: 1,
      hash: hash("graph"),
      capabilityCatalog: version("catalog_gtm"),
      entryNodeId: "observe",
      nodes: [node("observe", "planner"), node("execute", "specialist"), node("verify", "verifier"), node("human", "human")],
      edges: [edge("edge_observe_execute", "observe", "execute"), edge("edge_execute_verify", "execute", "verify")],
      createdAt: at
    };
    expect(AmpedGraphDefinitionSchema.parse(graph).nodes).toHaveLength(4);
    expect(AmpedGraphDefinitionSchema.safeParse({
      ...graph,
      edges: [edge("edge_dangling", "observe", "missing")]
    }).success).toBe(false);
    expect(AmpedGraphDefinitionSchema.safeParse({
      ...graph,
      edges: [{
        ...edge("edge_human", "verify", "human"),
        kind: "human-gate",
        condition: { kind: "always" }
      }]
    }).success).toBe(false);
  });

  it("makes replay and shadow effect-free and bound to exact prior run and trace identities", () => {
    expect(AmpedReplayIdentitySchema.parse({
      id: "replay_live",
      mode: "live",
      inputHash: hash("input"),
      noExternalEffects: false
    }).mode).toBe("live");
    expect(AmpedReplayIdentitySchema.safeParse({
      id: "replay_shadow",
      mode: "shadow",
      inputHash: hash("input"),
      noExternalEffects: false
    }).success).toBe(false);
    expect(AmpedReplayIdentitySchema.parse({
      id: "replay_shadow",
      mode: "shadow",
      sourceRunId: "run_source",
      sourceTraceId: "trace_source",
      inputHash: hash("input"),
      noExternalEffects: true,
      candidateVersion: version("harness_candidate", 2)
    }).mode).toBe("shadow");
  });

  it("separates producer, evaluator, and reviewer and binds model, tool, runtime, effect, and kill policy", () => {
    const evaluator = {
      schemaVersion: "amped-evaluator-v1",
      version: version("evaluator_teaching"),
      producerId: "producer_one",
      evaluatorId: "evaluator_one",
      reviewerId: "reviewer_one",
      heldOutSuiteHash: hash("suite"),
      baseline: version("baseline_teaching"),
      rubricHash: hash("rubric"),
      blindComparisonRequired: true,
      minimumScore: 8,
      zeroAllowed: false,
      frozenAt: at
    };
    expect(AmpedEvaluatorVersionSchema.parse(evaluator).reviewerId).toBe("reviewer_one");
    expect(AmpedEvaluatorVersionSchema.safeParse({ ...evaluator, reviewerId: "producer_one" }).success).toBe(false);

    const choices = (["planner", "specialist", "verifier"] as const).map((role) => ({
      id: `choice_${role}`,
      role,
      provider: "provider_evaluated",
      model: `model-${role}`,
      tools: [`tool_${role}`],
      evaluation: version(`evaluation_${role}`),
      reliability: 0.9,
      p95LatencyMs: 1_000,
      maxCostCents: 100
    }));
    const policy = {
      schemaVersion: "amped-model-tool-policy-v1",
      version: version("policy_model_tool"),
      choices,
      fallbackOrder: choices.map((choice) => choice.id),
      createdAt: at
    };
    expect(AmpedModelToolPolicySchema.parse(policy).choices).toHaveLength(3);
    expect(AmpedModelToolPolicySchema.safeParse({ ...policy, fallbackOrder: ["choice_missing"] }).success).toBe(false);

    const runtime = {
      schemaVersion: "amped-runtime-v1",
      version: version("runtime_worker"),
      workerProtocol: "durable-lease-v1",
      partitionKey: "company_id",
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      maxConcurrencyPerCompany: 2,
      queuePageSize: 50,
      backpressureThreshold: 100,
      circuitBreakerFailures: 5,
      deadLetterAfterAttempts: 3,
      fullPortfolioScanAllowed: false
    };
    expect(AmpedRuntimeVersionSchema.parse(runtime).partitionKey).toBe("company_id");
    expect(AmpedRuntimeVersionSchema.safeParse({ ...runtime, heartbeatMs: 30_000 }).success).toBe(false);

    const execution = {
      schemaVersion: "amped-node-execution-v1",
      id: "execution_offer",
      version: 1,
      hash: hash("execution"),
      node: version("node_offer"),
      harness: version("harness_main"),
      context: version("context_main"),
      modelToolPolicy: version("policy_model_tool"),
      evaluator: version("evaluator_teaching"),
      runtime: version("runtime_worker"),
      effectPolicy: version("effect_policy"),
      structuredOutputSchemaHash: hash("output-schema"),
      deterministicValidationRequired: true,
      scopedCredentialHandlesOnly: true,
      producerMayVerify: false,
      limits,
      killStateCheckedAt: ["claim", "before-model", "before-effect", "before-commit"]
    };
    expect(AmpedNodeExecutionContractSchema.parse(execution).producerMayVerify).toBe(false);
    expect(AmpedNodeExecutionContractSchema.safeParse({
      ...execution,
      killStateCheckedAt: ["claim", "claim", "before-effect", "before-commit"]
    }).success).toBe(false);
  });

  it("requires complete teaching, passing independent scores, and safe cross-company playbooks", () => {
    const bindings = {
      workspaceId: "workspace_alpha",
      companyId: "venture_alpha",
      evidenceIds: ["evidence_current"],
      effectKeys: [],
      receiptIds: ["receipt_decision"]
    };
    const teaching = {
      schemaVersion: "amped-teaching-v1",
      id: "teaching_decision",
      version: 1,
      hash: hash("teaching"),
      bindings,
      decisionTraceId: "decision_trace",
      why_now: "Buyer proof is the current constraint.",
      founder_lesson: "Validation precedes expansion.",
      agent_work: "Agents synthesize the observed evidence.",
      founder_action: "Founder chooses the exact ICP.",
      evidence_required: "Two authoritative buyer outcomes.",
      success_signal: "The same buyer pain repeats.",
      failure_signal: "The pain does not repeat.",
      reflection: "The prior ICP was weakly grounded.",
      what_changed: "New buyer evidence invalidated it.",
      next_gate: "Founder confirms the revised ICP.",
      uncertainty: "medium",
      createdAt: at
    };
    expect(AmpedTeachingRecordSchema.parse(teaching).id).toBe("teaching_decision");
    expect(AmpedTeachingRecordSchema.safeParse({ ...teaching, founder_action: undefined }).success).toBe(false);
    expect(AmpedTeachingRubricSchema.safeParse({
      correctConstraintEvidenceGate: 2,
      companyGrounding: 2,
      founderAgentSplit: 2,
      calibratedUncertainty: 1,
      actionableProofReflection: 1
    }).success).toBe(true);
    expect(AmpedTeachingRubricSchema.safeParse({
      correctConstraintEvidenceGate: 2,
      companyGrounding: 2,
      founderAgentSplit: 2,
      calibratedUncertainty: 2,
      actionableProofReflection: 0
    }).success).toBe(false);

    const playbook = {
      schemaVersion: "amped-playbook-v1",
      version: version("playbook_offer"),
      owner: "Amped Ventures",
      scope: "studio-general",
      sourceRefs: ["engine://playbook/offer"],
      rightsSafe: true,
      deidentified: true,
      lifecycleStages: ["validation"],
      preconditions: ["Buyer evidence is current"],
      instructions: ["Test one bounded offer"],
      antiPatterns: ["Build product depth without demand proof"],
      expectedEvidence: ["buyer_outcome"],
      teachingNotes: ["Explain why the offer is bounded"],
      evaluations: [],
      state: "candidate",
      createdAt: at
    };
    expect(AmpedPlaybookPackSchema.parse(playbook).scope).toBe("studio-general");
    expect(AmpedPlaybookPackSchema.safeParse({ ...playbook, deidentified: false }).success).toBe(false);
  });

  it("freezes tenant, scheduler, limit, backpressure, and telemetry invariants without a fleet claim", () => {
    expect(AMPED_SCALE_INVARIANTS_V1.tenantKeys).toEqual(["workspace_id", "company_id"]);
    expect(AMPED_SCALE_INVARIANTS_V1.scheduler).toMatchObject({
      boundedPageSize: 100,
      continuationCursorRequired: true,
      fullPortfolioScanAllowed: false,
      partitionKey: "company_id"
    });
    expect(AMPED_SCALE_INVARIANTS_V1.capacityClaimAllowed).toBe(false);
  });
});
