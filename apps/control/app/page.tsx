import type { Metadata } from "next";
import Link from "next/link";
import { SELF_SERVE_PLANS, SELF_SERVE_PLAN_ORDER } from "@amped-studio-os/contracts";

export const metadata: Metadata = {
  title: "Amped Studio OS: tell it what you are building, it goes to market",
  description: "A company runtime that picks the next go-to-market move, does the bounded work, and brings back proof. It stops and asks before it sends, publishes, or overspends."
};

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const steps = [
  {
    title: "Describe the company",
    body: "The customer, the offer, where you want to end up, and how much your agents may spend each month. Takes one form and a few minutes."
  },
  {
    title: "It picks one move",
    body: "Not a backlog of forty tasks. One initiative, the outcome it expects, and the proof that would actually advance the company."
  },
  {
    title: "It brings back proof",
    body: "Every result is filed with its tier and its authority, so a real outcome never gets filed next to a claim and counted the same."
  }
];

const capabilities = [
  {
    title: "One initiative at a time",
    body: "The runtime reads where the company actually is and names the single highest-leverage next move, with the expected outcome, the proof that advances it, and why it is uncertain."
  },
  {
    title: "The budget is the product",
    body: "Your tier is the monthly model budget your agents may spend on their own. Work that fits inside it runs without asking you. Work that does not, stops and waits."
  },
  {
    title: "Exact approvals, not vague alerts",
    body: "When something needs you, you get the recommended action, the target, the cost, the sender, when it expires, and how to roll it back. Approve or deny. Nothing else is gated."
  },
  {
    title: "Green, amber, red",
    body: "What an outside authority has proven, what is only internally true, and what is still missing. The runtime cannot promote its own work to proven."
  },
  {
    title: "Outreach and publishing stay off",
    body: "On every tier, including Scale. Paying more does not buy the right to contact people or publish claims on your behalf. Those arrive as approval requests."
  },
  {
    title: "Kill switch and export",
    body: "Stop a company for good in one click, or export everything it knows as JSON. You are never locked in to find out what it learned."
  }
];

export default function LandingPage() {
  return (
    <main className="landing">
      <header className="landing-header">
        <Link className="brand" href="/">Amped Studio OS <span>GTM</span></Link>
        <nav aria-label="Main">
          <a href="#how-it-works">How it works</a>
          <Link href="/proof">Proof</Link>
          <a href="#pricing">Pricing</a>
          <Link href="/login">Log in</Link>
          <Link className="landing-nav-cta" href="/signup">Start a company</Link>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="landing-inner">
          <p className="eyebrow">Go-to-market runtime</p>
          <h1>Tell it what you are building. It goes to market.</h1>
          <p className="landing-lede">
            Amped Studio OS turns a company definition into evidence-backed initiatives and receipts. It
            picks the next move, does the bounded work itself, and shows you what is proven. It will
            not send, publish, or spend past the budget you set without asking you first.
          </p>
          <div className="landing-cta-row">
            <Link className="landing-cta" href="/signup">Start a company</Link>
            <a className="landing-cta ghost" href="#pricing">See pricing</a>
          </div>
          <p className="landing-fineprint">No card to create your account. You subscribe once your company is set up.</p>
        </div>
      </section>

      <section className="landing-section" id="how-it-works" aria-labelledby="how-it-works-title">
        <p className="eyebrow">How it works</p>
        <h2 id="how-it-works-title">Three steps, then it runs.</h2>
        <ol className="landing-steps">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span className="landing-step-number" aria-hidden="true">{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section landing-section-alt" aria-labelledby="capabilities-title">
        <div className="landing-inner">
          <p className="eyebrow">What you get</p>
          <h2 id="capabilities-title">Bounded autonomy, and you can see the boundary.</h2>
          <div className="landing-capabilities">
            {capabilities.map((capability) => (
              <article key={capability.title}>
                <h3>{capability.title}</h3>
                <p>{capability.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section" id="pricing" aria-labelledby="pricing-title">
        <p className="eyebrow">Pricing</p>
        <h2 id="pricing-title">One company per subscription. Pick your budget.</h2>
        <p className="landing-section-lede">
          The tier you pick is the monthly model budget your agents may spend on their own. A bigger
          envelope means fewer interruptions, not a longer feature list.
        </p>
        <div className="landing-plan-grid">
          {SELF_SERVE_PLAN_ORDER.map((id) => {
            const plan = SELF_SERVE_PLANS[id];
            return (
              <article key={plan.id} className="landing-plan" aria-labelledby={`landing-plan-${plan.id}`}>
                <h3 id={`landing-plan-${plan.id}`}>{plan.name}</h3>
                <p className="landing-plan-amount">
                  <strong>{dollars(plan.priceCents)}</strong>
                  <span> / month</span>
                </p>
                <p className="landing-plan-budget">{dollars(plan.modelBudgetCents)} monthly model budget</p>
                <p>{plan.summary}</p>
                <Link className="landing-cta" href={`/signup?plan=${plan.id}`}>Start with {plan.name}</Link>
              </article>
            );
          })}
        </div>
        <p className="landing-section-note">
          Cancel from billing controls at any time. Full detail on the <Link href="/pricing">pricing page</Link>.
        </p>
      </section>

      <section className="landing-close" aria-labelledby="close-title">
        <div className="landing-inner">
          <h2 id="close-title">Start a company tonight.</h2>
          <p>
            Create the account, describe what you are building, and read the first initiative it
            comes back with. Subscribe when you want it to keep going.
          </p>
          <div className="landing-cta-row">
            <Link className="landing-cta" href="/signup">Start a company</Link>
            <Link className="landing-cta ghost" href="/support">Snapshot details</Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <p>Amped Studio OS</p>
        <nav aria-label="Service information">
          <Link href="/proof">Proof</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/support">Support</Link>
          <Link href="/security">Security</Link>
        </nav>
      </footer>
    </main>
  );
}
