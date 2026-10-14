import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Terms | Amped Studio OS" };

export default function TermsPage() {
  return <PublicPage title="Terms of Service"><p>This experimental source snapshot does not provide contractual terms for an operating service.</p><p>Operators must obtain and publish terms appropriate to their deployment before accepting users, payments, or data.</p></PublicPage>;
}
