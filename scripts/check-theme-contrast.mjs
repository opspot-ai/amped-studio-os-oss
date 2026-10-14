#!/usr/bin/env node
/**
 * Theme accessibility gate for the included control app.
 *
 * Reads actual token values from apps/control/app/styles.css, measures every
 * real text/UI pair that the current screens paint, and enforces WCAG 2.1 AA.
 * Does not invent colors: every hex comes from the theme layer.
 *
 *   node scripts/check-theme-contrast.mjs
 *
 * Exit 1 on any AA failure.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const THEME_PATH = path.join(ROOT, "apps/control/app/styles.css");

const AA_TEXT = 4.5;
const AA_LARGE = 3.0;
const AA_NONTEXT = 3.0;

/** Real pairs painted by current screens (selector notes are documentation only). */
const PAIRS = [
  { where: "body text on paper canvas", fg: "--gtm-ink-900", bg: "--gtm-paper", kind: "text" },
  { where: "muted / summary on paper", fg: "--gtm-ink-600", bg: "--gtm-paper", kind: "text" },
  { where: "card body on panel", fg: "--gtm-ink-900", bg: "--gtm-panel", kind: "text" },
  { where: "muted on panel", fg: "--gtm-ink-600", bg: "--gtm-panel", kind: "text" },
  { where: "default button label", fg: "--gtm-ink-900", bg: "--gtm-panel", kind: "text" },
  { where: "primary button label on lime", fg: "--gtm-on-lime", bg: "--gtm-lime-500", kind: "text" },
  { where: "danger button label on paper", fg: "--gtm-danger-text", bg: "--gtm-paper", kind: "text" },
  { where: "link text on paper", fg: "--gtm-link", bg: "--gtm-paper", kind: "text" },
  { where: "auth brand span (lime-800) on panel", fg: "--gtm-lime-800", bg: "--gtm-panel", kind: "text" },
  { where: "notice text on proven wash", fg: "--gtm-notice-text", bg: "--gtm-proven-bg", kind: "text" },
  { where: "error text on missing wash", fg: "--gtm-error-text", bg: "--gtm-missing-bg", kind: "text" },
  { where: "portfolio strong text on navy", fg: "--gtm-on-navy", bg: "--gtm-navy-800", kind: "text" },
  { where: "portfolio body on navy", fg: "--gtm-on-navy-body", bg: "--gtm-navy-800", kind: "text" },
  { where: "portfolio muted eyebrow on navy", fg: "--gtm-on-navy-muted", bg: "--gtm-navy-800", kind: "text" },
  { where: "portfolio faint meta on navy", fg: "--gtm-on-navy-faint", bg: "--gtm-navy-800", kind: "text" },
  { where: "account line on navy", fg: "--gtm-on-navy-account", bg: "--gtm-navy-800", kind: "text" },
  { where: "public nav link on navy", fg: "--gtm-on-navy-nav", bg: "--gtm-navy-800", kind: "text" },
  { where: "landing footer link on deep navy", fg: "--gtm-on-navy-nav", bg: "--gtm-navy-900", kind: "text" },
  { where: "landing footer body on deep navy", fg: "--gtm-on-navy-account", bg: "--gtm-navy-900", kind: "text" },
  { where: "landing ghost CTA border on navy", fg: "--gtm-navy-400", bg: "--gtm-navy-800", kind: "nontext" },
  { where: "selected rail row text", fg: "--gtm-on-navy", bg: "--gtm-navy-600", kind: "text" },
  { where: "new-link lime on navy (large/bold)", fg: "--gtm-lime-500", bg: "--gtm-navy-800", kind: "large" },
  { where: "brand accent lime on navy (large/bold)", fg: "--gtm-lime-500", bg: "--gtm-navy-800", kind: "large" },
  { where: "approval label on uncertain wash", fg: "--gtm-uncertain-label", bg: "--gtm-uncertain-bg", kind: "text" },
  { where: "uncertain border signal on panel", fg: "--gtm-uncertain", bg: "--gtm-panel", kind: "nontext" },
  { where: "proven border signal on panel", fg: "--gtm-proven", bg: "--gtm-panel", kind: "nontext" },
  { where: "missing border signal on panel", fg: "--gtm-missing", bg: "--gtm-panel", kind: "nontext" },
  { where: "focus ring on paper", fg: "--gtm-focus", bg: "--gtm-paper", kind: "nontext" },
  { where: "input border on panel", fg: "--gtm-ink-400", bg: "--gtm-panel", kind: "nontext" },
  { where: "control border on panel (via --border-control)", fg: "--border-control", bg: "--gtm-panel", kind: "nontext" }
];

function parseHex(value) {
  const raw = value.trim();
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) return null;
  let hex = raw.slice(1);
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (hex.length === 8) hex = hex.slice(0, 6);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

function extractTokens(css) {
  const tokens = new Map();
  const blockMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!blockMatch) throw new Error("Could not find :root token block in styles.css");
  const block = blockMatch[1];
  const decl = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = decl.exec(block))) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

function resolveToken(tokens, name, stack = []) {
  if (stack.includes(name)) throw new Error(`Circular token: ${[...stack, name].join(" -> ")}`);
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`Missing token ${name} (not invented; must exist in theme)`);
  if (raw.startsWith("var(")) {
    const inner = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
    if (!inner) throw new Error(`Unsupported var() form for ${name}: ${raw}`);
    return resolveToken(tokens, inner[1], [...stack, name]);
  }
  const hex = parseHex(raw);
  if (!hex) throw new Error(`Token ${name} is not a measurable hex color: ${raw}`);
  return { name, raw, rgb: hex };
}

function minFor(kind) {
  if (kind === "text") return AA_TEXT;
  if (kind === "large") return AA_LARGE;
  return AA_NONTEXT;
}

function fmt(n) {
  return (Math.round(n * 100) / 100).toFixed(2).padStart(5);
}

async function main() {
  const css = await readFile(THEME_PATH, "utf8");
  const tokens = extractTokens(css);
  const rows = PAIRS.map((pair) => {
    const fg = resolveToken(tokens, pair.fg);
    const bg = resolveToken(tokens, pair.bg);
    const ratio = contrastRatio(fg.rgb, bg.rgb);
    const min = minFor(pair.kind);
    return {
      ...pair,
      fgRaw: fg.raw,
      bgRaw: bg.raw,
      ratio: Math.round(ratio * 100) / 100,
      min,
      pass: ratio >= min
    };
  });

  const bad = rows.filter((r) => !r.pass);
  const worstText = rows
    .filter((r) => r.kind === "text" || r.kind === "large")
    .reduce((m, r) => Math.min(m, r.ratio), Infinity);

  console.log(`GTM theme contrast · ${path.relative(ROOT, THEME_PATH)}`);
  console.log(`pairs measured: ${rows.length}  lowest text/large: ${fmt(worstText)}:1`);
  for (const r of rows) {
    const mark = r.pass ? "ok  " : "FAIL";
    console.log(
      `  ${mark} ${fmt(r.ratio)}:1  min ${r.min.toFixed(1)}  ${r.fgRaw} on ${r.bgRaw}  ${r.where}`
    );
  }
  console.log("");
  if (bad.length) {
    console.log(`RESULT: ${bad.length} WCAG AA failure(s).`);
    process.exit(1);
  }
  console.log("RESULT: every measured pair meets WCAG 2.1 AA.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
