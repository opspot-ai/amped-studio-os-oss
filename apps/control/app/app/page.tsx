import { Dashboard } from "../ui";

export const dynamic = "force-dynamic";

/**
 * The authenticated front door. `/` is the public landing page, so every post-auth redirect
 * (email confirmation, Stripe success/cancel, billing portal return) lands here instead.
 */
export default function Page() {
  return <Dashboard />;
}
