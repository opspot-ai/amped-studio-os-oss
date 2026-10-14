import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LandingPage from "../page.js";
import ProofPage, { metadata } from "./page.js";

test("proof page publishes the frozen evidence contract and is linked from the landing page", () => {
  assert.equal(metadata.title, "The proof standard | Amped Studio OS");

  const proof = renderToStaticMarkup(createElement(ProofPage));
  for (const phrase of [
    "The proof standard",
    "candidate",
    "validating",
    "offer-ready",
    "launch-ready",
    "externally-live",
    "revenue-verified",
    "fulfillment-verified",
    "scaling",
    "Advancement is evidence-gated. The kernel requires the evidence types for the requested transition, and every matching item must be current and unexpired.",
    "Payment and fulfillment add stricter authority, proof-tier, and non-fixture checks.",
    "A current, unexpired external-surface-live evidence item.",
    "An authoritative successful payment or collection event.",
    "An authoritative promised-delivery event tied to that payment or customer order.",
    "Every candidate item for a required evidence type is current and unexpired; stale, conflicting, superseded, and unavailable candidates block the transition.",
    "Payment and delivery evidence must additionally carry payment or fulfillment authority, the matching proof tier, and must not be a fixture.",
    "Every allow and every deny is written to a transition receipt and recorded in an audit event.",
    "A denied request leaves lifecycle state unchanged; an allowed state change is committed in the same storage transaction as its stored result.",
    "Evidence records its authority, observation time, optional expiry, status, and content hash.",
    "Readiness reports a requirement as conflicting when a referenced source is already marked conflicting.",
    "Stale, superseded, and unavailable source conditions also surface as readiness gaps.",
    "launch-ready means prepared; externally-live requires current, unexpired external-surface-live evidence.",
    "The runtime cannot promote its own work to proven.",
    "Fixtures prove rule behavior only. They cannot satisfy the authoritative payment or promised-delivery evidence required for revenue-verified or fulfillment-verified.",
    "No exact state"
  ]) assert.match(proof, new RegExp(phrase));
  assert.equal((proof.match(/<tbody>/g) ?? []).length, 2);
  assert.match(proof, /href="\/pricing"/);

  const serviceNavigation = proof.match(/<nav aria-label="Service information">([\s\S]*?)<\/nav>/);
  assert.ok(serviceNavigation, "shared service navigation must render on public pages");
  const serviceNavigationMarkup = serviceNavigation[1];
  assert.ok(serviceNavigationMarkup, "shared service navigation must contain links");
  const serviceLinks = Array.from(
    serviceNavigationMarkup.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g),
    ([, href, label]) => ({ href, label })
  );
  assert.deepEqual(serviceLinks, [
    { href: "/pricing", label: "Pricing" },
    { href: "/proof", label: "Proof" },
    { href: "/privacy", label: "Privacy" },
    { href: "/terms", label: "Terms" },
    { href: "/support", label: "Support" },
    { href: "/security", label: "Security" }
  ]);

  const landing = renderToStaticMarkup(createElement(LandingPage));
  assert.equal((landing.match(/href="\/proof"/g) ?? []).length, 2);
});
