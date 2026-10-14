import { Dashboard } from "../ui";

export const dynamic = "force-dynamic";

/** Same surface as `/app`, opened on the log-in tab for someone arriving from the landing page. */
export default function Page() {
  return <Dashboard initialMode="sign-in" />;
}
