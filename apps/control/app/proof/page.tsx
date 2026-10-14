import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "../public-page";

export const metadata: Metadata = {
  title: "The proof standard | Amped Studio OS",
  description: "The evidence rules Amped Studio OS uses before a company can advance from idea to scale."
};

const states = [
  "candidate",
  "validating",
  "offer-ready",
  "launch-ready",
  "externally-live",
  "revenue-verified",
  "fulfillment-verified",
  "scaling"
] as const;

const transitions = [
  ["candidate", "validating", "Problem, buyer, founder boundary, and source-reference evidence."],
  ["validating", "offer-ready", "A priced offer, buyer validation evidence, and supportable claim boundaries."],
  ["offer-ready", "launch-ready", "An acquisition path, payment path, fulfillment plan and capacity, policy bounds, and rollback or kill evidence."],
  ["launch-ready", "externally-live", "A current, unexpired external-surface-live evidence item."],
  ["externally-live", "revenue-verified", "An authoritative successful payment or collection event."],
  ["revenue-verified", "fulfillment-verified", "An authoritative promised-delivery event tied to that payment or customer order."],
  ["fulfillment-verified", "scaling", "Repeated acquisition and delivery within agreed economics, quality, and founder-intervention thresholds."]
] as const;

const vocabulary = [
  ["Idea", "candidate", "Only after a venture exists. A pre-venture idea is not represented."],
  ["Validate", "validating", "The problem and buyer are being tested against evidence."],
  ["Build", "No exact state", "A finished build alone does not earn launch readiness."],
  ["Launch", "externally-live", "launch-ready means prepared; externally-live requires current, unexpired external-surface-live evidence."],
  ["Revenue", "revenue-verified", "Requires an authoritative successful payment or collection event."],
  ["Fulfill", "fulfillment-verified", "Requires promised delivery tied to the payment or customer order."],
  ["Scale", "scaling", "Requires repeated acquisition and delivery within the agreed bounds."],
  ["Exit-ready", "No exact state", "Exit readiness is a founder destination, not a lifecycle stage."]
] as const;

export default function ProofPage() {
  return (
    <PublicPage title="The proof standard">
      <p className="proof-intro">
        Advancement is evidence-gated. The kernel requires the evidence types for the requested transition, and every matching item must be current and unexpired. Payment and fulfillment add stricter authority, proof-tier, and non-fixture checks.
      </p>

      <section aria-labelledby="proof-states">
        <h2 id="proof-states">Eight states, in order</h2>
        <ol className="proof-state-chain">
          {states.map((state, index) => (
            <li key={state}>
              <code>{state}</code>
              {index < states.length - 1 ? <span aria-hidden="true">→</span> : null}
            </li>
          ))}
        </ol>
        <p>
          Any active state may move to <code>parked</code> or <code>killed</code> only through an
          explicit command. Neither destructive recommendation is ever executed automatically.
        </p>
      </section>

      <section aria-labelledby="proof-transition-evidence">
        <h2 id="proof-transition-evidence">What each transition must prove</h2>
        <div className="proof-table-wrap">
          <table className="proof-table">
            <thead>
              <tr>
                <th scope="col">Transition</th>
                <th scope="col">Minimum evidence class</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map(([from, to, evidence]) => (
                <tr key={`${from}-${to}`}>
                  <th scope="row"><code>{from} → {to}</code></th>
                  <td>{evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="proof-request-checks">
        <h2 id="proof-request-checks">What the engine checks before it advances</h2>
        <ol className="proof-checks">
          <li>The expected current state matches.</li>
          <li>The requested transition edge is allowed.</li>
          <li>Every named evidence type exists for the same venture.</li>
          <li>Every candidate item for a required evidence type is current and unexpired; stale, conflicting, superseded, and unavailable candidates block the transition.</li>
          <li>Payment and delivery evidence must additionally carry payment or fulfillment authority, the matching proof tier, and must not be a fixture.</li>
          <li>The idempotency key has not already produced a different effect.</li>
        </ol>
        <p>
          Every allow and every deny is written to a transition receipt and recorded in an audit event. A denied request leaves lifecycle state unchanged; an allowed state change is committed in the same storage transaction as its stored result.
        </p>
      </section>

      <section aria-labelledby="proof-conflicts">
        <h2 id="proof-conflicts">Evidence fields, conflicts, and freshness</h2>
        <p>
          Evidence records its authority, observation time, optional expiry, status, and content hash. Readiness reports a requirement as conflicting when a referenced source is already marked conflicting. Stale, superseded, and unavailable source conditions also surface as readiness gaps.
        </p>
        <aside className="proof-note" aria-label="Fixture boundary">
          <strong>The runtime cannot promote its own work to proven.</strong>
          <p>
            Fixtures prove rule behavior only. They cannot satisfy the authoritative payment or promised-delivery evidence required for revenue-verified or fulfillment-verified.
          </p>
        </aside>
      </section>

      <section aria-labelledby="proof-vocabulary">
        <h2 id="proof-vocabulary">Founder language beside the lifecycle</h2>
        <div className="proof-table-wrap">
          <table className="proof-table">
            <thead>
              <tr>
                <th scope="col">Plain language</th>
                <th scope="col">Internal state</th>
                <th scope="col">Boundary</th>
              </tr>
            </thead>
            <tbody>
              {vocabulary.map(([plain, state, boundary]) => (
                <tr key={plain}>
                  <th scope="row">{plain}</th>
                  <td>{state === "No exact state" ? state : <code>{state}</code>}</td>
                  <td>{boundary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="proof-cta">
        Want to operate a company against this standard? <Link href="/pricing">See pricing</Link>.
      </p>
    </PublicPage>
  );
}
