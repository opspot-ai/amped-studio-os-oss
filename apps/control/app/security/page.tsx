import type { Metadata } from "next";
import { PublicPage } from "../public-page";

export const metadata: Metadata = { title: "Security | Amped Studio OS" };

export default function SecurityPage() {
  return <PublicPage title="Security"><p>This snapshot makes no claim of certification, audit coverage, or a security response time.</p><p>Operators must evaluate and configure security controls before processing sensitive or customer data. Do not post credentials, private data, or exploit details in public channels.</p><p>This snapshot includes no security-reporting contact or monitored response channel.</p></PublicPage>;
}
