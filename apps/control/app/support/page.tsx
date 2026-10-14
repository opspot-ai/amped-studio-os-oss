import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Support | Amped Studio OS" };

export default function SupportPage() {
  return <PublicPage title="Support"><p>This experimental source snapshot includes no configured support contact, service-level agreement, response time, or availability commitment.</p><p>Operators must establish their own support process before serving users. See the <a href="/security">security guidance</a> for snapshot limitations.</p></PublicPage>;
}
