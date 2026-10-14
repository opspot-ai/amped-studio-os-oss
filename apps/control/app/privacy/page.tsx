import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Privacy | Amped Studio OS" };

export default function PrivacyPage() {
  return <PublicPage title="Privacy"><p>This experimental source snapshot does not define privacy terms for an operating service.</p><p>Operators must provide and maintain their own privacy disclosures and data-handling controls before accepting personal data. Do not place credentials or unnecessary personal information in prompts, receipts, exports, analytics, or logs.</p></PublicPage>;
}
