import type { Metadata } from "next";
import Link from "next/link";
import { SELF_SERVE_PLANS, SELF_SERVE_PLAN_ORDER } from "@amped-studio-os/contracts";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Pricing | Amped Studio OS" };

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default function PricingPage() {
  return (
    <PublicPage title="Pricing">
      <p>
        One company per subscription. The tier you pick is the monthly model budget your agents may
        spend on their own. Work inside that budget runs without asking you; anything beyond it stops
        and asks.
      </p>
      <div className="pricing-grid">
        {SELF_SERVE_PLAN_ORDER.map((id) => {
          const plan = SELF_SERVE_PLANS[id];
          return (
            <section key={plan.id} className="pricing-card" aria-labelledby={`plan-${plan.id}`}>
              <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
              <p className="pricing-amount">
                <strong>{dollars(plan.priceCents)}</strong>
                <span> / month</span>
              </p>
              <p className="pricing-budget">{dollars(plan.modelBudgetCents)} monthly model budget</p>
              <p>{plan.summary}</p>
              <Link className="pricing-cta" href={`/signup?plan=${plan.id}`}>Start with {plan.name}</Link>
            </section>
          );
        })}
      </div>
      <h2>What every tier includes</h2>
      <ul>
        <li>Bounded autonomy: agents act only inside the budget and limits you are shown.</li>
        <li>Every automatic decision is recorded with the same audit trail as one you make yourself.</li>
        <li>
          Outreach and public posting stay off on every tier, including Scale. Paying more does not
          buy the right to contact people or publish claims on your behalf. Those remain your call,
          and arrive as approval requests.
        </li>
        <li>Cancel through billing controls at any time. See <Link href="/terms">Terms</Link>.</li>
      </ul>
      <p>
        See the support page for this snapshot’s limitations.
      </p>
    </PublicPage>
  );
}
