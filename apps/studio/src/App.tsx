import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  Check,
  Circle,
  FileText,
  HourglassMedium,
  LockKey,
  Pause,
  Play,
  Plus,
  Robot,
  ShieldCheck,
  SpinnerGap,
  User,
  Warning,
  X
} from "@phosphor-icons/react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AmpedGraphDefinition,
  AmpedGraphRunVersion,
  AmpedTeachingRecord
} from "../../../packages/contracts/src/amped";
import {
  bootstrapCompany,
  getAmped,
  getCompany,
  getInvite,
  getSession,
  listCompanies,
  pauseCompany,
  requestRecovery,
  resolveApproval,
  selectWorkspace,
  signIn,
  signOut,
  signUp,
  startAmped,
  StudioApiError,
  type AmpedSnapshot,
  type AuthSession,
  type CompanyDetail,
  type CompanyListItem,
  type PendingApproval
} from "./api";
import {
  activeGraphNode,
  companyOutcome,
  currentInitiative,
  graphStateLabel,
  highestConstraint,
  lifecycleStage,
  STUDIO_STAGES,
  type StudioStage
} from "./view-model";

const PREVIEW_QUERY = new URLSearchParams(window.location.search).get("preview") === "1";
const PREVIEW_MODE = PREVIEW_QUERY || import.meta.env.VITE_STUDIO_PREVIEW === "true";

type AppMode = "loading" | "live" | "preview" | "empty" | "error";
type GraphNodeStatus = "complete" | "active" | "gated" | "locked" | "failed";

interface GraphNodeView {
  id: string;
  label: string;
  kind: string;
  status: GraphNodeStatus;
}

interface ScreenData {
  company: string;
  owner: string;
  outcome: string;
  stage: StudioStage;
  constraint: string;
  initiative: string;
  graphState: string;
  activeNode: string;
  agentWork: string;
  founderWork: string;
  requiredProof: string;
  whyNow: string;
  founderLesson: string;
  whatChanged: string;
  gateTitle: string;
  gateDetail: string;
  proofStatus: string;
  graphNodes: GraphNodeView[];
  runState?: AmpedGraphRunVersion["state"];
}

const NODE_LABELS: Record<string, string> = {
  portfolio: "Allocate portfolio attention",
  observe: "Observe company truth",
  research: "Research market and problem",
  verify_research: "Verify research independently",
  choose: "Choose the next move",
  offer: "Shape ICP, offer, and pricing",
  verify_offer: "Verify offer evidence",
  founder_gate: "Founder authority gate",
  learn: "Commit the lesson",
  replan: "Replan from evidence"
};

const PREVIEW_NODES: GraphNodeView[] = [
  { id: "portfolio", label: NODE_LABELS.portfolio, kind: "Portfolio", status: "complete" },
  { id: "observe", label: NODE_LABELS.observe, kind: "Company", status: "complete" },
  { id: "research", label: NODE_LABELS.research, kind: "Initiative", status: "complete" },
  { id: "verify_research", label: NODE_LABELS.verify_research, kind: "Verifier", status: "complete" },
  { id: "offer", label: NODE_LABELS.offer, kind: "Initiative", status: "complete" },
  { id: "founder_gate", label: NODE_LABELS.founder_gate, kind: "Human gate", status: "gated" },
  { id: "learn", label: NODE_LABELS.learn, kind: "Studio learning", status: "locked" },
  { id: "replan", label: NODE_LABELS.replan, kind: "Company", status: "locked" }
];

function previewScreen(state: "waiting" | "running" | "paused"): ScreenData {
  const graphState = state === "waiting" ? "Waiting for approval" : state === "paused" ? "Paused" : "Running";
  return {
    company: "Amped Studio OS",
    owner: "Example Owner",
    outcome: "Prove the private studio operating loop",
    stage: "Validation",
    constraint: "No real dogfood run yet",
    initiative: "Run the first production-shaped company loop",
    graphState,
    activeNode: state === "waiting" ? "Founder authority gate" : "Commit the lesson",
    agentWork: "Prepare scoped market and offer evidence",
    founderWork: state === "waiting" ? "Approve the exact research boundary" : "Review the next evidence packet",
    requiredProof: "Independent verifier receipt + materially changed next initiative",
    whyNow: "Fixture proof is complete; one real company dogfood run is still missing.",
    founderLesson: "Approval changes authority. It does not create proof.",
    whatChanged: "Phase 2 backend proof unlocked this disposable UI.",
    gateTitle: state === "waiting" ? "Authority required — no external action" : "No human gate is open",
    gateDetail: state === "waiting" ? "Research boundary approval" : "The preview branch is clear to continue.",
    proofStatus: "Backend fixture-verified · Dogfood blocked",
    graphNodes: PREVIEW_NODES.map((node) => {
      if (state === "waiting") return node;
      if (node.id === "founder_gate") return { ...node, status: "complete" };
      if (node.id === "learn") return { ...node, status: state === "paused" ? "gated" : "active" };
      return node;
    }),
    runState: state === "waiting" ? "waiting-human" : state === "paused" ? "paused" : "running"
  };
}

