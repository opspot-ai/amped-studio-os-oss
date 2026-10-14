import type { Metadata } from "next";
import { PostHogSnippet } from "./posthog";
import "./styles.css";

export const metadata: Metadata = {
  title: "Amped Studio OS Cloud",
  description: "Run companies with bounded autonomy, proof, and explicit founder approvals."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <PostHogSnippet />
      </body>
    </html>
  );
}
