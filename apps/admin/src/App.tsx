import { FormEvent, useEffect, useState } from "react";
import { ArrowsClockwise, Copy, LockKey, ShieldCheck, SignOut, Warning } from "@phosphor-icons/react";
import {
  createInvite,
  endSupport,
  getSupport,
  listAudit,
  listCompaniesAsSupport,
  listWorkspaces,
  session,
  signIn,
  signOut,
  startSupport,
  type AdminWorkspace,
  type SupportAudit,
  type SupportSession
} from "./api";

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState("");
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [selected, setSelected] = useState("");
  const [cursor, setCursor] = useState("");
  const [nextCursor, setNextCursor] = useState("");
  const [support, setSupport] = useState<SupportSession>();
  const [audit, setAudit] = useState<SupportAudit[]>([]);
  const [customerContext, setCustomerContext] = useState<unknown>();
  const [privateLink, setPrivateLink] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  async function refresh(pageCursor = cursor): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      const page = await listWorkspaces(pageCursor || undefined);
      setWorkspaces(page.workspaces);
      setCursor(pageCursor);
      setNextCursor(page.nextCursor ?? "");
      setSelected((current) => page.workspaces.some((item) => item.workspaceId === current) ? current : page.workspaces[0]?.workspaceId ?? "");
      if (support) {
        setAudit(await listAudit(support));
      }
      return true;
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Admin state could not be loaded.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void session().then(async (value) => {
      if (!await refresh()) return;
      setEmail(value.user.email);
      setAuthenticated(true);
      const supportSessionId = window.sessionStorage.getItem("amped-admin-support-session");
      return supportSessionId ? getSupport(supportSessionId).then(setSupport).catch(() => {
          window.sessionStorage.removeItem("amped-admin-support-session");
        }) : undefined;
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!support || support.status !== "active") return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [support]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const result = await signIn(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
      if (!await refresh()) {
        await signOut();
        return;
      }
      setEmail(result.user.email);
      setAuthenticated(true);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const result = await createInvite(String(form.get("email") ?? ""), String(form.get("workspace") ?? "") || undefined);
      setPrivateLink(result.privateLink);
      await refresh();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Invite creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function beginSupport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const next = await startSupport(selected, String(form.get("reason") ?? ""), Number(form.get("expiry") ?? 30));
      setSupport(next);
      window.sessionStorage.setItem("amped-admin-support-session", next.id);
      setAudit(await listAudit(next));
      setCustomerContext(undefined);
    } catch (supportError) {
      setError(supportError instanceof Error ? supportError.message : "Support session could not start.");
    } finally {
      setBusy(false);
    }
  }

  if (!authenticated) {
    return (
      <main className="access-page">
        <LockKey size={40} aria-hidden="true" />
        <p className="eyebrow">Amped Studio OS platform support</p>
        <h1>Verified platform admins only.</h1>
        <form onSubmit={login}>
          <label>Email<input name="email" type="email" required autoComplete="email" /></label>
          <label>Password<input name="password" type="password" minLength={8} required autoComplete="current-password" /></label>
          <button disabled={busy}>Sign in</button>
        </form>
        {error && <p role="alert" className="error"><Warning aria-hidden="true" /> {error}</p>}
      </main>
    );
  }

  const selectedWorkspace = workspaces.find((workspace) => workspace.workspaceId === selected);
  const remainingSeconds = support ? Math.max(0, Math.ceil((Date.parse(support.expiresAt) - Date.now()) / 1_000)) : 0;
  const active = support?.status === "active" && remainingSeconds > 0;

  async function logout() {
    setBusy(true);
    setError(undefined);
    try {
      if (support?.status === "active") await endSupport(support.id);
      await signOut();
      window.sessionStorage.removeItem("amped-admin-support-session");
      setSupport(undefined);
      setAuthenticated(false);
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "Sign-out failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {support && (
        <div className={`support-banner ${active ? "" : "expired"}`} role="status">
          <ShieldCheck aria-hidden="true" />
          <strong>Admin operating</strong>
          <span>actual actor {support.adminSubject}</span>
          <span>target {support.targetWorkspaceId}</span>
          <span>reason {support.reason}</span>
          <span>{active ? `${remainingSeconds}s remaining` : support.status}</span>
        </div>
      )}
      <header>
        <div><p className="eyebrow">Amped Studio OS</p><h1>Platform admin</h1></div>
        <div className="header-actions">
          <span>{email}</span>
          <button onClick={() => void refresh()} disabled={busy}><ArrowsClockwise aria-hidden="true" /> Refresh</button>
          <button onClick={() => void logout()} disabled={busy}><SignOut aria-hidden="true" /> Sign out</button>
        </div>
      </header>
      <main>
        {error && <p role="alert" className="error"><Warning aria-hidden="true" /> {error}</p>}
        <section>
          <h2>Private workspaces</h2>
          <p>Bounded summaries only. No raw credentials, tokens, prompts, or database tables are exposed.</p>
          <div className="workspace-grid">
            {workspaces.map((workspace) => (
              <button className={workspace.workspaceId === selected ? "workspace selected" : "workspace"} onClick={() => setSelected(workspace.workspaceId)} key={workspace.workspaceId}>
                <strong>{workspace.selectedCompanyName ?? "Empty workspace"}</strong>
                <span>{workspace.workspaceId}</span>
                <span>{workspace.inviteStatus} invite · {workspace.accountStatus} account</span>
                <span>{workspace.companyCount} companies · {workspace.pendingHumanGates} pending gates</span>
                <span>{workspace.workerHealth} worker · {workspace.failedWorkCount} failures</span>
                <span>{workspace.boundedCostCents}¢ · {workspace.receiptCount} receipts</span>
                <span>Orgo: {workspace.orgoStatus}</span>
              </button>
            ))}
          </div>
          {(cursor || nextCursor) && (
            <div className="header-actions">
              {cursor && <button onClick={() => void refresh("")}>First page</button>}
              {nextCursor && <button onClick={() => void refresh(nextCursor)}>Next page</button>}
            </div>
          )}
        </section>
        <div className="two-column">
          <section>
            <h2>Create private invite</h2>
            <p>No email is sent. This snapshot has no public support contact.</p>
            <form onSubmit={invite}>
              <label>Invited email<input name="email" type="email" required placeholder="synthetic-contact-009@example.test" /></label>
              <label>Existing workspace (optional)<input name="workspace" placeholder="Leave blank for a new empty workspace" /></label>
              <button disabled={busy}>Create single-use link</button>
            </form>
            {privateLink && (
              <div className="private-link">
                <strong>Copy once — no email sent</strong>
                <code>{privateLink}</code>
                <button onClick={() => void navigator.clipboard.writeText(privateLink)}><Copy aria-hidden="true" /> Copy link</button>
              </div>
            )}
          </section>
          <section>
            <h2>Audited support</h2>
            <p>{selectedWorkspace ? `Target: ${selectedWorkspace.workspaceId}` : "Select one workspace."}</p>
            {!active ? (
              <form onSubmit={beginSupport}>
                <label>Explicit reason<textarea name="reason" minLength={10} required placeholder="Why customer-equivalent support is needed now" /></label>
                <label>Expiry
                  <select name="expiry" defaultValue="30">
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">60 minutes</option>
                  </select>
                </label>
                <button disabled={busy || !selected}>Start support session</button>
              </form>
            ) : (
              <div className="support-controls">
                <button onClick={() => void listCompaniesAsSupport(support).then((value) => {
                  setCustomerContext(value);
                  return listAudit(support).then(setAudit);
                }).catch((supportError) => setError(supportError instanceof Error ? supportError.message : "Support read failed."))}>
                  List companies through customer command path
                </button>
                <button className="danger" onClick={() => void endSupport(support.id).then((ended) => {
                  setSupport(ended);
                  window.sessionStorage.removeItem("amped-admin-support-session");
                  return listAudit(support).then(setAudit);
                })}>End support now</button>
              </div>
            )}
          </section>
        </div>
        {support && (
          <section>
            <h2>Customer context</h2>
            <p className="context-banner">Admin operating as {support.adminSubject}; never impersonating a customer.</p>
            <pre>{customerContext ? JSON.stringify(customerContext, null, 2) : "No customer-equivalent read has been attempted."}</pre>
            <h3>Immutable command audit</h3>
            <ol className="audit-list">
              {audit.map((event) => <li key={event.id}><strong>{event.outcome}</strong> {event.command} · {event.resultCode} · {new Date(event.attemptedAt).toLocaleString()}<small>{event.adminSubject} · {event.inputDigest}</small></li>)}
            </ol>
          </section>
        )}
      </main>
    </>
  );
}
