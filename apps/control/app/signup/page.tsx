import { Dashboard } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Self-serve signup. Opens on the sign-up tab, and `?plan=<tier>` from the landing or pricing page
 * is read by the auth screen so the chosen tier survives the email-confirmation round trip.
 */
export default function Page() {
  return <Dashboard initialMode="sign-up" />;
}