function latestTeaching(records: AmpedTeachingRecord[]): AmpedTeachingRecord | undefined {
  return [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
}

function approvalAction(approval?: PendingApproval): string {
  if (!approval?.packet) return "Legacy or malformed packet — approval is disabled";
  return approval.packet.exactUnlock.action;
}

function liveGraphNodes(graph?: AmpedGraphDefinition, run?: AmpedGraphRunVersion, traces: AmpedSnapshot["traces"] = []): GraphNodeView[] {
  if (!graph) return [];
  const completed = new Set(traces.map((trace) => trace.versions.activeNode.id));
  return graph.nodes.map((node) => {
    let status: GraphNodeStatus = "locked";
    if (run?.state === "failed" && run.activeNode?.node.id === node.id) status = "failed";
    else if (run?.activeNode?.node.id === node.id) status = run.state === "waiting-human" ? "gated" : "active";
    else if (completed.has(node.id)) status = "complete";
    return {
      id: node.id,
      label: NODE_LABELS[node.id] ?? node.purpose,
      kind: node.hierarchy.replace("-", " "),
      status
    };
  });
}

function liveScreen(detail: CompanyDetail, amped?: AmpedSnapshot): ScreenData {
  const state = detail.state;
  const run = amped?.run;
  const node = activeGraphNode(amped?.graph, run);
  const teaching = latestTeaching(amped?.teaching ?? []);
  const approval = detail.approvals[0];
  const receiptCount = amped?.run.bindings.receiptIds.length ?? 0;

  return {
    company: state.bootstrap.snapshot.name,
    owner: state.bootstrap.snapshot.owner,
    outcome: companyOutcome(state),
    stage: lifecycleStage(state.lifecycleState),
    constraint: teaching?.why_now ?? highestConstraint(state, run),
    initiative: currentInitiative(state),
    graphState: graphStateLabel(run),
    activeNode: node ? (NODE_LABELS[node.id] ?? node.purpose) : "No active graph node",
    agentWork: teaching?.agent_work ?? (node?.role !== "human" ? node?.purpose : undefined) ?? "No agent work is currently recorded.",
    founderWork: teaching?.founder_action ?? (approval ? approvalAction(approval) : "No founder action is currently recorded."),
    requiredProof: teaching?.evidence_required ?? node?.outputContract.join(" · ") ?? "Start the graph to bind required proof.",
    whyNow: teaching?.why_now ?? "The graph has not emitted a teaching record yet.",
    founderLesson: teaching?.founder_lesson ?? "Founder teaching will appear after a committed decision.",
    whatChanged: teaching?.what_changed ?? "No verified result has changed the route yet.",
    gateTitle: approval ? "Authority required — no external action" : "No human gate is open",
    gateDetail: approval ? approvalAction(approval) : "The current branch has no pending approval.",
    proofStatus: run ? `${receiptCount} run receipts · ${run.state}` : "Graph not started · no run proof",
    graphNodes: liveGraphNodes(amped?.graph, run, amped?.traces),
    runState: run?.state
  };
}

function StatusIcon({ status }: { status: GraphNodeStatus }) {
  if (status === "complete") return <Check weight="bold" aria-hidden="true" />;
  if (status === "active") return <Circle weight="fill" aria-hidden="true" />;
  if (status === "gated") return <LockKey weight="regular" aria-hidden="true" />;
  if (status === "failed") return <Warning weight="fill" aria-hidden="true" />;
  return <Circle weight="regular" aria-hidden="true" />;
}

export function App() {
  return PREVIEW_MODE ? <StudioApp /> : <PrivateStudio />;
}

function PrivateStudio() {
  const [session, setSession] = useState<AuthSession>();
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<{ token: string; email: string }>();
  const [view, setView] = useState<"sign-in" | "sign-up" | "recovery">("sign-in");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void (async () => {
      try {
        setSession(await getSession());
      } catch (sessionError) {
        if (!(sessionError instanceof StudioApiError) || ![401, 403].includes(sessionError.status ?? 0)) {
          setError(sessionError instanceof Error ? sessionError.message : "The private session could not be loaded.");
        }
        const params = new URLSearchParams(window.location.search);
        const token = params.get("invite");
        if (token) {
          try {
            const info = await getInvite(token);
            setInvite({ token, email: info.email });
            setView("sign-up");
          } catch {
            setInvite(undefined);
          }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      if (view === "recovery") {
        await requestRecovery(email);
        setMessage("If that invited account exists, recovery instructions are on the way.");
      } else if (view === "sign-up" && invite) {
        const result = await signUp(email, password, invite.token);
        if ("confirmationRequired" in result) {
          setMessage("Confirm the invited email, then this private workspace will finish opening.");
        } else {
          setSession(result);
        }
      } else {
        setSession(await signIn(email, password, invite?.token));
      }
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="state-page" aria-live="polite"><SpinnerGap className="spin" size={34} aria-hidden="true" /><p>Checking private access…</p></main>;
  }
  if (session) {
    return (
      <StudioApp
        session={session}
        onSession={setSession}
        onSignOut={async () => {
          await signOut();
          setSession(undefined);
          setView("sign-in");
        }}
      />
    );
  }
  return (
    <main className="state-page private-access">
      <LockKey size={38} aria-hidden="true" />
      <p className="eyebrow">Invite-only Studio</p>
      <h1>{view === "sign-up" && invite ? "Open your private workspace." : view === "recovery" ? "Recover an invited account." : "Private access only."}</h1>
      <p>
        {view === "sign-up" && invite
          ? "This single-use invitation is bound to the email below. No public account or workspace will be created."
          : "There is no public signup or configured support contact in this snapshot."}
      </p>
      <form className="auth-form" onSubmit={submitAuth}>
        <label>Email<input name="email" type="email" required autoComplete="email" defaultValue={invite?.email ?? new URLSearchParams(window.location.search).get("email") ?? ""} readOnly={view === "sign-up" && Boolean(invite)} /></label>
        {view !== "recovery" && <label>Password<input name="password" type="password" minLength={8} maxLength={128} required autoComplete={view === "sign-up" ? "new-password" : "current-password"} /></label>}
        <button className="button button-primary" disabled={busy}>
          {busy && <SpinnerGap className="spin" aria-hidden="true" />}
          {view === "sign-up" ? "Accept private invite" : view === "recovery" ? "Request recovery" : "Sign in"}
        </button>
      </form>
      <div className="button-row auth-switcher">
        {view !== "sign-in" && <button className="text-button" onClick={() => setView("sign-in")}>Use an existing invited account</button>}
        {view !== "recovery" && <button className="text-button" onClick={() => setView("recovery")}>Forgot password?</button>}
      </div>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </main>
  );
}

function StudioApp({
  session,
  onSession,
  onSignOut
}: {
  session?: AuthSession;
  onSession?: (session: AuthSession) => void;
  onSignOut?: () => Promise<void>;
}) {
  const [mode, setMode] = useState<AppMode>(PREVIEW_MODE ? "preview" : "loading");
  const [previewState, setPreviewState] = useState<"waiting" | "running" | "paused">("waiting");
  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CompanyDetail>();
  const [amped, setAmped] = useState<AmpedSnapshot>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const requestVersion = useRef(0);
  const createDialog = useRef<HTMLDialogElement>(null);
  const reportDialog = useRef<HTMLDialogElement>(null);
  const gateDialog = useRef<HTMLDialogElement>(null);
  const actor = session?.user.email ?? "Example Owner";

  const approval = detail?.approvals[0];
  const screen = useMemo(
    () => mode === "preview" ? previewScreen(previewState) : detail ? liveScreen(detail, amped) : undefined,
    [mode, previewState, detail, amped]
  );

  async function loadSelected(ventureId: string, silent = false) {
    const version = ++requestVersion.current;
    if (!silent) {
      setBusy("refresh");
      setError(undefined);
      setDetail(undefined);
      setAmped(undefined);
    }
    try {
      const nextDetail = await getCompany(ventureId);
      const runId = sessionStorage.getItem(`amped-studio-run:${ventureId}`);
      let nextAmped: AmpedSnapshot | undefined;
      if (runId) {
        try {
          nextAmped = await getAmped(ventureId, runId);
        } catch (runError) {
          if (runError instanceof StudioApiError && runError.code === "run-missing") {
            sessionStorage.removeItem(`amped-studio-run:${ventureId}`);
          } else {
            throw runError;
          }
        }
      }
      if (version !== requestVersion.current) return;
      setDetail(nextDetail);
      setAmped(nextAmped);
      setMode("live");
    } catch (loadError) {
      if (version !== requestVersion.current) return;
      setMode("error");
      setError(loadError instanceof Error ? loadError.message : "The company could not be loaded.");
    } finally {
      if (version === requestVersion.current) setBusy(undefined);
    }
  }

  async function loadPortfolio(preferredId?: string) {
    setBusy("portfolio");
    setError(undefined);
    try {
      const nextCompanies = await listCompanies();
      setCompanies(nextCompanies);
      if (nextCompanies.length === 0) {
        setSelectedId("");
        setDetail(undefined);
        setAmped(undefined);
        setMode("empty");
        return;
      }
      const nextId = preferredId && nextCompanies.some((company) => company.ventureId === preferredId)
        ? preferredId
        : selectedId && nextCompanies.some((company) => company.ventureId === selectedId)
          ? selectedId
          : nextCompanies[0]!.ventureId;
      setSelectedId(nextId);
      await loadSelected(nextId);
    } catch (portfolioError) {
      setMode("error");
      setError(portfolioError instanceof Error ? portfolioError.message : "The private portfolio is unavailable.");
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => {
    if (!PREVIEW_MODE) void loadPortfolio();
  }, []);

  async function runGraph() {
    if (mode === "preview") {
      setPreviewState("running");
      setNotice("Preview only — the running state changed locally; no backend was mutated.");
      return;
    }
    if (!selectedId) return;
    setBusy("run");
    setError(undefined);
    try {
      const snapshot = await startAmped(selectedId);
      sessionStorage.setItem(`amped-studio-run:${selectedId}`, snapshot.run.id);
      setAmped(snapshot);
      setNotice(snapshot.run.state === "running" ? "The canonical graph run started." : `Graph state: ${snapshot.run.state}.`);
      await loadSelected(selectedId, true);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "The graph could not start.");
    } finally {
      setBusy(undefined);
    }
  }

  async function pauseGraph() {
    if (mode === "preview") {
      setPreviewState("paused");
      setNotice("Preview only — company work is shown as paused; no backend was mutated.");
      return;
    }
    if (!selectedId) return;
    setBusy("pause");
    setError(undefined);
    try {
      await pauseCompany(selectedId, actor);
      setNotice("Company work was paused through the canonical command path.");
      await loadSelected(selectedId, true);
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : "Company work could not be paused.");
    } finally {
      setBusy(undefined);
    }
  }

  async function decideGate(decision: "approve" | "deny") {
    if (mode === "preview") {
      setPreviewState(decision === "approve" ? "running" : "paused");
      setNotice(`Preview only — ${decision === "approve" ? "approval" : "denial"} was not sent to a backend.`);
      gateDialog.current?.close();
      return;
    }
    if (!approval || !selectedId) return;
    setBusy(decision);
    setError(undefined);
    try {
      await resolveApproval(approval, decision, actor);
      gateDialog.current?.close();
      setNotice(`The exact gate was ${decision === "approve" ? "approved" : "denied"}.`);
      await loadSelected(selectedId, true);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "The approval could not be resolved.");
    } finally {
      setBusy(undefined);
    }
  }

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const idea = String(form.get("idea") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const destination = String(form.get("destination") ?? "durable-operation") as "cash-flow" | "growth" | "durable-operation" | "acquisition-readiness" | "exit-readiness";
    const constraint = String(form.get("constraint") ?? "").trim();
    setBusy("create");
    setError(undefined);
    try {
      const ventureId = await bootstrapCompany({
        idea,
        ...(name ? { name } : {}),
        owner: actor,
        destination,
        horizonDays: 90,
        budgetCents: 0,
        constraints: constraint ? [constraint] : [],
        killConditions: ["Stop when the bounded run cannot produce material evidence without new authority"],
        permissions: "No external send, public post, deployment, credential mutation, or money movement without exact approval"
      });
      createDialog.current?.close();
      setNotice("The company was created in the selected private workspace.");
      await loadPortfolio(ventureId);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The company could not be created.");
    } finally {
      setBusy(undefined);
    }
  }

  if (mode === "loading") {
    return (
      <main className="state-page" aria-live="polite">
        <SpinnerGap className="spin" size={34} aria-hidden="true" />
        <p>Loading the private portfolio…</p>
      </main>
    );
  }

  if (mode === "empty") {
    return (
      <main className="state-page">
        <p className="eyebrow">Private portfolio</p>
        <h1>DOGFOOD_COMPANY_SELECTION_REQUIRED</h1>
        <p>The invited workspace is isolated and empty. No company is preselected, seeded, imported, approved, or running.</p>
        <div className="selection-packet">
          <strong>Company owner must name:</strong>
          <span>company + owning source · destination · budget · constraints · permissions · source references · kill conditions</span>
          <small>Still disabled: outreach, public posting, spend, deployment, credentials, billing, customer systems, Orgo, Matt/Amped access, external invitations, final design, and production launch.</small>
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
      </main>
    );
  }

  if (mode === "error" && !screen) {
    return (
      <main className="state-page">
        <Warning size={38} aria-hidden="true" />
        <p className="eyebrow">Studio connection</p>
        <h1>The private backend is unavailable.</h1>
        <p>{error}</p>
        <div className="button-row">
          <button className="button button-primary" onClick={() => void loadPortfolio()}>
            <ArrowsClockwise aria-hidden="true" /> Retry
          </button>
          <a className="button" href="?preview=1">Open contract preview</a>
        </div>
      </main>
    );
  }

  if (!screen) return null;

  const waitingGate = screen.runState === "waiting-human" || (mode === "preview" && previewState === "waiting");
  const packetReady = mode === "preview" || approval?.packetState === "valid";
  const canRun = mode === "preview"
    ? previewState === "paused"
    : Boolean(selectedId) && (!amped || amped.run.state === "paused");
  const canPause = mode === "preview"
    ? previewState !== "paused"
    : Boolean(selectedId) && (
      detail?.state.runState === "running"
      || detail?.state.runState === "waiting-approval"
      || amped?.run.state === "running"
      || amped?.run.state === "waiting-human"
    );

  return (
    <>
      <a className="skip-link" href="#studio-main">Skip to decision room</a>
      <div className="studio-shell">
        <header className="studio-header">
          <div className="brand-row">
            <a className="wordmark" href="/" aria-label="Amped Studio OS home">Amped <span>Studio OS</span></a>
            <span className="private-label">
              {mode === "preview" ? "Private contract preview · no live state" : `Private workspace · ${session?.workspace.id ?? screen.owner}`}
            </span>
            <div className="header-actions">
              <span className="date-label">Jul 28, 2026</span>
              <span className="room-label">Decision Room</span>
              <details className="user-menu">
                <summary aria-label="Open user menu">
                  <span aria-hidden="true">{actor.slice(0, 1).toUpperCase()}</span>
                  <CaretDown size={14} aria-hidden="true" />
                </summary>
                <div>
                  <strong>{actor}</strong>
                  <span>{mode === "preview" ? "Preview viewer" : `${session?.workspace.role ?? "owner"} · verified session`}</span>
                  {session && session.workspaces.length > 1 && (
                    <label>Workspace
                      <select
                        value={session.workspace.id}
                        onChange={(event) => void selectWorkspace(event.target.value).then((next) => {
                          onSession?.(next);
                          void loadPortfolio();
                        })}
                      >
                        {session.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.id} · {workspace.role}</option>)}
                      </select>
                    </label>
                  )}
                  {onSignOut && <button className="text-button" onClick={() => void onSignOut()}>Sign out</button>}
                </div>
              </details>
            </div>
          </div>
          <div className="company-row">
            <label htmlFor="company-select">Company</label>
            {mode === "preview" ? (
              <span className="company-name">{screen.company}</span>
            ) : (
              <select
                id="company-select"
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  void loadSelected(event.target.value);
                }}
              >
                {companies.map((company) => (
                  <option value={company.ventureId} key={company.ventureId}>{company.name}</option>
                ))}
              </select>
            )}
            {mode !== "preview" && (
              <button className="text-button" onClick={() => createDialog.current?.showModal()}>
                <Plus aria-hidden="true" /> New company
              </button>
            )}
            <button className="report-link" onClick={() => reportDialog.current?.showModal()}>
              Open report <ArrowSquareOut aria-hidden="true" />
            </button>
          </div>
        </header>

        <main id="studio-main">
          <section className="ink-hero" aria-labelledby="initiative-heading">
            <div className="constraint-block">
              <p className="eyebrow light">Highest constraint</p>
              <h1>{screen.constraint}</h1>
            </div>
            <img src="/assets/aerial-road.webp" alt="" className="road-image" />
            <div className="initiative-block">
              <p className="eyebrow light">Initiative</p>
              <h2 id="initiative-heading">{screen.initiative}</h2>
              <div className="hero-meta">
                <div>
                  <span>Outcome</span>
                  <strong>{screen.outcome}</strong>
                </div>
                <div>
                  <span>Graph state</span>
                  <strong className={waitingGate ? "amber-text" : ""}>
                    <HourglassMedium aria-hidden="true" /> {screen.graphState}
                  </strong>
                </div>
                <div>
                  <span>Active node</span>
                  <strong>{screen.activeNode}</strong>
                </div>
              </div>
            </div>
          </section>

          {error && <div className="notice error-notice" role="alert"><Warning aria-hidden="true" /> {error}</div>}
          {notice && <div className="notice" role="status"><ShieldCheck aria-hidden="true" /> {notice}<button onClick={() => setNotice(undefined)} aria-label="Dismiss notice"><X aria-hidden="true" /></button></div>}

          <section className="operating-grid">
            <div className="lifecycle-panel">
              <p className="eyebrow">Lifecycle</p>
              <ol className="lifecycle-list">
                {STUDIO_STAGES.map((stage, index) => (
                  <li className={stage === screen.stage ? "current" : ""} key={stage}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{stage}</strong>
                      <small>{stage === screen.stage ? screen.outcome : lifecycleDescription(stage)}</small>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="graph-panel">
              <div className="section-heading">
                <p className="eyebrow">Graph state</p>
                {mode !== "preview" && (
                  <button className="icon-button" onClick={() => void loadSelected(selectedId)} aria-label="Refresh graph state" disabled={Boolean(busy)}>
                    <ArrowsClockwise className={busy === "refresh" ? "spin" : ""} aria-hidden="true" />
                  </button>
                )}
              </div>
              {screen.graphNodes.length === 0 ? (
                <div className="graph-empty">
                  <p>No graph run is loaded for this company.</p>
                  <button className="text-button" onClick={() => void runGraph()} disabled={Boolean(busy)}>Start the canonical graph</button>
                </div>
              ) : (
                <ol className="graph-list">
                  {screen.graphNodes.map((node) => (
                    <li className={`node-${node.status}`} key={node.id}>
                      <span className="node-icon"><StatusIcon status={node.status} /></span>
                      <div>
                        <strong>{node.label}</strong>
                        <small>{node.kind} · {node.status}</small>
                      </div>
                      {node.status === "gated" && <span className="gate-inline">Authority required</span>}
                    </li>
                  ))}
                </ol>
              )}
              <div className="work-split">
                <div>
                  <span><Robot aria-hidden="true" /> Agent work</span>
                  <p>{screen.agentWork}</p>
                </div>
                <div>
                  <span><User aria-hidden="true" /> Founder work</span>
                  <p>{screen.founderWork}</p>
                </div>
              </div>
            </div>

            <aside className="teaching-panel" aria-labelledby="teaching-heading">
              <p className="eyebrow" id="teaching-heading">Teaching record</p>
              <dl>
                <div><dt>Why now</dt><dd>{screen.whyNow}</dd></div>
                <div><dt>Founder lesson</dt><dd>{screen.founderLesson}</dd></div>
                <div><dt>What changed</dt><dd>{screen.whatChanged}</dd></div>
              </dl>
              <div className="proof-block">
                <span>Required proof</span>
                <p>{screen.requiredProof}</p>
              </div>
              <div className="proof-block">
                <span>Proof status</span>
                <p className="proof-status"><ShieldCheck aria-hidden="true" /> {screen.proofStatus}</p>
              </div>
            </aside>
          </section>

          <section className={`command-rail ${waitingGate ? "is-gated" : ""}`} aria-label="Run controls">
            <div className="gate-summary">
              <LockKey aria-hidden="true" />
              <div>
                <span>Human gate</span>
                <strong>{screen.gateTitle}</strong>
                <small>{screen.gateDetail}</small>
              </div>
            </div>
            <div className="command-actions">
              <div>
                <span>Run</span>
                <button className="button command-button" disabled={!canRun || Boolean(busy)} onClick={() => void runGraph()}>
                  {busy === "run" ? <SpinnerGap className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />} Run
                </button>
                <small>{canRun ? "Start or resume the active path" : waitingGate ? "Unavailable — waiting for approval" : "Already running"}</small>
              </div>
              <div>
                <span>Pause</span>
                <button className="button command-button" disabled={!canPause || Boolean(busy)} onClick={() => void pauseGraph()}>
                  {busy === "pause" ? <SpinnerGap className="spin" aria-hidden="true" /> : <Pause aria-hidden="true" />} Pause
                </button>
                <small>Pause company work safely</small>
              </div>
              <div>
                <span>Approve</span>
                <button
                  className="button button-primary command-button"
                  disabled={!waitingGate || !packetReady || Boolean(busy)}
                  onClick={() => gateDialog.current?.showModal()}
                >
                  <Check aria-hidden="true" /> Approve
                </button>
                <small>{waitingGate ? packetReady ? "Review the exact boundary first" : "Unavailable — packet failed strict validation" : "No approval is pending"}</small>
              </div>
            </div>
          </section>
        </main>
      </div>

      <CreateCompanyDialog dialogRef={createDialog} onSubmit={createCompany} busy={busy === "create"} />
      <ReportDialog dialogRef={reportDialog} screen={screen} amped={amped} mode={mode} />
      <GateDialog
        dialogRef={gateDialog}
        screen={screen}
        approval={approval}
        busy={busy === "approve" || busy === "deny"}
        actor={actor}
        onDecision={decideGate}
      />
    </>
  );
}

function lifecycleDescription(stage: StudioStage): string {
  const copy: Record<StudioStage, string> = {
    Ideation: "Pressure-test a problem before building.",
    Validation: "Collect buyer, offer, and pricing evidence.",
    Build: "Create the minimum sellable system.",
    "Launch & Grow": "Advance only from authoritative proof."
  };
  return copy[stage];
}

function CreateCompanyDialog({
  dialogRef,
  onSubmit,
  busy
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
}) {
  return (
    <dialog ref={dialogRef} className="studio-dialog" aria-labelledby="create-company-title">
      <form method="dialog" className="dialog-close-form">
        <button aria-label="Close create company dialog"><X aria-hidden="true" /></button>
      </form>
      <form onSubmit={onSubmit}>
        <p className="eyebrow">Private company</p>
        <h2 id="create-company-title">Create a company</h2>
        <p>The control plane will create the canonical company, goal, budget, constraints, and kill conditions.</p>
        <label>Company name<input name="name" autoComplete="organization" placeholder="Company or idea name" /></label>
        <label>Company truth<textarea name="idea" minLength={20} required rows={4} placeholder="What exists, who it serves, and what is still unknown." /></label>
        <label>Outcome
          <select name="destination" defaultValue="durable-operation">
            <option value="cash-flow">Cash flow</option>
            <option value="growth">Growth</option>
            <option value="durable-operation">Durable operation</option>
            <option value="acquisition-readiness">Acquisition readiness</option>
            <option value="exit-readiness">Exit readiness</option>
          </select>
        </label>
        <label>Highest known constraint<input name="constraint" placeholder="Optional; missing truth stays missing." /></label>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="button button-primary" disabled={busy}>
            {busy ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />} Create company
          </button>
        </div>
      </form>
    </dialog>
  );
}

function ReportDialog({
  dialogRef,
  screen,
  amped,
  mode
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  screen: ScreenData;
  amped?: AmpedSnapshot;
  mode: AppMode;
}) {
  return (
    <dialog ref={dialogRef} className="studio-dialog report-dialog" aria-labelledby="report-title">
      <form method="dialog" className="dialog-close-form">
        <button aria-label="Close report"><X aria-hidden="true" /></button>
      </form>
      <p className="eyebrow">Proof report</p>
      <h2 id="report-title">{screen.company}</h2>
      <p className="report-status">{mode === "preview" ? "Contract preview — no canonical data is shown." : screen.proofStatus}</p>
      <section>
        <h3>Required proof</h3>
        <p>{screen.requiredProof}</p>
      </section>
      <section>
        <h3>Teaching record</h3>
        <p>{screen.whatChanged}</p>
      </section>
      <section>
        <h3>Trace receipts</h3>
        {amped?.traces.length ? (
          <ul className="receipt-list">
            {amped.traces.map((trace) => (
              <li key={trace.identity.traceId}>
                <FileText aria-hidden="true" />
                <div><strong>{trace.identity.traceId}</strong><span>{trace.costCents}¢ · {trace.completedAt ? "complete" : "open"}</span></div>
              </li>
            ))}
          </ul>
        ) : <p>No trace receipts are available in this state.</p>}
      </section>
    </dialog>
  );
}

function GateDialog({
  dialogRef,
  screen,
  approval,
  busy,
  actor,
  onDecision
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  screen: ScreenData;
  approval?: PendingApproval;
  busy: boolean;
  actor: string;
  onDecision: (decision: "approve" | "deny") => void;
}) {
  return (
    <dialog ref={dialogRef} className="studio-dialog gate-dialog" aria-labelledby="gate-title">
      <form method="dialog" className="dialog-close-form">
        <button aria-label="Close approval"><X aria-hidden="true" /></button>
      </form>
      <LockKey size={32} className="amber-text" aria-hidden="true" />
      <p className="eyebrow">Exact human gate</p>
      <h2 id="gate-title">{screen.gateTitle}</h2>
      <p>{screen.gateDetail}</p>
      {approval?.packet ? (
        <div className="decision-packet">
          <dl className="gate-details">
            <div><dt>Authority</dt><dd>{actor} · founder</dd></div>
            <div><dt>Question</dt><dd>{approval.packet.question}</dd></div>
            <div><dt>Why now</dt><dd>{approval.packet.whyNow}</dd></div>
            <div><dt>Company / initiative</dt><dd>{approval.packet.companyName} · {approval.packet.initiativeTitle}</dd></div>
            <div><dt>Exact unlock</dt><dd>{approval.packet.exactUnlock.action}</dd></div>
            <div><dt>Expires</dt><dd>{new Date(approval.packet.expiresAt).toLocaleString()}</dd></div>
          </dl>
          <section><h3>Agent actions</h3><ol>{approval.packet.orderedAgentActions.map((item) => <li key={item.order}><strong>{item.role}</strong> — {item.action}</li>)}</ol></section>
          <section><h3>Allowed sources and tools</h3><p>{approval.packet.allowedSourceScopes.join(" · ")}</p><p>{approval.packet.allowedToolIds.join(" · ") || "No tools"}</p></section>
          <section><h3>Hard bounds</h3><p>{approval.packet.limits.maxTimeMinutes} min · {approval.packet.limits.maxInputTokens} input tokens · {approval.packet.limits.maxOutputTokens} output tokens · {approval.packet.limits.maxCostCents}¢ · {approval.packet.limits.maxOutreach} outreach · {approval.packet.limits.maxExternalEffects} external effects</p></section>
          <section><h3>Forbidden</h3><p>{approval.packet.forbiddenActions.join(" · ")}</p></section>
          <section><h3>Artifact and verifier</h3><p>{approval.packet.expectedArtifact.kind}: {approval.packet.expectedArtifact.requiredFields.join(" · ")}</p><p>{approval.packet.verifier.identity} · {approval.packet.verifier.role}. {approval.packet.verifier.separationRule}</p></section>
          <section><h3>Proof and signals</h3><p>{approval.packet.proofRequired.join(" · ")}</p><p><strong>Success:</strong> {approval.packet.successSignals.join(" · ")}</p><p><strong>Failure:</strong> {approval.packet.failureSignals.join(" · ")}</p></section>
          <section><h3>Stop and escalation</h3><p>{approval.packet.stopConditions.join(" · ")}</p><p>{approval.packet.escalationRoute}</p></section>
          <section><h3>Still locked</h3><p>{approval.packet.remainsLocked.join(" · ")}</p></section>
          <small className="packet-digest">Action digest {approval.packet.actionDigest}</small>
        </div>
      ) : approval ? (
        <p className="error-message" role="alert">This packet is malformed or legacy. It may be paused or denied, but it cannot be approved.</p>
      ) : (
        <dl className="gate-details">
          <div><dt>Authority</dt><dd>{actor} · preview founder</dd></div>
          <div><dt>Action</dt><dd>{approvalAction(approval)}</dd></div>
          <div><dt>Proof required</dt><dd>{screen.requiredProof}</dd></div>
          <div><dt>External action</dt><dd>Not authorized by this preview</dd></div>
        </dl>
      )}
      <div className="dialog-actions">
        <button className="button" disabled={busy} onClick={() => void onDecision("deny")}>Deny</button>
        <button className="button button-primary" disabled={busy || Boolean(approval && !approval.packet)} onClick={() => void onDecision("approve")}>
          {busy ? <SpinnerGap className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />} Approve exact boundary
        </button>
      </div>
    </dialog>
  );
}
