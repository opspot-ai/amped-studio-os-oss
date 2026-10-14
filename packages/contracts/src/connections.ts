import { z } from "zod";

/**
 * Curated Composio toolkits a customer may connect in v1.
 *
 * Free-form toolkit input is rejected at the route. Adding a toolkit is a product decision:
 * it widens what agents may later request, never what they may do without an approval gate.
 */
export const ComposioToolkitIdSchema = z.enum([
  "gmail",
  "square",
  "shopify",
  "stripe",
  "slack",
  "notion",
  "hubspot",
  "x",
  "instagram"
]);
export type ComposioToolkitId = z.infer<typeof ComposioToolkitIdSchema>;

export interface ComposioToolkitCatalogEntry {
  id: ComposioToolkitId;
  displayName: string;
  /** Short founder-facing line: what connecting this app unlocks for later gated work. */
  unlocks: string;
}

export const COMPOSIO_TOOLKIT_CATALOG: Readonly<Record<ComposioToolkitId, ComposioToolkitCatalogEntry>> = Object.freeze({
  gmail: {
    id: "gmail",
    displayName: "Gmail",
    unlocks: "Company email send and inbox reads, still behind the approval gate."
  },
  square: {
    id: "square",
    displayName: "Square",
    unlocks: "POS and payment signals from the company's Square account."
  },
  shopify: {
    id: "shopify",
    displayName: "Shopify",
    unlocks: "Store catalog, orders, and customer signals from Shopify."
  },
  stripe: {
    id: "stripe",
    displayName: "Stripe",
    unlocks: "The company's own Stripe account for operated payments (not Amped Studio OS SaaS billing)."
  },
  slack: {
    id: "slack",
    displayName: "Slack",
    unlocks: "Team channels and messages the company chooses to expose."
  },
  notion: {
    id: "notion",
    displayName: "Notion",
    unlocks: "Workspace pages and databases the company chooses to expose."
  },
  hubspot: {
    id: "hubspot",
    displayName: "HubSpot",
    unlocks: "CRM contacts, deals, and pipeline state from HubSpot."
  },
  x: {
    id: "x",
    displayName: "X",
    unlocks: "Public posts and mention signals on X (Twitter)."
  },
  instagram: {
    id: "instagram",
    displayName: "Instagram",
    unlocks: "Profile and content signals from Instagram."
  }
});

export const COMPOSIO_TOOLKIT_ORDER: readonly ComposioToolkitId[] = Object.freeze([
  "gmail",
  "square",
  "shopify",
  "stripe",
  "slack",
  "notion",
  "hubspot",
  "x",
  "instagram"
]);

export function isComposioToolkitId(value: string): value is ComposioToolkitId {
  return ComposioToolkitIdSchema.safeParse(value).success;
}
