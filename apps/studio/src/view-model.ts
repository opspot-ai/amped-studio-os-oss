import type {
  AmpedGraphDefinition,
  AmpedGraphRunVersion
} from "../../../packages/contracts/src/amped";
import type { CompanyState, LifecycleState } from "./contracts";

export const STUDIO_STAGES = ["Ideation", "Validation", "Build", "Launch & Grow"] as const;
export type StudioStage = (typeof STUDIO_STAGES)[number];

export function lifecycleStage(state: LifecycleState): StudioStage {
  if (state === "candidate") return "Ideation";
  if (state === "validating" || state === "offer-ready") return "Validation";
  if (state === "launch-ready") return "Build";
  return "Launch & Grow";
}

export function graphStateLabel(run?: AmpedGraphRunVersion): string {
  if (!run) return "Not started";
  const labels: Record<AmpedGraphRunVersion["state"], string> = {
    planned: "Planned",
    running: "Running",
    paused: "Paused",
    "waiting-human": "Waiting for approval",
    "waiting-reconciliation": "Waiting for reconciliation",
    backpressured: "Backpressured",
    completed: "Completed",
    failed: "Failed",
    killed: "Killed"
  };
  return labels[run.state];
}

export function activeGraphNode(graph?: AmpedGraphDefinition, run?: AmpedGraphRunVersion) {
  if (!graph || !run?.activeNode) return undefined;
  return graph.nodes.find((node) => node.id === run.activeNode?.node.id);
}

export function companyOutcome(state: CompanyState): string {
  return state.bootstrap.snapshot.initialGoal.target;
}

export function currentInitiative(state: CompanyState): string {
  return state.currentInitiative?.title ?? "No initiative selected";
}

export function highestConstraint(state: CompanyState, run?: AmpedGraphRunVersion): string {
  if (run?.state === "waiting-human") return "Exact human authority is required";
  return state.currentInitiative?.uncertaintyReason ?? "Awaiting the first evidence-grounded decision";
}
